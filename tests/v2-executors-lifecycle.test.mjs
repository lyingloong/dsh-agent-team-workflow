import test from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createExecutors, parseAgentText, textOf, agentPrompt } from '../src/v2/executors.mjs';

const completed = (text = '{"outcome":"complete","output":{"ok":true}}') => ({
  stopReason: 'completed', output: [{ type: 'text', text }],
});
const never = () => new Promise(() => {});
const candidates = [{ provider: 'route-a', model: 'model-a' }, { provider: 'route-b', model: 'model-b' }];
const argsFor = (config = {}) => ({
  node: { id: 'worker', type: 'agent', config }, input: {}, context: {},
  definition: { name: 'executor-test', providers: [] }, token: { id: 'token-1' },
});
function setup(startActivation, { signal = new AbortController().signal, settings = {}, onActivity, cwd = process.cwd() } = {}) {
  return createExecutors({
    ctx: { get: name => name === 'subagents' ? { startActivation } : undefined },
    exec: { agent: { id: 'parent' }, signal }, settings: { subagentProvider: 'spawn', ...settings }, cwd, onActivity,
  });
}
async function temporaryDirectory(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'workflow-executor-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }));
  return dir;
}

// These tests use in-memory child handles only; no real workflow or model runs.
test('successful child is checkpointed and released before returning', async () => {
  const order = [];
  const args = argsFor({ provider: 'route-a', model: 'model-a' });
  let spec;
  const executors = setup(async request => {
    spec = request;
    order.push('start');
    return { childId: 'child-1', result: Promise.resolve(completed()), dispose: async () => { order.push('dispose'); } };
  }, { onActivity: async (token, activity) => {
    assert.equal(token, args.token);
    assert.deepEqual(activity, { childId: 'child-1', provider: 'route-a', model: 'model-a' });
    order.push('checkpoint');
  } });
  const result = await executors.agent(args);
  assert.deepEqual(order, ['start', 'checkpoint', 'dispose']);
  assert.deepEqual(result.output, { ok: true });
  assert.equal(spec.delivery, 'caller');
  assert.equal(spec.request.parent.id, 'parent');
});

test('failed candidate releases its child before the next candidate starts', async () => {
  const order = [];
  let count = 0;
  const executors = setup(async () => {
    const index = ++count;
    order.push(`start-${index}`);
    return {
      childId: `child-${index}`,
      result: index === 1 ? Promise.reject(new Error('quota exhausted')) : Promise.resolve(completed()),
      dispose: async () => { order.push(`dispose-${index}`); },
    };
  });
  const result = await executors.agent(argsFor({ models: candidates }));
  assert.deepEqual(order, ['start-1', 'dispose-1', 'start-2', 'dispose-2']);
  assert.deepEqual(result.model, candidates[1]);
});

test('already cancelled execution never admits a child or tries fallback', async () => {
  const controller = new AbortController();
  controller.abort('stopped');
  let starts = 0;
  const executors = setup(async () => { starts += 1; }, { signal: controller.signal });
  await assert.rejects(executors.agent(argsFor({ models: candidates })), { code: 'execution_aborted' });
  assert.equal(starts, 0);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('caller cancellation breaks result wait, releases the child and stops fallback', async () => {
  const controller = new AbortController();
  let ready;
  const started = new Promise(resolve => { ready = resolve; });
  let starts = 0;
  let disposed = 0;
  let childSignal;
  const executors = setup(async spec => {
    starts += 1;
    childSignal = spec.signal;
    return { childId: 'child', result: never(), dispose: async () => { disposed += 1; } };
  }, { signal: controller.signal, onActivity: async () => ready() });
  const pending = executors.agent(argsFor({ models: candidates }));
  await started;
  controller.abort('human stop');
  await assert.rejects(pending, { code: 'execution_aborted' });
  assert.equal(childSignal.aborted, true);
  assert.equal(starts, 1);
  assert.equal(disposed, 1);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assert.equal(getEventListeners(childSignal, 'abort').length, 0);
});

test('aborted stopReason is cancellation, not a reason to try another model', async () => {
  let starts = 0;
  let disposed = 0;
  const executors = setup(async () => {
    starts += 1;
    return { result: Promise.resolve({ stopReason: 'aborted', output: [] }), dispose: async () => { disposed += 1; } };
  });
  await assert.rejects(executors.agent(argsFor({ models: candidates })), { code: 'execution_aborted' });
  assert.equal(starts, 1);
  assert.equal(disposed, 1);
});

test('node deadline overrides settings and drains a stalled child without fallback', async () => {
  let starts = 0;
  let disposed = 0;
  let childSignal;
  const executors = setup(async spec => {
    starts += 1;
    childSignal = spec.signal;
    return { result: never(), dispose: async () => { disposed += 1; } };
  }, { settings: { agentTimeoutMs: 60_000 } });
  await assert.rejects(executors.agent(argsFor({ timeoutMs: 20, models: candidates })), error => {
    assert.equal(error.code, 'execution_timeout');
    assert.match(error.message, /20ms/);
    return true;
  });
  assert.equal(childSignal.aborted, true);
  assert.equal(starts, 1);
  assert.equal(disposed, 1);
});

test('settings deadline cancels compliant startup admission before a handle exists', async () => {
  let signal;
  const executors = setup(spec => {
    signal = spec.signal;
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  }, { settings: { agentTimeoutMs: 20 } });
  await assert.rejects(executors.agent(argsFor()), { code: 'execution_timeout' });
  assert.equal(signal.aborted, true);
});

test('successful completion clears deadline and parent cancellation subscription', async () => {
  const controller = new AbortController();
  let childSignal;
  const executors = setup(async spec => {
    childSignal = spec.signal;
    return { result: Promise.resolve(completed()), dispose: async () => {} };
  }, { signal: controller.signal });
  await executors.agent(argsFor({ timeoutMs: 20 }));
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  await new Promise(resolve => setTimeout(resolve, 35));
  controller.abort();
  assert.equal(childSignal.aborted, false);
});

test('checkpoint failure still releases the child and does not run a second model', async () => {
  let starts = 0;
  let disposed = 0;
  const executors = setup(async () => {
    starts += 1;
    return { result: Promise.reject(new Error('early child failure')), dispose: async () => { disposed += 1; } };
  }, { onActivity: async () => {
    await new Promise(resolve => setImmediate(resolve));
    throw new Error('disk unavailable');
  } });
  await assert.rejects(executors.agent(argsFor({ models: candidates })), { code: 'activity_persistence_failed' });
  assert.equal(starts, 1);
  assert.equal(disposed, 1);
});

test('cleanup failure cannot turn cancellation into a fallback attempt', async () => {
  let starts = 0;
  const executors = setup(async () => {
    starts += 1;
    return { result: Promise.resolve({ stopReason: 'aborted' }), dispose: async () => { throw new Error('cleanup failed'); } };
  });
  await assert.rejects(executors.agent(argsFor({ models: candidates })), { code: 'execution_aborted' });
  assert.equal(starts, 1);
});

test('fenced JSON and final JSON after commentary select explicit outcomes', () => {
  const options = { outcomes: ['pass', 'fail'], fallback: 'pass' };
  assert.deepEqual(parseAgentText('```json\n{"outcome":"fail","output":{"reason":"tests failed"}}\n```', options), {
    outcome: 'fail', output: { reason: 'tests failed' },
  });
  assert.deepEqual(parseAgentText('I checked the output.\n{"outcome":"pass","output":{"nested":{"a":1},"text":"brace } and \\\"quoted\\\""}}', options), {
    outcome: 'pass', output: { nested: { a: 1 }, text: 'brace } and \"quoted\"' },
  });
  assert.deepEqual(parseAgentText('Result:\n```json\n{"outcome":"fail","output":null}\n```', options), { outcome: 'fail', output: null });
});

test('multi-outcome parsing fails closed for absent, unknown or ambiguous decisions', () => {
  const options = { outcomes: ['pass', 'fail'], fallback: 'pass' };
  for (const text of ['', 'probably fine', '{"output":{"ok":true}}', '{"outcome":"unknown"}',
    '{"outcome":"pass"}\n{"outcome":"fail"}', '{"outcome":"pass"}\nActually I am unsure.',
    '[{"outcome":"pass"}]']) {
    assert.throws(() => parseAgentText(text, options), { code: 'invalid_agent_output' }, text);
  }
  assert.equal(parseAgentText('fail', options).outcome, 'fail');
  for (const text of ['true', '42', 'null']) {
    assert.deepEqual(parseAgentText(text, { outcomes: ['complete'] }), { outcome: 'complete', output: { text } });
  }
  assert.deepEqual(parseAgentText('Files updated; details in the diff.', { outcomes: ['complete'] }), {
    outcome: 'complete', output: { text: 'Files updated; details in the diff.' },
  });
});

test('invalid branching output is released and is not retried on another model', async () => {
  let starts = 0;
  let disposed = 0;
  const executors = setup(async () => {
    starts += 1;
    return { result: Promise.resolve(completed('uncertain')), dispose: async () => { disposed += 1; } };
  });
  await assert.rejects(executors.agent(argsFor({ outcomes: ['pass', 'fail'], models: candidates })), { code: 'invalid_agent_output' });
  assert.equal(starts, 1);
  assert.equal(disposed, 1);
});

test('prompt rejects positional defaults and text blocks preserve JSON boundaries', () => {
  assert.equal(textOf([{ type: 'text', text: 'commentary' }, { type: 'text', text: '{"outcome":"fail"}' }]), 'commentary\n{"outcome":"fail"}');
  const args = argsFor();
  const prompt = agentPrompt({ ...args, outcomes: ['pass', 'fail'] });
  assert.match(prompt, /Never default to the first outcome/);
  assert.doesNotMatch(prompt, /use the first allowed outcome/);
});

test('npm script preflight reports configuration failure for absent manifest', async t => {
  const cwd = await temporaryDirectory(t);
  const executors = setup(null, { cwd });
  for (const command of ['npm test', 'npm run verify', 'npm.cmd run test']) {
    await assert.rejects(executors.command({ node: { id: 'verify', config: { command } } }), error => {
      assert.equal(error.code, 'invalid_command_cwd');
      assert.equal(error.cwd, cwd);
      assert.equal(error.command, command);
      assert.match(error.message, /package\.json is missing/);
      return true;
    });
  }
});

test('command results include effective cwd and exact command on success and failure', async t => {
  const cwd = await temporaryDirectory(t);
  const executors = setup(null, { cwd });
  for (const code of [0, 3]) {
    const command = `"${process.execPath}" -e "process.exit(${code})"`;
    const result = await executors.command({ node: { id: 'verify', config: { command } } });
    assert.equal(result.outcome, code === 0 ? 'complete' : 'fail');
    assert.equal(result.output.code, code);
    assert.equal(result.output.cwd, cwd);
    assert.equal(result.output.command, command);
  }
});

test('cancelled commands are not translated into normal fail edges', async () => {
  const controller = new AbortController();
  controller.abort();
  const executors = setup(null, { signal: controller.signal });
  await assert.rejects(executors.command({ node: { id: 'verify', config: { command: 'echo should-not-run' } } }), { code: 'execution_aborted' });
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('HTTP caller cancellation aborts fetch and cleans up its subscription', async t => {
  const controller = new AbortController();
  let ready;
  const started = new Promise(resolve => { ready = resolve; });
  let fetchSignal;
  t.mock.method(globalThis, 'fetch', (url, options) => {
    fetchSignal = options.signal;
    ready();
    return never();
  });
  const executors = setup(null, { signal: controller.signal });
  const pending = executors.http({ node: { id: 'request', config: { url: 'https://example.invalid' } } });
  await started;
  controller.abort();
  await assert.rejects(pending, { code: 'execution_aborted' });
  assert.equal(fetchSignal.aborted, true);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assert.equal(getEventListeners(fetchSignal, 'abort').length, 0);
});

test('HTTP deadline covers a stalled response body', async t => {
  let fetchSignal;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    fetchSignal = options.signal;
    return { ok: true, status: 200, text: never };
  });
  const executors = setup(null);
  await assert.rejects(executors.http({ node: { id: 'request', config: { url: 'https://example.invalid', timeoutMs: 20 } } }), { code: 'execution_timeout' });
  assert.equal(fetchSignal.aborted, true);
});


test('default agent has no task timer but still releases its cancellation subscription', async t => {
  const timer=t.mock.method(globalThis,'setTimeout',()=>{throw new Error('agent default must not arm a task timer');});
  const parent=new AbortController();let disposed=0;let signal;
  const executor=setup(async spec=>{signal=spec.signal;return {result:Promise.resolve(completed()),dispose:async()=>{disposed++;}};},{signal:parent.signal});
  await executor.agent(argsFor());
  assert.equal(timer.mock.callCount(),0);assert.equal(disposed,1);assert.equal(signal.aborted,false);
  assert.equal(getEventListeners(parent.signal,'abort').length,0);
});

test('timeoutMs zero explicitly disables an inherited optional agent timeout', async t => {
  const timer=t.mock.method(globalThis,'setTimeout',()=>{throw new Error('zero must not arm timer');});
  const executor=setup(async()=>({result:Promise.resolve(completed()),dispose:async()=>{}}),{settings:{agentTimeoutMs:25}});
  await executor.agent(argsFor({timeoutMs:0}));assert.equal(timer.mock.callCount(),0);
});
