/**
 * v2 workflow definition: a node graph.
 *
 * Nodes are typed executors; edges select the next node by outcome. A
 * definition is pure data and carries no host-specific behavior. Permissions
 * are granted separately at creation time and are never widened by a
 * definition.
 */

export const API_VERSION = 2;
export const NODE_TYPES = ['agent', 'command', 'http', 'human', 'fanout', 'join', 'subworkflow'];
const JOIN_MODES = ['all', 'any', 'quorum'];
const TOP_KEYS = ['apiVersion', 'name', 'description', 'entry', 'providers', 'nodes', 'edges'];
const NODE_KEYS = ['id', 'type', 'title', 'role', 'inputs', 'config'];
const EDGE_KEYS = ['from', 'to', 'on'];
const PROVIDER_KEYS = ['id', 'adapter', 'model', 'reasoningEffort', 'maxTokens'];

export class DefinitionError extends Error {
  constructor(errors) {
    super(`Invalid v2 workflow definition:\n${errors.map(entry => `  ${entry.path}: ${entry.message}`).join('\n')}`);
    this.name = 'DefinitionError';
    this.code = 'invalid_definition';
    this.errors = errors;
  }
}

export function normalizeDefinition(raw, { depth = 0 } = {}) {
  if (depth > 8) throw new DefinitionError([{ path: '$', message: 'subworkflow nesting is too deep' }]);
  const errors = [];
  if (!isObject(raw)) throw new DefinitionError([{ path: '$', message: 'must be a JSON object' }]);
  checkKeys(raw, TOP_KEYS, '$', errors);
  if (raw.apiVersion !== API_VERSION) {
    errors.push({ path: '$.apiVersion', message: `must be ${API_VERSION}` });
  }
  const name = text(raw.name, '$.name', errors, 120);
  const description = raw.description === undefined || raw.description === null || raw.description === ''
    ? ''
    : text(raw.description, '$.description', errors, 2000);
  const providers = readProviders(raw.providers, errors);
  const nodes = readNodes(raw.nodes, errors, depth);
  const nodeIds = new Set(nodes.map(node => node.id));
  if (nodes.length > 0) {
    const entry = raw.entry === undefined ? nodes[0].id : text(raw.entry, '$.entry', errors);
    if (!nodeIds.has(entry)) errors.push({ path: '$.entry', message: `unknown node "${entry}"` });
    const edges = readEdges(raw.edges, nodes, nodeIds, errors);
    if (edges.length === 0 && nodes.length > 1) errors.push({ path: '$.edges', message: 'a multi-node graph needs edges' });
    if (!nodes.some(node => edges.every(edge => edge.from !== node.id))) {
      errors.push({ path: '$.nodes', message: 'needs at least one terminal node (no outgoing edge)' });
    }
    if (errors.length > 0) throw new DefinitionError(errors);
    return { apiVersion: API_VERSION, name, description, entry, providers, nodes, edges };
  }
  if (errors.length > 0) throw new DefinitionError(errors);
  return { apiVersion: API_VERSION, name, description, entry: null, providers, nodes, edges: [] };
}

/** Short human summary; used by define/status and the panel. */
export function describeDefinition(definition) {
  const lines = [
    `${definition.name} (v2 node graph)`,
    `entry: ${definition.entry}`,
    `nodes: ${definition.nodes.length}, edges: ${definition.edges.length}`,
  ];
  for (const node of definition.nodes) {
    const detail = node.type === 'agent'
      ? `role=${node.role ?? '-'} lane=${node.config.lane ?? '-'}`
      : node.type === 'fanout'
        ? `→${node.config.target} join=${node.config.join}`
        : node.type === 'join'
          ? `mode=${node.config.mode}`
          : '';
    lines.push(`  ${node.id} [${node.type}] ${node.title ?? ''}${detail ? ` (${detail})` : ''}`);
  }
  return lines.join('\n');
}

function readProviders(raw, errors) {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    errors.push({ path: '$.providers', message: 'must be an array' });
    return [];
  }
  return raw.flatMap((value, index) => {
    const path = `$.providers[${index}]`;
    if (!isObject(value)) {
      errors.push({ path, message: 'must be an object' });
      return [];
    }
    checkKeys(value, PROVIDER_KEYS, path, errors);
    const id = text(value.id, `${path}.id`, errors, 80);
    if (!id) return [];
    return [{
      id,
      adapter: value.adapter === undefined || value.adapter === null ? null : text(value.adapter, `${path}.adapter`, errors, 120),
      model: value.model === undefined || value.model === null ? null : text(value.model, `${path}.model`, errors, 200),
      reasoningEffort: value.reasoningEffort === undefined || value.reasoningEffort === null ? null : text(value.reasoningEffort, `${path}.reasoningEffort`, errors, 80),
      maxTokens: value.maxTokens === undefined || value.maxTokens === null ? null : integer(value.maxTokens, `${path}.maxTokens`, errors, 1, 1_000_000),
    }];
  });
}

function readNodes(raw, errors, depth) {
  if (!Array.isArray(raw) || raw.length === 0) {
    errors.push({ path: '$.nodes', message: 'must be a non-empty array' });
    return [];
  }
  const nodes = [];
  const seen = new Set();
  for (const [index, value] of raw.entries()) {
    const path = `$.nodes[${index}]`;
    if (!isObject(value)) {
      errors.push({ path, message: 'must be an object' });
      continue;
    }
    checkKeys(value, NODE_KEYS, path, errors);
    const id = text(value.id, `${path}.id`, errors, 80);
    if (!id) continue;
    if (seen.has(id)) {
      errors.push({ path: `${path}.id`, message: `duplicate node "${id}"` });
      continue;
    }
    seen.add(id);
    const type = value.type;
    if (!NODE_TYPES.includes(type)) {
      errors.push({ path: `${path}.type`, message: `must be one of ${NODE_TYPES.join(', ')}` });
      continue;
    }
    const inputs = value.inputs === undefined ? {} : (isObject(value.inputs) ? value.inputs : (errors.push({ path: `${path}.inputs`, message: 'must be an object' }), {}));
    const config = value.config === undefined ? {} : (isObject(value.config) ? value.config : (errors.push({ path: `${path}.config`, message: 'must be an object' }), {}));
    const role = value.role === undefined || value.role === null ? null : text(value.role, `${path}.role`, errors, 80);
    const title = value.title === undefined || value.title === null ? null : text(value.title, `${path}.title`, errors, 200);
    const node = { id, type, title, role, inputs: { ...inputs }, config: { ...config } };
    validateNodeConfig(node, path, errors, depth);
    nodes.push(node);
  }
  return nodes;
}

function validateNodeConfig(node, path, errors, depth) {
  const config = node.config;
  if (node.type === 'agent') {
    if (config.prompt !== undefined) text(config.prompt, `${path}.config.prompt`, errors, 20_000);
    if (config.lane !== undefined) text(config.lane, `${path}.config.lane`, errors, 80);
    if (config.provider !== undefined) text(config.provider, `${path}.config.provider`, errors, 120);
    if (config.model !== undefined) text(config.model, `${path}.config.model`, errors, 200);
    if (config.outcome !== undefined) text(config.outcome, `${path}.config.outcome`, errors, 80);
  } else if (node.type === 'command') {
    if (config.command === undefined) errors.push({ path: `${path}.config.command`, message: 'is required' });
    else text(config.command, `${path}.config.command`, errors, 4000);
    if (config.cwd !== undefined) text(config.cwd, `${path}.config.cwd`, errors, 400);
    if (config.timeoutMs !== undefined) integer(config.timeoutMs, `${path}.config.timeoutMs`, errors, 100, 3_600_000);
  } else if (node.type === 'http') {
    if (config.url === undefined) errors.push({ path: `${path}.config.url`, message: 'is required' });
    else text(config.url, `${path}.config.url`, errors, 4000);
    if (config.method !== undefined) text(config.method, `${path}.config.method`, errors, 20);
  } else if (node.type === 'human') {
    if (config.title !== undefined) text(config.title, `${path}.config.title`, errors, 200);
    if (config.outcomes !== undefined && (!Array.isArray(config.outcomes) || config.outcomes.some(item => typeof item !== 'string'))) {
      errors.push({ path: `${path}.config.outcomes`, message: 'must be an array of strings' });
    }
  } else if (node.type === 'fanout') {
    if (!node.config.items) errors.push({ path: `${path}.config.items`, message: 'is required' });
    else text(node.config.items, `${path}.config.items`, errors, 400);
    if (!node.config.target) errors.push({ path: `${path}.config.target`, message: 'is required' });
    else text(node.config.target, `${path}.config.target`, errors, 80);
    if (!node.config.join) errors.push({ path: `${path}.config.join`, message: 'is required' });
    else text(node.config.join, `${path}.config.join`, errors, 80);
  } else if (node.type === 'join') {
    const mode = config.mode ?? 'all';
    if (!JOIN_MODES.includes(mode)) errors.push({ path: `${path}.config.mode`, message: `must be one of ${JOIN_MODES.join(', ')}` });
    if (mode === 'quorum' && config.count === undefined) errors.push({ path: `${path}.config.count`, message: 'is required for quorum' });
    if (config.count !== undefined) integer(config.count, `${path}.config.count`, errors, 1, 10_000);
  } else if (node.type === 'subworkflow') {
    if (!isObject(config.definition)) {
      errors.push({ path: `${path}.config.definition`, message: 'must be a workflow object' });
      return;
    }
    const child = normalizeDefinition(config.definition, { depth: depth + 1 });
    node.config = { ...config, definition: child };
  }
}

function readEdges(raw, nodes, nodeIds, errors) {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    errors.push({ path: '$.edges', message: 'must be an array' });
    return [];
  }
  return raw.flatMap((value, index) => {
    const path = `$.edges[${index}]`;
    if (!isObject(value)) {
      errors.push({ path, message: 'must be an object' });
      return [];
    }
    checkKeys(value, EDGE_KEYS, path, errors);
    const from = text(value.from, `${path}.from`, errors, 80);
    const to = text(value.to, `${path}.to`, errors, 80);
    const on = value.on === undefined ? 'complete' : text(value.on, `${path}.on`, errors, 80);
    if (!nodeIds.has(from)) errors.push({ path: `${path}.from`, message: `unknown node "${from}"` });
    if (!nodeIds.has(to)) errors.push({ path: `${path}.to`, message: `unknown node "${to}"` });
    return from && to ? [{ from, to, on }] : [];
  });
}

function checkKeys(value, allowed, path, errors) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) errors.push({ path: `${path}.${key}`, message: 'is not a known field' });
  }
}

function text(value, path, errors, max) {
  if (typeof value !== 'string' || value.trim() === '') {
    errors.push({ path, message: 'must be a non-empty string' });
    return '';
  }
  if (max !== undefined && value.length > max) errors.push({ path, message: `must be at most ${max} characters` });
  return value;
}

function integer(value, path, errors, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    errors.push({ path, message: `must be an integer between ${min} and ${max}` });
    return undefined;
  }
  return value;
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
