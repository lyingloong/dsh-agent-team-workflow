#!/usr/bin/env node
/**
 * `agent-team-workflow` command line: validate a workflow definition, record it, inspect
 * projected state and run the scheduler against synthetic tasks.
 *
 * The CLI is intentionally thin. Every command reads or writes the same event
 * store a host integration would use.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DefinitionError, describeDefinition, normalizeDefinition } from './definition.mjs';
import { Store } from './store.mjs';
import { LockError, acquireLock, readLock } from './lock.mjs';
import { Engine, EngineError } from './engine.mjs';
import { buildStatus, formatRoster, formatStatus } from './status.mjs';
import { simulate } from './scheduler.mjs';
import { dataPaths, defaultDataDir, ensureDataDir } from './paths.mjs';
import { startBoardServer } from './board/server.mjs';

const USAGE = `agent-team-workflow — resumable, provider-aware workflow engine for agent teams

usage:
  agent-team-workflow validate <workflow.json> [--json]
  agent-team-workflow define <workflow.json> [--data DIR]
  agent-team-workflow status [--data DIR] [--json]
  agent-team-workflow roster [--data DIR] [--json]
  agent-team-workflow events [--data DIR] [--limit N]
  agent-team-workflow rebuild [--data DIR]
  agent-team-workflow simulate <workflow.json> [--tasks tasks.json] [--ticks N] [--json]
  agent-team-workflow init [workflow.json] [--force]
  agent-team-workflow board [--data DIR] [--port N] [--host H]

work:
  agent-team-workflow enqueue <title> [--kind K] [--priority N] [--input JSON] [--json]
  agent-team-workflow claim --role ROLE [--member M] [--provider P] [--json]
  agent-team-workflow complete --attempt ID [--outcome NAME] [--result JSON] [--json]
  agent-team-workflow fail --attempt ID [--error TEXT] [--no-retry] [--provider-error] [--json]
  agent-team-workflow gate --item ID --gate NAME --decision approve|reject [--by WHO] [--note TEXT]
  agent-team-workflow expire [--json]

State lives outside the repository:
  default  ${defaultDataDir()}
  override --data DIR or AGENT_TEAM_WORKFLOW_DATA
`;

class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

/** Run one CLI invocation. Returns the process exit code. */
export function main(argv, { stdout = console.log, stderr = console.error, cwd = process.cwd(), env = process.env } = {}) {
  try {
    const { flags, positional } = parseArgs(argv);
    const [command, ...rest] = positional;
    if (flags.help || command === undefined || command === 'help') {
      stdout(USAGE.trimEnd());
      return 0;
    }
    switch (command) {
      case 'version': {
        stdout(readVersion());
        return 0;
      }
      case 'validate':
        return commandValidate(rest, flags, { stdout, cwd });
      case 'define':
        return commandDefine(rest, flags, { stdout, cwd, env });
      case 'status':
        return commandStatus(flags, { stdout, env }, 'status');
      case 'roster':
        return commandStatus(flags, { stdout, env }, 'roster');
      case 'events':
        return commandEvents(flags, { stdout, env });
      case 'rebuild':
        return commandRebuild(flags, { stdout, env });
      case 'simulate':
        return commandSimulate(rest, flags, { stdout, cwd });
      case 'init':
        return commandInit(rest, flags, { stdout, cwd });
      case 'board':
        return commandBoard(flags, { stdout, stderr, env });
      case 'enqueue':
        return commandEnqueue(rest, flags, { stdout, env });
      case 'claim':
        return commandClaim(flags, { stdout, env });
      case 'complete':
        return commandComplete(flags, { stdout, env });
      case 'fail':
        return commandFail(flags, { stdout, env });
      case 'gate':
        return commandGate(flags, { stdout, env });
      case 'expire':
        return commandExpire(flags, { stdout, env });
      default:
        throw new UsageError(`unknown command "${command}"`);
    }
  } catch (error) {
    if (error instanceof UsageError) {
      stderr(`agent-team-workflow: ${error.message}`);
      stderr(USAGE.trimEnd());
      return 2;
    }
    if (error instanceof DefinitionError) {
      stderr(error.message);
      return 1;
    }
    if (error instanceof LockError) {
      stderr(`agent-team-workflow: ${error.message}`);
      stderr('hint: stop the running coordinator, or use a different --data directory');
      return 1;
    }
    if (error instanceof EngineError) {
      stderr(`agent-team-workflow: ${error.code}: ${error.message}`);
      if (error.nextAction) stderr(`hint: ${error.nextAction}`);
      return 1;
    }
    stderr(`agent-team-workflow: ${error.message}`);
    if (env.AGENT_TEAM_WORKFLOW_DEBUG) stderr(error.stack);
    return 1;
  }
}

function commandValidate(args, flags, { stdout, cwd }) {
  const file = singleFile(args, 'validate');
  const definition = loadDefinition(file, cwd);
  if (flags.json) {
    stdout(JSON.stringify({ ok: true, definition }, null, 2));
  } else {
    stdout(describeDefinition(definition));
  }
  return 0;
}

function commandDefine(args, flags, { stdout, cwd, env }) {
  const file = singleFile(args, 'define');
  const raw = readJson(path.resolve(cwd, file), file);
  const definition = normalizeDefinition(raw);
  const dir = resolveDataDir(flags, env);
  const paths = ensureDataDir(dir);
  const lock = acquireLock({ dataDir: paths.dataDir });
  try {
    const store = Store.open(paths.dbPath);
    try {
      store.append({
        type: 'workflow.defined',
        entity: 'workflow',
        entityId: 'default',
        workflowId: 'default',
        // Keep the authored document, not the normalized projection: defaults
        // and nulls are an implementation detail that a later version may
        // change without rewriting stored definitions.
        payload: { workflowId: 'default', name: definition.name, definition: raw },
      });
    } finally {
      store.close();
    }
  } finally {
    lock.release();
  }
  stdout(`defined "${definition.name}" in ${paths.dbPath}`);
  return 0;
}

function commandStatus(flags, { stdout, env }, view) {
  const paths = dataPaths(resolveDataDir(flags, env));
  if (!existsSync(paths.dbPath)) {
    stdout('agent-team-workflow: no workflow defined yet');
    stdout('run: agent-team-workflow define <workflow.json>');
    return 0;
  }
  const store = Store.open(paths.dbPath);
  try {
    const snapshot = store.snapshot();
    const definition = snapshot.workflow ? normalizeDefinition(snapshot.workflow.definition) : null;
    const status = buildStatus({ snapshot, definition, lock: readLock(paths.dataDir) });
    status.events = store.eventCount;
    if (flags.json) {
      stdout(JSON.stringify(status, null, 2));
    } else {
      stdout(view === 'roster' ? formatRoster(status) : formatStatus(status));
    }
  } finally {
    store.close();
  }
  return 0;
}

function commandEvents(flags, { stdout, env }) {
  const paths = dataPaths(resolveDataDir(flags, env));
  if (!existsSync(paths.dbPath)) {
    stdout('agent-team-workflow: no workflow defined yet');
    return 0;
  }
  const store = Store.open(paths.dbPath);
  try {
    const events = store.events({ after: 0, limit: flags.limit ?? 50 });
    for (const event of events) {
      stdout(`${event.seq}\t${event.createdAt}\t${event.type}\t${event.entityId}\t${JSON.stringify(event.payload)}`);
    }
  } finally {
    store.close();
  }
  return 0;
}

function commandRebuild(flags, { stdout, env }) {
  const paths = dataPaths(resolveDataDir(flags, env));
  if (!existsSync(paths.dbPath)) {
    stdout('agent-team-workflow: no workflow defined yet');
    return 0;
  }
  const lock = acquireLock({ dataDir: paths.dataDir });
  try {
    const store = Store.open(paths.dbPath);
    try {
      const count = store.rebuild();
      stdout(`replayed ${count} event(s) into ${paths.dbPath}`);
    } finally {
      store.close();
    }
  } finally {
    lock.release();
  }
  return 0;
}

function commandSimulate(args, flags, { stdout, cwd }) {
  const file = singleFile(args, 'simulate');
  const definition = loadDefinition(file, cwd);
  let tasks;
  let source = 'demo';
  if (flags.tasks) {
    const raw = readJson(path.resolve(cwd, flags.tasks), flags.tasks);
    if (!Array.isArray(raw)) throw new UsageError(`${flags.tasks} must contain a JSON array of tasks`);
    tasks = raw;
    source = flags.tasks;
  } else {
    tasks = demoTasks(definition);
  }
  const ticks = flags.ticks ?? 12;
  if (!Number.isInteger(ticks) || ticks < 1) throw new UsageError('--ticks must be a positive integer');
  const result = simulate({
    definition,
    providers: definition.providers.map(provider => ({ id: provider.id, health: 'ok' })),
    tasks,
    ticks,
  });
  if (flags.json) {
    stdout(JSON.stringify({ source, ...result }, null, 2));
    return 0;
  }
  stdout(`simulating "${definition.name}" with ${tasks.length} task(s) from ${source} for up to ${ticks} tick(s)`);
  for (const step of result.trace) {
    const assigned = step.assigned.length === 0
      ? '-'
      : step.assigned.map(entry => `${entry.taskId}->${entry.slotId}${entry.provider ? ` (${entry.provider})` : ''}`).join(', ');
    const completed = step.completed.length > 0 ? ` completed: ${step.completed.join(', ')}` : '';
    stdout(`t${step.tick} active=${step.active} assigned: ${assigned}${completed}`);
  }
  stdout(`completed: ${result.completed.length}/${tasks.length}; unresolved: ${result.unresolved.length > 0 ? result.unresolved.join(', ') : 'none'}`);
  return 0;
}

function commandEnqueue(args, flags, { stdout, env }) {
  const title = args.join(' ').trim();
  if (title === '') throw new UsageError('enqueue requires a title');
  const input = flags.input === undefined ? {} : parseJsonArgument(flags.input, '--input');
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new UsageError('--input must be a JSON object');
  }
  const priority = flags.priority ?? 0;
  const { engine, store } = openEngine(flags, env);
  try {
    const result = engine.enqueue({ title, kind: flags.kind ?? 'item', data: input, priority });
    output(stdout, flags, result, `enqueued ${result.itemId} (task ${result.taskId}, stage ${result.stage})`);
    return 0;
  } finally {
    store.close();
  }
}

function commandClaim(flags, { stdout, env }) {
  requireFlag(flags, 'role');
  const { engine, store } = openEngine(flags, env);
  try {
    const claimed = engine.claim({
      role: flags.role,
      member: flags.member ?? `${flags.role}-cli`,
      provider: flags.provider ?? null,
    });
    if (!claimed) {
      output(stdout, flags, { claimed: null }, 'no ready task');
      return 0;
    }
    output(
      stdout,
      flags,
      claimed,
      `claimed ${claimed.task.id} (${claimed.task.stage}) attempt ${claimed.attempt.id} expires ${claimed.attempt.expiresAt}`,
    );
    return 0;
  } finally {
    store.close();
  }
}

function commandComplete(flags, { stdout, env }) {
  requireFlag(flags, 'attempt');
  const result = flags.result === undefined ? {} : parseJsonArgument(flags.result, '--result');
  const { engine, store } = openEngine(flags, env);
  try {
    const completed = engine.complete({
      attemptId: flags.attempt,
      outcome: flags.outcome ?? 'complete',
      result,
    });
    const human = completed.status === 'advanced'
      ? `completed attempt; item ${completed.itemId} moved to ${completed.stage} (task ${completed.nextTaskId})`
      : completed.status === 'gated'
        ? `completed attempt; item ${completed.itemId} is blocked on gate(s): ${completed.gates.join(', ')}`
        : completed.status === 'done'
          ? `completed attempt; item ${completed.itemId} is done`
          : `already applied (${completed.status})`;
    output(stdout, flags, completed, human);
    return 0;
  } finally {
    store.close();
  }
}

function commandFail(flags, { stdout, env }) {
  requireFlag(flags, 'attempt');
  const { engine, store } = openEngine(flags, env);
  try {
    const failed = engine.fail({
      attemptId: flags.attempt,
      error: flags.error ?? '',
      retryable: !flags.noRetry,
      providerError: Boolean(flags.providerError),
    });
    const human = failed.status === 'retried'
      ? `attempt failed; task released for retry ${failed.attemptCount}/${failed.maxAttempts} at ${failed.availableAt}${failed.providerFailure ? ' (provider lane parked)' : ''}`
      : failed.status === 'failed'
        ? `attempt failed; task and item are blocked (${failed.attemptCount}/${failed.maxAttempts})${failed.providerFailure ? ' (provider lane parked)' : ''}`
        : `already applied (${failed.status})`;
    output(stdout, flags, failed, human);
    return 0;
  } finally {
    store.close();
  }
}

function commandGate(flags, { stdout, env }) {
  for (const name of ['item', 'gate', 'decision']) requireFlag(flags, name);
  const { engine, store } = openEngine(flags, env);
  try {
    const decided = engine.decideGate({
      itemId: flags.item,
      gate: flags.gate,
      decision: flags.decision,
      by: flags.by ?? 'human',
      note: flags.note ?? '',
    });
    output(
      stdout,
      flags,
      decided,
      `gate ${flags.gate}: ${decided.status}${decided.stage ? ` (item now at ${decided.stage})` : ''}`,
    );
    return 0;
  } finally {
    store.close();
  }
}

function commandExpire(flags, { stdout, env }) {
  const { engine, store } = openEngine(flags, env);
  try {
    const expired = engine.expireLeases();
    if (flags.json) {
      stdout(JSON.stringify({ expired }, null, 2));
    } else if (expired.length === 0) {
      stdout('no expired leases');
    } else {
      for (const entry of expired) stdout(`expired ${entry.attemptId}: ${entry.status}`);
    }
    return 0;
  } finally {
    store.close();
  }
}

function commandInit(args, flags, { stdout, cwd }) {
  if (args.length > 1) throw new UsageError('init accepts at most one target file');
  const target = path.resolve(cwd, args[0] ?? 'workflow.json');
  if (existsSync(target) && !flags.force) {
    throw new UsageError(`${target} already exists; pass --force to overwrite`);
  }
  const template = readFileSync(new URL('../examples/dev-team.json', import.meta.url), 'utf8');
  writeFileSync(target, template);
  stdout(`wrote ${target}`);
  stdout(`next: agent-team-workflow define ${path.relative(cwd, target) || target}`);
  stdout('then: agent-team-workflow board');
  return 0;
}

function commandBoard(flags, { stdout, stderr, env }) {
  const board = startBoardServer({
    dataDir: resolveDataDir(flags, env),
    host: flags.host ?? '127.0.0.1',
    port: flags.port ?? 7171,
  });
  board.ready
    .then(url => {
      stdout(`board: ${url}`);
      stdout('press Ctrl+C to stop');
    })
    .catch(error => {
      stderr(`agent-team-workflow: ${error.message}`);
      process.exitCode = 1;
      board.close();
    });
  const shutdown = () => {
    board.close().then(() => process.exit(0), () => process.exit(1));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  return 0;
}

function openEngine(flags, env) {
  const paths = dataPaths(resolveDataDir(flags, env));
  if (!existsSync(paths.dbPath)) {
    throw new UsageError('no workflow defined yet; run: agent-team-workflow define <workflow.json>');
  }
  const store = Store.open(paths.dbPath);
  const snapshot = store.snapshot();
  if (!snapshot.workflow) {
    store.close();
    throw new UsageError('no workflow defined yet; run: agent-team-workflow define <workflow.json>');
  }
  let definition;
  try {
    definition = normalizeDefinition(snapshot.workflow.definition);
  } catch (error) {
    store.close();
    throw error;
  }
  return { engine: new Engine({ store, definition, workflowId: snapshot.workflow.id }), store, paths };
}

function requireFlag(flags, name) {
  if (flags[name] === undefined) {
    const flag = name.replace(/[A-Z]/g, character => `-${character.toLowerCase()}`);
    throw new UsageError(`--${flag} is required`);
  }
}

function parseJsonArgument(value, label) {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new UsageError(`${label} must be valid JSON: ${error.message}`);
  }
}

function output(stdout, flags, value, human) {
  stdout(flags.json ? JSON.stringify(value, null, 2) : human);
}

function demoTasks(definition) {
  return definition.roles
    .filter(role => role.kind !== 'coordinator')
    .map(role => ({ id: `demo-${role.id}`, role: role.id, priority: 0 }));
}

function singleFile(args, command) {
  if (args.length !== 1) throw new UsageError(`${command} requires exactly one workflow file`);
  return args[0];
}

function loadDefinition(file, cwd) {
  const absolute = path.resolve(cwd, file);
  const raw = readJson(absolute, file);
  return normalizeDefinition(raw);
}

function readJson(absolute, label) {
  let text;
  try {
    text = readFileSync(absolute, 'utf8');
  } catch (error) {
    throw new UsageError(`cannot read ${label}: ${error.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new UsageError(`cannot parse ${label} as JSON: ${error.message}`);
  }
}

function resolveDataDir(flags, env) {
  return path.resolve(flags.data ?? env.AGENT_TEAM_WORKFLOW_DATA ?? defaultDataDir({ env }));
}

const BOOLEAN_FLAGS = new Set(['json', 'help', 'noRetry', 'providerError', 'force']);
const NUMBER_FLAGS = new Set(['ticks', 'limit', 'priority', 'port']);

function parseArgs(argv) {
  const flags = { json: false, help: false };
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '-h') {
      flags.help = true;
      continue;
    }
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const key = camelCase(arg.slice(2));
    if (BOOLEAN_FLAGS.has(key)) {
      flags[key] = true;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined) throw new UsageError(`${arg} requires a value`);
    index += 1;
    if (NUMBER_FLAGS.has(key)) {
      const number = Number(value);
      if (!Number.isInteger(number)) throw new UsageError(`${arg} requires an integer`);
      flags[key] = number;
    } else {
      flags[key] = value;
    }
  }
  if (flags.ticks !== undefined && (!Number.isInteger(flags.ticks) || flags.ticks < 1)) {
    throw new UsageError('--ticks must be a positive integer');
  }
  if (flags.limit !== undefined && (!Number.isInteger(flags.limit) || flags.limit < 1)) {
    throw new UsageError('--limit must be a positive integer');
  }
  return { flags, positional };
}

function camelCase(value) {
  return value.replace(/-([a-z])/g, (_, character) => character.toUpperCase());
}

function readVersion() {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  return pkg.version;
}

const invokedDirectly = process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  process.exitCode = main(process.argv.slice(2));
}
