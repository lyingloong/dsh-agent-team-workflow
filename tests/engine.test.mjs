import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { normalizeDefinition } from '../src/definition.mjs';
import { Engine, EngineError } from '../src/engine.mjs';
import { Store } from '../src/store.mjs';

const START = '2026-01-01T00:00:00.000Z';

function setup(t, {
  leaseMs = 60_000,
  policies = {},
  providerConcurrency = 2,
  providers,
  roleProviders = ['p1'],
  stageProviders,
} = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'agent-team-workflow-engine-'));
  let now = new Date(START);
  const clock = () => now;
  const store = Store.open(path.join(dir, 'agent-team-workflow.sqlite3'), { clock });
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  const definition = normalizeDefinition({
    apiVersion: 1,
    name: 'flow',
    roles: [
      { id: 'analyst', instances: 3, providers: roleProviders },
      { id: 'engineer', instances: 2, providers: roleProviders },
      { id: 'reviewer', instances: 2, providers: roleProviders },
      { id: 'captain', kind: 'coordinator', instances: 1 },
    ],
    providers: providers ?? [{ id: 'p1', concurrency: providerConcurrency }],
    stages: [
      { id: 'specify', role: 'analyst', ...(stageProviders ? { providers: stageProviders } : {}), on: { complete: 'implement' } },
      { id: 'implement', role: 'engineer', on: { complete: 'review' } },
      {
        id: 'review',
        role: 'reviewer',
        options: ['pass', 'needs_revision'],
        on: { pass: 'approved', needs_revision: 'implement' },
      },
      { id: 'approved', role: 'reviewer' },
    ],
    gates: [{ id: 'merge', after: 'review', outcome: 'pass', kind: 'manual' }],
    policies: {
      retry: { maxAttempts: 2, backoffSeconds: [0] },
      ...policies,
    },
  });
  const engine = new Engine({ store, definition, clock, leaseMs });
  const advance = ms => {
    now = new Date(now.getTime() + ms);
  };
  return { store, engine, definition, advance, now: () => now };
}

function expectEngineError(fn, code) {
  assert.throws(fn, error => {
    assert.ok(error instanceof EngineError, `expected EngineError, got ${error?.name}: ${error?.message}`);
    assert.equal(error.code, code);
    return true;
  });
}

test('enqueue creates an item and its entry task', (t) => {
  const { store, engine } = setup(t);
  const { itemId, taskId } = engine.enqueue({ title: 'first', data: { prompt: 'do it' }, priority: 3 });
  const snapshot = store.snapshot();
  assert.equal(snapshot.items.length, 1);
  assert.equal(snapshot.items[0].id, itemId);
  assert.equal(snapshot.items[0].stage, 'specify');
  assert.equal(snapshot.items[0].status, 'active');
  assert.equal(snapshot.tasks[0].id, taskId);
  assert.equal(snapshot.tasks[0].status, 'ready');
  assert.equal(snapshot.tasks[0].role, 'analyst');
  assert.deepEqual(snapshot.tasks[0].contract.input, { prompt: 'do it' });
  assert.deepEqual(snapshot.tasks[0].contract.requires, []);
});

test('claim marks a task running with an attempt lease', (t) => {
  const { store, engine } = setup(t);
  const { taskId } = engine.enqueue({ title: 'first' });
  const claimed = engine.claim({ role: 'analyst', member: 'a1', provider: 'p1' });
  assert.equal(claimed.task.id, taskId);
  assert.equal(claimed.task.status, 'running');
  assert.equal(claimed.attempt.expiresAt, '2026-01-01T00:01:00.000Z');
  const snapshot = store.snapshot();
  assert.equal(snapshot.tasks[0].status, 'running');
  assert.equal(snapshot.tasks[0].attemptId, claimed.attempt.id);
  assert.equal(snapshot.attempts[0].status, 'running');
  assert.equal(snapshot.attempts[0].expiresAt, claimed.attempt.expiresAt);
});

test('claim returns null when the role has no work', (t) => {
  const { engine } = setup(t);
  assert.equal(engine.claim({ role: 'analyst', member: 'a1' }), null);
});

test('claim enforces global capacity', (t) => {
  const { engine } = setup(t, { policies: { concurrency: { global: 1 } } });
  engine.enqueue({ title: 'one' });
  engine.enqueue({ title: 'two' });
  engine.claim({ role: 'analyst', member: 'a1' });
  expectEngineError(() => engine.claim({ role: 'analyst', member: 'a2' }), 'global_capacity');
});

test('claim enforces the role slot limit', (t) => {
  const { engine } = setup(t, { providerConcurrency: 3 });
  engine.enqueue({ title: 'one' });
  engine.enqueue({ title: 'two' });
  engine.enqueue({ title: 'three' });
  engine.enqueue({ title: 'four' });
  engine.claim({ role: 'analyst', member: 'a1' });
  engine.claim({ role: 'analyst', member: 'a2' });
  engine.claim({ role: 'analyst', member: 'a3' });
  expectEngineError(() => engine.claim({ role: 'analyst', member: 'a4' }), 'role_capacity');
  assert.equal(engine.claim({ role: 'engineer', member: 'e1' }), null);
});

test('claim enforces per-provider capacity', (t) => {
  const { definition, store } = setup(t);
  const engine = new Engine({ store, definition, clock: () => new Date(START) });
  for (let index = 0; index < 3; index += 1) engine.enqueue({ title: `item-${index}` });
  engine.claim({ role: 'analyst', member: 'a1', provider: 'p1' });
  engine.claim({ role: 'analyst', member: 'a2', provider: 'p1' });
  expectEngineError(() => engine.claim({ role: 'analyst', member: 'a3', provider: 'p1' }), 'provider_capacity');
});

test('coordinator roles cannot claim tasks', (t) => {
  const { engine } = setup(t);
  expectEngineError(() => engine.claim({ role: 'captain', member: 'c1' }), 'coordinator_role');
});

test('claim refuses a blocked provider', (t) => {
  const { store, engine } = setup(t);
  engine.enqueue({ title: 'one' });
  store.append({
    type: 'provider.health',
    entity: 'provider',
    entityId: 'p1',
    payload: { providerId: 'p1', health: 'blocked', reason: 'quota' },
  });
  expectEngineError(() => engine.claim({ role: 'analyst', member: 'a1', provider: 'p1' }), 'provider_blocked');
  expectEngineError(() => engine.claim({ role: 'analyst', member: 'a1', provider: 'nope' }), 'unknown_provider');
});

test('runs the full specify, implement and review chain', (t) => {
  const { store, engine } = setup(t);

  const { itemId } = engine.enqueue({ title: 'feature' });
  const spec = engine.claim({ role: 'analyst', member: 'a1' });
  const specDone = engine.complete({ attemptId: spec.attempt.id, outcome: 'complete' });
  assert.equal(specDone.status, 'advanced');
  assert.equal(specDone.stage, 'implement');
  assert.ok(specDone.nextTaskId);

  const impl = engine.claim({ role: 'engineer', member: 'e1' });
  assert.equal(impl.task.stage, 'implement');
  engine.complete({ attemptId: impl.attempt.id, outcome: 'complete' });

  const review = engine.claim({ role: 'reviewer', member: 'r1' });
  assert.equal(review.task.stage, 'review');
  const gated = engine.complete({ attemptId: review.attempt.id, outcome: 'pass' });
  assert.equal(gated.status, 'gated');
  assert.deepEqual(gated.gates, ['merge']);

  const snapshot = store.snapshot();
  assert.equal(snapshot.items[0].status, 'blocked');
  assert.equal(snapshot.gates[0].status, 'pending');
  assert.equal(snapshot.tasks.at(-1).status, 'completed');
  assert.equal(snapshot.tasks.filter(task => task.stage === 'approved').length, 0);

  const decided = engine.decideGate({ itemId, gate: 'merge', decision: 'approve', by: 'reviewer' });
  assert.equal(decided.status, 'approved');
  assert.equal(decided.stage, 'approved');
  const after = store.snapshot();
  assert.equal(after.items[0].stage, 'approved');
  assert.equal(after.items[0].status, 'done');
  assert.equal(after.gates[0].status, 'approved');
  assert.equal(engine.claim({ role: 'reviewer', member: 'r1' }), null);
});

test('review needs_revision loops back without gating', (t) => {
  const { store, engine } = setup(t);
  const { itemId } = engine.enqueue({ title: 'loop' });
  const spec = engine.claim({ role: 'analyst', member: 'a1' });
  engine.complete({ attemptId: spec.attempt.id });
  const impl = engine.claim({ role: 'engineer', member: 'e1' });
  engine.complete({ attemptId: impl.attempt.id });
  const review = engine.claim({ role: 'reviewer', member: 'r1' });
  const revise = engine.complete({ attemptId: review.attempt.id, outcome: 'needs_revision' });
  assert.equal(revise.status, 'advanced');
  assert.equal(revise.stage, 'implement');
  assert.equal(store.snapshot().gates.length, 0);
  assert.equal(store.snapshot().items[0].status, 'active');
  assert.equal(store.snapshot().items[0].id, itemId);
});

test('rejecting a gate blocks the item', (t) => {
  const { store, engine } = setup(t);
  const { itemId } = engine.enqueue({ title: 'reject me' });
  for (const [role, member] of [['analyst', 'a1'], ['engineer', 'e1']]) {
    const claimed = engine.claim({ role, member });
    engine.complete({ attemptId: claimed.attempt.id });
  }
  const review = engine.claim({ role: 'reviewer', member: 'r1' });
  engine.complete({ attemptId: review.attempt.id, outcome: 'pass' });
  const rejected = engine.decideGate({ itemId, gate: 'merge', decision: 'reject', note: 'not now' });
  assert.equal(rejected.status, 'rejected');
  assert.equal(store.snapshot().items[0].status, 'blocked');
  assert.equal(store.snapshot().gates[0].status, 'rejected');
});

test('a gate can only be decided once', (t) => {
  const { engine } = setup(t);
  const { itemId } = engine.enqueue({ title: 'once' });
  for (const [role, member] of [['analyst', 'a1'], ['engineer', 'e1']]) {
    const claimed = engine.claim({ role, member });
    engine.complete({ attemptId: claimed.attempt.id });
  }
  const review = engine.claim({ role: 'reviewer', member: 'r1' });
  engine.complete({ attemptId: review.attempt.id, outcome: 'pass' });
  engine.decideGate({ itemId, gate: 'merge', decision: 'approve' });
  expectEngineError(() => engine.decideGate({ itemId, gate: 'merge', decision: 'approve' }), 'gate_decided');
  expectEngineError(() => engine.decideGate({ itemId, gate: 'missing', decision: 'approve' }), 'gate_not_found');
});

test('a failed attempt retries within budget and then fails the task', (t) => {
  const { store, engine } = setup(t);
  const { itemId } = engine.enqueue({ title: 'flaky' });
  const first = engine.claim({ role: 'analyst', member: 'a1' });
  const retry = engine.fail({ attemptId: first.attempt.id, error: 'boom' });
  assert.equal(retry.status, 'retried');
  assert.equal(store.snapshot().tasks[0].status, 'ready');
  assert.equal(store.snapshot().attempts[0].status, 'failed');

  const second = engine.claim({ role: 'analyst', member: 'a1' });
  const exhausted = engine.fail({ attemptId: second.attempt.id, error: 'boom again' });
  assert.equal(exhausted.status, 'failed');
  assert.equal(store.snapshot().tasks[0].status, 'failed');
  assert.equal(store.snapshot().items[0].id, itemId);
  assert.equal(store.snapshot().items[0].status, 'blocked');
});

test('a non-retryable failure fails immediately', (t) => {
  const { store, engine } = setup(t);
  engine.enqueue({ title: 'fatal' });
  const claimed = engine.claim({ role: 'analyst', member: 'a1' });
  const result = engine.fail({ attemptId: claimed.attempt.id, error: 'fatal', retryable: false });
  assert.equal(result.status, 'failed');
  assert.equal(store.snapshot().tasks[0].status, 'failed');
});

test('retry uses the configured backoff before the task is claimable again', (t) => {
  const { store, engine, advance } = setup(t, { policies: { retry: { maxAttempts: 3, backoffSeconds: [60] } } });
  engine.enqueue({ title: 'slow' });
  const claimed = engine.claim({ role: 'analyst', member: 'a1' });
  const retry = engine.fail({ attemptId: claimed.attempt.id, error: 'boom' });
  assert.equal(retry.availableAt, '2026-01-01T00:01:00.000Z');
  assert.equal(engine.claim({ role: 'analyst', member: 'a1' }), null);
  advance(61_000);
  const claimedAgain = engine.claim({ role: 'analyst', member: 'a1' });
  assert.ok(claimedAgain);
  assert.equal(store.snapshot().tasks[0].availableAt, retry.availableAt);
});

test('expired leases are reaped and retried', (t) => {
  const { store, engine, advance } = setup(t, { leaseMs: 1_000 });
  engine.enqueue({ title: 'lease' });
  const claimed = engine.claim({ role: 'analyst', member: 'a1' });
  advance(2_000);
  const expired = engine.expireLeases();
  assert.equal(expired.length, 1);
  assert.equal(expired[0].status, 'retried');
  assert.equal(store.snapshot().attempts[0].status, 'failed');
  assert.equal(store.snapshot().tasks[0].status, 'ready');
});

test('completing twice is idempotent', (t) => {
  const { engine } = setup(t);
  engine.enqueue({ title: 'twice' });
  const claimed = engine.claim({ role: 'analyst', member: 'a1' });
  const first = engine.complete({ attemptId: claimed.attempt.id });
  assert.equal(first.status, 'advanced');
  const second = engine.complete({ attemptId: claimed.attempt.id });
  assert.equal(second.status, 'duplicate');
});

test('stale, unknown and ended attempts are rejected', (t) => {
  const { engine } = setup(t);
  engine.enqueue({ title: 'stale' });
  const claimed = engine.claim({ role: 'analyst', member: 'a1' });
  engine.fail({ attemptId: claimed.attempt.id, error: 'done' });
  expectEngineError(() => engine.complete({ attemptId: claimed.attempt.id }), 'attempt_not_running');
  expectEngineError(() => engine.complete({ attemptId: 'attempt-missing' }), 'attempt_not_found');
});

test('rejects an outcome the stage does not declare', (t) => {
  const { engine } = setup(t);
  engine.enqueue({ title: 'bad outcome' });
  const claimed = engine.claim({ role: 'analyst', member: 'a1' });
  expectEngineError(() => engine.complete({ attemptId: claimed.attempt.id, outcome: 'explode' }), 'unknown_outcome');
});

test('assigns the least-loaded healthy lane automatically', (t) => {
  const { engine } = setup(t, {
    providers: [{ id: 'p1', concurrency: 2 }, { id: 'p2', concurrency: 2 }],
    roleProviders: ['p1', 'p2'],
  });
  for (let index = 0; index < 3; index += 1) engine.enqueue({ title: `item-${index}` });
  const providers = [
    engine.claim({ role: 'analyst', member: 'a1' }).attempt.provider,
    engine.claim({ role: 'analyst', member: 'a2' }).attempt.provider,
    engine.claim({ role: 'analyst', member: 'a3' }).attempt.provider,
  ];
  assert.deepEqual(providers.sort(), ['p1', 'p1', 'p2']);
});

test('skips a blocked lane when selecting automatically', (t) => {
  const { engine, store } = setup(t, {
    providers: [{ id: 'p1', concurrency: 1 }, { id: 'p2', concurrency: 1 }],
    roleProviders: ['p1', 'p2'],
  });
  store.append({
    type: 'provider.health',
    entity: 'provider',
    entityId: 'p1',
    payload: { providerId: 'p1', health: 'blocked', reason: 'quota' },
  });
  engine.enqueue({ title: 'one' });
  const claimed = engine.claim({ role: 'analyst', member: 'a1' });
  assert.equal(claimed.attempt.provider, 'p2');
});

test('a provider error parks the lane and the task moves to another', (t) => {
  const { engine, store } = setup(t, {
    providers: [
      { id: 'p1', concurrency: 1, backoffMinutes: [10] },
      { id: 'p2', concurrency: 1 },
    ],
    roleProviders: ['p1', 'p2'],
  });
  engine.enqueue({ title: 'flaky' });
  const claimed = engine.claim({ role: 'analyst', member: 'a1', provider: 'p1' });
  const failed = engine.fail({ attemptId: claimed.attempt.id, error: '429 rate limit' });
  assert.equal(failed.status, 'retried');
  assert.equal(failed.providerFailure, true);
  assert.equal(failed.availableAt, '2026-01-01T00:00:00.000Z');

  const parked = store.snapshot().providers.find(provider => provider.id === 'p1');
  assert.equal(parked.health, 'blocked');
  assert.equal(parked.reason, '429 rate limit');
  assert.equal(parked.blockedUntil, '2026-01-01T00:10:00.000Z');

  const next = engine.claim({ role: 'analyst', member: 'a2' });
  assert.equal(next.attempt.provider, 'p2');
});

test('a provider error can be forced for a generic message', (t) => {
  const { engine, store } = setup(t, {
    providers: [{ id: 'p1', concurrency: 2 }, { id: 'p2', concurrency: 2 }],
    roleProviders: ['p1', 'p2'],
  });
  engine.enqueue({ title: 'silent' });
  const claimed = engine.claim({ role: 'analyst', member: 'a1', provider: 'p1' });
  const failed = engine.fail({ attemptId: claimed.attempt.id, error: 'backend exploded', providerError: true });
  assert.equal(failed.providerFailure, true);
  assert.equal(store.snapshot().providers.find(provider => provider.id === 'p1').health, 'blocked');
});

test('a stage provider pool narrows the role pool', (t) => {
  const { engine } = setup(t, {
    providers: [{ id: 'p1', concurrency: 2 }, { id: 'p2', concurrency: 2 }],
    roleProviders: ['p1', 'p2'],
    stageProviders: ['p2'],
  });
  engine.enqueue({ title: 'narrow' });
  expectEngineError(() => engine.claim({ role: 'analyst', member: 'a1', provider: 'p1' }), 'provider_not_allowed');
  const claimed = engine.claim({ role: 'analyst', member: 'a1', provider: 'p2' });
  assert.equal(claimed.attempt.provider, 'p2');
});

test('a member cannot hold more tasks than its per-member capacity', (t) => {
  const { engine } = setup(t, { providerConcurrency: 1 });
  engine.enqueue({ title: 'one' });
  engine.enqueue({ title: 'two' });
  engine.claim({ role: 'analyst', member: 'a1' });
  expectEngineError(() => engine.claim({ role: 'analyst', member: 'a1' }), 'member_capacity');
});
