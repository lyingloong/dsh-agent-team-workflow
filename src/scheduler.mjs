/**
 * Deterministic scheduler.
 *
 * `planDispatch()` is a pure function over a snapshot: given role slots, provider
 * health and ready tasks, it returns the assignments a coordinator should make.
 * It never invents work: when nothing is ready, the result is empty.
 *
 * `simulate()` runs that planner over synthetic tasks so the scheduling rules can
 * be tested without a host, a model or a clock.
 */

/** Task states that occupy a role slot and provider capacity right now. */
export const ACTIVE_TASK_STATES = new Set(['claimed', 'running']);
export const TERMINAL_TASK_STATES = new Set(['completed', 'failed', 'cancelled']);

/** Build one slot per member capacity unit; coordinator roles take no tasks. */
export function buildSlots(definition) {
  const slots = [];
  for (const role of definition.roles) {
    if (role.kind === 'coordinator') continue;
    const providers = role.providers.length > 0 ? role.providers : definition.providers.map(provider => provider.id);
    for (let member = 1; member <= role.instances; member += 1) {
      const provider = providers.length > 0 ? providers[(member - 1) % providers.length] : null;
      for (let unit = 1; unit <= role.capacity; unit += 1) {
        slots.push({
          id: `${role.id}-${member}-${unit}`,
          role: role.id,
          provider,
          member: `${role.id}-${member}`,
          status: 'idle',
          taskId: null,
        });
      }
    }
  }
  return slots;
}

/**
 * Decide which ready tasks get which idle slots.
 *
 * @param {object} input
 * @param {object} input.definition normalized workflow definition
 * @param {Array<{id:string, health:string, blockedUntil?:string|null}>} [input.providers]
 * @param {Array<{id:string, role:string, provider:string|null, member:string, status:string, taskId?:string|null}>} [input.slots]
 * @param {Array<{id:string, role:string, status:string, priority?:number, provider?:string|null, createdAt?:string}>} [input.tasks]
 * @param {string} [input.now] ISO timestamp used to expire blocked windows
 */
export function planDispatch({ definition, providers = [], slots = [], tasks = [], now = new Date().toISOString() }) {
  const providerById = new Map(definition.providers.map(provider => [provider.id, provider]));
  const healthById = new Map(providers.map(provider => [provider.id, provider]));
  const roleIds = new Set(definition.roles.map(role => role.id));
  const warnings = [];
  const nowMs = Date.parse(now);

  const usable = providerId => {
    if (!providerId) return true;
    const state = healthById.get(providerId);
    if (!state) return true;
    if (state.health === 'ok') return true;
    if (state.health === 'blocked' && state.blockedUntil) {
      const until = Date.parse(state.blockedUntil);
      return Number.isFinite(until) && until <= nowMs;
    }
    return false;
  };

  for (const provider of providers) {
    if (provider.health === 'degraded') {
      warnings.push({ code: 'provider_degraded', providerId: provider.id, message: `provider ${provider.id} is degraded; no new dispatch` });
    } else if (provider.health === 'blocked' && !usable(provider.id)) {
      warnings.push({ code: 'provider_blocked', providerId: provider.id, message: `provider ${provider.id} is blocked${provider.reason ? `: ${provider.reason}` : ''}` });
    }
  }

  const capacityOf = providerId => {
    const provider = providerById.get(providerId);
    return provider?.concurrency ?? Number.POSITIVE_INFINITY;
  };

  const runningByProvider = new Map();
  let active = 0;
  for (const task of tasks) {
    if (!ACTIVE_TASK_STATES.has(task.status)) continue;
    active += 1;
    const key = task.provider ?? null;
    runningByProvider.set(key, (runningByProvider.get(key) ?? 0) + 1);
  }

  const globalLimit = definition.policies.concurrency.global;
  const ready = tasks
    .filter(task => task.status === 'ready')
    .sort(compareTasks);
  const idleSlots = slots
    .filter(slot => slot.status === 'idle')
    .sort(compareSlots);
  const assignedSlotIds = new Set();
  const assignments = [];
  const waiting = [];
  const unknownRoles = new Set();

  for (const task of ready) {
    if (!roleIds.has(task.role)) {
      if (!unknownRoles.has(task.role)) {
        unknownRoles.add(task.role);
        warnings.push({ code: 'unknown_role', role: task.role, message: `task ${task.id} names unknown role "${task.role}"` });
      }
      waiting.push({ taskId: task.id, reason: 'unknown_role' });
      continue;
    }
    if (active >= globalLimit) {
      waiting.push({ taskId: task.id, reason: 'global_capacity' });
      continue;
    }
    const candidates = idleSlots.filter(slot => {
      if (assignedSlotIds.has(slot.id)) return false;
      if (slot.role !== task.role) return false;
      if (!usable(slot.provider)) return false;
      return (runningByProvider.get(slot.provider ?? null) ?? 0) < capacityOf(slot.provider);
    });
    if (candidates.length === 0) {
      waiting.push({ taskId: task.id, reason: 'no_slot' });
      continue;
    }

    let chosen = null;
    let fallbackFrom = null;
    if (task.provider) {
      chosen = candidates.find(slot => slot.provider === task.provider) ?? null;
      if (!chosen && definition.policies.fallback.sameRole) {
        chosen = candidates[0];
        fallbackFrom = task.provider;
      }
    } else {
      chosen = candidates[0];
    }
    if (!chosen) {
      waiting.push({ taskId: task.id, reason: 'provider_unavailable' });
      continue;
    }

    assignedSlotIds.add(chosen.id);
    active += 1;
    const key = chosen.provider ?? null;
    runningByProvider.set(key, (runningByProvider.get(key) ?? 0) + 1);
    assignments.push({
      taskId: task.id,
      slotId: chosen.id,
      role: task.role,
      provider: chosen.provider,
      member: chosen.member,
      ...(fallbackFrom ? { fallbackFrom } : {}),
    });
  }

  if (slots.length === 0) {
    warnings.push({ code: 'no_slots', message: 'definition declares no worker or reviewer capacity' });
  }

  return { assignments, waiting, warnings, active, capacity: globalLimit };
}

/**
 * Run the planner over synthetic tasks for a number of ticks.
 *
 * Providers, tasks and slots are plain objects, so a test (or a dry run) can
 * script health changes with `onTick` without touching a database or a host.
 */
export function simulate({
  definition,
  providers = [],
  tasks = [],
  ticks = 20,
  stepMs = 60_000,
  startAt = '2026-01-01T00:00:00.000Z',
  defaultDurationMs = 120_000,
  onTick,
} = {}) {
  const slots = buildSlots(definition).map(slot => ({ ...slot }));
  const state = tasks.map(task => ({
    id: task.id,
    role: task.role,
    priority: task.priority ?? 0,
    provider: task.provider ?? null,
    createdAt: task.createdAt ?? startAt,
    durationMs: task.durationMs ?? defaultDurationMs,
    status: 'ready',
    finishAt: null,
  }));
  const startMs = Date.parse(startAt);
  const trace = [];
  const completed = [];
  let tick = 0;
  for (; tick < ticks; tick += 1) {
    const now = new Date(startMs + tick * stepMs).toISOString();
    const completedNow = [];
    for (const slot of slots) {
      if (slot.status !== 'busy') continue;
      const task = state.find(candidate => candidate.id === slot.taskId);
      if (!task || task.finishAt === null) continue;
      if (Date.parse(task.finishAt) <= Date.parse(now)) {
        task.status = 'completed';
        completed.push(task.id);
        completedNow.push(task.id);
        slot.status = 'idle';
        slot.taskId = null;
      }
    }
    onTick?.({ tick, now, providers, tasks: state, slots });
    const plan = planDispatch({ definition, providers, slots, tasks: state, now });
    for (const assignment of plan.assignments) {
      const task = state.find(candidate => candidate.id === assignment.taskId);
      const slot = slots.find(candidate => candidate.id === assignment.slotId);
      task.status = 'running';
      task.provider = assignment.provider;
      task.finishAt = new Date(Date.parse(now) + task.durationMs).toISOString();
      slot.status = 'busy';
      slot.taskId = task.id;
    }
    trace.push({
      tick,
      now,
      assigned: plan.assignments.map(assignment => ({
        taskId: assignment.taskId,
        slotId: assignment.slotId,
        role: assignment.role,
        provider: assignment.provider,
        ...(assignment.fallbackFrom ? { fallbackFrom: assignment.fallbackFrom } : {}),
      })),
      completed: completedNow,
      active: plan.active,
      waiting: plan.waiting.map(entry => entry.taskId),
      warnings: plan.warnings,
    });
    if (state.every(task => TERMINAL_TASK_STATES.has(task.status))) break;
  }
  return {
    trace,
    completed,
    unresolved: state.filter(task => !TERMINAL_TASK_STATES.has(task.status)).map(task => task.id),
    ticksRun: tick + 1,
  };
}

function compareTasks(a, b) {
  const priority = (b.priority ?? 0) - (a.priority ?? 0);
  if (priority !== 0) return priority;
  const created = String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? ''));
  if (created !== 0) return created;
  return a.id.localeCompare(b.id);
}

function compareSlots(a, b) {
  const provider = String(a.provider ?? '').localeCompare(String(b.provider ?? ''));
  if (provider !== 0) return provider;
  return a.id.localeCompare(b.id);
}
