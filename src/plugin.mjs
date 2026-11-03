/**
 * DSH host adapter for agent-team-workflow.
 *
 * Registers the model-facing `team_workflow_*` tools and one usage section into
 * the host system prompt. The tools translate a user's natural-language team
 * description into the engine's workflow definition, then expose the durable
 * board, gates and pull-mode task lifecycle.
 *
 * This module imports no DSH package on purpose: it must load inside the host
 * process without requiring the harness package graph to be reachable from the
 * plugin directory. Everything host-specific goes through `ctx` services.
 *
 * `team_workflow_delegate` uses `ctx.subagents.startActivation` when the host
 * mounts a subagent provider; without one the rest of the tools still work and
 * external workers can pull tasks through `team_workflow_claim`.
 */

import path from 'node:path';
import { existsSync } from 'node:fs';

import { DefinitionError, describeDefinition, normalizeDefinition } from './definition.mjs';
import { Engine, inferProviderError } from './engine.mjs';
import { Store } from './store.mjs';
import { acquireLock } from './lock.mjs';
import { dataPaths, ensureDataDir } from './paths.mjs';
import { buildBoardData } from './board/data.mjs';
import { startBoardServer } from './board/server.mjs';

export const name = 'agent-team-workflow';
export const inject = ['tools', 'systemPrompt'];

const DEFAULT_CONFIG = {
  stateDir: '.agent-team-workflow',
  boardPort: 7171,
  autoBoard: true,
  subagentProvider: 'spawn',
  promptSectionOrder: 118,
};

const USAGE = `Agent Team Workflow provides a user-defined, resumable workflow for this workspace.

When the user describes a team or an automated workflow in natural language ("创建一个自动开发的工作流，一个人负责需求，一个人负责实现，一个人负责审查"), translate it into a workflow definition and call team_workflow_define. Do not ask the user to write JSON.

Definition rules:
- roles[]: {id, kind: worker|reviewer|coordinator, instances, capacity, providers[]}. A role is a reusable worker type; instances × capacity is its concurrency.
- providers[]: {id, model, concurrency, backoffMinutes[]}. A lane is one model account or route; roles and stages reference lanes by id.
- stages[]: {id, role, title, options[], on: {outcome: nextStage}}. A stage without on is terminal. entry defaults to the first stage; every stage must be reachable and at least one terminal stage is required.
- A stage may narrow its role's lane pool with providers[].
- gates[]: {id, after, outcome?, kind: manual|external, required}. A gate pauses the item after that stage/outcome. It never merges, closes or pushes anything.
- policies: concurrency.global, retry.maxAttempts/backoffSeconds, fallback.sameRole.
- A provider error (429, quota, rate limit, timeout) is reported through team_workflow_fail with providerError=true (or inferred from the message); that lane parks for its backoff and the task retries on another lane.

Defining:
1. Call team_workflow_define with the complete definition.
2. If it returns validation errors, fix the exact JSON paths and retry once. Report the error instead of silently simplifying the flow.
3. Report the summary and the board URL. Do not enqueue work or start execution until the user asks.

Running:
- team_workflow_status and team_workflow_plan show the projected state and ready tasks.
- team_workflow_delegate claims one ready task whose stage has a single outcome, spawns a subagent to do it, and records the result when it settles. Call it again for the next task; do not spawn more tasks than the engine reports ready.
- Workers outside DSH use team_workflow_claim, then team_workflow_complete or team_workflow_fail with the attempt id.
- Decide gates with team_workflow_gate. Never invent tasks, and never bypass role/provider capacity.`;

/**
 * Install the plugin. Safe to call with a host context that has only `tools`
 * and `systemPrompt`; the subagent and logger services are optional.
 * @param {object} ctx - Cordis host context.
 * @param {object} [config] - profile/extension configuration.
 */
export function apply(ctx, config = {}) {
  const settings = resolveSettings(config);
  const boards = new Map();
  const activations = new Set();

  const logger = ctx.logger ?? { warn() {}, info() {} };
  const subagentsOf = () => (typeof ctx.get === 'function' ? ctx.get('subagents') : ctx.subagents);

  const workspaceOf = exec => {
    const cwd = exec?.agent?.session?.header?.cwd;
    return typeof cwd === 'string' && cwd !== '' ? cwd : process.cwd();
  };

  const stateDirOf = cwd => path.resolve(cwd, settings.stateDir);

  function openWorkspace(cwd) {
    const dataDir = stateDirOf(cwd);
    const paths = dataPaths(dataDir);
    if (!existsSync(paths.dbPath)) {
      throw new Error(`no workflow is defined in ${dataDir}; call team_workflow_define first`);
    }
    const store = Store.open(paths.dbPath);
    try {
      const snapshot = store.snapshot();
      if (!snapshot.workflow) {
        throw new Error(`no workflow is defined in ${dataDir}; call team_workflow_define first`);
      }
      const definition = normalizeDefinition(snapshot.workflow.definition);
      const engine = new Engine({ store, definition, workflowId: snapshot.workflow.id });
      return { store, snapshot, definition, engine, paths };
    } catch (error) {
      store.close();
      throw error;
    }
  }

  function withWorkspace(cwd, fn) {
    const workspace = openWorkspace(cwd);
    try {
      return fn(workspace);
    } finally {
      workspace.store.close();
    }
  }

  async function boardFor(cwd, port = settings.boardPort, { restart = false } = {}) {
    const dataDir = stateDirOf(cwd);
    const existing = boards.get(dataDir);
    if (existing && !restart) {
      return { url: await existing.ready, alreadyRunning: true };
    }
    if (existing) {
      boards.delete(dataDir);
      await existing.close().catch(() => {});
    }
    let board = startBoardServer({ dataDir, port });
    let url;
    try {
      url = await board.ready;
    } catch (error) {
      await board.close().catch(() => {});
      if (error?.code !== 'EADDRINUSE' || port === 0) throw error;
      board = startBoardServer({ dataDir, port: 0 });
      url = await board.ready;
    }
    board.url = url;
    boards.set(dataDir, board);
    return { url, alreadyRunning: false };
  }

  function register(tool) {
    // Registration is effect-based: the owning fiber unregisters the tool when
    // the plugin unloads, so no manual disposer list is needed.
    ctx.tools.register(tool);
  }

  // --- tools ---------------------------------------------------------------

  register(toolDefine({
    workspaceOf,
    logger,
    settings,
    define: async (exec, rawDefinition) => {
      const cwd = workspaceOf(exec);
      let raw = rawDefinition;
      if (typeof raw === 'string') {
        try {
          raw = JSON.parse(raw);
        } catch (error) {
          return { ok: false, errors: [{ path: 'definition', message: `not valid JSON: ${error.message}` }] };
        }
      }
      let definition;
      try {
        definition = normalizeDefinition(raw);
      } catch (error) {
        if (error instanceof DefinitionError) return { ok: false, errors: error.errors };
        throw error;
      }
      const paths = ensureDataDir(stateDirOf(cwd));
      const lock = acquireLock({ dataDir: paths.dataDir });
      try {
        const store = Store.open(paths.dbPath);
        try {
          store.append({
            type: 'workflow.defined',
            entity: 'workflow',
            entityId: 'default',
            workflowId: 'default',
            payload: { workflowId: 'default', name: definition.name, definition: raw },
          });
        } finally {
          store.close();
        }
      } finally {
        lock.release();
      }
      let boardUrl;
      if (settings.autoBoard) {
        try {
          boardUrl = (await boardFor(cwd, settings.boardPort, { restart: true })).url;
        } catch (error) {
          logger.warn(`agent-team-workflow: board did not start: ${error.message}`);
        }
      }
      return {
        ok: true,
        name: definition.name,
        entry: definition.entry,
        summary: describeDefinition(definition),
        ...(boardUrl ? { boardUrl } : {}),
      };
    },
  }));

  register(toolStatus({
    workspaceOf,
    stateDirOf,
    boards,
    openWorkspace,
    withWorkspace,
  }));

  register(toolBoard({
    workspaceOf,
    settings,
    boardFor,
    withWorkspace,
  }));

  register(toolEnqueue({ workspaceOf, withWorkspace }));
  register(toolGate({ workspaceOf, withWorkspace }));
  register(toolClaim({ workspaceOf, withWorkspace }));
  register(toolComplete({ workspaceOf, withWorkspace }));
  register(toolFail({ workspaceOf, withWorkspace }));
  register(toolPlan({ workspaceOf, withWorkspace }));

  register(toolDelegate({
    workspaceOf,
    settings,
    subagentsOf,
    activations,
    logger,
    withWorkspace,
  }));

  // --- usage section -------------------------------------------------------

  try {
    ctx.systemPrompt.section({
      name: 'agent-team-workflow:usage',
      order: settings.promptSectionOrder,
      text: USAGE,
    });
  } catch (error) {
    logger.warn(`agent-team-workflow: could not install the usage section: ${error.message}`);
  }

  // --- lifecycle -----------------------------------------------------------

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      for (const board of boards.values()) {
        board.close().catch(() => {});
      }
      boards.clear();
      for (const activation of activations) {
        Promise.resolve(activation.dispose?.()).catch(() => {});
      }
      activations.clear();
    }, 'agent-team-workflow: resources');
  }
}

// --- tool definitions ------------------------------------------------------

function toolDefine({ workspaceOf, logger, settings, define }) {
  return {
    name: 'team_workflow_define',
    description: 'Create or replace this workspace\'s workflow definition from a complete JSON definition. Use this when the user describes a team or automated workflow in natural language: translate their description into roles, stages, gates and provider lanes, then pass the whole definition. Validation errors are returned with JSON paths so you can fix them. Auto-starts the local board unless the host disabled it.',
    parameters: objectSchema({
      definition: freeObject('Complete workflow definition JSON. See the usage section for the schema.'),
    }, ['definition']),
    output: {
      schema: objectSchema({
        ok: booleanSchema(),
        name: stringSchema(),
        entry: stringSchema(),
        summary: stringSchema(),
        boardUrl: stringSchema(),
        errors: {
          type: 'array',
          items: objectSchema({
            path: stringSchema(),
            message: stringSchema(),
          }, ['path', 'message']),
        },
      }, ['ok']),
      render: (_args, value) => [{
        type: 'text',
        text: value.ok
          ? `Defined "${value.name}" (entry: ${value.entry}).${value.boardUrl ? ` Board: ${value.boardUrl}` : ''}\n\n${value.summary ?? ''}`
          : `Definition rejected:\n${(value.errors ?? []).map(error => `- ${error.path}: ${error.message}`).join('\n')}`,
      }],
    },
    async execute(args, exec) {
      if (args?.definition === undefined) throw new Error('definition is required');
      try {
        return await define(exec, args.definition);
      } catch (error) {
        if (error instanceof DefinitionError) return { ok: false, errors: error.errors };
        throw error;
      }
    },
  };
}

function toolStatus({ workspaceOf, boards, withWorkspace }) {
  return {
    name: 'team_workflow_status',
    description: 'Show the workflow\'s projected state: counts, stage columns, provider lane health, pending gates and the board URL. Use it after defining or after delegating work.',
    parameters: objectSchema({}),
    output: {
      schema: objectSchema({
        defined: booleanSchema(),
        name: stringSchema(),
        entry: stringSchema(),
        counts: freeObject('Item, task and gate counts.'),
        columns: {
          type: 'array',
          items: objectSchema({
            id: stringSchema(),
            title: stringSchema(),
            role: stringSchema(),
            count: integerSchema(),
          }, ['id', 'title', 'role', 'count']),
        },
        providers: {
          type: 'array',
          items: objectSchema({
            id: stringSchema(),
            model: stringSchema(),
            health: stringSchema(),
            active: integerSchema(),
            concurrency: integerSchema(),
            blockedUntil: stringSchema(),
          }, ['id', 'health', 'active']),
        },
        pendingGates: {
          type: 'array',
          items: objectSchema({
            itemId: stringSchema(),
            itemTitle: stringSchema(),
            gate: stringSchema(),
          }, ['itemId', 'itemTitle', 'gate']),
        },
        boardUrl: stringSchema(),
      }, ['defined']),
      render: (_args, value) => [{
        type: 'text',
        text: value.defined
          ? [
              `Workflow "${value.name}" (entry: ${value.entry})`,
              `items ${value.counts?.items ?? 0}, active ${value.counts?.active ?? 0}, blocked ${value.counts?.blocked ?? 0}, done ${value.counts?.done ?? 0}`,
              `tasks running ${value.counts?.tasksRunning ?? 0}/${value.counts?.capacity ?? '?'}, waiting gates ${value.counts?.pendingGates ?? 0}`,
              `columns: ${(value.columns ?? []).map(column => `${column.id}(${column.count})`).join(' -> ')}`,
              `lanes: ${(value.providers ?? []).map(provider => `${provider.id} ${provider.health} ${provider.active}/${provider.concurrency ?? '?'}`).join(', ') || 'none'}`,
              ...(value.pendingGates?.length ? [`pending decisions: ${value.pendingGates.map(gate => `${gate.itemTitle}/${gate.gate}`).join(', ')}`] : []),
              ...(value.boardUrl ? [`board: ${value.boardUrl}`] : []),
            ].join('\n')
          : 'No workflow defined in this workspace yet. Call team_workflow_define.',
      }],
    },
    async execute(_args, exec) {
      const cwd = workspaceOf(exec);
      try {
        return withWorkspace(cwd, ({ store, definition, paths }) => {
          const board = boards.get(paths.dataDir);
          const data = buildBoardData({ snapshot: store.snapshot(), definition });
          return {
            defined: true,
            name: definition.name,
            entry: definition.entry,
            counts: data.counts,
            columns: data.columns.map(column => ({
              id: column.id,
              title: column.title,
              role: column.role,
              count: column.items.length,
            })),
            providers: data.providers.map(provider => ({
              id: provider.id,
              ...(provider.model ? { model: provider.model } : {}),
              health: provider.health,
              active: provider.active,
              ...(provider.concurrency !== null ? { concurrency: provider.concurrency } : {}),
              ...(provider.blockedUntil ? { blockedUntil: provider.blockedUntil } : {}),
            })),
            pendingGates: data.pendingGates.map(gate => ({
              itemId: gate.itemId,
              itemTitle: gate.itemTitle,
              gate: gate.gate,
            })),
            ...(board?.url ? { boardUrl: board.url } : {}),
          };
        });
      } catch (error) {
        if (/no workflow is defined/.test(error.message)) return { defined: false };
        throw error;
      }
    },
  };
}

function toolBoard({ workspaceOf, boardFor, withWorkspace }) {
  return {
    name: 'team_workflow_board',
    description: 'Start (or return) the local kanban board for this workspace and return its URL. The board is loopback-only and can approve/reject gates; it never merges or closes anything.',
    parameters: objectSchema({
      port: integerSchema('Optional explicit port; defaults to the configured port, then an ephemeral port if that one is busy.'),
    }),
    output: {
      schema: objectSchema({
        url: stringSchema(),
        alreadyRunning: booleanSchema(),
      }, ['url', 'alreadyRunning']),
      render: (_args, value) => [{ type: 'text', text: `Board: ${value.url}` }],
    },
    async execute(args, exec) {
      const cwd = workspaceOf(exec);
      const port = Number.isInteger(args?.port) && args.port >= 0 ? args.port : undefined;
      // Surface the actionable "define first" error instead of a board boot failure.
      withWorkspace(cwd, () => undefined);
      const result = await boardFor(cwd, port);
      return { url: result.url, alreadyRunning: result.alreadyRunning };
    },
  };
}

function toolEnqueue({ workspaceOf, withWorkspace }) {
  return {
    name: 'team_workflow_enqueue',
    description: 'Create one item at the workflow entry stage. The item immediately becomes a ready task for the entry role. Only enqueue work the user asked for.',
    parameters: objectSchema({
      title: stringSchema('Short title shown on the board.'),
      input: freeObject('Optional task input carried into the stage contract.'),
      priority: integerSchema('Higher runs first; default 0.'),
    }, ['title']),
    output: {
      schema: objectSchema({
        itemId: stringSchema(),
        taskId: stringSchema(),
        stage: stringSchema(),
      }, ['itemId', 'taskId', 'stage']),
      render: (_args, value) => [{ type: 'text', text: `Enqueued ${value.itemId} at ${value.stage} (task ${value.taskId}).` }],
    },
    async execute(args, exec) {
      const title = requireString(args?.title, 'title');
      const input = args?.input ?? {};
      if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('input must be a JSON object');
      const priority = args?.priority ?? 0;
      if (!Number.isInteger(priority)) throw new Error('priority must be an integer');
      const cwd = workspaceOf(exec);
      return withWorkspace(cwd, ({ engine }) => engine.enqueue({ title, data: input, priority }));
    },
  };
}

function toolGate({ workspaceOf, withWorkspace }) {
  return {
    name: 'team_workflow_gate',
    description: 'Approve or reject one pending gate. This records the decision and advances (approve) or blocks (reject) the item. It never merges, closes or pushes.',
    parameters: objectSchema({
      itemId: stringSchema(),
      gate: stringSchema('Gate id from pendingGates or the board.'),
      decision: { type: 'string', enum: ['approve', 'reject'], description: 'approve or reject' },
      note: stringSchema('Optional decision note.'),
    }, ['itemId', 'gate', 'decision']),
    output: {
      schema: objectSchema({
        status: stringSchema(),
        itemId: stringSchema(),
        gate: stringSchema(),
        stage: stringSchema(),
        remaining: { type: 'array', items: stringSchema() },
      }, ['status', 'itemId', 'gate']),
      render: (_args, value) => [{
        type: 'text',
        text: `Gate ${value.gate} ${value.status} for ${value.itemId}${value.stage ? ` (now at ${value.stage})` : ''}${value.remaining ? `; still waiting on ${value.remaining.join(', ')}` : ''}.`,
      }],
    },
    async execute(args, exec) {
      const cwd = workspaceOf(exec);
      const decided = withWorkspace(cwd, ({ engine }) => engine.decideGate({
        itemId: requireString(args?.itemId, 'itemId'),
        gate: requireString(args?.gate, 'gate'),
        decision: requireString(args?.decision, 'decision'),
        by: 'dsh',
        note: typeof args?.note === 'string' ? args.note : '',
      }));
      return {
        status: decided.status,
        itemId: decided.itemId,
        gate: decided.gate,
        ...(decided.stage ? { stage: decided.stage } : {}),
        ...(decided.remaining ? { remaining: decided.remaining } : {}),
      };
    },
  };
}

function toolClaim({ workspaceOf, withWorkspace }) {
  return {
    name: 'team_workflow_claim',
    description: 'Claim the next ready task for a role. Returns the task contract and an attempt id; only that attempt can complete or fail it. The engine enforces role, member, global and lane capacity. Use this from a worker session that is not delegated by team_workflow_delegate.',
    parameters: objectSchema({
      role: stringSchema('Role id from the workflow definition.'),
      member: stringSchema('Stable worker name, e.g. engineer-1.'),
      provider: stringSchema('Optional lane id; omit to let the engine pick the least-loaded healthy lane.'),
    }, ['role']),
    output: {
      schema: objectSchema({
        claimed: booleanSchema(),
        taskId: stringSchema(),
        itemId: stringSchema(),
        attemptId: stringSchema(),
        stage: stringSchema(),
        role: stringSchema(),
        expiresAt: stringSchema(),
        contract: freeObject('Task contract passed to the worker.'),
      }, ['claimed']),
      render: (_args, value) => [{
        type: 'text',
        text: value.claimed
          ? `Claimed ${value.taskId} (${value.stage}) for ${value.role}; attempt ${value.attemptId} expires ${value.expiresAt}.`
          : 'No ready task for that role.',
      }],
    },
    async execute(args, exec) {
      const role = requireString(args?.role, 'role');
      const member = args?.member === undefined ? `${role}-dsh` : requireString(args.member, 'member');
      const provider = args?.provider === undefined ? null : requireString(args.provider, 'provider');
      const cwd = workspaceOf(exec);
      return withWorkspace(cwd, ({ engine }) => {
        const claimed = engine.claim({ role, member, provider });
        if (!claimed) return { claimed: false };
        return {
          claimed: true,
          taskId: claimed.task.id,
          itemId: claimed.task.itemId,
          attemptId: claimed.attempt.id,
          stage: claimed.task.stage,
          role: claimed.task.role,
          expiresAt: claimed.attempt.expiresAt,
          contract: claimed.task.contract,
        };
      });
    },
  };
}

function toolComplete({ workspaceOf, withWorkspace }) {
  return {
    name: 'team_workflow_complete',
    description: 'Complete a claimed attempt with one of its stage\'s declared outcomes. This records the result, and either advances the item (creating the next task), pauses it on a gate, or finishes it. Repeating the same call is a no-op.',
    parameters: objectSchema({
      attemptId: stringSchema(),
      outcome: stringSchema('Stage outcome; defaults to "complete".'),
      result: freeObject('Optional result carried into the task record.'),
    }, ['attemptId']),
    output: {
      schema: objectSchema({
        status: stringSchema(),
        itemId: stringSchema(),
        stage: stringSchema(),
        nextTaskId: stringSchema(),
        gates: { type: 'array', items: stringSchema() },
      }, ['status']),
      render: (_args, value) => [{
        type: 'text',
        text: value.status === 'advanced'
          ? `Item ${value.itemId} moved to ${value.stage} (next task ${value.nextTaskId}).`
          : value.status === 'gated'
            ? `Item ${value.itemId} is waiting on gate(s): ${(value.gates ?? []).join(', ')}.`
            : value.status === 'done'
              ? `Item ${value.itemId} is done.`
              : `Completion already applied (${value.status}).`,
      }],
    },
    async execute(args, exec) {
      const cwd = workspaceOf(exec);
      const completed = withWorkspace(cwd, ({ engine }) => engine.complete({
        attemptId: requireString(args?.attemptId, 'attemptId'),
        outcome: args?.outcome === undefined ? 'complete' : requireString(args.outcome, 'outcome'),
        result: args?.result ?? {},
      }));
      // Project exactly the declared fields: the host rejects extra output
      // properties, and the engine's duplicate branch carries an attempt id.
      return {
        status: completed.status,
        ...(completed.itemId ? { itemId: completed.itemId } : {}),
        ...(completed.stage ? { stage: completed.stage } : {}),
        ...(completed.nextTaskId ? { nextTaskId: completed.nextTaskId } : {}),
        ...(completed.gates ? { gates: completed.gates } : {}),
      };
    },
  };
}

function toolFail({ workspaceOf, withWorkspace }) {
  return {
    name: 'team_workflow_fail',
    description: 'Report a failed attempt. A provider-class failure (quota, 429, rate limit, timeout) parks that lane for its backoff and releases the task for another lane; other failures retry with the policy backoff until the attempt budget is exhausted, then block the item.',
    parameters: objectSchema({
      attemptId: stringSchema(),
      error: stringSchema('Human-readable failure.'),
      providerError: { type: 'boolean', description: 'Force lane parking even when the message does not look like a provider error.' },
      retryable: { type: 'boolean', description: 'Default true.' },
    }, ['attemptId']),
    output: {
      schema: objectSchema({
        status: stringSchema(),
        attemptCount: integerSchema(),
        maxAttempts: integerSchema(),
        availableAt: stringSchema(),
        providerFailure: booleanSchema(),
        itemId: stringSchema(),
      }, ['status']),
      render: (_args, value) => [{
        type: 'text',
        text: value.status === 'retried'
          ? `Retry ${value.attemptCount}/${value.maxAttempts} scheduled at ${value.availableAt}${value.providerFailure ? '; lane parked' : ''}.`
          : value.status === 'failed'
            ? `Task failed (${value.attemptCount}/${value.maxAttempts}); item blocked${value.providerFailure ? '; lane parked' : ''}.`
            : `Failure already applied (${value.status}).`,
      }],
    },
    async execute(args, exec) {
      const cwd = workspaceOf(exec);
      const failed = withWorkspace(cwd, ({ engine }) => engine.fail({
        attemptId: requireString(args?.attemptId, 'attemptId'),
        error: typeof args?.error === 'string' ? args.error : '',
        providerError: args?.providerError === true,
        retryable: args?.retryable !== false,
      }));
      return {
        status: failed.status,
        ...(Number.isInteger(failed.attemptCount) ? { attemptCount: failed.attemptCount } : {}),
        ...(Number.isInteger(failed.maxAttempts) ? { maxAttempts: failed.maxAttempts } : {}),
        ...(failed.availableAt ? { availableAt: failed.availableAt } : {}),
        ...(failed.providerFailure === true ? { providerFailure: true } : {}),
        ...(failed.itemId ? { itemId: failed.itemId } : {}),
      };
    },
  };
}

function toolPlan({ workspaceOf, withWorkspace }) {
  return {
    name: 'team_workflow_plan',
    description: 'List ready tasks (role, stage, item and outcome count) and pending gates. Use it to decide which task to delegate next. It is read-only.',
    parameters: objectSchema({}),
    output: {
      schema: objectSchema({
        ready: {
          type: 'array',
          items: objectSchema({
            taskId: stringSchema(),
            itemId: stringSchema(),
            title: stringSchema(),
            role: stringSchema(),
            stage: stringSchema(),
            outcomes: integerSchema(),
          }, ['taskId', 'itemId', 'title', 'role', 'stage', 'outcomes']),
        },
        pendingGates: {
          type: 'array',
          items: objectSchema({
            itemId: stringSchema(),
            itemTitle: stringSchema(),
            gate: stringSchema(),
          }, ['itemId', 'itemTitle', 'gate']),
        },
      }, ['ready']),
      render: (_args, value) => [{
        type: 'text',
        text: value.ready.length === 0 && value.pendingGates.length === 0
          ? 'No ready tasks or pending gates.'
          : [
              ...value.ready.map(task => `ready: ${task.taskId} ${task.role}/${task.stage} "${task.title}" outcomes=${task.outcomes}`),
              ...value.pendingGates.map(gate => `gate: ${gate.itemTitle}/${gate.gate}`),
            ].join('\n'),
      }],
    },
    async execute(_args, exec) {
      const cwd = workspaceOf(exec);
      return withWorkspace(cwd, ({ store, definition }) => {
        const now = new Date().toISOString();
        const rows = store.db.prepare(`
          SELECT t.id, t.item_id, t.role, t.stage, i.title
          FROM tasks t JOIN items i ON i.id = t.item_id
          WHERE t.status = 'ready' AND (t.available_at IS NULL OR t.available_at <= ?)
          ORDER BY t.priority DESC, t.created_at ASC, t.id ASC
        `).all(now);
        const snapshot = store.snapshot();
        const outcomesOf = stageId => Object.keys(
          definition.stages.find(stage => stage.id === stageId)?.on ?? {},
        ).length;
        return {
          ready: rows.map(row => ({
            taskId: row.id,
            itemId: row.item_id,
            title: row.title,
            role: row.role,
            stage: row.stage,
            outcomes: outcomesOf(row.stage),
          })),
          pendingGates: snapshot.gates
            .filter(gate => gate.status === 'pending')
            .map(gate => ({
              itemId: gate.itemId,
              itemTitle: snapshot.items.find(item => item.id === gate.itemId)?.title ?? gate.itemId,
              gate: gate.gate,
            })),
        };
      });
    },
  };
}

function toolDelegate({ workspaceOf, settings, subagentsOf, activations, logger, withWorkspace }) {
  return {
    name: 'team_workflow_delegate',
    description: 'Claim one ready task whose stage has exactly one outcome, spawn a subagent to do the work, and record completion or failure when it settles. Returns immediately; use team_workflow_status to observe progress. Requires a host subagent provider.',
    parameters: objectSchema({
      role: stringSchema('Role whose ready task should be delegated.'),
      member: stringSchema('Member name recorded on the attempt; defaults to <role>-agent.'),
      provider: stringSchema('Optional lane id.'),
    }, ['role']),
    output: {
      schema: objectSchema({
        spawned: booleanSchema(),
        taskId: stringSchema(),
        attemptId: stringSchema(),
        childId: stringSchema(),
        outcome: stringSchema(),
        reason: stringSchema(),
      }, ['spawned']),
      render: (_args, value) => [{
        type: 'text',
        text: value.spawned
          ? `Delegated ${value.taskId} to child ${value.childId}; it will report ${value.outcome}.`
          : `Not delegated: ${value.reason ?? 'no ready task'}.`,
      }],
    },
    async execute(args, exec) {
      const subagents = subagentsOf();
      if (!subagents || typeof subagents.startActivation !== 'function') {
        throw new Error('team_workflow_delegate requires the host subagent service; use team_workflow_claim with an external worker instead');
      }
      const role = requireString(args?.role, 'role');
      const member = args?.member === undefined ? `${role}-agent` : requireString(args.member, 'member');
      const provider = args?.provider === undefined ? null : requireString(args.provider, 'provider');
      const cwd = workspaceOf(exec);

      let claimed;
      let outcome;
      let definitionName;
      try {
        const opened = withWorkspace(cwd, ({ engine, definition }) => {
          const peeked = engine.peek({ role });
          if (!peeked) return { reason: 'no ready task for that role' };
          const stage = definition.stages.find(candidate => candidate.id === peeked.stage);
          const outcomes = Object.keys(stage.on);
          if (outcomes.length !== 1) {
            return { reason: `stage "${stage.id}" has ${outcomes.length} outcomes; decide it with team_workflow_complete instead` };
          }
          const claimedTask = engine.claim({ role, member, provider });
          if (!claimedTask) return { reason: 'could not claim a task' };
          return { claimed: claimedTask, outcome: outcomes[0], definitionName: definition.name };
        });
        if (!opened.claimed) return { spawned: false, reason: opened.reason };
        claimed = opened.claimed;
        outcome = opened.outcome;
        definitionName = opened.definitionName;
      } catch (error) {
        if (/no workflow is defined/.test(error.message)) throw error;
        throw error;
      }

      const prompt = workerPrompt({ workflowName: definitionName, cwd, claimed, outcome });
      let activation;
      try {
        activation = await subagents.startActivation({
          provider: settings.subagentProvider,
          label: `team-workflow:${claimed.task.id}`,
          request: {
            prompt: [{ type: 'text', text: prompt }],
            parent: exec.agent,
            cwd,
          },
          signal: exec.signal,
          delivery: 'caller',
        });
      } catch (error) {
        // The task is already running; release it so this attempt does not hold
        // a slot until the lease expires.
        try {
          withWorkspace(cwd, ({ engine }) => engine.fail({
            attemptId: claimed.attempt.id,
            error: `delegate spawn failed: ${error.message}`,
            retryable: true,
            providerError: inferProviderError(error.message),
          }));
        } catch (releaseError) {
          logger.warn(`agent-team-workflow: could not release delegated attempt: ${releaseError.message}`);
        }
        throw error;
      }

      activations.add(activation);
      Promise.resolve(activation.result)
        .then(result => settleDelegation({ cwd, attemptId: claimed.attempt.id, outcome, result, withWorkspace, logger }))
        .catch(error => settleFailure({ cwd, attemptId: claimed.attempt.id, error, withWorkspace, logger }))
        .finally(() => {
          activations.delete(activation);
          Promise.resolve(activation.dispose?.()).catch(() => {});
        });

      return {
        spawned: true,
        taskId: claimed.task.id,
        attemptId: claimed.attempt.id,
        childId: activation.childId ?? '',
        outcome,
      };
    },
  };
}

function settleDelegation({ cwd, attemptId, outcome, result, withWorkspace, logger }) {
  const summary = textOf(result?.output) || result?.diagnostic || '';
  const errorText = result?.diagnostic ?? `subagent stopped: ${result?.stopReason ?? 'unknown'}`;
  try {
    withWorkspace(cwd, ({ engine }) => {
      if (result?.stopReason === 'completed') {
        return engine.complete({ attemptId, outcome, result: { summary } });
      }
      return engine.fail({
        attemptId,
        error: errorText,
        retryable: true,
        providerError: inferProviderError(errorText),
      });
    });
  } catch (error) {
    logger.warn(`agent-team-workflow: could not record delegated result: ${error.message}`);
  }
}

function settleFailure({ cwd, attemptId, error, withWorkspace, logger }) {
  const message = `delegated subagent failed: ${error?.message ?? String(error)}`;
  try {
    withWorkspace(cwd, ({ engine }) => engine.fail({
      attemptId,
      error: message,
      retryable: true,
      providerError: inferProviderError(message),
    }));
  } catch (releaseError) {
    logger.warn(`agent-team-workflow: could not record delegated failure: ${releaseError.message}`);
  }
}

function workerPrompt({ workflowName, cwd, claimed, outcome }) {
  return [
    `You are executing one task in the "${workflowName}" workflow.`,
    '',
    `Item: ${claimed.task.contract.title ?? claimed.task.itemId}`,
    `Stage: ${claimed.task.stage} | Role: ${claimed.task.role}`,
    `Workspace: ${cwd}`,
    '',
    'Task contract (JSON):',
    JSON.stringify(claimed.task.contract, null, 2),
    '',
    'Do the work now using the workspace tools you have.',
    'Do not create or manage a workflow, do not spawn other agents, and do not merge, close or push anything.',
    `When finished, reply with a concise summary and the files you changed. The coordinator will record the "${outcome}" outcome.`,
    'If you are blocked, say exactly what is missing instead of guessing.',
  ].join('\n');
}

function textOf(blocks) {
  if (!Array.isArray(blocks)) return '';
  return blocks
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
    .trim();
}

// --- config and schema helpers --------------------------------------------

function resolveSettings(config) {
  return {
    stateDir: typeof config.stateDir === 'string' && config.stateDir.trim() !== ''
      ? config.stateDir
      : DEFAULT_CONFIG.stateDir,
    boardPort: Number.isInteger(config.boardPort) && config.boardPort >= 0
      ? config.boardPort
      : DEFAULT_CONFIG.boardPort,
    autoBoard: config.autoBoard !== false,
    subagentProvider: typeof config.subagentProvider === 'string' && config.subagentProvider !== ''
      ? config.subagentProvider
      : DEFAULT_CONFIG.subagentProvider,
    promptSectionOrder: Number.isInteger(config.promptSectionOrder)
      ? config.promptSectionOrder
      : DEFAULT_CONFIG.promptSectionOrder,
  };
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function objectSchema(properties, required = []) {
  return { type: 'object', properties, required, additionalProperties: false };
}

function freeObject(description) {
  return { type: 'object', additionalProperties: true, ...(description ? { description } : {}) };
}

function stringSchema(description) {
  return { type: 'string', ...(description ? { description } : {}) };
}

function integerSchema(description) {
  return { type: 'integer', ...(description ? { description } : {}) };
}

function booleanSchema() {
  return { type: 'boolean' };
}

export default { name, inject, apply };
