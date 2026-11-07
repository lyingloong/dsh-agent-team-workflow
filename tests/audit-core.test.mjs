/** Host-free audit regressions: disposable temp stores; no shell/network/profile. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { normalizeDefinition } from '../src/definition.mjs';
import { newRunState, enqueue, run, decide, waitingHumanTokens } from '../src/runtime.mjs';
import { SessionStore } from '../src/store.mjs';
import { requireCommand, requireHttp } from '../src/permissions.mjs';
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function graph(nodes, edges = [], extra = {}) { return normalizeDefinition({ apiVersion: 2, name: 'core audit', nodes, edges, ...extra }); }
async function fixture(t, definition, input = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'workflow-audit-core-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new SessionStore(directory), io = store.createIO('audit-run');
  const state = await newRunState({ definition, input, cwd: directory }, io);
  return { directory, store, io, state };
}
for (const [mode, count] of [['any', undefined], ['quorum', 2]]) {
  test(`AUDIT-JOIN-${mode}: late children cannot execute parent continuation again`, { timeout: 8000 }, async t => {
    const { state, io } = await fixture(t, graph([
      { id: 'fork', type: 'fanout', config: { items: '$input.items', target: 'child', join: 'join' } },
      { id: 'child', type: 'agent', concurrency: 3 },
      { id: 'join', type: 'join', config: { mode, ...(count ? { count } : {}) } },
      { id: 'tail', type: 'agent', concurrency: 3 },
    ], [{ from: 'child', to: 'join' }, { from: 'join', to: 'tail' }], { concurrency: 4 }), { items: [{ id: 0 }, { id: 1 }, { id: 2 }] });
    const releaseLate = deferred(), tailPackets = [];
    const rootPacket = Object.keys(state.packets)[0], threshold = count ?? 1;
    try {
      await run(state, { agent: async ({ node, input, packet }) => {
        if (node.id === 'child') { if (input.id >= threshold) await releaseLate.promise; return { output: input }; }
        tailPackets.push(packet.id); releaseLate.resolve(); return { output: input };
      } }, { io });
    } finally { releaseLate.resolve(); }
    t.diagnostic(JSON.stringify({ mode, threshold, rootPacket, tailPackets })); assert.deepEqual(tailPackets, [rootPacket]);
  });
}
test('AUDIT-JOIN-OUTPUT: early any completion cannot be overwritten by its still-publishing fork', { timeout: 8000 }, async t => {
  const { state, io, store } = await fixture(t, graph([
    { id: 'fork', type: 'fanout', config: { items: '$input.items', target: 'child', join: 'join' } },
    { id: 'child', type: 'agent', concurrency: 2 }, { id: 'join', type: 'join', config: { mode: 'any' } }, { id: 'tail', type: 'agent' },
  ], [{ from: 'child', to: 'join' }, { from: 'join', to: 'tail' }], { concurrency: 4 }), { items: [{ id: 'fast' }, { id: 'slow-publication' }] });
  const parentId = Object.keys(state.packets)[0];
  const delayedIO = { ...io, put: async value => { if (value?.id === 'slow-publication') await new Promise(resolve => setTimeout(resolve, 40)); return io.put(value); } };
  await run(state, { agent: async ({ node, input }) => ({ output: node.id === 'tail' ? { joined: true } : input }) }, { io: delayedIO });
  const terminal = (await store.readHistory(state.runId)).find(record => record.type === 'packet' && record.id === parentId);
  assert.deepEqual(await io.get(terminal.outputRef), { joined: true });
});

test('AUDIT-COMMIT-SNAPSHOT: checkpoints during terminal archival retain an uncertain running token', { timeout: 8000 }, async t => {
  const { state, io, store } = await fixture(t, graph([{ id: 'worker', type: 'agent' }, { id: 'tail', type: 'agent' }], [{ from: 'worker', to: 'tail' }]));
  let during;
  const observedIO = { ...io, archive: async record => {
    if (record.type === 'token' && record.nodeId === 'worker') { await store.saveRun(state); during = await store.loadRun(state.runId); }
    return io.archive(record);
  } };
  await run(state, { agent: async () => ({ output: null }) }, { io: observedIO });
  assert.equal(during.tokens.find(token => token.nodeId === 'worker')?.status, 'running');
  assert.equal(during.tokens.some(token => token.nodeId === 'tail'), false);
});

test('AUDIT-PERSIST: acknowledged enqueue survives previously queued runtime snapshots', { timeout: 8000 }, async t => {
  const { state, io, store } = await fixture(t, graph([{ id: 'worker', type: 'agent', concurrency: 2 }], [], { concurrency: 2 }), { id: 'first' });
  await enqueue(state, { input: { id: 'second' } }, io);
  const firstWriteEntered = deferred(), releaseFirstWrite = deferred(), thirdWriteSaved = deferred(), releaseExecutors = deferred();
  let writes = Promise.resolve(), writeNumber = 0;
  const persist = (snapshot = structuredClone(state)) => {
    writes = writes.then(async () => {
      const ordinal = ++writeNumber; if (ordinal === 1) { firstWriteEntered.resolve(); await releaseFirstWrite.promise; }
      await store.saveRun(snapshot); if (ordinal === 3) thirdWriteSaved.resolve();
    }); return writes;
  };
  const running = run(state, { agent: async ({ input }) => { await releaseExecutors.promise; return { output: input }; } }, { io, checkpoint: persist }); running.catch(() => {});
  let disk, acknowledgedId;
  try {
    await firstWriteEntered.promise;
    const admitted = await enqueue(state, { input: { id: 'acknowledged-arrival' } }, io); acknowledgedId = admitted.id;
    const acknowledged = persist(); releaseFirstWrite.resolve(); await acknowledged; await thirdWriteSaved.promise;
    disk = await store.loadRun(state.runId); t.diagnostic(JSON.stringify({ acknowledgedId, inMemory: !!state.packets[acknowledgedId], onDisk: !!disk.packets[acknowledgedId] }));
  } finally { releaseFirstWrite.resolve(); releaseExecutors.resolve(); await running; }
  assert.ok(disk.packets[acknowledgedId]);
});
test('AUDIT-PRUNE: in-flight enqueue input survives repeated prune passes', { timeout: 8000 }, async t => {
  const { state, io, store } = await fixture(t, graph([{ id: 'worker', type: 'agent', inputs: { id: '$input.id' } }], [], { historyLimit: 0 }), { id: 'published' });
  const getEntered = deferred(), releaseGet = deferred();
  const delayedIO = { ...io, get: async ref => { getEntered.resolve(ref); await releaseGet.promise; return io.get(ref); } };
  const pending = enqueue(state, { input: { id: 'unpublished' } }, delayedIO); pending.catch(() => {});
  let error, packet;
  try {
    await getEntered.promise; await store.pruneArtifacts(state.runId, state); await store.pruneArtifacts(state.runId, state);
    releaseGet.resolve(); try { packet = await pending; } catch (caught) { error = caught; }
  } finally { releaseGet.resolve(); await pending.catch(() => {}); }
  t.diagnostic(JSON.stringify({ enqueueSucceeded: !!packet, errorCode: error?.code })); assert.equal(error, undefined);
});
test('AUDIT-DECIDE: decision racing with sibling failure cannot publish successors', { timeout: 8000 }, async t => {
  const { state, io } = await fixture(t, graph([
    { id: 'start', type: 'gate' }, { id: 'human', type: 'human' }, { id: 'breaker', type: 'agent' }, { id: 'tail', type: 'agent' },
  ], [{ from: 'start', to: 'human' }, { from: 'start', to: 'breaker' }, { from: 'human', to: 'tail', on: 'approve' }], { concurrency: 3 }));
  await run(state, {}, { io, control: { nodes: { breaker: false } } });
  const human = waitingHumanTokens(state)[0], putEntered = deferred(), releasePut = deferred();
  const delayedIO = { ...io, put: async value => { putEntered.resolve(); await releasePut.promise; return io.put(value); } };
  const deciding = decide(state, { tokenId: human.id, outcome: 'approve', output: { note: 'audit' } }, delayedIO); deciding.catch(() => {});
  let decisionError;
  try {
    await putEntered.promise; await run(state, { agent: async () => { throw new Error('sibling failed'); } }, { io });
    releasePut.resolve(); try { await deciding; } catch (caught) { decisionError = caught; }
  } finally { releasePut.resolve(); await deciding.catch(() => {}); }
  const ghosts = state.tokens.filter(token => token.status === 'ready' && state.packets[token.packetId]?.status !== 'active');
  t.diagnostic(JSON.stringify({ decisionError: decisionError?.code, runStatus: state.status, ghostNodes: ghosts.map(token => token.nodeId) }));
  assert.ok(decisionError); assert.equal(ghosts.length, 0);
});
test('AUDIT-FINISH: output write racing with sibling failure cannot publish successors', { timeout: 8000 }, async t => {
  const { state, io } = await fixture(t, graph([
    { id: 'start', type: 'gate' }, { id: 'writer', type: 'agent' }, { id: 'breaker', type: 'agent' }, { id: 'tail', type: 'agent' },
  ], [{ from: 'start', to: 'writer' }, { from: 'start', to: 'breaker' }, { from: 'writer', to: 'tail' }], { concurrency: 3 }));
  const outputEntered = deferred(), releaseOutput = deferred(), failureSaved = deferred();
  const delayedIO = { ...io, put: async value => { if (value?.lateOutput) { outputEntered.resolve(); await releaseOutput.promise; } return io.put(value); } };
  const running = run(state, { agent: async ({ node }) => {
    if (node.id === 'writer') return { output: { lateOutput: true } };
    if (node.id === 'breaker') { await outputEntered.promise; throw new Error('sibling failure during output write'); }
    assert.fail('tail must not execute');
  } }, { io: delayedIO, checkpoint: async snapshot => { if (snapshot.tokens.some(token => token.nodeId === 'breaker' && token.status === 'failed')) failureSaved.resolve(); } }); running.catch(() => {});
  try { await failureSaved.promise; } finally { releaseOutput.resolve(); await running; }
  const ghosts = state.tokens.filter(token => token.status === 'ready' && state.packets[token.packetId]?.status !== 'active');
  t.diagnostic(JSON.stringify({ runStatus: state.status, ghostNodes: ghosts.map(token => token.nodeId) })); assert.equal(ghosts.length, 0);
});
test('AUDIT-PERMISSION: narrow command grant rejects appended shell commands', { timeout: 8000 }, async t => {
  const { state, io } = await fixture(t, graph([{ id: 'command', type: 'command', config: { command: 'node trusted-driver.mjs task && unauthorized-command' } }]));
  state.permissions.command = { mode: 'allowlist', allow: ['node trusted-driver.mjs'] }; const executed = [];
  await run(state, { command: async ({ node }) => { executed.push(node.config.command); return { output: null }; } }, { io });
  t.diagnostic(JSON.stringify({ executed, failed: state.counts.failed })); assert.deepEqual(executed, []);
});
test('AUDIT-IDENTIFIER: prototype-named nodes obey failure budgets', { timeout: 8000 }, async t => {
  const { state, io } = await fixture(t, graph([{ id: 'constructor', type: 'agent', config: { maxFailures: 3 } }], [{ from: 'constructor', to: 'constructor', on: 'needs_revision' }]));
  let calls = 0; await run(state, { agent: async () => { calls++; return { outcome: 'needs_revision', output: null }; } }, { io, maxSteps: 7 });
  const packet = Object.values(state.packets)[0]; t.diagnostic(JSON.stringify({ calls, pauseReason: state.pauseReason, failureCounter: String(packet.failures.constructor) }));
  assert.equal(calls, 3); assert.equal(state.tokens[0].error?.code, 'failure_budget_exhausted');
});
test('CONTROL-3PLUS3: six executors overlap across independent three-slot pools', { timeout: 8000 }, async t => {
  const { state, io, store } = await fixture(t, graph([
    { id: 'engineer', type: 'agent', concurrency: 3 },
    { id: 'reviewer', type: 'agent', concurrency: 3, inputs: { id: '$input.id', previous: '$prev.id', own: '$nodes.engineer.output.id' } },
  ], [{ from: 'engineer', to: 'reviewer' }], { concurrency: 6, historyLimit: 4 }), { id: 0 });
  for (let id = 1; id < 6; id++) await enqueue(state, { input: { id } }, io);
  const release = deferred(); let engineers = 0, reviewers = 0, maxEngineers = 0, maxReviewers = 0, maximum = 0;
  try {
    await run(state, { agent: async ({ node, input }) => {
      if (node.id === 'engineer') engineers++; else { reviewers++; assert.equal(input.id, input.previous); assert.equal(input.id, input.own); }
      maxEngineers = Math.max(maxEngineers, engineers); maxReviewers = Math.max(maxReviewers, reviewers); maximum = Math.max(maximum, engineers + reviewers);
      if (engineers === 3 && reviewers === 3) release.resolve();
      if ((node.id === 'engineer' && input.id >= 3) || (node.id === 'reviewer' && input.id < 3)) await release.promise;
      if (node.id === 'engineer') engineers--; else reviewers--; return { output: { id: input.id } };
    } }, { io, checkpoint: snapshot => store.saveRun(snapshot) });
  } finally { release.resolve(); }
  t.diagnostic(JSON.stringify({ maxEngineers, maxReviewers, maximum })); assert.equal(maxEngineers, 3); assert.equal(maxReviewers, 3); assert.equal(maximum, 6); assert.equal(state.counts.packetsCompleted, 6);
});
test('AUDIT-SAME-PACKET: concurrent terminal siblings complete their packet only once', async () => {
  const artifacts = new Map(), records = [], outputs = deferred(); let next = 0, written = 0;
  const io = { put: async value => { const ref = `memory-${++next}`; artifacts.set(ref, structuredClone(value)); if (value?.node) { if (++written === 2) outputs.resolve(); await outputs.promise; } return ref; }, get: async ref => structuredClone(artifacts.get(ref)), archive: async record => { records.push(record); } };
  const state = await newRunState({ definition: graph([{ id: 'start', type: 'gate' }, { id: 'left', type: 'agent' }, { id: 'right', type: 'agent' }], [{ from: 'start', to: 'left' }, { from: 'start', to: 'right' }], { concurrency: 3 }) }, io);
  await run(state, { agent: async ({ node }) => ({ output: { node: node.id } }) }, { io });
  assert.equal(state.counts.packetsCompleted, 1);
  assert.equal(records.filter(record => record.type === 'packet').length, 1);
});

test('AUDIT-FANOUT-FAILURE: failed parent cannot publish children after an awaited item load', { timeout: 8000 }, async t => {
  const { state, io } = await fixture(t, graph([
    { id: 'start', type: 'gate' }, { id: 'fork', type: 'fanout', config: { items: '$input.items', target: 'child', detached: true } },
    { id: 'breaker', type: 'agent' }, { id: 'child', type: 'agent' },
  ], [{ from: 'start', to: 'fork' }, { from: 'start', to: 'breaker' }], { concurrency: 3 }), { items: [{ id: 1 }] });
  const reading = deferred(), release = deferred(), failed = deferred(); let childCalls = 0;
  const delayedIO = { ...io, get: async ref => { const value = await io.get(ref); if (Array.isArray(value)) { reading.resolve(); await release.promise; } return value; } };
  const running = run(state, { agent: async ({ node }) => {
    if (node.id === 'breaker') { await reading.promise; throw new Error('parent failed'); }
    childCalls++; return { output: null };
  } }, { io: delayedIO, checkpoint: async snapshot => { if (snapshot.tokens.some(token => token.nodeId === 'breaker' && token.status === 'failed')) failed.resolve(); } });
  running.catch(() => {});
  try { await failed.promise; } finally { release.resolve(); await running; }
  assert.equal(childCalls, 0); assert.equal(state.counts.packetsCreated, 1);
});

test('AUDIT-NESTED-FAILURE: active nested step drains but no later step starts after parent failure', { timeout: 8000 }, async t => {
  const child = { apiVersion: 2, name: 'child', nodes: [{ id: 'first', type: 'agent' }, { id: 'second', type: 'agent' }], edges: [{ from: 'first', to: 'second' }] };
  const { state, io } = await fixture(t, graph([{ id: 'start', type: 'gate' }, { id: 'nested', type: 'subworkflow', config: { definition: child } }, { id: 'breaker', type: 'agent' }], [{ from: 'start', to: 'nested' }, { from: 'start', to: 'breaker' }], { concurrency: 3 }));
  const entered = deferred(), release = deferred(), failed = deferred(); const calls = [];
  const running = run(state, { agent: async ({ node }) => {
    calls.push(node.id);
    if (node.id === 'first') { entered.resolve(); await release.promise; return { output: null }; }
    if (node.id === 'breaker') { await entered.promise; throw new Error('outer sibling failed'); }
    return { output: null };
  } }, { io, checkpoint: async snapshot => { if (snapshot.tokens.some(token => token.nodeId === 'breaker' && token.status === 'failed')) failed.resolve(); } });
  running.catch(() => {});
  try { await failed.promise; } finally { release.resolve(); await running; }
  assert.ok(calls.includes('first')); assert.equal(calls.includes('second'), false);
});

test('AUDIT-DECISION-OWNERSHIP: live decision archival is not an orphan during another scheduler slice', { timeout: 8000 }, async t => {
  const { state, io } = await fixture(t, graph([{ id: 'human', type: 'human' }]));
  await run(state, {}, { io }); const tokenId = waitingHumanTokens(state)[0].id;
  const entered = deferred(), release = deferred();
  const delayedIO = { ...io, archive: async record => { entered.resolve(); await release.promise; return io.archive(record); } };
  const deciding = decide(state, { tokenId, outcome: 'approve' }, delayedIO); deciding.catch(() => {});
  let status;
  try { await entered.promise; await run(state, {}, { io }); status = state.status; }
  finally { release.resolve(); await deciding; }
  assert.notEqual(status, 'interrupted'); assert.equal(state.counts.packetsCompleted, 1);
});

for (const items of [[], [{ fail: true }, { fail: false }]]) test(`CONTROL-JOIN-all: empty/failure aggregation ${items.length}`, { timeout: 8000 }, async t => {
  const { state, io, store } = await fixture(t, graph([
    { id: 'fork', type: 'fanout', config: { items: '$input.items', target: 'child', join: 'join' } },
    { id: 'child', type: 'agent', concurrency: 2 }, { id: 'join', type: 'join', config: { mode: 'all' } }, { id: 'tail', type: 'agent' },
  ], [{ from: 'child', to: 'join' }, { from: 'join', to: 'tail' }], { concurrency: 4 }), { items });
  let tails = 0;
  await run(state, { agent: async ({ node, input }) => { if (node.id === 'tail') tails++; if (input?.fail) throw new Error('child failed'); return { output: input }; } }, { io });
  assert.equal(tails, items.length ? 0 : 1);
  if (items.length) assert.ok((await store.readHistory(state.runId)).some(record => record.nodeId === 'join' && record.status === 'failed'));
});

test('AUDIT-CAUSAL: same-packet repeated nodes keep each successor context and result mapping isolated', { timeout: 8000 }, async t => {
  const { state, io } = await fixture(t, graph([
    { id: 'start', type: 'gate' }, { id: 'worker', type: 'agent', concurrency: 2 },
    { id: 'sink', type: 'agent', concurrency: 2, inputs: { previous: '$prev.id', mapped: '$nodes.worker.output.id' } },
  ], [{ from: 'start', to: 'worker' }, { from: 'start', to: 'worker' }, { from: 'worker', to: 'sink' }], { concurrency: 4 }));
  let next = 0;
  await run(state, { agent: async () => ({ output: { id: ++next } }) }, { io, control: { nodes: { sink: false } } });
  const seen = [];
  await run(state, { agent: async ({ input, context, packet }) => {
    const contextual = await io.get(context.results.worker.outputRef);
    const packetResult = await io.get(packet.results.worker.outputRef);
    seen.push({ ...input, contextual: contextual.id, packet: packetResult.id });
    return { output: input };
  } }, { io });
  seen.sort((a, b) => a.previous - b.previous);
  assert.deepEqual(seen, [{ previous: 1, mapped: 1, contextual: 1, packet: 1 }, { previous: 2, mapped: 2, contextual: 2, packet: 2 }]);
  assert.equal(state.counts.packetsCompleted, 1);
});

test('AUDIT-DOUBLE-DECIDE: simultaneous decisions have one winner and one continuation', { timeout: 8000 }, async t => {
  const { state, io, store } = await fixture(t, graph([{ id: 'human', type: 'human' }, { id: 'tail', type: 'agent' }], [{ from: 'human', to: 'tail', on: 'approve' }]));
  await run(state, {}, { io }); const tokenId = waitingHumanTokens(state)[0].id;
  const results = await Promise.allSettled([decide(state, { tokenId, outcome: 'approve', output: 1 }, io), decide(state, { tokenId, outcome: 'approve', output: 2 }, io)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'not_waiting');
  let calls = 0; await run(state, { agent: async () => { calls++; return { output: null }; } }, { io });
  assert.equal(calls, 1); assert.equal(state.counts.packetsCompleted, 1);
  assert.equal(store.channel(state.runId).pins.size, 0); assert.equal(store.channel(state.runId).holds, 0);
});

test('AUDIT-PROTOTYPES: missing results and JSON input cannot expose inherited constructor fields', { timeout: 8000 }, async t => {
  const beforeObject = Object.getOwnPropertyDescriptors(Object), beforeToString = Object.getOwnPropertyDescriptors(Object.prototype.toString);
  const { state, io } = await fixture(t, graph([
    { id: 'constructor', type: 'agent', inputs: { absent: '$nodes.constructor.name', prototype: '$input.constructor.name' } },
    { id: 'toString', type: 'agent', inputs: { output: '$nodes.constructor.output.value', absent: '$nodes.toString.name' } },
  ], [{ from: 'constructor', to: 'toString' }]));
  const seen = [];
  await run(state, { agent: async ({ node, input }) => { seen.push([node.id, input]); return { output: { value: 'owned' } }; } }, { io });
  assert.deepEqual(seen, [['constructor', {}], ['toString', { output: 'owned' }]]);
  assert.equal(state.nodeStats.constructor.completed, 1); assert.equal(state.nodeStats.toString.completed, 1);
  assert.deepEqual(Object.getOwnPropertyDescriptors(Object), beforeObject);
  assert.deepEqual(Object.getOwnPropertyDescriptors(Object.prototype.toString), beforeToString);
});

test('CONTROL-GENERATION: notifications before parking cannot be lost and abort removes waiters', { timeout: 8000 }, async t => {
  const { io } = await fixture(t, graph([{ id: 'worker', type: 'agent' }]));
  const before = io.version(); io.notify(); assert.equal(io.version(), before + 1);
  await io.waitForChange({ since: before });
  const controller = new AbortController();
  const waiting = io.waitForChange({ since: io.version(), signal: controller.signal });
  controller.abort(); await waiting;
  const next = io.waitForChange({ since: io.version() }); io.notify(); await next;
});

test('CONTROL-PERMISSIONS: literal argv and exact HTTP host grants have explicit boundaries', () => {
  const command = { mode: 'allowlist', allow: ['node trusted-driver.mjs', '"C:\\Program Files\\node.exe" trusted-driver.mjs'] };
  for (const value of ['node trusted-driver.mjs action --input "path with spaces"', '"C:\\Program Files\\node.exe" trusted-driver.mjs action']) assert.doesNotThrow(() => requireCommand(command, value));
  for (const value of ['node trusted-driver.mjs.evil', 'node trusted-driver.mjs && bad', 'node trusted-driver.mjs | bad', 'node trusted-driver.mjs;bad', 'node trusted-driver.mjs > target', 'node trusted-driver.mjs $(bad)', 'node trusted-driver.mjs `bad`', 'node trusted-driver.mjs %COMMAND%', 'node trusted-driver.mjs\nbad', 'node "trusted-driver.mjs']) assert.throws(() => requireCommand(command, value), { code: 'permission_denied' });
  assert.throws(() => requireCommand(undefined, 'node trusted-driver.mjs'), { code: 'permission_denied' });
  assert.doesNotThrow(() => requireCommand({ mode: 'full' }, 'arbitrary && explicitly-authorized'));
  const http = { mode: 'allowlist', allow: ['EXAMPLE.TEST', '*.child.test', 'other.test:8080'] };
  for (const url of ['https://example.test/x', 'http://a.child.test/x', 'http://other.test:8080/x']) assert.doesNotThrow(() => requireHttp(http, url));
  for (const url of ['https://example.test.evil/x', 'https://child.test/x', 'http://other.test:8081/x', 'file://example.test/x', 'ftp://example.test/x']) assert.throws(() => requireHttp(http, url), { code: 'permission_denied' });
  assert.throws(() => requireHttp({ mode: 'full' }, 'file:///tmp/not-http'), { code: 'permission_denied' });
});

test('CONTROL-RETENTION: bounded history does not bound retained failure evidence', { timeout: 8000 }, async t => {
  const { state, io, store } = await fixture(t, graph([{ id: 'worker', type: 'agent', concurrency: 3 }], [], { historyLimit: 2 }));
  for (let id = 1; id < 20; id++) await enqueue(state, { input: { id } }, io);
  let calls = 0; const executors = { agent: async () => { calls++; throw new Error('audit retained failure'); } };
  await run(state, executors, { io }); await run(state, executors, { io }); const history = await store.readHistory(state.runId);
  t.diagnostic(JSON.stringify({ calls, hotTokens: state.tokens.length, hotPackets: Object.keys(state.packets).length, history: history.length })); assert.equal(calls, 20); assert.equal(history.length, 2); assert.equal(state.tokens.length, 20);
});
