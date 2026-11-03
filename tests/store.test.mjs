import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Store } from '../src/store.mjs';

function tempStore(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'agent-team-workflow-store-'));
  const dbPath = path.join(dir, 'agent-team-workflow.sqlite3');
  const store = Store.open(dbPath);
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  return { store, dbPath };
}

function itemEvent(id = 'item-1', overrides = {}) {
  return {
    type: 'item.created',
    entity: 'item',
    entityId: id,
    payload: {
      itemId: id,
      kind: 'task',
      title: 'first item',
      stage: 'work',
      priority: 3,
      data: { source: 'unit-test' },
      ...overrides,
    },
  };
}

test('migrates to the current schema', (t) => {
  const { store } = tempStore(t);
  assert.equal(store.schemaVersion, 2);
  assert.equal(store.eventCount, 0);
});

test('projects an appended event', (t) => {
  const { store } = tempStore(t);
  const result = store.append(itemEvent());
  assert.equal(result.deduped, false);
  assert.equal(result.seq, 1);
  const snapshot = store.snapshot();
  assert.equal(snapshot.items.length, 1);
  assert.equal(snapshot.items[0].id, 'item-1');
  assert.equal(snapshot.items[0].title, 'first item');
  assert.equal(snapshot.items[0].priority, 3);
  assert.deepEqual(snapshot.items[0].data, { source: 'unit-test' });
});

test('is idempotent for a repeated requestId', (t) => {
  const { store } = tempStore(t);
  const first = store.append(itemEvent(), { requestId: 'req-1' });
  const second = store.append(itemEvent('item-2'), { requestId: 'req-1' });
  assert.equal(second.deduped, true);
  assert.equal(second.seq, first.seq);
  assert.equal(store.eventCount, 1);
  assert.equal(store.snapshot().items.length, 1);
});

test('rolls back a batch when one projection fails', (t) => {
  const { store } = tempStore(t);
  assert.throws(() => store.appendMany([
    itemEvent('item-1'),
    {
      type: 'task.created',
      entity: 'task',
      entityId: 'task-1',
      payload: { taskId: 'task-1', itemId: 'item-1', role: 'worker' },
    },
  ]));
  assert.equal(store.eventCount, 0);
  assert.equal(store.snapshot().items.length, 0);
});

test('rebuild replays the log over a tampered projection', (t) => {
  const { store } = tempStore(t);
  store.append(itemEvent());
  store.db.exec("UPDATE items SET title = 'tampered' WHERE id = 'item-1'");
  assert.equal(store.snapshot().items[0].title, 'tampered');
  const replayed = store.rebuild();
  assert.equal(replayed, 1);
  assert.equal(store.snapshot().items[0].title, 'first item');
});

test('ignores unknown event types while replaying', (t) => {
  const { store } = tempStore(t);
  store.append(itemEvent());
  store.append({
    type: 'future.event',
    entity: 'future',
    entityId: 'x',
    payload: { anything: true },
  });
  assert.equal(store.rebuild(), 2);
  assert.equal(store.snapshot().items.length, 1);
});

test('persists across reopen', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'agent-team-workflow-reopen-'));
  const dbPath = path.join(dir, 'agent-team-workflow.sqlite3');
  const first = Store.open(dbPath);
  first.append(itemEvent());
  first.close();
  const second = Store.open(dbPath);
  t.after(() => {
    second.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  assert.equal(second.eventCount, 1);
  assert.equal(second.snapshot().items[0].id, 'item-1');
});

test('projects task lifecycle, attempts, reviews and gates', (t) => {
  const { store } = tempStore(t);
  store.appendMany([
    itemEvent('item-9'),
    {
      type: 'task.created',
      entity: 'task',
      entityId: 'task-9',
      payload: {
        taskId: 'task-9',
        itemId: 'item-9',
        stage: 'work',
        role: 'worker',
        priority: 1,
        dependencies: ['task-8'],
        contract: { objective: 'do the thing' },
      },
    },
    {
      type: 'task.updated',
      entity: 'task',
      entityId: 'task-9',
      payload: { taskId: 'task-9', status: 'running', provider: 'lane-a', assignee: 'worker-1', attemptId: 'attempt-1' },
    },
    {
      type: 'attempt.started',
      entity: 'attempt',
      entityId: 'attempt-1',
      payload: { attemptId: 'attempt-1', taskId: 'task-9', member: 'worker-1', provider: 'lane-a' },
    },
    {
      type: 'review.submitted',
      entity: 'review',
      entityId: 'review-1',
      payload: {
        reviewId: 'review-1',
        taskId: 'task-9',
        verdict: 'needs_revision',
        findings: [{ id: 'F1', severity: 'high', problem: 'missing test', requiredFix: 'add one' }],
        evidence: { command: 'node --test' },
      },
    },
    {
      type: 'gate.observed',
      entity: 'gate',
      entityId: 'item-9:merge',
      payload: { itemId: 'item-9', gate: 'merge', status: 'pending', signal: { source: 'github' } },
    },
  ]);
  const snapshot = store.snapshot();
  assert.equal(snapshot.tasks[0].status, 'running');
  assert.deepEqual(snapshot.tasks[0].dependencies, ['task-8']);
  assert.equal(snapshot.attempts[0].status, 'running');
  assert.equal(snapshot.reviews[0].verdict, 'needs_revision');
  assert.equal(snapshot.reviews[0].findings[0].id, 'F1');
  assert.equal(snapshot.gates[0].id, 'item-9:merge');
  assert.equal(snapshot.gates[0].status, 'pending');
});

test('stores a workflow definition', (t) => {
  const { store } = tempStore(t);
  store.append({
    type: 'workflow.defined',
    entity: 'workflow',
    entityId: 'default',
    workflowId: 'default',
    payload: { workflowId: 'default', name: 'unit', definition: { apiVersion: 1, name: 'unit' } },
  });
  const snapshot = store.snapshot();
  assert.equal(snapshot.workflow.name, 'unit');
  assert.equal(snapshot.workflow.definition.name, 'unit');
});
