/**
 * v2 node runtime.
 *
 * The runtime is host-free: executors for agent/command/http are injected by
 * the adapter, while fanout, join, human and subworkflow are handled here.
 * State is a plain JSON document so a caller can persist it atomically between
 * ticks and resume after a restart.
 */

import { randomUUID } from 'node:crypto';

export class RuntimeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RuntimeError';
    this.code = code;
  }
}

export class PermissionError extends RuntimeError {
  constructor(message) {
    super('permission_denied', message);
  }
}

export const DEFAULT_PERMISSIONS = {
  command: { mode: 'deny', allow: [] },
  http: { mode: 'deny', allow: [] },
};

export function normalizePermissions(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {};
  const normalize = section => {
    const value = source[section] !== null && typeof source[section] === 'object' ? source[section] : {};
    const mode = ['deny', 'allowlist', 'full'].includes(value.mode) ? value.mode : 'deny';
    return {
      mode,
      allow: Array.isArray(value.allow) ? value.allow.filter(item => typeof item === 'string') : [],
    };
  };
  return { command: normalize('command'), http: normalize('http') };
}

export function newRunState({ definition, permissions, input = {}, cwd = null, now = new Date().toISOString() }) {
  const state = {
    version: 2,
    runId: `run-${randomUUID()}`,
    definition,
    cwd,
    initialInput: structuredClone(input),
    permissions: normalizePermissions(permissions),
    status: 'running',
    context: { input: structuredClone(input), nodes: {}, artifacts: {} },
    failureStreaks: {},
    tokens: [],
    fanouts: {},
    createdAt: now,
    updatedAt: now,
  };
  const entry = definition.nodes.find(node => node.id === definition.entry);
  if (!entry) throw new RuntimeError('no_entry', 'definition has no entry node');
  state.tokens.push(makeToken(entry, resolveInputs(entry, state, null), now));
  refreshStatus(state);
  return state;
}

/** Process ready tokens until the run waits for a human/join/gate or a step budget is hit. */
export async function run(state, executors, {
  maxSteps = 50, now = () => new Date().toISOString(), control = null,
  signal, checkpoint = async () => {}, maxFailures = 3,
} = {}) {
  // A failed or interrupted attempt is evidence, not permission to replay work.
  if (['failed', 'interrupted', 'done'].includes(state.status)) return state;
  const save = async () => { state.updatedAt = now(); await checkpoint(state); };
  const orphan = state.tokens.find(token => token.status === 'running');
  if (orphan) {
    orphan.status = 'interrupted';
    orphan.error = { code: 'execution_unknown', message: 'The previous execution ended without a terminal checkpoint; inspect its effects before retrying.' };
    state.status = 'interrupted';
    state.lastError = orphan.error.message;
    await save();
    return state;
  }
  state.status = 'running';
  state.pauseReason = null;
  state.yieldReason = null;
  let steps = 0;
  while (steps < maxSteps) {
    if (signal?.aborted) {
      state.status = 'interrupted';
      state.lastError = 'Execution cancelled; completed nodes will not be replayed.';
      await save();
      return state;
    }
    // Read the persisted switch at every safe point, including repair loops.
    const currentControl = typeof control === 'function' ? await control() : control;
    if (currentControl?.continuous !== false) {
      for (const token of state.tokens) {
        const node = state.definition.nodes.find(candidate => candidate.id === token.nodeId);
        if (token.status === 'waiting' && node?.type === 'gate' && token.reason === 'gate_paused') {
          token.status = 'ready';
          token.reason = null;
          token.updatedAt = now();
        }
      }
    }
    const token = state.tokens.find(candidate => candidate.status === 'ready');
    if (!token) break;
    const node = state.definition.nodes.find(candidate => candidate.id === token.nodeId);
    if (currentControl?.continuous === false && node?.type !== 'gate') {
      state.status = 'paused';
      state.pauseReason = 'control_off';
      await save();
      return state;
    }
    steps += 1;
    await executeToken(state, token, executors, now, currentControl, { signal, checkpoint: save, maxFailures, controlReader: control });
    refreshStatus(state);
    await save();
    if (['failed', 'interrupted'].includes(state.status)) return state;
  }
  refreshStatus(state);
  if (steps >= maxSteps && state.tokens.some(token => token.status === 'ready')) {
    state.status = 'paused';
    state.pauseReason = 'step_budget';
    state.yieldReason = 'step_budget';
  }
  await save();
  return state;
}

/** Decide a waiting human node; then the caller can run again. */
export function decide(state, { tokenId, outcome, output = null, now = new Date().toISOString() }) {
  const token = state.tokens.find(candidate => candidate.id === tokenId);
  if (!token || token.status !== 'waiting') throw new RuntimeError('not_waiting', `token ${tokenId} is not waiting`);
  const node = state.definition.nodes.find(candidate => candidate.id === token.nodeId);
  if (node?.type !== 'human') {
    const subject = node ? `${node.type} node "${node.id}"` : 'an unknown node';
    throw new RuntimeError('not_decidable', `token ${tokenId} is not a human decision: it belongs to ${subject}`);
  }
  const allowed = humanOutcomes(node);
  if (!allowed.includes(outcome)) throw new RuntimeError('unknown_outcome', `expected one of ${allowed.join(', ')}`);
  completeToken(state, token, { outcome, output }, () => now);
  followEdges(state, token, outcome, () => now);
  state.updatedAt = now;
  refreshStatus(state);
  return state;
}

export function humanOutcomes(node) {
  const configured = node?.config?.outcomes;
  return Array.isArray(configured) && configured.length > 0 ? configured : ['approve', 'reject'];
}

/** Raw waiting tokens, including internal fan-out join tokens; use waitingHumanTokens for decisions. */
export function waitingTokens(state) {
  return state.tokens.filter(token => token.status === 'waiting');
}

/**
 * Waiting tokens that need a human decision. Join tokens wait internally for
 * their branches and are deliberately excluded.
 */
export function waitingHumanTokens(state) {
  const humanNodes = new Set(state.definition.nodes.filter(node => node.type === 'human').map(node => node.id));
  return waitingTokens(state).filter(token => humanNodes.has(token.nodeId));
}

async function executeToken(state, token, executors, now, control = null, { signal, checkpoint = async () => {}, maxFailures = 3, controlReader = control } = {}) {
  const node = state.definition.nodes.find(candidate => candidate.id === token.nodeId);
  if (!node) throw new RuntimeError('unknown_node', `token ${token.id} references unknown node ${token.nodeId}`);
  token.status = 'running';
  token.attempt += 1;
  token.updatedAt = now();
  state.currentNode = node.id;
  // Persist the running marker BEFORE launching a child or a command.
  await checkpoint(state);
  try {
    signal?.throwIfAborted();
    if (node.type === 'human') {
      token.status = 'waiting';
      token.updatedAt = now();
      return;
    }
    if (node.type === 'gate') {
      if (control?.continuous === false) {
        token.status = 'waiting';
        token.reason = 'gate_paused';
        token.updatedAt = now();
        return;
      }
      if (node.config.newCycle === true) {
        const index = (state.context.cycle?.index ?? 0) + 1;
        if (index > 1) {
          for (const key of node.config.consumeInput ?? []) delete state.context.input[key];
          state.context.nodes = {};
          state.failureStreaks = {};
        }
        state.context.cycle = { index };
      }
      completeToken(state, token, { outcome: 'complete', output: null }, now);
      followEdges(state, token, 'complete', now);
      return;
    }
    if (node.type === 'fanout') {
      executeFanout(state, token, node, now);
      return;
    }
    if (node.type === 'join') {
      // A join token is created by fanout and becomes ready when children arrive.
      completeToken(state, token, { outcome: 'complete', output: token.outputs ?? [] }, now);
      followEdges(state, token, 'complete', now);
      return;
    }
    if (node.type === 'subworkflow') {
      const childDefinition = node.config.definition;
      const childInput = token.input;
      const child = newRunState({ definition: childDefinition, permissions: state.permissions, input: childInput, cwd: state.cwd, now: now() });
      token.childRun = child;
      await checkpoint(state);
      await run(child, executors, { maxSteps: 100, now, control: controlReader, signal, maxFailures, checkpoint: () => checkpoint(state) });
      if (child.status !== 'done') {
        throw new RuntimeError('subworkflow_not_done', `subworkflow ${node.id} ended as ${child.status}`);
      }
      const output = { context: child.context, tokens: child.tokens };
      completeToken(state, token, { outcome: 'complete', output }, now);
      followEdges(state, token, 'complete', now);
      return;
    }

    const input = token.input;
    let result;
    if (node.type === 'agent') {
      if (!executors.agent) throw new RuntimeError('no_executor', 'no agent executor is mounted');
      result = await executors.agent({ node, input, context: state.context, token, definition: state.definition, permissions: state.permissions });
    } else if (node.type === 'command') {
      requirePermission(state.permissions.command, node.config.command, 'command');
      if (!executors.command) throw new RuntimeError('no_executor', 'no command executor is mounted');
      result = await executors.command({ node, input, context: state.context, token, definition: state.definition });
    } else if (node.type === 'http') {
      requireHttpPermission(state.permissions.http, node.config.url);
      if (!executors.http) throw new RuntimeError('no_executor', 'no http executor is mounted');
      result = await executors.http({ node, input, context: state.context, token, definition: state.definition });
    } else {
      throw new RuntimeError('unknown_node_type', `unsupported node type ${node.type}`);
    }
    const outcome = typeof result?.outcome === 'string' && result.outcome !== ''
      ? result.outcome
      : node.type === 'agent' ? (node.config.outcome ?? 'complete') : 'complete';
    // Preserve failing evidence even when no repair edge exists. Count failure
    // visits across fresh tokens, not token.attempt (which resets on each edge).
    state.failureStreaks ??= {};
    const failedOutcome = outcome === 'fail' || outcome === 'needs_revision';
    state.failureStreaks[node.id] = failedOutcome ? (state.failureStreaks[node.id] || 0) + 1 : 0;
    token.outcome = outcome;
    token.output = result?.output ?? null;
    token.model = result?.model ?? null;
    const limit = Math.max(1, Number(node.config.maxFailures) || maxFailures);
    if (failedOutcome && state.failureStreaks[node.id] >= limit) {
      token.status = 'failed';
      token.error = { code: 'failure_budget_exhausted', message: `Node ${node.id} failed ${limit} times without a passing verification. Inspect its command, cwd and last output before retrying.` };
      token.updatedAt = now();
      return;
    }
    if (outcome === 'fail' && !state.definition.edges.some(edge => edge.from === node.id && edge.on === 'fail')) {
      token.status = 'failed';
      token.error = { code: 'unhandled_failure', message: `node ${node.id} returned fail and has no fail edge` };
      token.updatedAt = now();
      return;
    }
    completeToken(state, token, { outcome, output: result?.output ?? null, model: result?.model ?? null }, now);
    followEdges(state, token, outcome, now);
  } catch (error) {
    if (signal?.aborted || error?.code === 'execution_aborted' || error?.name === 'AbortError') {
      token.status = 'interrupted';
      token.error = { code: 'execution_aborted', message: error?.message || 'Execution cancelled; inspect side effects before retrying.' };
      token.updatedAt = now();
      state.status = 'interrupted';
      state.lastError = token.error.message;
      return;
    }
    if (error instanceof PermissionError) {
      token.status = 'failed';
      token.error = { code: error.code, message: error.message };
      token.updatedAt = now();
      return;
    }
    const maxAttempts = node.type === 'agent' || node.type === 'command' || node.type === 'http'
      ? Math.max(1, Number(node.config.attempts) || 1)
      : 1;
    const nonRetryable = ['no_executor', 'invalid_command_cwd', 'invalid_agent_output', 'execution_timeout', 'activity_persistence_failed', 'activation_disposal_failed'];
    if (token.attempt < maxAttempts && !nonRetryable.includes(error?.code)) {
      token.status = 'ready';
      token.error = { code: error.code ?? 'execution_failed', message: error.message ?? String(error) };
      token.updatedAt = now();
      return;
    }
    token.status = 'failed';
    token.error = { code: error.code ?? 'execution_failed', message: error.message ?? String(error) };
    token.updatedAt = now();
  }
}

function executeFanout(state, token, node, now) {
  const resolved = resolveValue(node.config.items, scopeOf(state, token));
  if (!Array.isArray(resolved)) {
    throw new RuntimeError('invalid_fanout', `fanout ${node.id} items did not resolve to an array`);
  }
  const joinNode = state.definition.nodes.find(candidate => candidate.id === node.config.join);
  if (!joinNode || joinNode.type !== 'join') throw new RuntimeError('invalid_fanout', `fanout ${node.id} join is not a join node`);
  const target = state.definition.nodes.find(candidate => candidate.id === node.config.target);
  if (!target) throw new RuntimeError('invalid_fanout', `fanout ${node.id} target does not exist`);
  const mode = joinNode.config.mode ?? 'all';
  const threshold = mode === 'any' ? 1 : mode === 'quorum' ? Math.max(1, Number(joinNode.config.count) || 1) : resolved.length;
  const joinToken = makeToken(joinNode, {}, now());
  joinToken.status = 'waiting';
  joinToken.expected = resolved.length;
  joinToken.threshold = Math.min(threshold, resolved.length);
  joinToken.mode = mode;
  joinToken.outputs = [];
  joinToken.fanoutId = token.id;
  state.tokens.push(joinToken);
  state.fanouts[token.id] = { joinTokenId: joinToken.id, expected: resolved.length };
  if (resolved.length === 0) joinToken.status = 'ready';
  for (const [index, item] of resolved.entries()) {
    const child = makeToken(target, resolveInputs(target, state, token, { item, index }), now());
    child.branch = { fanoutId: token.id, joinTokenId: joinToken.id, index, item };
    child.joinTokenId = joinToken.id;
    state.tokens.push(child);
  }
  completeToken(state, token, { outcome: 'complete', output: resolved }, now);
  followEdges(state, token, 'complete', now);
}

function completeToken(state, token, { outcome, output, model = null }, now = () => new Date().toISOString()) {
  token.status = 'completed';
  token.outcome = outcome;
  token.output = output ?? null;
  token.model = model ?? null;
  token.updatedAt = now();
  const node = state.definition.nodes.find(candidate => candidate.id === token.nodeId);
  state.context.nodes[node?.id ?? token.nodeId] = { outcome, output: output ?? null, model: model ?? null };
  if (token.joinTokenId) registerJoinArrival(state, token);
}

function registerJoinArrival(state, token) {
  const joinToken = state.tokens.find(candidate => candidate.id === token.joinTokenId);
  if (!joinToken || joinToken.status !== 'waiting') return;
  joinToken.outputs = [...(joinToken.outputs ?? []), { branch: token.branch, outcome: token.outcome, output: token.output }];
  joinToken.received = joinToken.outputs.length;
  if (joinToken.received >= joinToken.threshold) joinToken.status = 'ready';
}

function followEdges(state, token, outcome, now) {
  const edges = state.definition.edges.filter(edge => edge.from === token.nodeId && edge.on === outcome);
  for (const edge of edges) {
    const target = state.definition.nodes.find(candidate => candidate.id === edge.to);
    if (!target) throw new RuntimeError('unknown_node', `edge targets unknown node ${edge.to}`);
    const next = makeToken(target, resolveInputs(target, state, token), now());
    next.branch = token.branch ? structuredClone(token.branch) : null;
    state.tokens.push(next);
  }
}

function makeToken(node, input, now = new Date().toISOString()) {
  return {
    id: `token-${randomUUID()}`,
    nodeId: node.id,
    status: 'ready',
    attempt: 0,
    input: structuredClone(input),
    outcome: null,
    output: null,
    model: null,
    error: null,
    branch: null,
    joinTokenId: null,
    createdAt: now,
    updatedAt: now,
  };
}

function resolveInputs(node, state, token, extra = null) {
  const scope = scopeOf(state, token);
  if (extra) Object.assign(scope, extra);
  const result = {};
  for (const [key, value] of Object.entries(node.inputs ?? {})) {
    result[key] = resolveValue(value, scope);
  }
  return result;
}

function scopeOf(state, token) {
  return {
    input: state.context.input,
    nodes: state.context.nodes,
    artifacts: state.context.artifacts,
    context: state.context,
    item: token?.branch?.item,
    index: token?.branch?.index,
    token: token?.id ?? null,
  };
}

/** Resolve "$input", "$nodes.req.output", "$item", "$index" or nested paths. */
export function resolveValue(value, scope) {
  if (typeof value === 'string' && value.startsWith('$')) {
    const path = value.slice(1).split('.').filter(Boolean);
    let current = scope;
    for (const segment of path) {
      if (current === null || current === undefined) return undefined;
      current = current[segment];
    }
    return current;
  }
  if (Array.isArray(value)) return value.map(entry => resolveValue(entry, scope));
  if (value !== null && typeof value === 'object') {
    const output = {};
    for (const [key, entry] of Object.entries(value)) output[key] = resolveValue(entry, scope);
    return output;
  }
  return value;
}

function requirePermission(grant, subject, label) {
  if (grant.mode === 'full') return;
  if (grant.mode === 'allowlist' && grant.allow.some(entry => subject === entry || subject.startsWith(`${entry} `))) return;
  throw new PermissionError(`${label} is not granted: ${subject}`);
}

function requireHttpPermission(grant, url) {
  if (grant.mode === 'full') return;
  let host;
  try {
    host = new URL(url).host;
  } catch {
    throw new PermissionError(`invalid URL: ${url}`);
  }
  const allowed = grant.mode === 'allowlist' && grant.allow.some(entry => entry === host || (entry.startsWith('*.') && host.endsWith(entry.slice(1))));
  if (!allowed) throw new PermissionError(`HTTP host is not granted: ${host}`);
}

function refreshStatus(state) {
  if (['failed', 'interrupted'].includes(state.status)) return;
  if (state.tokens.some(token => token.status === 'failed')) {
    state.status = 'failed';
    return;
  }
  if (state.tokens.some(token => token.status === 'ready' || token.status === 'running')) {
    state.status = 'running';
    return;
  }
  if (state.tokens.some(token => token.status === 'waiting')) {
    state.status = 'waiting';
    return;
  }
  state.status = 'done';
}
