/**
 * Coordination engine for external workers.
 *
 * Weft never runs an agent itself. A worker (a host session, a CLI agent, a
 * script) pulls work with `claim()` and reports back with `complete()` or
 * `fail()`. Every transition is an event, so a crash between claim and report
 * is recoverable: the lease expires and the task becomes claimable again.
 *
 * Tasks and their payloads are user-defined data. The engine only enforces the
 * definition's stages, outcomes, capacity, retry budget and gates.
 */

import { randomUUID } from 'node:crypto';

export class EngineError extends Error {
  constructor(code, message, nextAction) {
    super(message);
    this.name = 'EngineError';
    this.code = code;
    this.nextAction = nextAction;
  }
}

export class Engine {
  constructor({ store, definition, workflowId = 'default', clock = () => new Date(), leaseMs = 300_000 }) {
    this.store = store;
    this.definition = definition;
    this.workflowId = workflowId;
    this.clock = clock;
    this.leaseMs = leaseMs;
  }

  nowIso() {
    return this.clock().toISOString();
  }

  /** Register a new item at the entry stage and create its first task. */
  enqueue({ title, kind = 'item', data = {}, priority = 0 }) {
    if (typeof title !== 'string' || title.trim() === '') {
      throw new EngineError('invalid_title', 'title must be a non-empty string');
    }
    const entry = this.stage(this.definition.entry);
    const itemId = `item-${randomUUID()}`;
    const item = { id: itemId, kind, title, stage: entry.id, status: 'active', priority, data };
    const created = this.createTask(item);
    this.store.appendMany([
      event('item.created', 'item', itemId, {
        itemId,
        kind,
        title,
        stage: entry.id,
        status: 'active',
        priority,
        data,
      }, this.workflowId),
      ...created.events,
    ]);
    return { itemId, taskId: created.taskId, stage: entry.id };
  }

  /**
   * Claim the next ready task for a role. Returns null when the role has no
   * eligible work. Capacity and provider health are enforced here, so a caller
   * cannot bypass them by polling.
   */
  claim({ role: roleId, member = null, provider = null }) {
    const role = this.role(roleId);
    if (role.kind === 'coordinator') {
      throw new EngineError('coordinator_role', `role "${roleId}" coordinates and does not claim tasks`);
    }
    // Admission, selection and the write share one transaction: two workers must
    // not both observe a free slot and claim past it.
    return this.store.transaction(() => {
      const now = this.nowIso();
      this.assertAdmission(role, member);
      let rows = this.store.db.prepare(`
        SELECT * FROM tasks
        WHERE role = ? AND status = 'ready' AND (available_at IS NULL OR available_at <= ?)
        ORDER BY priority DESC, created_at ASC, id ASC
        LIMIT 100
      `).all(roleId, now);
      if (rows.length === 0) return null;

      if (provider !== null) {
        if (!this.definition.providers.some(declared => declared.id === provider)) {
          throw new EngineError('unknown_provider', `provider "${provider}" is not declared`, 'declare it in the workflow definition');
        }
        rows = rows.filter(row => this.providerPool(role, this.stage(row.stage)).includes(provider));
        if (rows.length === 0) {
          throw new EngineError(
            'provider_not_allowed',
            `provider "${provider}" is not allowed for any ready ${roleId} task`,
            'claim without a provider, or use a lane this stage allows',
          );
        }
      }

      for (const row of rows) {
        const task = decodeTask(row);
        const stage = this.stage(task.stage);
        const selection = this.selectProvider({ role, stage, requested: provider, now });
        if (selection === null) continue;
        const attemptId = `attempt-${randomUUID()}`;
        const expiresAt = new Date(Date.parse(now) + this.leaseMs).toISOString();
        this.store.appendManyInTransaction([
          event('attempt.started', 'attempt', attemptId, {
            attemptId,
            taskId: task.id,
            member,
            provider: selection.provider,
            startedAt: now,
            expiresAt,
          }, this.workflowId),
          event('task.updated', 'task', task.id, {
            taskId: task.id,
            status: 'running',
            assignee: member,
            provider: selection.provider,
            attemptId,
          }, this.workflowId),
        ]);
        return {
          task: { ...task, status: 'running', assignee: member, provider: selection.provider, attemptId },
          attempt: { id: attemptId, taskId: task.id, member, provider: selection.provider, expiresAt },
        };
      }
      return null;
    });
  }

  /**
   * Read the next ready task for a role without claiming it. Used by the DSH
   * adapter to decide whether a task is suitable for automatic delegation.
   */
  peek({ role: roleId, now = this.nowIso() }) {
    this.role(roleId);
    const row = this.store.db.prepare(`
      SELECT * FROM tasks
      WHERE role = ? AND status = 'ready' AND (available_at IS NULL OR available_at <= ?)
      ORDER BY priority DESC, created_at ASC, id ASC
      LIMIT 1
    `).get(roleId, now);
    return row ? decodeTask(row) : null;
  }

  /**
   * Complete an attempt and advance its item. `outcome` selects the stage's
   * transition. A blocking gate after the stage pauses the item instead of
   * advancing it. Repeating the same call is a no-op.
   */
  complete({ attemptId, outcome = 'complete', result = {} }) {
    const requestId = `complete:${attemptId}:${outcome}`;
    if (this.store.findEventByRequestId(requestId)) return { status: 'duplicate', attemptId };

    const attempt = this.requireAttempt(attemptId);
    if (attempt.status !== 'running') {
      throw new EngineError('attempt_not_running', `attempt ${attemptId} is ${attempt.status}`, 'claim a new task');
    }
    const task = this.requireTask(attempt.task_id);
    this.assertAttemptOwnsTask(task, attemptId);
    const stage = this.stage(task.stage);
    if (!Object.hasOwn(stage.on, outcome)) {
      throw new EngineError(
        'unknown_outcome',
        `stage "${stage.id}" does not declare outcome "${outcome}"`,
        `expected one of: ${Object.keys(stage.on).join(', ') || 'none (terminal stage)'}`,
      );
    }
    const targetId = stage.on[outcome];
    const now = this.nowIso();
    const events = [
      this.attemptEnded(attemptId, 'completed', now),
      event('task.updated', 'task', task.id, { taskId: task.id, status: 'completed', result }, this.workflowId),
    ];

    const blocking = this.blockingGates(task.stage, task.item_id, outcome);
    if (blocking.length > 0) {
      const signal = { outcome, next: targetId };
      for (const gate of blocking) {
        events.push(event('gate.observed', 'gate', `${task.item_id}:${gate.id}`, {
          itemId: task.item_id,
          gate: gate.id,
          status: 'pending',
          signal,
        }, this.workflowId));
      }
      events.push(event('item.moved', 'item', task.item_id, {
        itemId: task.item_id,
        stage: task.stage,
        status: 'blocked',
      }, this.workflowId));
      this.store.appendMany(events, { requestId });
      return { status: 'gated', itemId: task.item_id, stage: task.stage, gates: blocking.map(gate => gate.id) };
    }

    const item = this.requireItem(task.item_id);
    const advanced = this.advanceEvents(item, targetId);
    this.store.appendMany([...events, ...advanced.events], { requestId });
    return {
      status: advanced.terminal ? 'done' : 'advanced',
      itemId: task.item_id,
      stage: targetId,
      ...(advanced.taskId ? { nextTaskId: advanced.taskId } : {}),
    };
  }

  /**
   * Report a failed attempt. The task is released for another attempt while the
   * retry budget allows, with the policy's backoff; otherwise it fails and its
   * item is blocked for a human decision.
   */
  fail({ attemptId, error = '', retryable = true, providerError = false }) {
    const requestId = `fail:${attemptId}`;
    if (this.store.findEventByRequestId(requestId)) return { status: 'duplicate', attemptId };

    const attempt = this.requireAttempt(attemptId);
    if (attempt.status !== 'running') {
      throw new EngineError('attempt_not_running', `attempt ${attemptId} is ${attempt.status}`);
    }
    const task = this.requireTask(attempt.task_id);
    this.assertAttemptOwnsTask(task, attemptId);
    const stage = this.stage(task.stage);
    const maxAttempts = stage.maxAttempts ?? this.definition.policies.retry.maxAttempts;
    const used = Number(this.store.db.prepare('SELECT COUNT(*) AS count FROM attempts WHERE task_id = ?').get(task.id).count);
    const now = this.nowIso();
    const providerFailure = Boolean(providerError) || inferProviderError(error);
    const events = [
      this.attemptEnded(attemptId, 'failed', now, error),
      event('task.updated', 'task', task.id, { taskId: task.id, status: 'failed', result: { error } }, this.workflowId),
    ];
    if (providerFailure && attempt.provider) {
      events.push(this.providerBlockedEvent(attempt.provider, now, error));
    }

    if ((retryable || providerFailure) && used < maxAttempts) {
      const backoffSeconds = providerFailure ? 0 : this.backoffSeconds(used);
      const availableAt = new Date(Date.parse(now) + backoffSeconds * 1000).toISOString();
      events[1] = event('task.updated', 'task', task.id, {
        taskId: task.id,
        status: 'ready',
        availableAt,
        result: { lastError: error },
      }, this.workflowId);
      this.store.appendMany(events, { requestId });
      return { status: 'retried', attemptId, attemptCount: used, maxAttempts, availableAt, backoffSeconds, providerFailure };
    }

    events.push(event('item.moved', 'item', task.item_id, {
      itemId: task.item_id,
      stage: task.stage,
      status: 'blocked',
    }, this.workflowId));
    this.store.appendMany(events, { requestId });
    return { status: 'failed', attemptId, attemptCount: used, maxAttempts, itemId: task.item_id, providerFailure };
  }

  /** Fail attempts whose lease has expired so their tasks can be claimed again. */
  expireLeases() {
    const now = this.nowIso();
    const rows = this.store.db.prepare(`
      SELECT * FROM attempts
      WHERE status = 'running' AND expires_at IS NOT NULL AND expires_at <= ?
      ORDER BY expires_at
    `).all(now);
    const results = [];
    for (const row of rows) {
      results.push({
        attemptId: row.id,
        ...this.fail({ attemptId: row.id, error: 'attempt lease expired', retryable: true }),
      });
    }
    return results;
  }

  /** Decide a pending gate. Approval advances the item once every blocking gate passed. */
  decideGate({ itemId, gate: gateId, decision, by = 'human', note = '' }) {
    if (decision !== 'approve' && decision !== 'reject') {
      throw new EngineError('invalid_decision', 'decision must be "approve" or "reject"');
    }
    const row = this.store.db.prepare('SELECT * FROM gates WHERE id = ?').get(`${itemId}:${gateId}`);
    if (!row) throw new EngineError('gate_not_found', `gate "${gateId}" is not pending for ${itemId}`, 'complete the stage first');
    if (row.status !== 'pending') throw new EngineError('gate_decided', `gate "${gateId}" is already ${row.status}`);
    const declared = this.definition.gates.find(gate => gate.id === gateId);
    const signal = parseJson(row.signal_json, {});
    const mergedSignal = { ...signal, decision, by, note, decidedAt: this.nowIso() };
    const item = this.requireItem(itemId);
    const events = [event('gate.observed', 'gate', row.id, {
      itemId,
      gate: gateId,
      status: decision === 'approve' ? 'approved' : 'rejected',
      signal: mergedSignal,
    }, this.workflowId)];

    if (decision === 'reject') {
      events.push(event('item.moved', 'item', itemId, {
        itemId,
        stage: item.stage,
        status: 'blocked',
      }, this.workflowId));
      this.store.appendMany(events, { requestId: `gate:${itemId}:${gateId}:reject` });
      return { status: 'rejected', itemId, gate: gateId };
    }

    const remaining = (declared ? this.blockingGates(item.stage, itemId, signal.outcome) : [])
      .filter(gate => gate.id !== gateId);
    if (remaining.length > 0) {
      this.store.appendMany(events, { requestId: `gate:${itemId}:${gateId}:approve` });
      return { status: 'waiting', itemId, gate: gateId, remaining: remaining.map(gate => gate.id) };
    }
    if (!mergedSignal.next) {
      throw new EngineError('gate_without_target', `gate "${gateId}" has no next stage recorded`, 're-complete the stage');
    }
    const advanced = this.advanceEvents(item, mergedSignal.next);
    this.store.appendMany([...events, ...advanced.events], { requestId: `gate:${itemId}:${gateId}:approve` });
    return {
      status: 'approved',
      itemId,
      gate: gateId,
      stage: mergedSignal.next,
      ...(advanced.taskId ? { nextTaskId: advanced.taskId } : {}),
    };
  }

  // --- internals -----------------------------------------------------------

  assertAdmission(role, member) {
    const globalLimit = this.definition.policies.concurrency.global;
    if (this.activeCount() >= globalLimit) {
      throw new EngineError('global_capacity', `global capacity ${globalLimit} is in use`, 'complete a running task first');
    }
    const roleLimit = role.instances * role.capacity;
    const roleActive = this.activeRoleCount(role.id);
    if (roleActive >= roleLimit) {
      throw new EngineError('role_capacity', `role "${role.id}" already has ${roleActive}/${roleLimit} active task(s)`, 'wait for the role to release a slot');
    }
    if (member !== null && this.activeMemberCount(member) >= role.capacity) {
      const held = this.activeMemberCount(member);
      throw new EngineError('member_capacity', `member "${member}" already holds ${held}/${role.capacity} task(s)`, 'complete a task or use another member');
    }
  }

  activeCount() {
    return Number(this.store.db.prepare(
      "SELECT COUNT(*) AS count FROM tasks WHERE status IN ('claimed','running')",
    ).get().count);
  }

  activeRoleCount(roleId) {
    return Number(this.store.db.prepare(
      "SELECT COUNT(*) AS count FROM tasks WHERE status IN ('claimed','running') AND role = ?",
    ).get(roleId).count);
  }

  activeMemberCount(member) {
    return Number(this.store.db.prepare(
      "SELECT COUNT(*) AS count FROM tasks WHERE status IN ('claimed','running') AND assignee = ?",
    ).get(member).count);
  }

  activeProviderCount(providerId) {
    return Number(this.store.db.prepare(
      "SELECT COUNT(*) AS count FROM tasks WHERE status IN ('claimed','running') AND provider = ?",
    ).get(providerId).count);
  }

  providerState(providerId) {
    return this.store.db.prepare('SELECT * FROM providers WHERE id = ?').get(providerId) ?? null;
  }

  /** A stage may narrow the role's provider pool; an empty pool inherits it. */
  providerPool(role, stage) {
    if (stage.providers.length > 0) return stage.providers;
    if (role.providers.length > 0) return role.providers;
    return this.definition.providers.map(provider => provider.id);
  }

  isProviderUsable(state, now) {
    if (!state) return true;
    if (state.health === 'ok') return true;
    if (state.health === 'blocked' && state.blocked_until) {
      return Date.parse(state.blocked_until) <= Date.parse(now);
    }
    return false;
  }

  assertProviderUsable(providerId, now) {
    const declared = this.definition.providers.find(provider => provider.id === providerId);
    if (!declared) {
      throw new EngineError('unknown_provider', `provider "${providerId}" is not declared`, 'declare it in the workflow definition');
    }
    const state = this.providerState(providerId);
    if (!this.isProviderUsable(state, now)) {
      throw new EngineError(
        'provider_blocked',
        `provider "${providerId}" is ${state.health}${state.reason ? `: ${state.reason}` : ''}`,
        'claim with another provider of the same role',
      );
    }
    if (this.activeProviderCount(providerId) >= declared.concurrency) {
      throw new EngineError(
        'provider_capacity',
        `provider "${providerId}" is at ${this.activeProviderCount(providerId)}/${declared.concurrency}`,
        'wait for a lane slot',
      );
    }
  }

  /**
   * Pick a lane for one task. An explicit request is validated, never silently
   * replaced; an automatic pick is the least-loaded healthy lane in the pool.
   * Returns null when no lane is eligible (the caller tries the next task).
   */
  selectProvider({ role, stage, requested, now }) {
    const pool = this.providerPool(role, stage);
    if (pool.length === 0) {
      if (requested !== null) {
        throw new EngineError('provider_not_allowed', `provider "${requested}" is not declared for stage "${stage.id}"`);
      }
      return { provider: null };
    }
    if (requested !== null) {
      this.assertProviderUsable(requested, now);
      return { provider: requested };
    }
    const candidates = [];
    for (const id of pool) {
      if (!this.isProviderUsable(this.providerState(id), now)) continue;
      const declared = this.definition.providers.find(provider => provider.id === id);
      const active = this.activeProviderCount(id);
      if (declared && active >= declared.concurrency) continue;
      candidates.push({ id, active });
    }
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => a.active - b.active || a.id.localeCompare(b.id));
    return { provider: candidates[0].id };
  }

  /** A provider-class failure parks the lane so the next claim picks another. */
  providerBlockedEvent(providerId, now, error) {
    const declared = this.definition.providers.find(provider => provider.id === providerId);
    const schedule = declared?.backoffMinutes?.length
      ? declared.backoffMinutes
      : this.definition.policies.provider.backoffMinutes;
    const minutes = schedule[0] ?? 10;
    const blockedUntil = new Date(Date.parse(now) + minutes * 60_000).toISOString();
    return event('provider.health', 'provider', providerId, {
      providerId,
      health: 'blocked',
      blockedUntil,
      reason: error || 'provider error',
    }, this.workflowId);
  }

  createTask(item) {
    if (!item || !item.id) throw new EngineError('invalid_item', 'an item id is required');
    const stage = this.stage(item.stage);
    const taskId = `task-${randomUUID()}`;
    return {
      taskId,
      events: [event('task.created', 'task', taskId, {
        taskId,
        itemId: item.id,
        stage: stage.id,
        role: stage.role,
        status: 'ready',
        priority: item.priority ?? 0,
        dependencies: [],
        contract: {
          itemId: item.id,
          title: item.title,
          stage: stage.id,
          role: stage.role,
          requires: stage.requires,
          input: item.data ?? {},
        },
      }, this.workflowId)],
    };
  }

  advanceEvents(item, targetId) {
    const target = this.stage(targetId);
    const terminal = Object.keys(target.on).length === 0;
    const events = [event('item.moved', 'item', item.id, {
      itemId: item.id,
      stage: targetId,
      status: terminal ? 'done' : 'active',
    }, this.workflowId)];
    if (terminal) return { events, taskId: null, terminal: true };
    const created = this.createTask({ ...item, stage: targetId });
    events.push(...created.events);
    return { events, taskId: created.taskId, terminal: false };
  }

  blockingGates(stageId, itemId, outcome) {
    return this.definition.gates
      .filter(gate => gate.after === stageId && gate.required)
      .filter(gate => gate.outcome === null || gate.outcome === outcome)
      .map(gate => ({
        ...gate,
        row: this.store.db.prepare('SELECT * FROM gates WHERE id = ?').get(`${itemId}:${gate.id}`),
      }));
  }

  attemptEnded(attemptId, status, at, error = null) {
    return event('attempt.ended', 'attempt', attemptId, {
      attemptId,
      status,
      endedAt: at,
      ...(error ? { error } : {}),
    }, this.workflowId);
  }

  backoffSeconds(attemptCount) {
    const schedule = this.definition.policies.retry.backoffSeconds;
    if (schedule.length === 0) return 0;
    return schedule[Math.min(attemptCount - 1, schedule.length - 1)];
  }

  assertAttemptOwnsTask(task, attemptId) {
    if (task.attempt_id !== attemptId) {
      throw new EngineError('stale_attempt', `attempt ${attemptId} no longer owns task ${task.id}`, 'claim a new task');
    }
  }

  stage(id) {
    const stage = this.definition.stages.find(candidate => candidate.id === id);
    if (!stage) throw new EngineError('unknown_stage', `stage "${id}" is not declared`);
    return stage;
  }

  role(id) {
    const role = this.definition.roles.find(candidate => candidate.id === id);
    if (!role) throw new EngineError('unknown_role', `role "${id}" is not declared`);
    return role;
  }

  requireAttempt(id) {
    const row = this.store.db.prepare('SELECT * FROM attempts WHERE id = ?').get(id);
    if (!row) throw new EngineError('attempt_not_found', `attempt ${id} does not exist`);
    return row;
  }

  requireTask(id) {
    const row = this.store.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
    if (!row) throw new EngineError('task_not_found', `task ${id} does not exist`);
    return row;
  }

  requireItem(id) {
    const row = this.store.db.prepare('SELECT * FROM items WHERE id = ?').get(id);
    if (!row) throw new EngineError('item_not_found', `item ${id} does not exist`);
    return {
      id: row.id,
      kind: row.kind,
      title: row.title,
      stage: row.stage,
      status: row.status,
      priority: row.priority,
      data: parseJson(row.data_json, {}),
    };
  }
}

function event(type, entity, entityId, payload, workflowId) {
  return { type, entity, entityId, payload, workflowId };
}

function decodeTask(row) {
  return {
    id: row.id,
    itemId: row.item_id,
    stage: row.stage,
    role: row.role,
    status: row.status,
    priority: row.priority,
    provider: row.provider,
    assignee: row.assignee,
    attemptId: row.attempt_id,
    dependencies: parseJson(row.dependencies_json, []),
    contract: parseJson(row.contract_json, {}),
    availableAt: row.available_at ?? null,
    createdAt: row.created_at,
  };
}

function parseJson(value, fallback) {
  if (value === null || value === undefined) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

const PROVIDER_ERROR_PATTERN = /\b(?:429|402|403|408|500|502|503|504)\b|quota|rate.?limit|insufficient|balance|overloaded|timed? ?out|ECONNRESET|ETIMEDOUT|ENOTFOUND/i;

/** Best-effort classification for a provider-side failure. */
export function inferProviderError(message) {
  return typeof message === 'string' && PROVIDER_ERROR_PATTERN.test(message);
}
