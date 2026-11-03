import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { normalizeDefinition } from '../src/definition.mjs';
import { Engine } from '../src/engine.mjs';
import { Store } from '../src/store.mjs';
import { buildBoardData, stageOrder } from '../src/board/data.mjs';
import { startBoardServer } from '../src/board/server.mjs';

const workflow = {
  apiVersion: 1,
  name: 'board-flow',
  description: 'board fixture',
  roles: [
    { id: 'analyst', instances: 1 },
    { id: 'engineer', instances: 1 },
    { id: 'reviewer', instances: 1 },
  ],
  providers: [
    { id: 'lane-a', concurrency: 1 },
    { id: 'lane-b', concurrency: 1 },
  ],
  stages: [
    { id: 'specify', role: 'analyst', on: { complete: 'implement' } },
    { id: 'implement', role: 'engineer', on: { complete: 'review' } },
    { id: 'review', role: 'reviewer', options: ['pass', 'needs_revision'], on: { pass: 'approved', needs_revision: 'implement' } },
    { id: 'approved', role: 'reviewer' },
  ],
  gates: [{ id: 'merge', after: 'review', outcome: 'pass', kind: 'manual' }],
};

function tempDir() {
  return mkdtempSync(path.join(os.tmpdir(), 'agent-team-workflow-board-'));
}

function cleanupDir(t, dir) {
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
}

function seed(dir) {
  const store = Store.open(path.join(dir, 'agent-team-workflow.sqlite3'));
  store.append({
    type: 'workflow.defined',
    entity: 'workflow',
    entityId: 'default',
    workflowId: 'default',
    payload: { workflowId: 'default', name: workflow.name, definition: workflow },
  });
  const definition = normalizeDefinition(workflow);
  const engine = new Engine({ store, definition });
  const reviewItem = engine.enqueue({ title: '待审查的任务', data: { prompt: 'a' } });
  for (const role of ['analyst', 'engineer', 'reviewer']) {
    const claimed = engine.claim({ role, member: `${role}-1` });
    engine.complete({
      attemptId: claimed.attempt.id,
      outcome: role === 'reviewer' ? 'pass' : 'complete',
    });
  }
  const queuedItem = engine.enqueue({ title: '待规格的任务', data: { prompt: 'b' } });
  const snapshot = store.snapshot();
  store.close();
  return { definition, reviewItem, queuedItem, snapshot };
}

test('stage order follows the entry transitions', () => {
  const definition = normalizeDefinition(workflow);
  assert.deepEqual(stageOrder(definition).map(stage => stage.id), ['specify', 'implement', 'review', 'approved']);
});

test('builds columns, cards, gates and providers from the snapshot', (t) => {
  const dir = tempDir();
  const { definition, reviewItem } = seed(dir);
  const store = Store.open(path.join(dir, 'agent-team-workflow.sqlite3'));
  t.after(() => store.close());
  cleanupDir(t, dir);
  const board = buildBoardData({ snapshot: store.snapshot(), definition, now: '2026-01-01T00:00:00.000Z' });
  assert.equal(board.workflow.name, 'board-flow');
  assert.deepEqual(board.columns.map(column => column.id), ['specify', 'implement', 'review', 'approved']);
  assert.equal(board.columns.find(column => column.id === 'review').items[0].id, reviewItem.itemId);
  assert.equal(board.columns.find(column => column.id === 'review').items[0].status, 'blocked');
  assert.equal(board.pendingGates.length, 1);
  assert.equal(board.pendingGates[0].gate, 'merge');
  assert.equal(board.counts.blocked, 1);
  assert.deepEqual(board.providers.map(provider => provider.id), ['lane-a', 'lane-b']);
});

test('serves the board and accepts gate decisions over HTTP', async (t) => {
  const dir = tempDir();
  const { reviewItem } = seed(dir);
  const board = startBoardServer({ dataDir: dir, port: 0 });
  const url = await board.ready;
  t.after(async () => {
    await board.close();
  });
  cleanupDir(t, dir);

  const response = await fetch(new URL('/api/board', url));
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.workflow.name, 'board-flow');
  assert.equal(data.pendingGates.length, 1);
  assert.equal(data.counts.blocked, 1);

  const approved = await fetch(new URL('/api/gate', url), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ itemId: reviewItem.itemId, gate: 'merge', decision: 'approve', by: 'test' }),
  });
  assert.equal(approved.status, 200);
  assert.equal((await approved.json()).status, 'approved');

  const after = await (await fetch(new URL('/api/board', url))).json();
  assert.equal(after.pendingGates.length, 0);
  assert.equal(after.counts.done, 1);
  const approvedColumn = after.columns.find(column => column.id === 'approved');
  assert.equal(approvedColumn.items[0].id, reviewItem.itemId);

  const enqueued = await fetch(new URL('/api/enqueue', url), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: '新的任务', input: { prompt: 'c' } }),
  });
  assert.equal(enqueued.status, 201);
  const created = await enqueued.json();
  assert.ok(created.itemId);
  const withNew = await (await fetch(new URL('/api/board', url))).json();
  assert.ok(withNew.columns.find(column => column.id === 'specify').items.some(item => item.title === '新的任务'));

  const rejected = await fetch(new URL('/api/gate', url), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ itemId: reviewItem.itemId, gate: 'merge', decision: 'approve' }),
  });
  assert.equal(rejected.status, 400);
  assert.equal((await rejected.json()).error.code, 'gate_decided');
});

test('refuses to start without a defined workflow', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'agent-team-workflow-empty-'));
  try {
    assert.throws(() => startBoardServer({ dataDir: dir, port: 0 }), /no workflow defined/);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
