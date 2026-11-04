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

export function newRunState({ definition, permissions, input = {}, now = new Date().toISOString() }) {
  const state = {
    version: 2,
    runId: `run-${randomUUID()}`,
    definition,
    permissions: normalizePermissions(permissions),
    status: 'running',
    context: { input, nodes: {}, artifacts: {} },
    tokens: [],
    fanouts: {},
    createdAt: now,
    updatedAt: now,
  };
  const entry = definition.nodes.find(node => node.id === definition.entry);
  if (!entry) throw new RuntimeError('no_entry', 'definition has no entry node');
  state.tokens.push(makeToken(entry, resolveInputs(entry, state, null)));
  refreshStatus(state);
  return state;
}

/** Process ready tokens until the run waits for a human/join or a step budget is hit. */
export async function run(state, executors, { maxSteps = 50, now = () => new Date().toISOString() } = {}) {
  let steps = 0;
  while (steps < maxSteps) {
    const token = state.tokens.find(candidate => candidate.status === 'ready');
    if (!token) break;
    steps += 1;
    await executeToken(state, token, executors, now);
    refreshStatus(state);
    state.updatedAt = now();
    if (state.status === 'failed') break;
  }
  if (steps >= maxSteps && state.tokens.some(token => token.status === 'ready')) {
    throw new RuntimeError('step_budget', `workflow did not settle within ${maxSteps} steps`);
  }
  refreshStatus(state);
  state.updatedAt = now();
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
  completeToken(state, token, { outcome, output });
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

async function executeToken(state, token, executors, now) {
  const node = state.definition.nodes.find(candidate => candidate.id === token.nodeId);
  if (!node) throw new RuntimeError('unknown_node', `token ${token.id} references unknown node ${token.nodeId}`);
  token.status = 'running';
  token.attempt += 1;
  token.updatedAt = now();
  try {
    if (node.type === 'human') {
      token.status = 'waiting';
      token.updatedAt = now();
      return;
    }
    if (node.type === 'fanout') {
      executeFanout(state, token, node, now);
      return;
    }
    if (node.type === 'join') {
      // A join token is created by fanout and becomes ready when children arrive.
      completeToken(state, token, { outcome: 'complete', output: token.outputs ?? [] });
      followEdges(state, token, 'complete', now);
      return;
    }
    if (node.type === 'subworkflow') {
      const childDefinition = node.config.definition;
      const childInput = resolveInputs(node, state, token);
      const child = newRunState({ definition: childDefinition, permissions: state.permissions, input: childInput, now: now() });
      await run(child, executors, { maxSteps: 100, now });
      if (child.status !== 'done') {
        throw new RuntimeError('subworkflow_not_done', `subworkflow ${node.id} ended as ${child.status}`);
      }
      const output = { context: child.context, tokens: child.tokens };
      completeToken(state, token, { outcome: 'complete', output });
      followEdges(state, token, 'complete', now);
      return;
    }

    const input = resolveInputs(node, state, token);
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
    if (outcome === 'fail' && !state.definition.edges.some(edge => edge.from === node.id && edge.on === 'fail')) {
      token.status = 'failed';
      token.error = { code: 'unhandled_failure', message: `node ${node.id} returned fail and has no fail edge` };
      token.updatedAt = now();
      return;
    }
    completeToken(state, token, { outcome, output: result?.output ?? null });
    followEdges(state, token, outcome, now);
  } catch (error) {
    if (error instanceof PermissionError) {
      token.status = 'failed';
      token.error = { code: error.code, message: error.message };
      token.updatedAt = now();
      return;
    }
    const maxAttempts = node.type === 'agent' || node.type === 'command' || node.type === 'http'
      ? Math.max(1, Number(node.config.attempts) || 1)
      : 1;
    if (token.attempt < maxAttempts && !(error instanceof RuntimeError && error.code === 'no_executor')) {
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
  const joinToken = makeToken(joinNode, {});
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
    const child = makeToken(target, resolveInputs(target, state, token, { item, index }));
    child.branch = { fanoutId: token.id, joinTokenId: joinToken.id, index, item };
    child.joinTokenId = joinToken.id;
    state.tokens.push(child);
  }
  completeToken(state, token, { outcome: 'complete', output: resolved });
  followEdges(state, token, 'complete', now);
}

function completeToken(state, token, { outcome, output }) {
  token.status = 'completed';
  token.outcome = outcome;
  token.output = output ?? null;
  token.updatedAt = new Date().toISOString();
  const node = state.definition.nodes.find(candidate => candidate.id === token.nodeId);
  state.context.nodes[node?.id ?? token.nodeId] = { outcome, output: output ?? null };
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
    const next = makeToken(target, resolveInputs(target, state, token));
    state.tokens.push(next);
  }
}

function makeToken(node, input) {
  return {
    id: `token-${randomUUID()}`,
    nodeId: node.id,
    status: 'ready',
    attempt: 0,
    input,
    outcome: null,
    output: null,
    error: null,
    branch: null,
    joinTokenId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
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
  if (state.status === 'failed') return;
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
