import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { DefinitionError, describeDefinition, normalizeDefinition } from '../src/definition.mjs';

const minimal = {
  apiVersion: 1,
  name: 'minimal',
  roles: [{ id: 'worker' }],
  stages: [{ id: 'work', role: 'worker' }],
};

function errorsOf(raw) {
  try {
    normalizeDefinition(raw);
  } catch (error) {
    assert.ok(error instanceof DefinitionError, 'expected a DefinitionError');
    return error.errors;
  }
  assert.fail('expected the definition to be rejected');
}

function picks(errors, path) {
  return errors.filter(entry => entry.path === path);
}

test('applies defaults for the smallest definition', () => {
  const definition = normalizeDefinition(minimal);
  assert.equal(definition.apiVersion, 1);
  assert.equal(definition.entry, 'work');
  assert.deepEqual(definition.roles[0], {
    id: 'worker',
    kind: 'worker',
    instances: 1,
    capacity: 1,
    providers: [],
    prompt: null,
    tools: null,
    workdir: 'repo',
  });
  assert.equal(definition.policies.concurrency.global, 1);
  assert.equal(definition.policies.review.maxRounds, 3);
  assert.equal(definition.policies.fallback.sameRole, true);
  assert.deepEqual(definition.policies.retry.backoffSeconds, [30, 120, 300]);
  assert.deepEqual(definition.gates, []);
  assert.deepEqual(definition.providers, []);
});

test('rejects a different apiVersion', () => {
  const errors = errorsOf({ ...minimal, apiVersion: 2 });
  assert.equal(picks(errors, '$.apiVersion').length, 1);
});

test('reports unknown keys with their path', () => {
  const errors = errorsOf({ ...minimal, roles: [{ id: 'worker', secret: true }] });
  assert.match(picks(errors, '$.roles[0].secret')[0].message, /unknown key/);
});

test('rejects duplicate role and stage ids', () => {
  const errors = errorsOf({
    ...minimal,
    roles: [{ id: 'worker' }, { id: 'worker' }],
    stages: [{ id: 'work', role: 'worker' }, { id: 'work', role: 'worker' }],
  });
  assert.equal(picks(errors, '$.roles[1].id').length, 1);
  assert.equal(picks(errors, '$.stages[1].id').length, 1);
});

test('rejects a stage role that does not exist', () => {
  const errors = errorsOf({ ...minimal, stages: [{ id: 'work', role: 'ghost' }] });
  assert.match(picks(errors, '$.stages[0].role')[0].message, /unknown role "ghost"/);
});

test('rejects transitions to unknown stages and to itself', () => {
  const errors = errorsOf({
    ...minimal,
    stages: [
      { id: 'a', role: 'worker', on: { next: 'missing' } },
      { id: 'b', role: 'worker', on: { again: 'b' } },
    ],
  });
  assert.match(picks(errors, '$.stages[0].on.next')[0].message, /unknown stage "missing"/);
  assert.match(picks(errors, '$.stages[1].on.again')[0].message, /cannot transition to itself/);
});

test('requires every stage to be reachable and one terminal stage', () => {
  const unreachable = errorsOf({
    ...minimal,
    stages: [
      { id: 'a', role: 'worker', on: { complete: 'b' } },
      { id: 'b', role: 'worker' },
      { id: 'orphan', role: 'worker' },
    ],
  });
  assert.match(unreachable.find(entry => entry.message.includes('orphan')).message, /unreachable/);

  const loop = errorsOf({
    ...minimal,
    stages: [
      { id: 'a', role: 'worker', on: { complete: 'b' } },
      { id: 'b', role: 'worker', on: { again: 'a' } },
    ],
  });
  assert.match(loop.find(entry => entry.message.includes('terminal stage')).message, /terminal stage/);
});

test('declared options must cover the transitions', () => {
  const errors = errorsOf({
    ...minimal,
    roles: [{ id: 'worker' }, { id: 'reviewer' }],
    stages: [
      { id: 'review', role: 'reviewer', options: ['pass'], on: { pass: 'approved', needs_revision: 'repair' } },
      { id: 'approved', role: 'reviewer' },
      { id: 'repair', role: 'worker', on: { complete: 'review' } },
    ],
  });
  assert.match(picks(errors, '$.stages[0].on.needs_revision')[0].message, /not declared in options/);
});

test('accepts a review loop with an explicit terminal stage', () => {
  const definition = normalizeDefinition({
    apiVersion: 1,
    name: 'review-loop',
    roles: [{ id: 'engineer' }, { id: 'reviewer' }],
    stages: [
      { id: 'implement', role: 'engineer', on: { complete: 'review' } },
      { id: 'review', role: 'reviewer', options: ['pass', 'needs_revision'], on: { pass: 'approved', needs_revision: 'implement' } },
      { id: 'approved', role: 'reviewer' },
    ],
  });
  assert.equal(definition.stages[1].options.length, 2);
  assert.equal(definition.entry, 'implement');
});

test('validates provider references and gate shapes', () => {
  const errors = errorsOf({
    ...minimal,
    roles: [{ id: 'worker', providers: ['missing'] }],
    gates: [
      { id: 'merge', after: 'work', kind: 'external' },
      { id: 'manual', after: 'work', signal: 'nope' },
      { id: 'late', after: 'absent' },
    ],
  });
  assert.match(picks(errors, '$.roles[0].providers[0]')[0].message, /unknown provider "missing"/);
  assert.match(picks(errors, '$.gates[0].signal')[0].message, /must be a non-empty string/);
  assert.match(picks(errors, '$.gates[1].signal')[0].message, /only external gates/);
  assert.match(picks(errors, '$.gates[2].after')[0].message, /unknown stage "absent"/);
});

test('computes the default global capacity from instances and capacity', () => {
  const definition = normalizeDefinition({
    apiVersion: 1,
    name: 'caps',
    roles: [
      { id: 'a', instances: 3, capacity: 2 },
      { id: 'b', instances: 2, capacity: 1 },
      { id: 'captain', kind: 'coordinator', instances: 1 },
    ],
    stages: [{ id: 'work', role: 'a' }],
  });
  assert.equal(definition.policies.concurrency.global, 8);
});

test('describes a multi-lane definition', () => {
  const raw = JSON.parse(readFileSync(new URL('../examples/three-lane.json', import.meta.url), 'utf8'));
  const text = describeDefinition(normalizeDefinition(raw));
  assert.match(text, /three-lane/);
  assert.match(text, /slots: 9/);
  assert.match(text, /analyst x3/);
  assert.match(text, /review \[reviewer\]: pass -> approved/);
});
