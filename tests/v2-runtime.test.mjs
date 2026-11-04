import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DefinitionError, normalizeDefinition } from '../src/v2/definition.mjs';
import {
  DEFAULT_PERMISSIONS,
  RuntimeError,
  decide,
  humanOutcomes,
  newRunState,
  normalizePermissions,
  resolveValue,
  run,
  waitingHumanTokens,
  waitingTokens,
} from '../src/v2/runtime.mjs';
import { SessionStore } from '../src/v2/store.mjs';

const FULL = { command: { mode: 'full', allow: [] }, http: { mode: 'full', allow: [] } };

function definition(nodes, edges, extra = {}) {
  return normalizeDefinition({ apiVersion: 2, name: 'test-flow', entry: nodes[0].id, nodes, edges, ...extra });
}

function fakeExecutors(overrides = {}) {
  return {
    agent: async ({ input }) => ({ outcome: 'complete', output: { agent: input } }),
    command: async ({ input }) => ({ outcome: 'complete', output: { command: input } }),
    http: async ({ input }) => ({ outcome: 'complete', output: { http: input } }),
    ...overrides,
  };
}

test('v2 definition validates node types, edges and terminal nodes', () => {
  const flow = definition([
    { id: 'a', type: 'human' },
    { id: 'b', type: 'agent', role: 'worker' },
  ], [{ from: 'a', to: 'b', on: 'approve' }]);
  assert.equal(flow.apiVersion, 2);
  assert.equal(flow.nodes.length, 2);
  assert.deepEqual(normalizeDefinition(flow), flow);
  assert.throws(() => normalizeDefinition({
    apiVersion: 2,
    name: 'bad',
    nodes: [{ id: 'a', type: 'shell' }],
    edges: [],
  }), DefinitionError);
  assert.throws(() => normalizeDefinition({
    apiVersion: 2,
    name: 'bad-edge',
    nodes: [{ id: 'a', type: 'human' }, { id: 'b', type: 'human' }],
    edges: [{ from: 'a', to: 'missing' }],
  }), DefinitionError);
});

test('gate pauses a continuous workflow until control is enabled', async () => {
  const flow = definition([
    { id: 'gate', type: 'gate' },
    { id: 'approve', type: 'human', config: { outcomes: ['approve'] } },
  ], [{ from: 'gate', to: 'approve', on: 'complete' }]);
  const state = newRunState({ definition: flow, permissions: DEFAULT_PERMISSIONS, input: {} });
  await run(state, fakeExecutors(), { control: { continuous: false } });
  assert.equal(state.status, 'waiting');
  assert.equal(state.tokens[0].status, 'waiting');
  assert.equal(state.tokens[0].reason, 'gate_paused');
  await run(state, fakeExecutors(), { control: { continuous: true } });
  assert.equal(waitingHumanTokens(state).length, 1);
});

test('human -> agent runs to completion with input mapping', async () => {
  const flow = definition([
    { id: 'seed', type: 'human', config: { outcomes: ['approve'] } },
    { id: 'impl', type: 'agent', role: 'engineer', inputs: { task: '$input.task' }, config: {} },
  ], [{ from: 'seed', to: 'impl', on: 'approve' }]);
  const state = newRunState({ definition: flow, permissions: DEFAULT_PERMISSIONS, input: { task: 'build it' } });
  await run(state, fakeExecutors());
  assert.equal(state.status, 'waiting');
  const waiting = waitingTokens(state);
  assert.equal(waiting.length, 1);
  decide(state, { tokenId: waiting[0].id, outcome: 'approve' });
  await run(state, fakeExecutors());
  assert.equal(state.status, 'done');
  assert.deepEqual(state.context.nodes.impl.output.agent, { task: 'build it' });
});

test('fanout creates branches and join aggregates all outputs', async () => {
  const calls = [];
  const flow = definition([
    { id: 'seed', type: 'human' },
    { id: 'split', type: 'fanout', config: { items: '$input.items', target: 'work', join: 'join' } },
    { id: 'work', type: 'command', inputs: { item: '$item' }, config: { command: 'work' } },
    { id: 'join', type: 'join', config: { mode: 'all' } },
    { id: 'sink', type: 'command', inputs: { joined: '$nodes.join.output' }, config: { command: 'sink' } },
  ], [
    { from: 'seed', to: 'split', on: 'approve' },
    { from: 'join', to: 'sink', on: 'complete' },
  ]);
  const state = newRunState({ definition: flow, permissions: FULL, input: { items: [1, 2, 3] } });
  const executors = fakeExecutors({
    command: async ({ input }) => {
      calls.push(input);
      return { outcome: 'complete', output: input.item ?? input.joined ?? null };
    },
  });
  await run(state, executors);
  const waiting = waitingTokens(state);
  decide(state, { tokenId: waiting[0].id, outcome: 'approve' });
  await run(state, executors);
  assert.equal(state.status, 'done');
  assert.equal(calls.length, 4);
  const join = state.context.nodes.join.output;
  assert.equal(join.length, 3);
  assert.deepEqual(join.map(entry => entry.output).sort(), [1, 2, 3]);
});

test('command nodes require an explicit permission grant', async () => {
  const flow = definition([{ id: 'run', type: 'command', config: { command: 'rm -rf /' } }], []);
  const state = newRunState({ definition: flow, permissions: DEFAULT_PERMISSIONS });
  await run(state, fakeExecutors());
  assert.equal(state.status, 'failed');
  assert.equal(state.tokens[0].error.code, 'permission_denied');
  assert.equal(normalizePermissions({ command: { mode: 'allowlist', allow: ['rm'] } }).command.mode, 'allowlist');
});

test('an unhandled fail outcome fails the run', async () => {
  const flow = definition([{ id: 'run', type: 'command', config: { command: 'false' } }], []);
  const state = newRunState({ definition: flow, permissions: FULL });
  await run(state, { command: async () => ({ outcome: 'fail', output: { code: 1 } }) });
  assert.equal(state.status, 'failed');
  assert.equal(state.tokens[0].error.code, 'unhandled_failure');
});

test('a handled fail outcome follows its fail edge', async () => {
  const flow = definition([
    { id: 'run', type: 'command', config: { command: 'false' } },
    { id: 'gate', type: 'human' },
  ], [{ from: 'run', to: 'gate', on: 'fail' }]);
  const state = newRunState({ definition: flow, permissions: FULL });
  await run(state, { command: async () => ({ outcome: 'fail', output: { code: 1 } }) });
  assert.equal(state.status, 'waiting');
  assert.equal(state.tokens.find(token => token.nodeId === 'run').status, 'completed');
  assert.equal(state.tokens.find(token => token.nodeId === 'gate').status, 'waiting');
});

test('join any completes with the first branch', async () => {
  const flow = definition([
    { id: 'split', type: 'fanout', config: { items: '$input.items', target: 'work', join: 'join' } },
    { id: 'work', type: 'command', inputs: { item: '$item' }, config: { command: 'work' } },
    { id: 'join', type: 'join', config: { mode: 'any' } },
    { id: 'after', type: 'command', config: { command: 'after' } },
  ], [{ from: 'join', to: 'after', on: 'complete' }]);
  const state = newRunState({ definition: flow, permissions: FULL, input: { items: ['a', 'b'] } });
  await run(state, fakeExecutors());
  assert.equal(state.status, 'done');
  assert.equal(state.context.nodes.join.output.length, 1);
});

test('http nodes enforce host allowlists', async () => {
  const flow = definition([{ id: 'fetch', type: 'http', config: { url: 'https://api.example.com/ci' } }], []);
  const allowed = newRunState({
    definition: flow,
    permissions: { http: { mode: 'allowlist', allow: ['api.example.com'] } },
  });
  await run(allowed, fakeExecutors());
  assert.equal(allowed.status, 'done');

  const denied = newRunState({
    definition: flow,
    permissions: { http: { mode: 'allowlist', allow: ['other.example.com'] } },
  });
  await run(denied, fakeExecutors());
  assert.equal(denied.status, 'failed');
  assert.equal(denied.tokens[0].error.code, 'permission_denied');
});

test('subworkflow executes a nested definition', async () => {
  const child = {
    apiVersion: 2,
    name: 'child',
    entry: 'work',
    nodes: [{ id: 'work', type: 'command', inputs: { value: '$input.value' }, config: { command: 'child' } }],
    edges: [],
  };
  const flow = definition([{ id: 'sub', type: 'subworkflow', inputs: { value: '$input.value' }, config: { definition: child } }], []);
  const state = newRunState({ definition: flow, permissions: FULL, input: { value: 7 } });
  await run(state, fakeExecutors());
  assert.equal(state.status, 'done');
  assert.equal(state.context.nodes.sub.output.context.nodes.work.output.command.value, 7);
});

test('human rejection follows the reject edge', async () => {
  const flow = definition([
    { id: 'gate', type: 'human', config: { outcomes: ['approve', 'reject'] } },
    { id: 'accepted', type: 'command', config: { command: 'accept' } },
    { id: 'rejected', type: 'command', config: { command: 'reject' } },
  ], [
    { from: 'gate', to: 'accepted', on: 'approve' },
    { from: 'gate', to: 'rejected', on: 'reject' },
  ]);
  const state = newRunState({ definition: flow, permissions: FULL });
  await run(state, fakeExecutors());
  decide(state, { tokenId: waitingTokens(state)[0].id, outcome: 'reject' });
  await run(state, fakeExecutors());
  assert.equal(state.status, 'done');
  assert.ok(state.context.nodes.rejected);
  assert.equal(state.context.nodes.accepted, undefined);
});

test('the session store persists definition and run documents', async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'workflow-v2-store-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }));
  const store = new SessionStore(dir);
  const flow = definition([{ id: 'work', type: 'command', config: { command: 'echo' } }], []);
  await store.saveDefinition({ definition: flow, permissions: FULL });
  const loaded = await store.loadDefinition();
  assert.equal(loaded.definition.name, 'test-flow');
  const state = newRunState({ definition: flow, permissions: FULL });
  await store.saveRun(state);
  const runs = await store.listRuns();
  assert.equal(runs.length, 1);
  assert.equal(runs[0].runId, state.runId);
});

test('resolveValue handles input and node output paths', () => {
  const scope = { input: { seed: 1 }, nodes: { a: { output: { value: 2 } } }, item: { x: 3 }, index: 0 };
  assert.equal(resolveValue('$input.seed', scope), 1);
  assert.equal(resolveValue('$nodes.a.output.value', scope), 2);
  assert.equal(resolveValue('$item', scope).x, 3);
  assert.equal(resolveValue({ nested: '$index' }, scope).nested, 0);
});

test('join waits stay internal and are not decisions', async () => {
  const flow = definition([
    { id: 'split', type: 'fanout', config: { items: '$input.items', target: 'gate', join: 'join' } },
    { id: 'gate', type: 'human' },
    { id: 'join', type: 'join', config: { mode: 'all' } },
    { id: 'after', type: 'human', config: { outcomes: ['approve'] } },
  ], [{ from: 'join', to: 'after', on: 'complete' }]);
  const state = newRunState({ definition: flow, permissions: DEFAULT_PERMISSIONS, input: { items: ['a', 'b'] } });
  await run(state, fakeExecutors());
  assert.equal(state.status, 'waiting');

  const raw = waitingTokens(state);
  assert.equal(raw.length, 3);
  const joinToken = raw.find(token => token.nodeId === 'join');
  assert.ok(joinToken);
  assert.deepEqual(waitingHumanTokens(state).map(token => token.nodeId), ['gate', 'gate']);

  const snapshot = JSON.stringify(state.tokens);
  assert.throws(
    () => decide(state, { tokenId: joinToken.id, outcome: 'approve' }),
    error => error instanceof RuntimeError && error.code === 'not_decidable',
  );
  assert.equal(joinToken.status, 'waiting');
  assert.equal(joinToken.outcome, null);
  assert.equal(JSON.stringify(state.tokens), snapshot);
  assert.equal(state.context.nodes.join, undefined);

  for (const token of waitingHumanTokens(state)) decide(state, { tokenId: token.id, outcome: 'approve' });
  await run(state, fakeExecutors());
  assert.equal(state.status, 'waiting');
  assert.deepEqual(waitingHumanTokens(state).map(token => token.nodeId), ['after']);

  const join = state.context.nodes.join;
  assert.equal(join.outcome, 'complete');
  assert.equal(join.output.length, 2);
  assert.deepEqual(join.output.map(entry => entry.outcome), ['approve', 'approve']);
  assert.deepEqual(join.output.map(entry => entry.branch.index).sort(), [0, 1]);

  decide(state, { tokenId: waitingHumanTokens(state)[0].id, outcome: 'approve' });
  await run(state, fakeExecutors());
  assert.equal(state.status, 'done');
});
