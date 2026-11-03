import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeDefinition } from '../src/definition.mjs';
import { buildSlots, planDispatch, simulate } from '../src/scheduler.mjs';

function lanes({ global = 9, providerConcurrency = 3, fallback = true, providers } = {}) {
  return normalizeDefinition({
    apiVersion: 1,
    name: 'lanes',
    roles: [
      { id: 'analyst', instances: 3, providers: ['p1', 'p2', 'p3'] },
      { id: 'engineer', instances: 3, providers: ['p1', 'p2', 'p3'] },
      { id: 'reviewer', instances: 3, providers: ['p1', 'p2', 'p3'] },
    ],
    providers: providers ?? [
      { id: 'p1', concurrency: providerConcurrency },
      { id: 'p2', concurrency: providerConcurrency },
      { id: 'p3', concurrency: providerConcurrency },
    ],
    stages: [{ id: 'work', role: 'analyst' }],
    policies: {
      concurrency: { global },
      fallback: { sameRole: fallback },
    },
  });
}

function readyTasks(roles, count = 3, overrides = () => ({})) {
  const tasks = [];
  for (const role of roles) {
    for (let index = 0; index < count; index += 1) {
      tasks.push({
        id: `${role}-${index + 1}`,
        role,
        status: 'ready',
        priority: 0,
        createdAt: '2026-01-01T00:00:00.000Z',
        ...overrides(role, index),
      });
    }
  }
  return tasks;
}

const healthy = () => [
  { id: 'p1', health: 'ok' },
  { id: 'p2', health: 'ok' },
  { id: 'p3', health: 'ok' },
];

test('builds one slot per member capacity and skips coordinators', () => {
  const definition = normalizeDefinition({
    apiVersion: 1,
    name: 'slots',
    roles: [
      { id: 'captain', kind: 'coordinator', instances: 2 },
      { id: 'worker', instances: 2, capacity: 2, providers: ['p1'] },
    ],
    providers: [{ id: 'p1' }],
    stages: [{ id: 'work', role: 'worker' }],
  });
  const slots = buildSlots(definition);
  assert.equal(slots.length, 4);
  assert.deepEqual(slots.map(slot => slot.id), ['worker-1-1', 'worker-1-2', 'worker-2-1', 'worker-2-2']);
  assert.ok(slots.every(slot => slot.provider === 'p1'));
  assert.ok(slots.every(slot => slot.status === 'idle'));
});

test('fills every slot when tasks are ready', () => {
  const definition = lanes();
  const slots = buildSlots(definition);
  const tasks = readyTasks(['analyst', 'engineer', 'reviewer']);
  const plan = planDispatch({ definition, providers: healthy(), slots, tasks });
  assert.equal(plan.assignments.length, 9);
  assert.equal(plan.active, 9);
  assert.deepEqual(plan.waiting, []);
  assert.deepEqual(new Set(plan.assignments.map(entry => entry.slotId)).size, 9);
});

test('respects the global concurrency limit', () => {
  const definition = lanes({ global: 4 });
  const plan = planDispatch({
    definition,
    providers: healthy(),
    slots: buildSlots(definition),
    tasks: readyTasks(['analyst', 'engineer', 'reviewer']),
  });
  assert.equal(plan.assignments.length, 4);
  assert.equal(plan.waiting.length, 5);
  assert.ok(plan.waiting.every(entry => entry.reason === 'global_capacity'));
});

test('respects per-provider concurrency', () => {
  const definition = lanes({ providerConcurrency: 1 });
  const plan = planDispatch({
    definition,
    providers: healthy(),
    slots: buildSlots(definition),
    tasks: readyTasks(['analyst']),
  });
  assert.equal(plan.assignments.length, 3);
  const byProvider = new Map();
  for (const entry of plan.assignments) byProvider.set(entry.provider, (byProvider.get(entry.provider) ?? 0) + 1);
  assert.deepEqual([...byProvider.values()], [1, 1, 1]);
});

test('dispatches the highest priority task when capacity is one', () => {
  const definition = lanes({ global: 1 });
  const tasks = [
    { id: 'low', role: 'analyst', status: 'ready', priority: 1, createdAt: '2026-01-01T00:00:00.000Z' },
    { id: 'high', role: 'analyst', status: 'ready', priority: 9, createdAt: '2026-01-01T00:00:00.000Z' },
    { id: 'mid', role: 'analyst', status: 'ready', priority: 5, createdAt: '2026-01-01T00:00:00.000Z' },
  ];
  const plan = planDispatch({ definition, providers: healthy(), slots: buildSlots(definition), tasks });
  assert.equal(plan.assignments.length, 1);
  assert.equal(plan.assignments[0].taskId, 'high');
});

test('falls back to another provider of the same role when the preferred one is blocked', () => {
  const definition = lanes();
  const providers = healthy().map(provider => provider.id === 'p2' ? { ...provider, health: 'blocked' } : provider);
  const tasks = readyTasks(['analyst'], 3, () => ({ provider: 'p2' }));
  const plan = planDispatch({ definition, providers, slots: buildSlots(definition), tasks });
  assert.equal(plan.assignments.length, 2);
  assert.ok(plan.assignments.every(entry => entry.fallbackFrom === 'p2'));
  assert.ok(plan.assignments.every(entry => entry.provider !== 'p2'));
  assert.ok(plan.warnings.some(warning => warning.code === 'provider_blocked'));
});

test('does not fall back when the policy disables it', () => {
  const definition = lanes({ fallback: false });
  const providers = healthy().map(provider => provider.id === 'p2' ? { ...provider, health: 'blocked' } : provider);
  const tasks = readyTasks(['analyst'], 3, () => ({ provider: 'p2' }));
  const plan = planDispatch({ definition, providers, slots: buildSlots(definition), tasks });
  assert.equal(plan.assignments.length, 0);
  assert.ok(plan.waiting.every(entry => entry.reason === 'provider_unavailable'));
});

test('stops new dispatch on a degraded provider', () => {
  const definition = lanes();
  const providers = healthy().map(provider => provider.id === 'p2' ? { ...provider, health: 'degraded' } : provider);
  const tasks = readyTasks(['analyst', 'engineer', 'reviewer']);
  const plan = planDispatch({ definition, providers, slots: buildSlots(definition), tasks });
  assert.equal(plan.assignments.length, 6);
  assert.ok(plan.assignments.every(entry => entry.provider !== 'p2'));
  assert.ok(plan.warnings.some(warning => warning.code === 'provider_degraded'));
});

test('re-uses a blocked provider after its window expires', () => {
  const definition = lanes();
  const providers = [{ id: 'p1', health: 'ok' }, { id: 'p2', health: 'blocked', blockedUntil: '2026-01-01T00:00:00.000Z' }, { id: 'p3', health: 'ok' }];
  const tasks = readyTasks(['analyst'], 3, () => ({ provider: 'p2' }));
  const plan = planDispatch({
    definition,
    providers,
    slots: buildSlots(definition),
    tasks,
    now: '2026-01-02T00:00:00.000Z',
  });
  assert.equal(plan.assignments.length, 3);
  assert.ok(plan.assignments.some(entry => entry.provider === 'p2' && !entry.fallbackFrom));
});

test('does not invent work when nothing is ready', () => {
  const definition = lanes();
  const plan = planDispatch({ definition, providers: healthy(), slots: buildSlots(definition), tasks: [] });
  assert.deepEqual(plan.assignments, []);
  assert.equal(plan.active, 0);
});

test('warns once about an unknown role', () => {
  const definition = lanes();
  const tasks = [
    { id: 'ghost-1', role: 'ghost', status: 'ready', priority: 0, createdAt: '2026-01-01T00:00:00.000Z' },
    { id: 'ghost-2', role: 'ghost', status: 'ready', priority: 0, createdAt: '2026-01-01T00:00:00.000Z' },
  ];
  const plan = planDispatch({ definition, providers: healthy(), slots: buildSlots(definition), tasks });
  assert.equal(plan.warnings.filter(warning => warning.code === 'unknown_role').length, 1);
  assert.equal(plan.waiting.length, 2);
});

test('is deterministic for equally ranked tasks', () => {
  const definition = lanes();
  const tasks = readyTasks(['analyst']);
  const forward = planDispatch({ definition, providers: healthy(), slots: buildSlots(definition), tasks });
  const backward = planDispatch({
    definition,
    providers: healthy(),
    slots: buildSlots(definition),
    tasks: [...tasks].reverse(),
  });
  assert.deepEqual(forward.assignments, backward.assignments);
});

test('simulates nine concurrent tasks', () => {
  const definition = lanes();
  const tasks = readyTasks(['analyst', 'engineer', 'reviewer']).map(task => ({ ...task, durationMs: 120_000 }));
  const result = simulate({ definition, providers: healthy(), tasks, ticks: 6, stepMs: 60_000 });
  assert.equal(result.trace[0].assigned.length, 9);
  assert.equal(result.trace[0].active, 9);
  assert.equal(result.completed.length, 9);
  assert.deepEqual(result.unresolved, []);
});

test('refills slots as tasks complete', () => {
  const definition = lanes();
  const tasks = readyTasks(['analyst', 'engineer', 'reviewer'], 4).map(task => ({ ...task, durationMs: 60_000 }));
  const result = simulate({ definition, providers: healthy(), tasks, ticks: 10, stepMs: 60_000 });
  assert.equal(result.completed.length, 12);
  assert.deepEqual(result.unresolved, []);
  assert.ok(result.trace.some(step => step.completed.length > 0));
});

test('simulates a fallback away from a blocked provider', () => {
  const definition = lanes();
  const providers = healthy().map(provider => provider.id === 'p2' ? { ...provider, health: 'blocked' } : provider);
  const tasks = readyTasks(['analyst'], 3, () => ({ provider: 'p2', durationMs: 60_000 }));
  const result = simulate({ definition, providers, tasks, ticks: 4, stepMs: 60_000 });
  const assigned = result.trace.flatMap(step => step.assigned);
  assert.equal(assigned.length, 3);
  assert.ok(assigned.every(entry => entry.fallbackFrom === 'p2'));
});

test('never invents tasks in an idle simulation', () => {
  const definition = lanes();
  const result = simulate({ definition, providers: healthy(), tasks: [], ticks: 3 });
  assert.ok(result.trace.every(step => step.assigned.length === 0));
  assert.deepEqual(result.unresolved, []);
});

test('applies a health change between ticks', () => {
  const definition = lanes({ global: 3 });
  const tasks = readyTasks(['analyst'], 6).map((task, index) => ({ ...task, durationMs: 60_000, id: `task-${index + 1}` }));
  const result = simulate({
    definition,
    providers: healthy(),
    tasks,
    ticks: 8,
    stepMs: 60_000,
    onTick: ({ tick, providers }) => {
      if (tick === 1) {
        const state = providers.find(provider => provider.id === 'p2');
        state.health = 'degraded';
      }
    },
  });
  assert.ok(result.completed.includes('task-1'));
  const lateAssignments = result.trace.slice(1).flatMap(step => step.assigned);
  assert.ok(lateAssignments.length > 0);
  assert.ok(lateAssignments.every(entry => entry.provider !== 'p2'));
});
