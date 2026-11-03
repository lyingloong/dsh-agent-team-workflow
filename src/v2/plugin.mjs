/**
 * v2 DSH adapter: five tools around the node runtime.
 *
 * This is the only host-facing entry point for v2. It mounts agent, command and
 * HTTP executors, resolves provider lanes, and stores workflow/run JSON in the
 * session data directory. No v1 tools or board APIs are imported.
 */

import path from 'node:path';
import os from 'node:os';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

import { DefinitionError, describeDefinition, normalizeDefinition } from './definition.mjs';
import { DEFAULT_PERMISSIONS, decide, newRunState, normalizePermissions, run, waitingTokens, humanOutcomes } from './runtime.mjs';
import { SessionStore } from './store.mjs';

const execAsync = promisify(exec);
export const name = 'dsh-agent-team-workflow';
export const inject = ['tools', 'systemPrompt'];

const DEFAULT_CONFIG = {
  dataDir: null,
  subagentProvider: 'spawn',
  promptSectionOrder: 118,
  maxSteps: 40,
};

const USAGE = `Agent Team Workflow v2 is a node-graph workflow engine.

A workflow is nodes plus edges. Node types:
- agent: a model subagent. Config: prompt?, lane?, outcome?, outcomes?; optional role label.
- command: a shell command. Config: command, cwd?, timeoutMs?. Requires a command permission grant.
- http: an HTTP request. Config: url, method?, headers?, body?, timeoutMs?. Requires an HTTP grant.
- human: waits for a decision. Config: title?, outcomes? (default approve/reject).
- fanout: creates one branch per item. Config: items (path), target (node id), join (join node id).
- join: aggregates branches. Config: mode all|any|quorum, count?.
- subworkflow: runs an inline nested definition. Config: definition.

Inputs map values from "$input", "$nodes.<id>.output", "$item", "$index" or "$context".
Edges select the next node: {from, to, on}. "on" is the outcome (default complete).

Permissions are NOT part of the definition. Before creating a workflow that uses
command/http nodes, ask the user whether to grant full/allowlist access.
Call team_workflow_define with a permissions grant: e.g.
  {"command":{"mode":"allowlist","allow":["pnpm","node"]},"http":{"mode":"allowlist","allow":["api.github.com"]}}
Default is deny: a command/http node will fail with permission_denied.
If the user refuses full access, design a restricted workflow using allowlists,
or use only agent/human/fanout/join nodes.

Tools:
- team_workflow_define: validate and store the definition + permission grant.
- team_workflow_start: create a run with an input object.
- team_workflow_run: execute ready nodes until the run waits or finishes.
- team_workflow_decide: resolve a waiting human node with an outcome.
- team_workflow_status: show definition/run summary and waiting tokens.`;

export function apply(ctx, config = {}) {
  const settings = resolveSettings(config);
  const stores = new Map();

  const sessionIdOf = exec => {
    const id = exec?.agent?.id;
    return typeof id === 'string' && id !== '' ? id : 'local';
  };
  const cwdOf = exec => exec?.agent?.session?.header?.cwd ?? process.cwd();
  const storeFor = exec => {
    const sessionId = sessionIdOf(exec);
    if (!stores.has(sessionId)) {
      const root = settings.dataDir ?? defaultDataDir();
      stores.set(sessionId, new SessionStore(path.join(root, 'sessions', sessionId)));
    }
    return stores.get(sessionId);
  };

  register(ctx, toolDefine({ storeFor }), 'dsh-agent-team-workflow: define');
  register(ctx, toolStart({ storeFor }), 'dsh-agent-team-workflow: start');
  register(ctx, toolRun({ storeFor, ctx, settings, cwdOf }), 'dsh-agent-team-workflow: run');
  register(ctx, toolDecide({ storeFor }), 'dsh-agent-team-workflow: decide');
  register(ctx, toolStatus({ storeFor }), 'dsh-agent-team-workflow: status');

  if (ctx.systemPrompt && typeof ctx.systemPrompt.section === 'function') {
    ctx.systemPrompt.section({ name: 'dsh-agent-team-workflow:usage', order: settings.promptSectionOrder, text: USAGE });
  }

  return { settings };
}

function register(ctx, tool, label) {
  const mount = () => ctx.tools.register(tool);
  if (typeof ctx.effect === 'function') ctx.effect(mount, label);
  else mount();
}

function toolDefine({ storeFor }) {
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
      await storeFor(exec).saveDefinition({ definition, permissions });
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

function toolStart({ storeFor }) {
  return {
    name: 'team_workflow_start',
    description: 'Create a new run of the stored v2 workflow with an input object and persist it.',
    parameters: objectSchema({ input: freeObject('Initial run input; available to nodes as $input.') }, []),
    output: {
      schema: objectSchema({ runId: stringSchema(), status: stringSchema() }, ['runId', 'status']),
      render: (_args, value) => [{ type: 'text', text: `Started ${value.runId} (${value.status}).` }],
    },
    async execute(args, exec) {
      const stored = await storeFor(exec).loadDefinition();
      if (!stored) throw new Error('no workflow defined; call team_workflow_define first');
      const state = newRunState({
        definition: stored.definition,
        permissions: stored.permissions ?? DEFAULT_PERMISSIONS,
        input: args?.input !== null && typeof args?.input === 'object' ? args.input : {},
      });
      await storeFor(exec).saveRun(state);
      return { runId: state.runId, status: state.status };
    },
  };
}

function toolRun({ storeFor, ctx, settings, cwdOf }) {
  return {
    name: 'team_workflow_run',
    description: 'Execute ready v2 nodes until the run waits for a human/join or finishes. Agent nodes spawn subagents; command/http nodes require the stored permission grant.',
    parameters: objectSchema({ runId: stringSchema('Optional run id; defaults to the latest run.') }, []),
    output: {
      schema: objectSchema({
        runId: stringSchema(),
        status: stringSchema(),
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
      const store = storeFor(exec);
      const state = await loadRun(store, args?.runId);
      const definition = await store.loadDefinition();
      if (!definition) throw new Error('no workflow defined');
      const executors = createExecutors({ ctx, exec, settings, cwd: cwdOf(exec), definition: definition.definition });
      try {
        await run(state, executors, { maxSteps: settings.maxSteps });
      } catch (error) {
        state.status = 'failed';
        state.lastError = error.message;
      }
      await store.saveRun(state);
      return summarizeRun(state);
    },
  };
}

function toolDecide({ storeFor }) {
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
      const store = storeFor(exec);
      const state = await loadRun(store, null);
      decide(state, { tokenId: requireText(args?.tokenId, 'tokenId'), outcome: requireText(args?.outcome, 'outcome'), output: args?.output ?? null });
      await store.saveRun(state);
      return { runId: state.runId, status: state.status };
    },
  };
}

function toolStatus({ storeFor }) {
  return {
    name: 'team_workflow_status',
    description: 'Show the stored v2 definition summary and the latest run: status, waiting tokens and token counts.',
    parameters: objectSchema({ runId: stringSchema('Optional run id; defaults to the latest run.') }, []),
    output: {
      schema: objectSchema({
        defined: booleanSchema(),
        summary: stringSchema(),
        run: freeObject('Latest run document, or {status:"none"}.'),
      }, ['defined', 'summary', 'run']),
      render: (_args, value) => [{ type: 'text', text: `${value.summary}\nrun: ${JSON.stringify(value.run)}` }],
    },
    async execute(args, exec) {
      const store = storeFor(exec);
      const stored = await store.loadDefinition();
      const state = await loadRun(store, args?.runId).catch(() => null);
      return {
        defined: stored !== null,
        summary: stored ? describeDefinition(stored.definition) : 'no workflow defined',
        run: state ? summarizeRun(state) : { status: 'none' },
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

function summarizeRun(state) {
  const failed = state.tokens.find(token => token.status === 'failed');
  return {
    runId: state.runId,
    status: state.status,
    waiting: waitingTokens(state).map(token => ({
      tokenId: token.id,
      nodeId: token.nodeId,
      title: state.definition.nodes.find(node => node.id === token.nodeId)?.title ?? token.nodeId,
      outcomes: humanOutcomes(state.definition.nodes.find(node => node.id === token.nodeId)),
    })),
    error: state.lastError ?? (failed ? `${failed.error.code}: ${failed.error.message}` : ''),
  };
}

function createExecutors({ ctx, exec, settings, cwd, definition }) {
  const subagents = ctx.get?.('subagents');
  return {
    async agent({ node, input, context, definition }) {
      if (!subagents || typeof subagents.startActivation !== 'function') {
        throw new Error('no subagent service is mounted');
      }
      const lane = definition.providers.find(provider => provider.id === node.config.lane) ?? null;
      const agentOptions = {};
      if (lane?.adapter) agentOptions.provider = lane.adapter;
      if (lane?.model && lane.model !== 'host-default') agentOptions.model = lane.model;
      if (lane?.reasoningEffort) agentOptions.reasoningEffort = lane.reasoningEffort;
      if (lane?.maxTokens) agentOptions.maxTokens = lane.maxTokens;
      const outcomes = Array.isArray(node.config.outcomes) && node.config.outcomes.length > 0
        ? node.config.outcomes
        : node.config.outcome ? [node.config.outcome] : ['complete'];
      const prompt = agentPrompt({ definition, node, input, context, outcomes });
      const activation = await subagents.startActivation({
        provider: settings.subagentProvider,
        label: `workflow:${node.id}`,
        request: {
          prompt: [{ type: 'text', text: prompt }],
          parent: exec.agent,
          cwd,
          ...(Object.keys(agentOptions).length > 0 ? { agentOptions } : {}),
        },
        signal: exec.signal,
        delivery: 'caller',
      });
      const result = await activation.result;
      if (result?.stopReason !== 'completed') throw new Error(result?.diagnostic ?? `subagent stopped: ${result?.stopReason ?? 'unknown'}`);
      return parseAgentText(textOf(result?.output), { outcomes, fallback: outcomes[0] });
    },
    async command({ node, input }) {
      try {
        const { stdout, stderr } = await execAsync(node.config.command, {
          cwd: node.config.cwd ? path.resolve(cwd, node.config.cwd) : cwd,
          timeout: node.config.timeoutMs ?? 120_000,
          maxBuffer: 1_000_000,
          windowsHide: true,
        });
        return { outcome: 'complete', output: { stdout, stderr, code: 0 } };
      } catch (error) {
        return {
          outcome: 'fail',
          output: { stdout: error.stdout ?? '', stderr: error.stderr ?? '', code: error.code ?? 1 },
        };
      }
    },
    async http({ node }) {
      const url = node.config.url;
      const method = (node.config.method ?? 'GET').toUpperCase();
      const headers = { ...(node.config.headers ?? {}) };
      let body;
      if (node.config.body !== undefined) {
        body = typeof node.config.body === 'string' ? node.config.body : JSON.stringify(node.config.body);
        if (!Object.keys(headers).some(key => key.toLowerCase() === 'content-type')) headers['content-type'] = 'application/json';
      }
      const response = await fetch(url, {
        method,
        headers,
        body,
        signal: AbortSignal.timeout(node.config.timeoutMs ?? 30_000),
      });
      const text = await response.text();
      return {
        outcome: response.ok ? 'complete' : 'fail',
        output: { status: response.status, ok: response.ok, body: text.slice(0, 40_000) },
      };
    },
  };
}

function agentPrompt({ definition, node, input, context, outcomes }) {
  return [
    `You are executing node "${node.id}" of workflow "${definition.name}".`,
    node.role ? `Role: ${node.role}` : '',
    node.config.prompt ? `Instructions:\n${node.config.prompt}` : '',
    `Input:\n${JSON.stringify(input, null, 2)}`,
    `Context:\n${JSON.stringify(context, null, 2)}`,
    `Allowed outcomes: ${outcomes.join(', ')}`,
    'Do the work with the tools you have. Do not create workflows or spawn agents.',
    'Reply with a JSON object: {"outcome":"<one of the allowed outcomes>","output":<any JSON>}.',
    'If you cannot decide an outcome, use the first allowed outcome and explain in output.',
  ].filter(Boolean).join('\n\n');
}

function parseAgentText(text, { outcomes, fallback }) {
  const trimmed = text.trim();
  if (trimmed !== '') {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed !== null && typeof parsed === 'object') {
        const outcome = outcomes.includes(parsed.outcome) ? parsed.outcome : fallback;
        return { outcome, output: parsed.output ?? parsed };
      }
    } catch {
      // Fall through: plain text is a valid output.
    }
    if (outcomes.includes(trimmed)) return { outcome: trimmed, output: { text: trimmed } };
  }
  return { outcome: fallback, output: { text } };
}

function textOf(blocks) {
  if (!Array.isArray(blocks)) return '';
  return blocks.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n').trim();
}

function renderDefine(value) {
  if (!value.ok) return `Definition rejected:\n${(value.errors ?? []).map(error => `- ${error.path}: ${error.message}`).join('\n')}`;
  return `Defined "${value.name}" (${value.nodes} nodes, ${value.edges} edges).\n\n${value.summary}`;
}

function renderRun(value) {
  const waiting = value.waiting.map(token => `- ${token.nodeId} (${token.title}): ${token.outcomes.join(', ')}`).join('\n');
  return `${value.status === 'failed' ? `Failed: ${value.error}\n` : ''}${value.runId}: ${value.status}${waiting ? `\nWaiting decisions:\n${waiting}` : ''}`;
}

function resolveSettings(config) {
  return {
    dataDir: typeof config.dataDir === 'string' && config.dataDir.trim() !== '' ? path.resolve(config.dataDir) : null,
    subagentProvider: typeof config.subagentProvider === 'string' && config.subagentProvider !== '' ? config.subagentProvider : DEFAULT_CONFIG.subagentProvider,
    promptSectionOrder: Number.isInteger(config.promptSectionOrder) ? config.promptSectionOrder : DEFAULT_CONFIG.promptSectionOrder,
    maxSteps: Number.isInteger(config.maxSteps) && config.maxSteps > 0 ? config.maxSteps : DEFAULT_CONFIG.maxSteps,
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
