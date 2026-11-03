/**
 * Workflow definition schema, validation and normalization.
 *
 * A definition is pure data: roles, stages, gates, sources, providers and
 * policies. Nothing here knows about a concrete host, model vendor, repository
 * or merge process. The same definition can be rendered by the CLI, executed by
 * the scheduler and stored in the event log.
 */

export const API_VERSION = 1;

const ROLE_KINDS = ['worker', 'reviewer', 'coordinator'];
const GATE_KINDS = ['manual', 'external', 'auto'];
const SOURCE_KINDS = ['manual', 'file', 'github-issues'];
const WORKDIR_KINDS = ['repo', 'worktree', 'temp'];
const EXECUTOR_KINDS = ['agent', 'external'];

const TOP_LEVEL_KEYS = [
  'apiVersion', 'name', 'description', 'entry', 'roles', 'providers',
  'stages', 'gates', 'sources', 'policies',
];
const ROLE_KEYS = ['id', 'kind', 'instances', 'capacity', 'providers', 'prompt', 'tools', 'workdir'];
const PROVIDER_KEYS = ['id', 'adapter', 'model', 'reasoningEffort', 'maxTokens', 'concurrency', 'lowWatermarkPct', 'backoffMinutes', 'quota'];
const STAGE_KEYS = ['id', 'role', 'title', 'executor', 'requires', 'options', 'on', 'maxAttempts', 'providers'];
const GATE_KEYS = ['id', 'after', 'outcome', 'kind', 'signal', 'required'];
const SOURCE_KEYS = ['id', 'kind', 'path'];
const POLICY_KEYS = ['concurrency', 'provider', 'fallback', 'review', 'retry', 'scheduler'];
const CONCURRENCY_KEYS = ['global'];
const PROVIDER_POLICY_KEYS = ['lowWatermarkPct', 'backoffMinutes', 'maxRetries'];
const FALLBACK_KEYS = ['sameRole'];
const REVIEW_KEYS = ['maxRounds'];
const RETRY_KEYS = ['maxAttempts', 'backoffSeconds'];
const SCHEDULER_KEYS = ['intervalSeconds', 'starvationTicks'];
const QUOTA_KEYS = ['windowHours', 'budgetUsd'];

/** A definition failed validation. `errors` is the machine-readable detail. */
export class DefinitionError extends Error {
  constructor(errors) {
    const detail = errors.map(entry => `  ${entry.path}: ${entry.message}`).join('\n');
    super(`Invalid workflow definition:\n${detail}`);
    this.name = 'DefinitionError';
    this.code = 'invalid_definition';
    this.errors = errors;
  }
}

/** Validate and normalize a raw definition object. Throws DefinitionError. */
export function normalizeDefinition(raw) {
  const errors = [];
  if (!isPlainObject(raw)) {
    throw new DefinitionError([{ path: '$', message: 'must be a JSON object' }]);
  }
  checkKeys(raw, TOP_LEVEL_KEYS, '$', errors);

  if (raw.apiVersion !== API_VERSION) {
    errors.push({
      path: '$.apiVersion',
      message: `must be ${API_VERSION}; version ${JSON.stringify(raw.apiVersion)} is not supported`,
    });
  }
  const name = readString(raw.name, '$.name', errors, { max: 120 });
  const description = raw.description === undefined
    ? ''
    : readString(raw.description, '$.description', errors, { max: 2000 }) ?? '';
  if (raw.description !== undefined && typeof raw.description !== 'string') {
    errors.push({ path: '$.description', message: 'must be a string' });
  }

  const roles = readRoles(raw.roles, errors);
  const providers = readProviders(raw.providers, errors);
  const stages = readStages(raw.stages, errors);
  const roleIds = new Set(roles.map(role => role.id));
  const stageIds = new Set(stages.map(stage => stage.id));
  const providerIds = new Set(providers.map(provider => provider.id));

  checkDuplicateIds(roles, '$.roles', 'role', errors);
  checkDuplicateIds(stages, '$.stages', 'stage', errors);
  checkDuplicateIds(providers, '$.providers', 'provider', errors);

  for (const [index, stage] of stages.entries()) {
    const path = `$.stages[${index}]`;
    if (!roleIds.has(stage.role)) {
      errors.push({ path: `${path}.role`, message: `references unknown role "${stage.role}"` });
    }
    for (const [outcome, target] of Object.entries(stage.on)) {
      if (!stageIds.has(target)) {
        errors.push({ path: `${path}.on.${outcome}`, message: `references unknown stage "${target}"` });
      } else if (target === stage.id) {
        errors.push({ path: `${path}.on.${outcome}`, message: 'a stage cannot transition to itself' });
      }
    }
    if (stage.options.length > 0) {
      for (const outcome of Object.keys(stage.on)) {
        if (!stage.options.includes(outcome)) {
          errors.push({ path: `${path}.on.${outcome}`, message: `outcome "${outcome}" is not declared in options` });
        }
      }
    }
  }

  for (const [index, role] of roles.entries()) {
    for (const [providerIndex, provider] of role.providers.entries()) {
      if (!providerIds.has(provider)) {
        errors.push({
          path: `$.roles[${index}].providers[${providerIndex}]`,
          message: `references unknown provider "${provider}"`,
        });
      }
    }
  }

  for (const [index, stage] of stages.entries()) {
    for (const [providerIndex, provider] of stage.providers.entries()) {
      if (!providerIds.has(provider)) {
        errors.push({
          path: `$.stages[${index}].providers[${providerIndex}]`,
          message: `references unknown provider "${provider}"`,
        });
      }
    }
  }

  const entry = raw.entry === undefined ? stages[0]?.id : readString(raw.entry, '$.entry', errors);
  if (stages.length > 0 && !stageIds.has(entry)) {
    errors.push({ path: '$.entry', message: `references unknown stage "${entry}"` });
  }
  if (stages.length > 0) {
    checkReachability(stages, entry, errors);
    if (!stages.some(stage => Object.keys(stage.on).length === 0)) {
      errors.push({ path: '$.stages', message: 'at least one terminal stage is required (a stage without transitions)' });
    }
  }

  const gates = readGates(raw.gates, stages, errors);
  const sources = readSources(raw.sources, errors);
  const policies = readPolicies(raw.policies, errors, defaultGlobalCapacity(roles));

  if (errors.length > 0) throw new DefinitionError(errors);

  return {
    apiVersion: API_VERSION,
    name,
    description,
    entry,
    roles,
    providers,
    stages,
    gates,
    sources,
    policies,
  };
}

/** Human-readable summary used by the CLI and by definition-change reviews. */
export function describeDefinition(definition) {
  const slots = definition.roles
    .filter(role => role.kind !== 'coordinator')
    .reduce((total, role) => total + role.instances * role.capacity, 0);
  const lines = [
    `${definition.name} (apiVersion ${definition.apiVersion})`,
    `entry: ${definition.entry}`,
    `slots: ${slots} (global limit ${definition.policies.concurrency.global})`,
    'roles:',
  ];
  for (const role of definition.roles) {
    const providers = role.providers.length === 0 ? 'any provider' : role.providers.join(', ');
    lines.push(`  ${role.id} x${role.instances} (${role.kind}, ${role.capacity} task/instance, ${providers})`);
  }
  lines.push('stages:');
  for (const stage of definition.stages) {
    const outcomes = Object.entries(stage.on);
    const arrow = outcomes.length === 0
      ? 'terminal'
      : outcomes.map(([outcome, target]) => `${outcome} -> ${target}`).join(', ');
    const providers = stage.providers.length > 0 ? `, ${stage.providers.join('/')}` : '';
    const executor = stage.executor !== 'agent' ? `, ${stage.executor}` : '';
    lines.push(`  ${stage.id} [${stage.role}${providers}${executor}]: ${arrow}`);
  }
  if (definition.gates.length > 0) {
    lines.push('gates:');
    for (const gate of definition.gates) {
      const signal = gate.signal ? `, signal: ${gate.signal}` : '';
      lines.push(`  ${gate.id} after ${gate.after} (${gate.kind}${signal})`);
    }
  }
  if (definition.providers.length > 0) {
    lines.push('providers:');
    for (const provider of definition.providers) {
      const route = [provider.adapter, provider.model].filter(Boolean).join('/');
      lines.push(`  ${provider.id}${route ? ` (${route})` : ''}, concurrency ${provider.concurrency}`);
    }
  }
  return lines.join('\n');
}

/** Slot capacity a definition declares for new work (coordinator roles excluded). */
export function defaultGlobalCapacity(roles) {
  return roles
    .filter(role => role.kind !== 'coordinator')
    .reduce((total, role) => total + role.instances * role.capacity, 0);
}

function readRoles(raw, errors) {
  if (!Array.isArray(raw) || raw.length === 0) {
    errors.push({ path: '$.roles', message: 'must be a non-empty array' });
    return [];
  }
  const roles = [];
  for (const [index, value] of raw.entries()) {
    const path = `$.roles[${index}]`;
    const role = readObject(value, path, errors);
    if (!role) continue;
    checkKeys(role, ROLE_KEYS, path, errors);
    const id = readString(role.id, `${path}.id`, errors, { pattern: /^[a-z][a-z0-9-]*$/, patternHint: 'lowercase letters, digits and dashes' });
    const kind = role.kind === undefined ? 'worker' : role.kind;
    if (!ROLE_KINDS.includes(kind)) {
      errors.push({ path: `${path}.kind`, message: `must be one of ${ROLE_KINDS.join(', ')}` });
    }
    const instances = readInteger(role.instances ?? 1, `${path}.instances`, errors, { min: 1, max: 1000 });
    const capacity = readInteger(role.capacity ?? 1, `${path}.capacity`, errors, { min: 1, max: 100 });
    const providers = role.providers === undefined ? [] : readStringArray(role.providers, `${path}.providers`, errors);
    const workdir = role.workdir === undefined ? 'repo' : role.workdir;
    if (!WORKDIR_KINDS.includes(workdir)) {
      errors.push({ path: `${path}.workdir`, message: `must be one of ${WORKDIR_KINDS.join(', ')}` });
    }
    if (role.prompt !== undefined) readString(role.prompt, `${path}.prompt`, errors, { max: 20000 });
    if (role.tools !== undefined) {
      if (typeof role.tools === 'string') {
        if (role.tools.trim() === '') errors.push({ path: `${path}.tools`, message: 'must not be empty' });
      } else {
        readStringArray(role.tools, `${path}.tools`, errors);
      }
    }
    if (id) {
      roles.push({
        id,
        kind,
        instances,
        capacity,
        providers,
        prompt: typeof role.prompt === 'string' ? role.prompt : null,
        tools: role.tools ?? null,
        workdir,
      });
    }
  }
  return roles;
}

function readProviders(raw, errors) {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    errors.push({ path: '$.providers', message: 'must be an array' });
    return [];
  }
  const providers = [];
  for (const [index, value] of raw.entries()) {
    const path = `$.providers[${index}]`;
    const provider = readObject(value, path, errors);
    if (!provider) continue;
    checkKeys(provider, PROVIDER_KEYS, path, errors);
    const id = readString(provider.id, `${path}.id`, errors, { pattern: /^[a-z][a-z0-9-]*$/, patternHint: 'lowercase letters, digits and dashes' });
    const concurrency = readInteger(provider.concurrency ?? 1, `${path}.concurrency`, errors, { min: 1, max: 1000 });
    const lowWatermarkPct = provider.lowWatermarkPct === undefined
      ? undefined
      : readInteger(provider.lowWatermarkPct, `${path}.lowWatermarkPct`, errors, { min: 0, max: 100 });
    const backoffMinutes = provider.backoffMinutes === undefined
      ? undefined
      : readIntegerArray(provider.backoffMinutes, `${path}.backoffMinutes`, errors, { min: 1 });
    let quota;
    if (provider.quota !== undefined) {
      const value2 = readObject(provider.quota, `${path}.quota`, errors);
      if (value2) {
        checkKeys(value2, QUOTA_KEYS, `${path}.quota`, errors);
        quota = {
          windowHours: value2.windowHours === undefined ? null : readInteger(value2.windowHours, `${path}.quota.windowHours`, errors, { min: 1 }),
          budgetUsd: value2.budgetUsd === undefined ? null : readNumber(value2.budgetUsd, `${path}.quota.budgetUsd`, errors, { min: 0 }),
        };
      }
    }
    if (provider.adapter !== undefined) readString(provider.adapter, `${path}.adapter`, errors, { max: 120 });
    if (provider.model !== undefined) readString(provider.model, `${path}.model`, errors, { max: 200 });
    if (provider.reasoningEffort !== undefined) readString(provider.reasoningEffort, `${path}.reasoningEffort`, errors, { max: 80 });
    const maxTokens = provider.maxTokens === undefined
      ? undefined
      : readInteger(provider.maxTokens, `${path}.maxTokens`, errors, { min: 1, max: 1_000_000 });
    if (id) {
      providers.push({
        id,
        adapter: typeof provider.adapter === 'string' ? provider.adapter : null,
        model: typeof provider.model === 'string' ? provider.model : null,
        reasoningEffort: typeof provider.reasoningEffort === 'string' ? provider.reasoningEffort : null,
        maxTokens: maxTokens ?? null,
        concurrency,
        lowWatermarkPct: lowWatermarkPct ?? null,
        backoffMinutes: backoffMinutes ?? null,
        quota: quota ?? null,
      });
    }
  }
  return providers;
}

function readStages(raw, errors) {
  if (!Array.isArray(raw) || raw.length === 0) {
    errors.push({ path: '$.stages', message: 'must be a non-empty array' });
    return [];
  }
  const stages = [];
  for (const [index, value] of raw.entries()) {
    const path = `$.stages[${index}]`;
    const stage = readObject(value, path, errors);
    if (!stage) continue;
    checkKeys(stage, STAGE_KEYS, path, errors);
    const id = readString(stage.id, `${path}.id`, errors, { pattern: /^[a-z][a-z0-9-]*$/, patternHint: 'lowercase letters, digits and dashes' });
    const role = readString(stage.role, `${path}.role`, errors);
    const requires = stage.requires === undefined ? [] : readStringArray(stage.requires, `${path}.requires`, errors);
    const providers = stage.providers === undefined ? [] : readStringArray(stage.providers, `${path}.providers`, errors);
    const executor = stage.executor === undefined ? 'agent' : stage.executor;
    if (!EXECUTOR_KINDS.includes(executor)) {
      errors.push({ path: `${path}.executor`, message: `must be one of ${EXECUTOR_KINDS.join(', ')}` });
    }
    if (stage.title !== undefined) readString(stage.title, `${path}.title`, errors, { max: 200 });
    let on = {};
    if (stage.on !== undefined) {
      const value2 = readObject(stage.on, `${path}.on`, errors);
      if (value2) {
        for (const [outcome, target] of Object.entries(value2)) {
          if (outcome.trim() === '') {
            errors.push({ path: `${path}.on`, message: 'outcome names must not be empty' });
            continue;
          }
          if (typeof target !== 'string' || target.trim() === '') {
            errors.push({ path: `${path}.on.${outcome}`, message: 'must be a stage id string' });
            continue;
          }
          on[outcome] = target;
        }
      }
    }
    let options = stage.options === undefined ? Object.keys(on) : readStringArray(stage.options, `${path}.options`, errors);
    const maxAttempts = stage.maxAttempts === undefined
      ? undefined
      : readInteger(stage.maxAttempts, `${path}.maxAttempts`, errors, { min: 1, max: 100 });
    if (id) {
      stages.push({
        id,
        role,
        title: typeof stage.title === 'string' ? stage.title : null,
        executor,
        requires,
        providers,
        options,
        on,
        maxAttempts: maxAttempts ?? null,
      });
    }
  }
  return stages;
}

function readGates(raw, stages, errors) {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    errors.push({ path: '$.gates', message: 'must be an array' });
    return [];
  }
  const stageIds = new Set(stages.map(stage => stage.id));
  const gates = [];
  for (const [index, value] of raw.entries()) {
    const path = `$.gates[${index}]`;
    const gate = readObject(value, path, errors);
    if (!gate) continue;
    checkKeys(gate, GATE_KEYS, path, errors);
    const id = readString(gate.id, `${path}.id`, errors, { pattern: /^[a-z][a-z0-9-]*$/, patternHint: 'lowercase letters, digits and dashes' });
    const after = readString(gate.after, `${path}.after`, errors);
    if (after && !stageIds.has(after)) {
      errors.push({ path: `${path}.after`, message: `references unknown stage "${after}"` });
    }
    const kind = gate.kind === undefined ? 'manual' : gate.kind;
    if (!GATE_KINDS.includes(kind)) {
      errors.push({ path: `${path}.kind`, message: `must be one of ${GATE_KINDS.join(', ')}` });
    }
    let outcome = null;
    if (gate.outcome !== undefined) {
      outcome = readString(gate.outcome, `${path}.outcome`, errors);
      const stage = stages.find(candidate => candidate.id === after);
      if (stage && outcome !== null && !Object.hasOwn(stage.on, outcome)) {
        errors.push({ path: `${path}.outcome`, message: `stage "${after}" does not declare outcome "${outcome}"` });
      }
    }
    if (kind === 'external') {
      readString(gate.signal, `${path}.signal`, errors, { max: 200 });
    } else if (gate.signal !== undefined) {
      errors.push({ path: `${path}.signal`, message: 'only external gates accept a signal' });
    }
    const required = gate.required === undefined ? true : readBoolean(gate.required, `${path}.required`, errors);
    if (id) gates.push({ id, after, outcome, kind, signal: typeof gate.signal === 'string' ? gate.signal : null, required });
  }
  return gates;
}

function readSources(raw, errors) {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    errors.push({ path: '$.sources', message: 'must be an array' });
    return [];
  }
  const sources = [];
  for (const [index, value] of raw.entries()) {
    const path = `$.sources[${index}]`;
    const source = readObject(value, path, errors);
    if (!source) continue;
    checkKeys(source, SOURCE_KEYS, path, errors);
    const id = readString(source.id, `${path}.id`, errors, { pattern: /^[a-z][a-z0-9-]*$/, patternHint: 'lowercase letters, digits and dashes' });
    const kind = source.kind === undefined ? 'manual' : source.kind;
    if (!SOURCE_KINDS.includes(kind)) {
      errors.push({ path: `${path}.kind`, message: `must be one of ${SOURCE_KINDS.join(', ')}` });
    }
    const sourcePath = source.path === undefined ? null : readString(source.path, `${path}.path`, errors);
    if (kind === 'file' && sourcePath === null) {
      errors.push({ path: `${path}.path`, message: 'file sources require a path' });
    }
    if (id) sources.push({ id, kind, path: sourcePath });
  }
  return sources;
}

function readPolicies(raw, errors, defaultGlobal) {
  const value = raw === undefined ? {} : readObject(raw, '$.policies', errors);
  const policies = {
    concurrency: { global: Math.max(1, defaultGlobal) },
    provider: { lowWatermarkPct: 15, backoffMinutes: [10, 30, 60], maxRetries: 3 },
    fallback: { sameRole: true },
    review: { maxRounds: 3 },
    retry: { maxAttempts: 3, backoffSeconds: [30, 120, 300] },
    scheduler: { intervalSeconds: 60, starvationTicks: 2 },
  };
  if (!value) return policies;
  checkKeys(value, POLICY_KEYS, '$.policies', errors);

  if (value.concurrency !== undefined) {
    const concurrency = readObject(value.concurrency, '$.policies.concurrency', errors);
    if (concurrency) {
      checkKeys(concurrency, CONCURRENCY_KEYS, '$.policies.concurrency', errors);
      if (concurrency.global !== undefined) {
        policies.concurrency.global = readInteger(concurrency.global, '$.policies.concurrency.global', errors, { min: 1, max: 10000 });
      }
    }
  }
  if (value.provider !== undefined) {
    const provider = readObject(value.provider, '$.policies.provider', errors);
    if (provider) {
      checkKeys(provider, PROVIDER_POLICY_KEYS, '$.policies.provider', errors);
      if (provider.lowWatermarkPct !== undefined) {
        policies.provider.lowWatermarkPct = readInteger(provider.lowWatermarkPct, '$.policies.provider.lowWatermarkPct', errors, { min: 0, max: 100 });
      }
      if (provider.backoffMinutes !== undefined) {
        policies.provider.backoffMinutes = readIntegerArray(provider.backoffMinutes, '$.policies.provider.backoffMinutes', errors, { min: 1 });
      }
      if (provider.maxRetries !== undefined) {
        policies.provider.maxRetries = readInteger(provider.maxRetries, '$.policies.provider.maxRetries', errors, { min: 1, max: 100 });
      }
    }
  }
  if (value.fallback !== undefined) {
    const fallback = readObject(value.fallback, '$.policies.fallback', errors);
    if (fallback) {
      checkKeys(fallback, FALLBACK_KEYS, '$.policies.fallback', errors);
      if (fallback.sameRole !== undefined) {
        policies.fallback.sameRole = readBoolean(fallback.sameRole, '$.policies.fallback.sameRole', errors);
      }
    }
  }
  if (value.review !== undefined) {
    const review = readObject(value.review, '$.policies.review', errors);
    if (review) {
      checkKeys(review, REVIEW_KEYS, '$.policies.review', errors);
      if (review.maxRounds !== undefined) {
        policies.review.maxRounds = readInteger(review.maxRounds, '$.policies.review.maxRounds', errors, { min: 1, max: 100 });
      }
    }
  }
  if (value.retry !== undefined) {
    const retry = readObject(value.retry, '$.policies.retry', errors);
    if (retry) {
      checkKeys(retry, RETRY_KEYS, '$.policies.retry', errors);
      if (retry.maxAttempts !== undefined) {
        policies.retry.maxAttempts = readInteger(retry.maxAttempts, '$.policies.retry.maxAttempts', errors, { min: 1, max: 100 });
      }
      if (retry.backoffSeconds !== undefined) {
        policies.retry.backoffSeconds = readIntegerArray(retry.backoffSeconds, '$.policies.retry.backoffSeconds', errors, { min: 0 });
      }
    }
  }
  if (value.scheduler !== undefined) {
    const scheduler = readObject(value.scheduler, '$.policies.scheduler', errors);
    if (scheduler) {
      checkKeys(scheduler, SCHEDULER_KEYS, '$.policies.scheduler', errors);
      if (scheduler.intervalSeconds !== undefined) {
        policies.scheduler.intervalSeconds = readInteger(scheduler.intervalSeconds, '$.policies.scheduler.intervalSeconds', errors, { min: 1 });
      }
      if (scheduler.starvationTicks !== undefined) {
        policies.scheduler.starvationTicks = readInteger(scheduler.starvationTicks, '$.policies.scheduler.starvationTicks', errors, { min: 1, max: 100 });
      }
    }
  }
  return policies;
}

function checkReachability(stages, entry, errors) {
  const byId = new Map(stages.map(stage => [stage.id, stage]));
  const seen = new Set();
  const queue = [entry];
  while (queue.length > 0) {
    const id = queue.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    const stage = byId.get(id);
    if (!stage) continue;
    for (const target of Object.values(stage.on)) queue.push(target);
  }
  for (const stage of stages) {
    if (!seen.has(stage.id)) {
      errors.push({ path: `$.stages`, message: `stage "${stage.id}" is unreachable from entry "${entry}"` });
    }
  }
}

function checkDuplicateIds(values, path, label, errors) {
  const seen = new Map();
  for (const [index, value] of values.entries()) {
    const count = seen.get(value.id) ?? 0;
    if (count === 0) {
      seen.set(value.id, 1);
    } else {
      seen.set(value.id, count + 1);
      errors.push({ path: `${path}[${index}].id`, message: `duplicate ${label} id "${value.id}"` });
    }
  }
}

function checkKeys(object, allowed, path, errors) {
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) {
      errors.push({ path: `${path}.${key}`, message: `unknown key; allowed keys: ${allowed.join(', ')}` });
    }
  }
}

function readObject(value, path, errors) {
  if (!isPlainObject(value)) {
    errors.push({ path, message: 'must be an object' });
    return null;
  }
  return value;
}

function readString(value, path, errors, { max = 500, pattern, patternHint } = {}) {
  if (typeof value !== 'string') {
    errors.push({ path, message: 'must be a non-empty string' });
    return null;
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    errors.push({ path, message: 'must not be empty' });
    return null;
  }
  if (trimmed.length > max) {
    errors.push({ path, message: `must be at most ${max} characters` });
    return null;
  }
  if (pattern && !pattern.test(trimmed)) {
    errors.push({ path, message: `must use ${patternHint ?? 'the expected format'}` });
    return null;
  }
  return trimmed;
}

function readStringArray(value, path, errors) {
  if (!Array.isArray(value)) {
    errors.push({ path, message: 'must be an array of strings' });
    return [];
  }
  const result = [];
  for (const [index, item] of value.entries()) {
    if (typeof item !== 'string' || item.trim() === '') {
      errors.push({ path: `${path}[${index}]`, message: 'must be a non-empty string' });
      continue;
    }
    result.push(item.trim());
  }
  return result;
}

function readInteger(value, path, errors, { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    errors.push({ path, message: 'must be an integer' });
    return min;
  }
  if (value < min || value > max) {
    errors.push({ path, message: `must be between ${min} and ${max}` });
    return min;
  }
  return value;
}

function readIntegerArray(value, path, errors, options) {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push({ path, message: 'must be a non-empty array of positive integers' });
    return [];
  }
  return value.map((item, index) => readInteger(item, `${path}[${index}]`, errors, options));
}

function readNumber(value, path, errors, { min = Number.MIN_SAFE_INTEGER } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    errors.push({ path, message: 'must be a finite number' });
    return min;
  }
  if (value < min) {
    errors.push({ path, message: `must be at least ${min}` });
    return min;
  }
  return value;
}

function readBoolean(value, path, errors) {
  if (typeof value !== 'boolean') {
    errors.push({ path, message: 'must be a boolean' });
    return true;
  }
  return value;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
