/**
 * v2 DSH adapter: five tools around the node runtime.
 *
 * This is the only host-facing entry point for v2. It mounts agent, command and
 * HTTP executors, resolves provider lanes, and stores workflow/run JSON in the
 * session data directory. No v1 tools or board APIs are imported.
 */

import path from 'node:path';
import os from 'node:os';

import { DefinitionError, describeDefinition, normalizeDefinition } from './definition.mjs';
import { DEFAULT_PERMISSIONS, decide, newRunState, normalizePermissions } from './runtime.mjs';
import { SessionStore } from './store.mjs';
import { WorkflowRunner, executionCwd, preflightRun } from './runner.mjs';
import { summarizeRun } from './view.mjs';
import { installWebApi } from './web-api.mjs';

export const name = 'dsh-agent-team-workflow';
export const inject = ['tools', 'systemPrompt'];

const DEFAULT_CONFIG = {
  dataDir: null,
  subagentProvider: 'spawn',
  promptSectionOrder: 118,
  maxSteps: 40,
  agentTimeoutMs: 600_000,
  maxFailures: 3,
};

const USAGE = `Agent Team Workflow v2 is a node-graph workflow engine.

A workflow is nodes plus edges. Node types:
- agent: a model subagent. Config: prompt?, lane?, provider?, model?, models?, cwd?, timeoutMs?, maxFailures?, outcome?, outcomes?; optional role label. The models array is an ordered fallback list.
- command: a shell command. Config: command, cwd?, timeoutMs?. Requires a command permission grant.
- http: an HTTP request. Config: url, method?, headers?, body?, timeoutMs?. Requires an HTTP grant.
- human: waits for a decision. Config: title?, outcomes? (default approve/reject).
- fanout: creates one branch per item. Config: items (path), target (node id), join (join node id).
- join: aggregates branches; its wait is internal, not a human decision. Config: mode all|any|quorum, count?.
- gate: switch/cycle boundary. Pauses when control is off. Optional newCycle resets per-item node results; consumeInput names initial-request keys consumed after the first cycle.
- subworkflow: runs an inline nested definition. Config: definition.

Inputs map values from "$input", "$nodes.<id>.output", "$item", "$index" or "$context".
Edges select the next node: {from, to, on}. "on" is the outcome (default complete).
Keep node ids short kebab-case and node titles concise (about 12 Chinese characters or 24 Latin characters); the board wraps to two lines but brevity reads better.

Permissions are NOT part of the definition. Before creating a workflow that uses
command/http nodes, ask the user whether to grant full/allowlist access.
Call team_workflow_define with a permissions grant: e.g.
  {"command":{"mode":"allowlist","allow":["pnpm","node"]},"http":{"mode":"allowlist","allow":["api.github.com"]}}
Default is deny: a command/http node will fail with permission_denied.
If the user refuses full access, design a restricted workflow using allowlists,
or use only agent/human/fanout/join nodes.

Tools:
- team_workflow_define: validate and store the definition + permission grant.
- team_workflow_start: bind an absolute repository cwd and input, then preflight without execution.
- team_workflow_run: dispatch a managed job and return its id. Use status/job_output for progress and job_kill to cancel; do not busy-poll.
- team_workflow_decide: resolve a waiting human node with an outcome.
- team_workflow_status: show cwd, active job/node, execution progress and waiting human decisions.
An interrupted/failed node may already have side effects. Inspect them before starting a new run.`;

export function apply(ctx, config = {}) {
  const settings = resolveSettings(config);
  const stores = new Map();
  const agents = new Map();
  const remember = exec => agents.set(sessionIdOf(exec), { agent: exec.agent });

  const sessionIdOf = exec => {
    const id = exec?.agent?.id;
    return typeof id === 'string' && id !== '' ? id : 'local';
  };
  const storeForSession = sessionId => {
    if (!stores.has(sessionId)) {
      const root = settings.dataDir ?? defaultDataDir();
      stores.set(sessionId, new SessionStore(path.join(root, 'sessions', sessionId)));
    }
    return stores.get(sessionId);
  };
  const storeFor = exec => storeForSession(sessionIdOf(exec));
  const runner = new WorkflowRunner({ ctx, storeFor: storeForSession, agents, settings });
  ctx.effect?.(() => () => runner.dispose(), 'dsh-agent-team-workflow: execution owner');

  const mount = tool => register(ctx, {
    ...tool,
    async execute(args, exec) {
      remember(exec);
      return tool.execute(args, exec);
    },
  }, 'dsh-agent-team-workflow: ' + tool.name);

  const webApi = installWebApi({ ctx, dataRoot: settings.dataDir ?? defaultDataDir(), agents, settings, runner, logger: console });

  mount(toolDefine({ storeFor, runner, sessionIdOf }));
  mount(toolStart({ storeFor, runner, sessionIdOf, ctx }));
  mount(toolRun({ runner, sessionIdOf }));
  mount(toolDecide({ storeFor, runner, sessionIdOf }));
  mount(toolStatus({ storeFor, ctx, boardUrl: webApi.boardUrl }));

  if (ctx.systemPrompt && typeof ctx.systemPrompt.section === 'function') {
    ctx.systemPrompt.section({ name: 'dsh-agent-team-workflow:usage', order: settings.promptSectionOrder, text: USAGE });
  }

  return { settings, runner };
}

function register(ctx, tool, label) {
  const mount = () => ctx.tools.register(tool);
  if (typeof ctx.effect === 'function') ctx.effect(mount, label);
  else mount();
}

function toolDefine({ storeFor, runner, sessionIdOf }) {
  return {
    name: 'team_workflow_define',
    description: 'Validate and store a v2 node-graph workflow definition for this session, together with the permission grant the user approved. Ask the user before granting command/http access; default deny.',
    parameters: objectSchema({
      definition: freeObject('v2 definition: nodes + edges (+ providers).'),
      permissions: freeObject('Permission grant for command/http nodes. Omit for deny.'),
    }, ['definition']),
    output: {
      schema: objectSchema({
        ok: booleanSchema(),
        name: stringSchema(),
        entry: stringSchema(),
        nodes: integerSchema(),
        edges: integerSchema(),
        summary: stringSchema(),
        permissions: freeObject('Stored permission grant.'),
        errors: arraySchema(objectSchema({ path: stringSchema(), message: stringSchema() }, ['path', 'message'])),
      }, ['ok']),
      render: (_args, value) => [{ type: 'text', text: renderDefine(value) }],
    },
    async execute(args, exec) {
      let raw = args?.definition;
      if (typeof raw === 'string') {
        try {
          raw = JSON.parse(raw);
        } catch (error) {
          return { ok: false, errors: [{ path: '$.definition', message: `invalid JSON: ${error.message}` }] };
        }
      }
      let definition;
      try {
        definition = normalizeDefinition(raw);
      } catch (error) {
        if (error instanceof DefinitionError) return { ok: false, errors: error.errors };
        throw error;
      }
      const permissions = normalizePermissions(args?.permissions);
      const store = storeFor(exec);
      await runner.mutate(sessionIdOf(exec), () => store.saveDefinition({ definition, permissions }));
      return {
        ok: true,
        name: definition.name,
        entry: definition.entry ?? '',
        nodes: definition.nodes.length,
        edges: definition.edges.length,
        summary: describeDefinition(definition),
        permissions,
        errors: [],
      };
    },
  };
}

function toolStart({ storeFor, runner, sessionIdOf, ctx }) {
  return {
    name: 'team_workflow_start',
    description: 'Create a run with an immutable repository directory and input. Preflight verification commands before any model work; does not execute nodes.',
    parameters: objectSchema({ input: freeObject('Initial run input; available to nodes as $input.'), cwd: stringSchema('Absolute target repository path. Omit only to bind the current effective DSH working directory, not its original header.') }, []),
    output: {
      schema: objectSchema({ runId: stringSchema(), status: stringSchema(), cwd: stringSchema() }, ['runId', 'status', 'cwd']),
      render: (_args, value) => [{ type: 'text', text: `Created ${value.runId} (${value.status})\ncwd: ${value.cwd}` }],
    },
    async execute(args, exec) {
      return runner.mutate(sessionIdOf(exec), async () => {
        const store = storeFor(exec);
        const stored = await store.loadDefinition();
        if (!stored) throw new Error('no workflow defined; call team_workflow_define first');
        const previous = await store.latestRun();
        if (previous && !['done', 'failed', 'interrupted'].includes(previous.status)) {
          throw new Error('An unfinished run already exists. Continue or inspect it instead of creating a duplicate.');
        }
        const cwd = await executionCwd(ctx, exec, args?.cwd);
        const state = newRunState({
          definition: stored.definition, permissions: stored.permissions ?? DEFAULT_PERMISSIONS,
          input: args?.input !== null && typeof args?.input === 'object' ? args.input : {}, cwd,
        });
        await preflightRun(state);
        await store.saveRun(state);
        return { runId: state.runId, status: state.status, cwd: state.cwd };
      });
    },
  };
}

function toolRun({ runner, sessionIdOf }) {
  return {
    name: 'team_workflow_run',
    description: 'Start or find the session-owned workflow job and return immediately. Follow progress with status/job_output; job_kill cancels. Failed or interrupted work is not replayed automatically.',
    parameters: objectSchema({ runId: stringSchema('Optional run id; defaults to the latest run.') }, []),
    output: {
      schema: objectSchema({
        runId: stringSchema(),
        status: stringSchema(),
        cwd: stringSchema(),
        jobId: stringSchema(),
        current: freeObject('Current node/token, state and child activity.'),
        execution: freeObject('Session-owned job lifecycle.'),
        counts: freeObject('Token counts by state.'),
        updatedAt: stringSchema(),
        pauseReason: stringSchema('Empty when not paused.'),
        waiting: arraySchema(objectSchema({
          tokenId: stringSchema(),
          nodeId: stringSchema(),
          title: stringSchema(),
          outcomes: arraySchema(stringSchema()),
        }, ['tokenId', 'nodeId', 'title', 'outcomes'])),
        error: stringSchema(),
      }, ['runId', 'status', 'waiting', 'error']),
      render: (_args, value) => [{ type: 'text', text: renderRun(value) }],
    },
    async execute(args, exec) {
      const state = await runner.dispatch(sessionIdOf(exec), args?.runId, exec);
      return summarizeRun(state);
    },
  };
}

function toolDecide({ storeFor, runner, sessionIdOf }) {
  return {
    name: 'team_workflow_decide',
    description: 'Resolve a waiting human node with one of its declared outcomes, then persist the run.',
    parameters: objectSchema({
      tokenId: stringSchema(),
      outcome: stringSchema(),
      output: freeObject('Optional decision payload.'),
    }, ['tokenId', 'outcome']),
    output: {
      schema: objectSchema({ runId: stringSchema(), status: stringSchema() }, ['runId', 'status']),
      render: (_args, value) => [{ type: 'text', text: `Decision recorded on ${value.runId} (${value.status}).` }],
    },
    async execute(args, exec) {
      return runner.mutate(sessionIdOf(exec), async () => {
        const store = storeFor(exec);
        const state = await loadRun(store, null);
        decide(state, { tokenId: requireText(args?.tokenId, 'tokenId'), outcome: requireText(args?.outcome, 'outcome'), output: args?.output ?? null });
        await store.saveRun(state);
        return { runId: state.runId, status: state.status };
      });
    },
  };
}

function toolStatus({ storeFor, ctx, boardUrl }) {
  return {
    name: 'team_workflow_status',
    description: 'Inspect persisted progress: bound cwd, current node and child, job id, checkpoints, errors and waiting decisions. Reading status never executes or retries work.',
    parameters: objectSchema({ runId: stringSchema('Optional run id; defaults to the latest run.') }, []),
    output: {
      schema: objectSchema({
        defined: booleanSchema(),
        summary: stringSchema(),
        run: freeObject('Latest run document, or {status:"none"}.'),
        boardUrl: stringSchema(),
      }, ['defined', 'summary', 'run', 'boardUrl']),
      render: (_args, value) => [{ type: 'text', text: `${value.summary}\nrun: ${JSON.stringify(value.run)}${value.boardUrl ? `\nboard: ${value.boardUrl}` : ''}` }],
    },
    async execute(args, exec) {
      const store = storeFor(exec);
      const stored = await store.loadDefinition();
      const state = await loadRun(store, args?.runId).catch(() => null);
      const session = exec?.agent?.id ?? 'local';
      const origin = ctx.get?.('webServer')?.getOrigin?.() ?? '';
      const fallback = `${String(origin).replace(/\/$/, '')}/plugins/dsh-agent-team-workflow/board?session=${encodeURIComponent(session)}`;
      const publicUrl = typeof boardUrl === 'function' ? boardUrl(session) : null;
      return {
        defined: stored !== null,
        summary: stored ? describeDefinition(stored.definition) : 'no workflow defined',
        run: state ? summarizeRun(state) : { status: 'none' },
        boardUrl: publicUrl || fallback,
      };
    },
  };
}

async function loadRun(store, runId) {
  if (typeof runId === 'string' && runId !== '') return store.loadRun(runId);
  const latest = await store.latestRun();
  if (!latest) throw new Error('no run exists; call team_workflow_start first');
  return latest;
}

function renderDefine(value) {
  if (!value.ok) return `Definition rejected:\n${(value.errors ?? []).map(error => `- ${error.path}: ${error.message}`).join('\n')}`;
  return `Defined "${value.name}" (${value.nodes} nodes, ${value.edges} edges).\n\n${value.summary}`;
}

function renderRun(value) {
  const waiting = value.waiting.map(token => `- ${token.nodeId} (${token.title}): ${token.outcomes.join(', ')}`).join('\n');
  return `${value.status === 'failed' ? `Failed: ${value.error}\n` : ''}${value.runId}: ${value.status}\ncwd: ${value.cwd || 'UNBOUND'}${value.jobId ? `\njob: ${value.jobId}` : ''}${value.current?.nodeId ? `\nnode: ${value.current.nodeId} (${value.current.status})` : ''}${waiting ? `\nWaiting decisions:\n${waiting}` : ''}`;
}

function resolveSettings(config) {
  return {
    dataDir: typeof config.dataDir === 'string' && config.dataDir.trim() !== '' ? path.resolve(config.dataDir) : null,
    subagentProvider: typeof config.subagentProvider === 'string' && config.subagentProvider !== '' ? config.subagentProvider : DEFAULT_CONFIG.subagentProvider,
    promptSectionOrder: Number.isInteger(config.promptSectionOrder) ? config.promptSectionOrder : DEFAULT_CONFIG.promptSectionOrder,
    maxSteps: Number.isInteger(config.maxSteps) && config.maxSteps > 0 ? config.maxSteps : DEFAULT_CONFIG.maxSteps,
    agentTimeoutMs: Number.isFinite(config.agentTimeoutMs) && config.agentTimeoutMs > 0 ? config.agentTimeoutMs : DEFAULT_CONFIG.agentTimeoutMs,
    maxFailures: Number.isInteger(config.maxFailures) && config.maxFailures > 0 ? config.maxFailures : DEFAULT_CONFIG.maxFailures,
  };
}

function defaultDataDir() {
  if (process.env.AGENT_TEAM_WORKFLOW_DATA) return path.resolve(process.env.AGENT_TEAM_WORKFLOW_DATA);
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'agent-team-workflow');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'agent-team-workflow');
  return path.join(process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share'), 'agent-team-workflow');
}

function requireText(value, label) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

function objectSchema(properties, required = []) {
  return { type: 'object', properties, required, additionalProperties: false };
}

function freeObject(description = 'Arbitrary JSON object.') {
  return { type: 'object', description, additionalProperties: true };
}

function arraySchema(items) {
  return { type: 'array', items };
}

function stringSchema(description) {
  return { type: 'string', ...(description ? { description } : {}) };
}

function integerSchema() {
  return { type: 'integer' };
}

function booleanSchema() {
  return { type: 'boolean' };
}
