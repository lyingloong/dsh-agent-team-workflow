import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { normalizeDefinition } from '../src/definition.mjs';
import { buildStatus, formatRoster, formatStatus } from '../src/status.mjs';

const definition = normalizeDefinition(
  JSON.parse(readFileSync(new URL('../examples/three-lane.json', import.meta.url), 'utf8')),
);

function snapshot(overrides = {}) {
  return {
    workflow: { id: 'default', name: 'three-lane', version: 1, definition },
    items: [],
    tasks: [],
    attempts: [],
    reviews: [],
    gates: [],
    providers: [],
    slots: [],
    ...overrides,
  };
}

test('reports declared capacity before any task exists', () => {
  const status = buildStatus({ snapshot: snapshot() });
  assert.equal(status.capacity.slots, 9);
  assert.equal(status.capacity.busy, 0);
  assert.equal(status.capacity.global, 9);
  assert.equal(status.roles.length, 3);
  assert.equal(status.roles[0].idle, 3);
  assert.deepEqual(status.attention, []);
});

test('counts items, tasks, gates and raises attention', () => {
  const status = buildStatus({
    snapshot: snapshot({
      items: [
        { id: 'i1', stage: 'review', status: 'active' },
        { id: 'i2', stage: 'specify', status: 'blocked' },
      ],
      tasks: [
        ...Array.from({ length: 4 }, (_, index) => ({ id: `e${index}`, role: 'engineer', status: 'ready' })),
        { id: 'r1', role: 'reviewer', status: 'ready' },
      ],
      gates: [{ id: 'i1:merge', itemId: 'i1', gate: 'merge', status: 'pending' }],
      providers: [{ id: 'p2', health: 'degraded', reason: 'low watermark' }],
    }),
  });
  assert.equal(status.items.total, 2);
  assert.equal(status.items.byStage.review, 1);
  assert.equal(status.tasks.ready, 5);
  assert.equal(status.gates.pending, 1);
  assert.equal(status.providers.find(provider => provider.id === 'p2').health, 'degraded');
  assert.ok(status.attention.some(entry => entry.includes('p2: degraded')));
  assert.ok(status.attention.some(entry => entry.includes('1 item(s) blocked')));
  assert.ok(status.attention.some(entry => entry.includes('1 gate(s) waiting')));
  assert.ok(status.attention.some(entry => entry.includes('engineer: 4 ready task(s), 3 idle slot(s)')));
});

test('formats status and roster for humans', () => {
  const status = buildStatus({ snapshot: snapshot() });
  const text = formatStatus(status);
  assert.match(text, /agent-team-workflow three-lane \(apiVersion 1, entry specify\)/);
  assert.match(text, /slots: 0\/9 busy/);
  assert.match(text, /lock: not held/);

  const roster = formatRoster(status);
  const lines = roster.split('\n');
  assert.match(lines[0], /^role\s+kind\s+members/);
  assert.match(roster, /analyst\s+worker\s+3\s+3\s+0\s+lane-a, lane-b, lane-c/);
});

test('handles an empty store without a definition', () => {
  const status = buildStatus({
    snapshot: { workflow: null, items: [], tasks: [], attempts: [], reviews: [], gates: [], providers: [], slots: [] },
  });
  assert.equal(status.workflow, null);
  assert.match(formatStatus(status), /no workflow defined yet/);
  assert.match(formatRoster(status), /no workflow defined yet/);
});
