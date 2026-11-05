import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { installWebApi, ROUTE_PREFIX } from '../src/v2/web-api.mjs';
import { normalizeDefinition } from '../src/v2/definition.mjs';
import { SessionStore } from '../src/v2/store.mjs';
import { WorkflowRunner } from '../src/v2/runner.mjs';
import { deferred, fakeJobs } from './helpers/jobs.mjs';

const SESSION = 'session-http-lifecycle';
const TEST_OPTIONS = { timeout: 30_000 };
const worker = id => ({
  id, type: 'agent', inputs: { ticket: '$input.ticket' },
  config: { prompt: 'Return the test result.', provider: 'mock-provider', model: 'mock-model' },
});
const FLOW = normalizeDefinition({
  apiVersion: 2, name: 'http-lifecycle', entry: 'gate',
  nodes: [
    { id: 'gate', type: 'gate' },
    { id: 'approval', type: 'human', config: { outcomes: ['approve'] } },
    worker('worker'),
    { id: 'finish', type: 'human', config: { outcomes: ['approve'] } },
  ],
  edges: [
    { from: 'gate', to: 'approval', on: 'complete' },
    { from: 'gate', to: 'worker', on: 'complete' },
    { from: 'worker', to: 'finish', on: 'complete' },
  ],
});
const CHAIN = normalizeDefinition({
  apiVersion: 2, name: 'http-pause-chain', entry: 'gate',
  nodes: [{ id: 'gate', type: 'gate' }, worker('worker'), worker('next')],
  edges: [
    { from: 'gate', to: 'worker', on: 'complete' },
    { from: 'worker', to: 'next', on: 'complete' },
  ],
});
const TERMINAL = normalizeDefinition({
  apiVersion: 2, name: 'http-history', entry: 'gate',
  nodes: [{ id: 'gate', type: 'gate' }, worker('worker')],
  edges: [{ from: 'gate', to: 'worker', on: 'complete' }],
});

// Every request crosses an actual loopback HTTP server. Private handlers are
// registered through the authentication wrapper, not the unprotected route map.
// Child admission and persisted activity checkpoints provide barriers: no sleeps
// or status polling are needed to keep a fake model pending deterministically.
async function setup(t, { definition = FLOW, holdDisposal = false } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'workflow-http-lifecycle-'));
  const jobs = fakeJobs();
  const calls = [];
  const admissions = new Map();
  const snapshots = [];
  const saveHolds = [];
  let api;
  let runner;
  let privateServer;
  t.after(async () => {
    for (const hold of saveHolds) hold.release.resolve();
    for (const call of calls) call.releaseDisposal.resolve();
    if (runner) await runner.dispose();
    await jobs.settleAll();
    if (api) await api.closeBoardServer();
    if (privateServer) {
      privateServer.closeAllConnections();
      await new Promise(resolve => privateServer.close(resolve));
    }
    await rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
  });

  const original = path.join(directory, 'original-project');
  const target = path.join(directory, 'bound-project');
  await Promise.all([original, target].map(cwd => mkdir(path.join(cwd, 'requirements'), { recursive: true })));
  const cwd = await realpath(target);
  await Promise.all([
    writeFile(path.join(original, 'requirements', 'requirements.json'), JSON.stringify([
      { id: 'wrong-project', title: 'Must not be displayed', source: 'user', priority: 0, status: 'queued' },
    ])),
    writeFile(path.join(cwd, 'requirements', 'requirements.json'), JSON.stringify([
      { id: 'bound-user', title: 'Bound project item', source: 'user', priority: 0, status: 'queued', tags: ['target'] },
    ])),
    writeFile(path.join(cwd, 'requirements', 'seeds.json'), JSON.stringify([{ id: 'seed', status: 'ready' }])),
  ]);
  let currentDirectory = cwd;
  const owner = { id: SESSION, session: { header: { cwd: original } } };
  const agents = new Map([[SESSION, { agent: owner }]]);
  const dataRoot = path.join(directory, 'data');
  const store = new SessionStore(path.join(dataRoot, 'sessions', SESSION));
  const save = store.saveRun.bind(store);
  store.saveRun = async state => {
    const snapshot = structuredClone(state);
    const hold = saveHolds.find(candidate => !candidate.claimed && candidate.predicate(snapshot));
    if (hold) {
      hold.claimed = true;
      hold.entered.resolve(snapshot);
      await hold.release.promise;
    }
    await save(snapshot);
    snapshots.push(snapshot);
    for (const token of snapshot.tokens) {
      if (token.status !== 'running' || !token.activity?.childId) continue;
      calls.find(call => call.childId === token.activity.childId)?.checkpoint.resolve(snapshot);
    }
    return state;
  };
  const admission = index => {
    if (!admissions.has(index)) admissions.set(index, deferred());
    return admissions.get(index);
  };
  const subagents = {
    async startActivation(spec) {
      const result = deferred();
      const index = calls.length;
      const call = {
        spec, childId: `http-child-${index + 1}`, result,
        checkpoint: deferred(), disposalStarted: deferred(), releaseDisposal: deferred(),
        disposed: 0, resultSettled: false,
      };
      if (!holdDisposal) call.releaseDisposal.resolve();
      const settle = value => { call.resultSettled = true; result.resolve(value); };
      call.complete = (output = { ok: true }) => settle({
        stopReason: 'completed', output: [{ type: 'text', text: JSON.stringify({ outcome: 'complete', output }) }],
      });
      call.completeText = text => settle({ stopReason: 'completed', output: [{ type: 'text', text }] });
      const abort = () => settle({ stopReason: 'aborted', diagnostic: 'fake child cancelled', output: [] });
      spec.signal.addEventListener('abort', abort, { once: true });
      if (spec.signal.aborted) abort();
      calls.push(call);
      admission(index).resolve(call);
      return {
        childId: call.childId,
        result: result.promise,
        async dispose() {
          call.disposalStarted.resolve();
          await call.releaseDisposal.promise;
          spec.signal.removeEventListener('abort', abort);
          call.disposed += 1;
        },
      };
    },
  };
  const routes = new Map();
  const logger = { warn() {} };
  const ctx = {
    get(name) {
      if (name === 'jobs') return jobs;
      if (name === 'subagents') return subagents;
      if (name === 'workingDirectory') return { ensure: async agent => { assert.equal(agent, owner); return currentDirectory; } };
      if (name === 'connection') return { requestRejection: req => req.headers['x-lifecycle-auth'] === 'allowed' ? undefined : 401 };
      if (name === 'webServer') return {
        register(route) { routes.set(route.path, route.handler); return () => routes.delete(route.path); },
      };
      return undefined;
    },
    effect(fn) { fn(); },
    on() {},
  };
  const settings = { subagentProvider: 'spawn', maxSteps: 20, agentTimeoutMs: 20_000 };
  runner = new WorkflowRunner({ ctx, storeFor: session => { assert.equal(session, SESSION); return store; }, agents, settings, logger });
  api = installWebApi({ ctx, dataRoot, agents, settings, runner, logger });
  assert.equal(api.runner, runner);
  privateServer = createServer((req, res) => {
    const handler = routes.get(new URL(req.url, 'http://local').pathname);
    if (!handler) { res.writeHead(404); res.end(); return; }
    Promise.resolve(handler(req, res)).catch(error => {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: error.message } }));
      } else res.destroy(error);
    });
  });
  await new Promise((resolve, reject) => {
    privateServer.once('error', reject);
    privateServer.listen(0, '127.0.0.1', resolve);
  });
  const privateBase = `http://127.0.0.1:${privateServer.address().port}`;
  const publicBase = await api.boardReady;
  assert.ok(publicBase, 'public loopback server started');
  await store.saveDefinition({ definition, permissions: {} });

  const request = async (transport, action, { method = 'GET', body, query = {}, authorized = true } = {}) => {
    const isPublic = transport === 'public';
    const url = new URL(`${ROUTE_PREFIX}/${isPublic ? 'public/' : ''}api/${action}`, isPublic ? publicBase : privateBase);
    if (isPublic) url.searchParams.set('token', authorized ? api.publicToken : 'invalid-token');
    if (method === 'GET') url.searchParams.set('session', SESSION);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    const headers = { connection: 'close' };
    if (!isPublic && authorized) headers['x-lifecycle-auth'] = 'allowed';
    if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch(url, {
      method, headers, signal: AbortSignal.timeout(5_000),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, json: await response.json() };
  };
  return {
    api, runner, jobs, store, calls, snapshots, cwd, original, request,
    setCurrentDirectory(value) { currentDirectory = value; },
    holdNextCheckpoint(predicate) {
      const hold = { predicate, claimed: false, entered: deferred(), release: deferred() };
      saveHolds.push(hold);
      return hold;
    },
    post(transport, action, fields = {}, options = {}) {
      return request(transport, action, { ...options, method: 'POST', body: { session: SESSION, ...fields } });
    },
    async pending(index = 0) {
      const call = await admission(index).promise;
      await call.checkpoint.promise;
      return call;
    },
  };
}

function expectStatus(response, status) {
  assert.equal(response.status, status, JSON.stringify(response.json));
  return response.json;
}

function assertPending(run, cwd, jobId, childId) {
  assert.equal(run.cwd, cwd);
  assert.equal(run.jobId, jobId);
  assert.equal(run.execution.active, true);
  assert.equal(run.current.nodeId, 'worker');
  assert.equal(run.current.status, 'running');
  assert.equal(run.current.activity.childId, childId);
  assert.equal(run.tokens.find(token => token.nodeId === 'gate').status, 'completed');
  assert.equal(run.tokens.find(token => token.nodeId === 'worker').attempt, 1);
}

test('HTTP run returns 202, checkpoints pending work and deduplicates transports without stale mutations', TEST_OPTIONS, async t => {
  const h = await setup(t);
  const started = expectStatus(await h.post('private', 'start', { input: { ticket: 'lifecycle' } }), 201);
  assert.equal(started.run.cwd, h.cwd, 'start binds effective cwd instead of the wrong session header');
  const runId = started.run.runId;
  // Neither fake child nor human decision can settle these calls; an old
  // synchronous /run implementation instead reaches the HTTP deadline.
  const accepted = await Promise.all(['private', 'public'].map(transport => h.post(transport, 'run', { runId })));
  for (const response of accepted) expectStatus(response, 202);
  const jobId = accepted[0].json.run.jobId;
  assert.ok(jobId);
  assert.equal(accepted[1].json.run.jobId, jobId);
  assert.equal(accepted[0].json.execution.jobId, jobId);
  assert.equal(h.jobs.records.size, 1);
  const child = await h.pending();
  assert.equal(child.resultSettled, false);
  assert.equal(child.spec.request.cwd, h.cwd);
  const initial = expectStatus(await h.request('public', 'state'), 200);
  assertPending(initial.run, h.cwd, jobId, child.childId);
  const approval = initial.run.tokens.find(token => token.nodeId === 'approval');
  assert.equal(approval.status, 'waiting');
  const mutations = [
    ['node-model', { runId, nodeId: 'worker', provider: 'other-provider', model: 'must-not-stick' }],
    ['start', { cwd: h.cwd }],
    ['decide', { runId, tokenId: approval.id, outcome: 'approve' }],
  ];
  const [reads, conflicts, repeats, shared] = await Promise.all([
    Promise.all(Array.from({ length: 6 }, (_, i) => h.request(i % 2 ? 'private' : 'public', 'state'))),
    Promise.all(['private', 'public'].flatMap(transport => mutations.map(([action, fields]) => h.post(transport, action, fields)))),
    Promise.all(['public', 'private'].map(transport => h.post(transport, 'run', { runId }))),
    h.runner.dispatch(SESSION, runId),
  ]);
  for (const response of reads) assertPending(expectStatus(response, 200).run, h.cwd, jobId, child.childId);
  for (const response of conflicts) assert.equal(expectStatus(response, 409).error.code, 'run_active');
  for (const response of repeats) assert.equal(expectStatus(response, 202).run.jobId, jobId);
  assert.equal(shared.execution.jobId, jobId, 'tool-side and both HTTP transports share one owner');
  assert.equal(h.calls.length, 1);
  assert.equal(h.jobs.records.size, 1);
  assert.equal((await h.store.loadDefinition()).definition.nodes.find(node => node.id === 'worker').config.model, 'mock-model');
  assert.equal((await h.store.loadRun(runId)).tokens.find(token => token.id === approval.id).status, 'waiting');

  child.complete({ checkpoint: 'finished' });
  await h.jobs.settle(jobId);
  const finished = expectStatus(await h.request('private', 'state'), 200);
  assert.equal(finished.run.execution.active, false);
  assert.equal(finished.run.status, 'waiting');
  assert.deepEqual(finished.run.context.nodes.worker.output, { checkpoint: 'finished' });
  assert.equal(initial.run.current.status, 'running', 'an earlier HTTP snapshot is immutable');
  const completedGate = h.snapshots.findIndex(state => state.tokens.some(token => token.nodeId === 'gate' && token.status === 'completed'));
  assert.ok(completedGate >= 0);
  for (const state of h.snapshots.slice(completedGate)) {
    const gate = state.tokens.find(token => token.nodeId === 'gate');
    assert.equal(gate.status, 'completed', 'concurrent API mutations cannot overwrite a checkpoint');
    assert.equal(gate.attempt, 1);
  }
  assert.equal(child.disposed, 1);
});

for (const transport of ['private', 'public']) {
  test(`${transport} HTTP stop cancels its managed job and holds ownership through child disposal`, TEST_OPTIONS, async t => {
    const h = await setup(t, { definition: CHAIN, holdDisposal: true });
    const runId = expectStatus(await h.post(transport, 'start', { cwd: h.cwd }), 201).run.runId;
    const jobId = expectStatus(await h.post(transport, 'run', { runId }), 202).run.jobId;
    const child = await h.pending();
    expectStatus(await h.post(transport, 'stop', {}, { authorized: false }), 401);
    assert.equal(child.spec.signal.aborted, false, 'unauthenticated stop has no effect');
    const stopped = expectStatus(await h.post(transport, 'stop'), 202);
    assert.deepEqual(stopped, { requested: true, jobId });
    await child.disposalStarted.promise;
    assert.equal(child.spec.signal.aborted, true);
    assert.equal(h.jobs.records.get(jobId).status, 'running');
    assert.equal(expectStatus(await h.post(transport, 'start', { cwd: h.cwd }), 409).error.code, 'run_active');
    const duringCleanup = expectStatus(await h.request(transport, 'state'), 200);
    assert.equal(duringCleanup.run.execution.active, true, 'job is not released before executor cleanup');
    child.releaseDisposal.resolve();
    await h.jobs.settle(jobId);
    const settled = expectStatus(await h.request(transport, 'state'), 200);
    assert.equal(settled.run.status, 'interrupted');
    assert.equal(settled.run.execution.active, false);
    assert.equal(settled.run.tokens.find(token => token.nodeId === 'worker').status, 'interrupted');
    assert.equal(settled.run.tokens.find(token => token.nodeId === 'gate').status, 'completed');
    assert.equal(child.disposed, 1);
    assert.equal(h.jobs.records.get(jobId).status, 'killed');
    assert.equal(h.calls.length, 1, 'the next node never launches');
    assert.equal(expectStatus(await h.post(transport, 'run', { runId }), 200).run.status, 'interrupted');
    assert.equal(h.jobs.records.size, 1, 'Run does not replay cancelled side effects');
    assert.deepEqual(expectStatus(await h.post(transport, 'stop'), 200), { requested: false });
  });
}

test('HTTP control accepts body sessions, rejects mismatches and pauses live work while queue stays cwd-bound', TEST_OPTIONS, async t => {
  const h = await setup(t, { definition: CHAIN });
  assert.equal(expectStatus(await h.request('public', 'state'), 200).queue, null, 'unbound runs do not read the original repository queue');
  const runId = expectStatus(await h.post('public', 'start', { cwd: h.cwd }), 201).run.runId;
  h.setCurrentDirectory(h.original);
  const bound = expectStatus(await h.request('private', 'state'), 200);
  assert.equal(bound.queue.path, path.join(h.cwd, 'requirements'));
  assert.deepEqual(bound.queue.items.map(item => item.id), ['bound-user']);
  assert.equal(bound.queue.seedsReady, 1);
  const off = expectStatus(await h.post('public', 'control', { continuous: false }), 200).control;
  assert.equal(off.continuous, false, 'POST has body.session and no query.session');
  assert.deepEqual(expectStatus(await h.request('private', 'control'), 200).control, off);
  for (const transport of ['private', 'public']) {
    const mismatch = await h.post(transport, 'control', { continuous: true }, { query: { session: 'different-session' } });
    assert.equal(expectStatus(mismatch, 400).error.code, 'invalid_session');
  }
  assert.deepEqual(await h.store.loadControl(), off, 'rejected mismatches make no control writes');
  expectStatus(await h.post('private', 'control', { continuous: true }, { query: { session: SESSION } }), 200);
  const jobId = expectStatus(await h.post('private', 'run', { runId }), 202).run.jobId;
  const child = await h.pending();
  assert.equal(child.spec.request.cwd, h.cwd, 'later effective-directory changes cannot rebind an existing run');
  expectStatus(await h.post('public', 'control', { continuous: false }), 200);
  child.complete();
  await h.jobs.settle(jobId);
  const paused = expectStatus(await h.request('public', 'state'), 200);
  assert.equal(paused.run.status, 'paused');
  assert.equal(paused.run.pauseReason, 'control_off');
  assert.equal(paused.run.tokens.find(token => token.nodeId === 'next').status, 'ready');
  assert.equal(h.calls.length, 1, 'live pause is observed before the next agent dispatch');
  assert.deepEqual(paused.queue.items.map(item => item.id), ['bound-user']);

  expectStatus(await h.post('private', 'control', { continuous: true }), 200);
  const resumedJob = expectStatus(await h.post('public', 'run', { runId }), 202).run.jobId;
  assert.notEqual(resumedJob, jobId);
  const next = await h.pending(1);
  assert.equal(next.spec.label, 'workflow:next');
  assert.equal(next.spec.request.cwd, h.cwd);
  next.complete();
  await h.jobs.settle(resumedJob);
  assert.equal(expectStatus(await h.request('private', 'state'), 200).run.status, 'done');
  assert.equal(h.calls.length, 2, 'resume does not replay the completed worker');
});

test('HTTP readers retain a coherent persisted snapshot while a completion checkpoint is pending', TEST_OPTIONS, async t => {
  const h = await setup(t);
  const runId = expectStatus(await h.post('private', 'start', { cwd: h.cwd }), 201).run.runId;
  const jobId = expectStatus(await h.post('public', 'run', { runId }), 202).run.jobId;
  const child = await h.pending();
  const before = await h.store.loadRun(runId);
  const hold = h.holdNextCheckpoint(state => state.tokens.some(token => token.nodeId === 'worker' && token.status === 'completed'));
  child.complete({ version: 'new-checkpoint' });
  const nextSnapshot = await hold.entered.promise;
  assert.equal(nextSnapshot.context.nodes.worker.output.version, 'new-checkpoint');
  const [reads, conflicts] = await Promise.all([
    Promise.all(['private', 'public', 'private', 'public'].map(transport => h.request(transport, 'state'))),
    Promise.all(['private', 'public'].map(transport => h.post(transport, 'node-model', {
      runId, nodeId: 'worker', provider: 'unexpected-provider', model: 'unexpected-model',
    }))),
  ]);
  for (const response of reads) {
    const state = expectStatus(response, 200);
    assertPending(state.run, h.cwd, jobId, child.childId);
    assert.equal(state.run.context.nodes.worker, undefined, 'uncommitted output is not exposed as persisted progress');
  }
  for (const response of conflicts) assert.equal(expectStatus(response, 409).error.code, 'run_active');
  assert.deepEqual(await h.store.loadRun(runId), before, 'the last complete document stays intact while the new checkpoint waits');
  hold.release.resolve();
  await h.jobs.settle(jobId);
  const after = expectStatus(await h.request('public', 'state'), 200);
  assert.equal(after.run.tokens.find(token => token.nodeId === 'worker').status, 'completed');
  assert.deepEqual(after.run.context.nodes.worker.output, { version: 'new-checkpoint' });
  assert.equal(after.run.execution.active, false);
  assert.equal(nextSnapshot.execution.active, true, 'later settlement does not mutate the earlier snapshot');
  assert.equal(h.calls.length, 1);
});

test('HTTP start preserves failed and completed history and rejects an unfinished replacement', TEST_OPTIONS, async t => {
  const h = await setup(t, { definition: TERMINAL });
  const firstId = expectStatus(await h.post('private', 'start', { cwd: h.cwd }), 201).run.runId;
  const firstJob = expectStatus(await h.post('public', 'run', { runId: firstId }), 202).run.jobId;
  const first = await h.pending();
  first.completeText(JSON.stringify({ outcome: 'unknown-outcome', output: { reason: 'intentional fixture failure' } }));
  await h.jobs.settle(firstJob);
  const failed = await h.store.loadRun(firstId);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.tokens.find(token => token.nodeId === 'worker').error.code, 'invalid_agent_output');
  const secondId = expectStatus(await h.post('public', 'start', { cwd: h.cwd }), 201).run.runId;
  assert.notEqual(secondId, firstId);
  assert.deepEqual(await h.store.loadRun(firstId), failed);
  assert.equal((await h.store.listRuns()).length, 2);
  assert.equal(expectStatus(await h.post('private', 'start', { cwd: h.cwd }), 409).error.code, 'unfinished_run');
  const historical = expectStatus(await h.request('public', 'state', { query: { runId: firstId } }), 200);
  assert.equal(historical.run.status, 'failed');
  assert.equal(historical.run.runId, firstId);
  assert.equal(expectStatus(await h.post('private', 'run', { runId: firstId }), 200).run.status, 'failed');
  assert.equal(h.jobs.records.size, 1, 'failed history is not dispatched again');

  const secondJob = expectStatus(await h.post('private', 'run', { runId: secondId }), 202).run.jobId;
  const second = await h.pending(1);
  second.complete({ result: 'complete' });
  await h.jobs.settle(secondJob);
  const completed = await h.store.loadRun(secondId);
  assert.equal(completed.status, 'done');
  const thirdId = expectStatus(await h.post('public', 'start', { cwd: h.cwd }), 201).run.runId;
  assert.notEqual(thirdId, secondId);
  assert.deepEqual(await h.store.loadRun(firstId), failed);
  assert.deepEqual(await h.store.loadRun(secondId), completed);
  assert.equal((await h.store.listRuns()).length, 3);
  assert.equal(h.calls.length, 2);
});
