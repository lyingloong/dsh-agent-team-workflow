import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { normalizeDefinition } from '../src/v2/definition.mjs';

const directory = new URL('../examples/', import.meta.url);

test('every bundled example validates as a v2 definition', () => {
  const names = readdirSync(directory).filter(name => name.endsWith('.json')).sort();
  assert.ok(names.length >= 4);
  for (const name of names) {
    const definition = normalizeDefinition(JSON.parse(readFileSync(new URL(name, directory), 'utf8')));
    assert.ok(definition.nodes.length > 0, name);
    assert.ok(definition.edges.length > 0, name);
  }
});

test('auto-dev example covers discovery, implementation, PR and user decision', () => {
  const definition = normalizeDefinition(JSON.parse(readFileSync(new URL('auto-dev.json', directory), 'utf8')));
  const ids = new Set(definition.nodes.map(node => node.id));
  for (const id of ['discover', 'implement', 'verify', 'review', 'pr', 'user_review', 'merge']) {
    assert.ok(ids.has(id), id);
  }
  assert.ok(definition.edges.some(edge => edge.from === 'review' && edge.on === 'needs_revision' && edge.to === 'implement'));
  assert.ok(definition.edges.some(edge => edge.from === 'user_review' && edge.on === 'approve' && edge.to === 'merge'));
});
