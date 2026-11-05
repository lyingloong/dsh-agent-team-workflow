import test from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { normalizeDefinition } from '../src/v2/definition.mjs';
import { createExecutors } from '../src/v2/executors.mjs';
import { SessionStore } from '../src/v2/store.mjs';
import { installWebApi, ROUTE_PREFIX } from '../src/v2/web-api.mjs';
import { deferred, fakeJobs } from './helpers/jobs.mjs';

const SESSION = 'session-model-fallback';
const OPTIONS = { timeout: 15_000 };
// Deliberately not alphabetic or catalog order: priority is user-controlled.
const MODELS = [
  { provider: 'route-c', model: 'model-c' },
  { provider: 'route-a', model: 'model-a' },
  { provider: 'route-b', model: 'model-b' },
];
const BASE_CONFIG = { prompt: 'Return a decision.', outcomes: ['pass', 'fail'], timeoutMs: 5_000 };
const DEFAULT_MODEL = { provider: 'host-route', model: 'host-model' };
const definitionFor = config => normalizeDefinition({
  apiVersion: 2, name: 'model-fallback-test', entry: 'worker',
  nodes: [
    { id: 'worker', type: 'agent', config: { ...BASE_CONFIG, ...config } },
    { id: 'approval', type: 'human', config: { outcomes: ['approve'] } },
  ],
  edges: [{ from: 'worker', to: 'approval', on: 'pass' }],
});
const workerConfig = definition => definition.nodes.find(node => node.id === 'worker').config;
const completed = (text = '{"outcome":"pass","output":{"ok":true}}') => ({
  stopReason: 'completed', output: [{ type: 'text', text }],
});

// Only temporary stores, a real local public HTTP server and fake job/model
// services are used. No production sessions, host models or commands are run.
async function setupApi(t, config = { provider: 'old-route', model: 'old-model' }) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'workflow-model-fallback-'));
  const dataRoot = path.join(directory, 'data');
  const jobs = fakeJobs();
  let api;
  t.after(async () => {
    if (api) await api.closeBoardServer();
    await jobs.settleAll();
    await rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
  });
  const ctx = {
    get(name) {
      if (name === 'jobs') return jobs;
      if (name === 'workingDirectory') return { ensure: async () => directory };
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ ...DEFAULT_MODEL }) };
      if (name === 'subagents') return { startActivation() { assert.fail('API persistence tests must not launch a model'); } };
      return undefined;
    },
    effect(fn) { fn(); },
    on() {},
  };
  api = installWebApi({ ctx, dataRoot, settings: { boardPort: 0 }, logger: { warn() {} } });
  const base = await api.boardReady;
  assert.ok(base, 'test-owned loopback server started');
  const store = new SessionStore(path.join(dataRoot, 'sessions', SESSION));
  const permissions = { command: { mode: 'deny', allow: [] }, http: { mode: 'deny', allow: [] } };
  await store.saveDefinition({ definition: definitionFor(config), permissions });
  const request = async (action, body, token = api.publicToken) => {
    const url = new URL(`${ROUTE_PREFIX}/public/api/${action}`, base);
    url.searchParams.set('token', token);
    if (body === undefined) url.searchParams.set('session', SESSION);
    const response = await fetch(url, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { connection: 'close', 'content-type': 'application/json' },
      signal: AbortSignal.timeout(5_000),
      ...(body === undefined ? {} : { body: JSON.stringify({ session: SESSION, ...body }) }),
    });
    return { status: response.status, json: await response.json() };
  };
  // Starting only creates the idle run document; no /run dispatch is made.
  const started = expectStatus(await request('start', { cwd: directory }), 201);
  const runId = started.run.runId;
  return {
    api, jobs, store, runId, permissions, request,
    update: (models, fields = {}) => request('node-model', { nodeId: 'worker', runId, models, ...fields }),
    async fresh() {
      const freshStore = new SessionStore(store.dataDir);
      return { stored: await freshStore.loadDefinition(), run: await freshStore.loadRun(runId) };
    },
    async documents() {
      return Promise.all([
        readFile(store.definitionPath, 'utf8'),
        readFile(path.join(store.runsDir, `${runId}.json`), 'utf8'),
      ]);
    },
  };
}

function expectStatus(response, status) {
  assert.equal(response.status, status, JSON.stringify(response.json));
  return response.json;
}

async function assertPersisted(h, config) {
  const { stored, run } = await h.fresh();
  assert.deepEqual(workerConfig(stored.definition), config, 'draft persisted through a fresh store');
  assert.deepEqual(workerConfig(run.definition), config, 'idle run definition persisted too');
  assert.deepEqual(stored.permissions, h.permissions, 'model edits cannot widen permissions');
  assert.deepEqual(run.permissions, h.permissions);
  assert.deepEqual(stored.definition.nodes[1], definitionFor({}).nodes[1], 'unrelated node is unchanged');
  const state = expectStatus(await h.request('state'), 200);
  assert.deepEqual(workerConfig(state.definition), config, 'public reload sees the saved run model order');
  assert.equal(h.jobs.records.size, 0, 'editing never dispatches a workflow job');
}

function executorHarness(startActivation, { signal = new AbortController().signal, onActivity } = {}) {
  return createExecutors({
    ctx: { get: name => name === 'subagents' ? { startActivation } : undefined },
    exec: { agent: { id: 'fake-parent' }, signal },
    settings: { subagentProvider: 'spawn' }, cwd: os.tmpdir(), onActivity,
  });
}
function executorArgs(config = { models: MODELS }) {
  const definition = definitionFor(config);
  return { node: definition.nodes[0], definition, token: { id: 'test-token' }, input: { ticket: 'fake' }, context: {} };
}

test('public API persists ordered multi-selection in draft and idle run, including up/down-equivalent edits', OPTIONS, async t => {
  const h = await setupApi(t);
  const originalRun = (await h.fresh()).run;
  const selected = expectStatus(await h.update(MODELS), 200);
  assert.deepEqual(workerConfig(selected.definition), { ...BASE_CONFIG, models: MODELS });
  await assertPersisted(h, { ...BASE_CONFIG, models: MODELS });

  const movedUp = [MODELS[1], MODELS[0], MODELS[2]];
  expectStatus(await h.update(movedUp), 200);
  await assertPersisted(h, { ...BASE_CONFIG, models: movedUp });
  // Move the first entry down again; updating an identical list is safe too.
  for (let repeat = 0; repeat < 2; repeat += 1) {
    expectStatus(await h.update(MODELS), 200);
    await assertPersisted(h, { ...BASE_CONFIG, models: MODELS });
  }
  assert.deepEqual(workerConfig(selected.definition).models, MODELS, 'later edits do not mutate previous responses');
  const { run } = await h.fresh();
  assert.deepEqual(run.tokens, originalRun.tokens, 'reordering does not execute or reset tokens');
  assert.deepEqual(run.context, originalRun.context);
});

test('clearing the list removes explicit overrides and restores inherited host-default execution', OPTIONS, async t => {
  const h = await setupApi(t, { provider: 'stale-route', model: 'stale-model', models: MODELS });
  const cleared = expectStatus(await h.update([]), 200);
  assert.deepEqual(workerConfig(cleared.definition), BASE_CONFIG);
  assert.deepEqual(cleared.models.default, DEFAULT_MODEL);
  await assertPersisted(h, BASE_CONFIG);
  const { run } = await h.fresh();
  let admitted;
  let disposed = 0;
  const executors = executorHarness(async spec => {
    admitted = spec;
    return { childId: 'default-child', result: Promise.resolve(completed()), dispose: async () => { disposed += 1; } };
  });
  const result = await executors.agent({ ...executorArgs(), node: run.definition.nodes[0], definition: run.definition });
  assert.equal(Object.hasOwn(admitted.request, 'agentOptions'), false, 'host chooses its current default, not a copied catalog model');
  assert.deepEqual(result.model, { provider: null, model: null });
  assert.equal(disposed, 1);
});

test('public API accepts the maximum eight models without sorting or truncation', OPTIONS, async t => {
  const h = await setupApi(t);
  const models = Array.from({ length: 8 }, (_, index) => ({ provider: `route-${7 - index}`, model: `model-${index}` }));
  expectStatus(await h.update(models), 200);
  await assertPersisted(h, { ...BASE_CONFIG, models });
});

test('invalid model selections are rejected without changing either persisted document', OPTIONS, async t => {
  const h = await setupApi(t, { models: MODELS });
  const before = await h.documents();
  const cases = [
    ['more than eight', Array.from({ length: 9 }, () => MODELS[0])],
    ['not an array', { provider: 'route', model: 'model' }],
    ['missing model after a valid entry', [MODELS[0], { provider: 'route' }]],
    ['missing provider', [{ model: 'model' }]],
    ['blank provider', [{ provider: '  ', model: 'model' }]],
    ['blank model', [{ provider: 'route', model: '  ' }]],
    ['non-string model', [{ provider: 'route', model: 42 }]],
    ['null entry', [null]],
    ['array entry', [['route', 'model']]],
  ];
  for (const [label, models] of cases) {
    await t.test(label, async () => {
      const response = expectStatus(await h.update(models), 400);
      assert.equal(response.error.code, 'invalid_model');
      assert.deepEqual(await h.documents(), before, 'failure must not partially save draft or run');
    });
  }
  await assertPersisted(h, { ...BASE_CONFIG, models: MODELS });
});

test('an unauthorized public selection cannot modify model priority', OPTIONS, async t => {
  const h = await setupApi(t, { models: MODELS });
  const before = await h.documents();
  const response = await h.request('node-model', { nodeId: 'worker', runId: h.runId, models: [] }, 'invalid-token');
  assert.equal(expectStatus(response, 401).error.code, 'unauthorized');
  assert.deepEqual(await h.documents(), before);
});

for (const failureKind of ['startup throws', 'result rejects', 'upstream failed stopReason']) {
  test(`ordered executor fallback: ${failureKind}, then second model succeeds`, OPTIONS, async () => {
    const calls = [];
    const order = [];
    const checkpoints = [];
    const upstream = new Error('upstream provider unavailable (HTTP 503)');
    const executors = executorHarness(async spec => {
      const index = calls.length;
      calls.push(spec);
      order.push(`start-${index}`);
      if (index === 0 && failureKind === 'startup throws') throw upstream;
      return {
        childId: `child-${index}`,
        result: index !== 0 ? Promise.resolve(completed())
          : failureKind === 'result rejects' ? Promise.reject(upstream)
            : Promise.resolve({ stopReason: 'failed', diagnostic: upstream.message, output: [] }),
        dispose: async () => { order.push(`dispose-${index}`); },
      };
    }, { onActivity: async (token, activity) => {
      assert.equal(token.id, 'test-token');
      checkpoints.push(activity);
      order.push(`checkpoint-${calls.length - 1}`);
    } });
    const args = executorArgs({ provider: 'ignored-route', model: 'ignored-model', models: MODELS });
    const before = structuredClone(args);
    const result = await executors.agent(args);
    assert.deepEqual(calls.map(call => call.request.agentOptions), MODELS.slice(0, 2));
    assert.equal(calls[0].signal, calls[1].signal, 'all candidates share one cancellation/deadline scope');
    assert.equal(calls[0].request.prompt[0].text, calls[1].request.prompt[0].text);
    assert.equal(calls[1].delivery, 'caller');
    assert.deepEqual(result, { outcome: 'pass', output: { ok: true }, model: MODELS[1] });
    assert.deepEqual(checkpoints.at(-1), { childId: 'child-1', ...MODELS[1] });
    assert.deepEqual(order, failureKind === 'startup throws'
      ? ['start-0', 'start-1', 'checkpoint-1', 'dispose-1']
      : ['start-0', 'checkpoint-0', 'dispose-0', 'start-1', 'checkpoint-1', 'dispose-1']);
    assert.deepEqual(args, before, 'candidate processing leaves saved config and inputs unchanged');
  });
}

test('exhausted call-error fallbacks try every model exactly once in saved order', OPTIONS, async () => {
  const calls = [];
  const executors = executorHarness(async spec => {
    const candidate = spec.request.agentOptions;
    calls.push(candidate);
    throw new Error(`upstream unavailable for ${candidate.model}`);
  });
  await assert.rejects(executors.agent(executorArgs()), error => {
    assert.match(error.message, /all model candidates failed/);
    let previous = -1;
    for (const candidate of MODELS) {
      const position = error.message.indexOf(`${candidate.provider}/${candidate.model}:`);
      assert.ok(position > previous, 'failure diagnostics retain candidate order');
      previous = position;
    }
    return true;
  });
  assert.deepEqual(calls, MODELS);
});

test('cancellation before admission never starts the first model or a fallback', OPTIONS, async () => {
  const controller = new AbortController();
  controller.abort('human stop');
  const executors = executorHarness(async () => { assert.fail('cancelled execution cannot start a model'); }, { signal: controller.signal });
  await assert.rejects(executors.agent(executorArgs()), { code: 'execution_aborted' });
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('cancellation during the first model releases it without admitting the second', OPTIONS, async () => {
  const controller = new AbortController();
  const checkpoint = deferred();
  const calls = [];
  let disposed = 0;
  const executors = executorHarness(async spec => {
    calls.push(spec);
    return { childId: 'pending-child', result: new Promise(() => {}), dispose: async () => { disposed += 1; } };
  }, { signal: controller.signal, onActivity: async () => checkpoint.resolve() });
  const pending = executors.agent(executorArgs());
  const rejected = assert.rejects(pending, { code: 'execution_aborted' });
  await checkpoint.promise;
  controller.abort('human stop');
  await rejected;
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].request.agentOptions, MODELS[0]);
  assert.equal(calls[0].signal.aborted, true);
  assert.equal(disposed, 1);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

for (const [label, childResult, code] of [
  ['child reports cancellation', { stopReason: 'aborted', diagnostic: 'human stop', output: [] }, 'execution_aborted'],
  ['empty output', completed(''), 'invalid_agent_output'],
  ['missing outcome', completed('{"output":{"ok":true}}'), 'invalid_agent_output'],
  ['unknown outcome', completed('{"outcome":"unexpected","output":{}}'), 'invalid_agent_output'],
  ['ambiguous prose', completed('Maybe pass, maybe fail.'), 'invalid_agent_output'],
]) {
  test(`${label} is not a call error and must not trigger fallback`, OPTIONS, async () => {
    const calls = [];
    let disposed = 0;
    const executors = executorHarness(async spec => {
      calls.push(spec);
      return { childId: 'invalid-child', result: Promise.resolve(childResult), dispose: async () => { disposed += 1; } };
    });
    await assert.rejects(executors.agent(executorArgs()), { code });
    assert.deepEqual(calls.map(call => call.request.agentOptions), [MODELS[0]]);
    assert.equal(disposed, 1);
  });
}

// A valid negative decision is data, not a provider-call failure.
test('valid fail outcome also stops fallback and preserves the first model decision', OPTIONS, async () => {
  const calls = [];
  const executors = executorHarness(async spec => {
    calls.push(spec.request.agentOptions);
    return { result: Promise.resolve(completed('{"outcome":"fail","output":{"reason":"review failed"}}')), dispose: async () => {} };
  });
  const result = await executors.agent(executorArgs());
  assert.deepEqual(result, { outcome: 'fail', output: { reason: 'review failed' }, model: MODELS[0] });
  assert.deepEqual(calls, [MODELS[0]]);
});
