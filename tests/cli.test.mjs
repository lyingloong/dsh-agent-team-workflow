import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { main } from '../src/cli.mjs';
import { acquireLock } from '../src/lock.mjs';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));

function tempDir(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'agent-team-workflow-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return dir;
}

function run(argv, { cwd = packageRoot } = {}) {
  const out = [];
  const err = [];
  const code = main(argv, {
    cwd,
    stdout: line => out.push(String(line)),
    stderr: line => err.push(String(line)),
    env: {},
  });
  return { code, stdout: out.join('\n'), stderr: err.join('\n') };
}

test('validates a workflow file', () => {
  const result = run(['validate', 'examples/three-lane.json']);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /three-lane \(apiVersion 1\)/);
  assert.match(result.stdout, /slots: 9/);
});

test('reports an unreadable workflow file', () => {
  const result = run(['validate', 'examples/minimal.json']);
  assert.equal(result.code, 0);
  const broken = run(['validate', 'examples/does-not-exist.json']);
  assert.equal(broken.code, 2);
  assert.match(broken.stderr, /cannot read examples\/does-not-exist\.json/);
});

test('returns 2 for an unknown command', () => {
  const result = run(['frobnicate']);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /unknown command "frobnicate"/);
  assert.match(result.stderr, /usage:/);
});

test('defines, inspects, lists and rebuilds a workflow', (t) => {
  const dir = tempDir(t);
  const defined = run(['define', 'examples/three-lane.json', '--data', dir]);
  assert.equal(defined.code, 0);
  assert.match(defined.stdout, /defined "three-lane"/);

  const status = run(['status', '--data', dir]);
  assert.equal(status.code, 0);
  assert.match(status.stdout, /agent-team-workflow three-lane/);
  assert.match(status.stdout, /events: 1/);

  const json = run(['status', '--data', dir, '--json']);
  const parsed = JSON.parse(json.stdout);
  assert.equal(parsed.workflow.name, 'three-lane');
  assert.equal(parsed.capacity.slots, 9);

  const roster = run(['roster', '--data', dir]);
  assert.equal(roster.code, 0);
  assert.match(roster.stdout, /analyst/);

  const events = run(['events', '--data', dir]);
  assert.equal(events.code, 0);
  assert.match(events.stdout, /workflow\.defined/);

  const rebuilt = run(['rebuild', '--data', dir]);
  assert.equal(rebuilt.code, 0);
  assert.match(rebuilt.stdout, /replayed 1 event\(s\)/);
});

test('reports an empty store without failing', () => {
  const result = run(['status', '--data', path.join(os.tmpdir(), 'agent-team-workflow-cli-missing-dir')]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /no workflow defined yet/);
});

test('refuses to redefine while a coordinator holds the lock', (t) => {
  const dir = tempDir(t);
  const lock = acquireLock({ dataDir: dir });
  t.after(() => lock.release());
  const result = run(['define', 'examples/three-lane.json', '--data', dir]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /another coordinator is running/);
  assert.match(result.stderr, /hint:/);
});

test('runs a claim, complete and gate through the CLI', (t) => {
  const dir = tempDir(t);
  const workflowPath = path.join(dir, 'workflow.json');
  writeFileSync(workflowPath, JSON.stringify({
    apiVersion: 1,
    name: 'cli-flow',
    roles: [
      { id: 'analyst', instances: 1 },
      { id: 'engineer', instances: 1 },
      { id: 'reviewer', instances: 1 },
    ],
    stages: [
      { id: 'specify', role: 'analyst', on: { complete: 'implement' } },
      { id: 'implement', role: 'engineer', on: { complete: 'review' } },
      { id: 'review', role: 'reviewer', options: ['pass', 'needs_revision'], on: { pass: 'approved', needs_revision: 'implement' } },
      { id: 'approved', role: 'reviewer' },
    ],
    gates: [{ id: 'merge', after: 'review', outcome: 'pass', kind: 'manual' }],
  }));

  assert.equal(run(['define', workflowPath, '--data', dir]).code, 0);

  const enqueued = run(['enqueue', 'first item', '--input', '{"prompt":"build it"}', '--data', dir, '--json']);
  assert.equal(enqueued.code, 0);
  const item = JSON.parse(enqueued.stdout);

  const spec = run(['claim', '--role', 'analyst', '--member', 'a1', '--data', dir, '--json']);
  const specClaim = JSON.parse(spec.stdout);
  assert.equal(specClaim.task.id, item.taskId);
  assert.equal(run(['complete', '--attempt', specClaim.attempt.id, '--data', dir]).code, 0);

  const impl = JSON.parse(run(['claim', '--role', 'engineer', '--data', dir, '--json']).stdout);
  assert.equal(run(['complete', '--attempt', impl.attempt.id, '--data', dir]).code, 0);

  const review = JSON.parse(run(['claim', '--role', 'reviewer', '--data', dir, '--json']).stdout);
  const gated = run(['complete', '--attempt', review.attempt.id, '--outcome', 'pass', '--data', dir, '--json']);
  assert.equal(gated.code, 0);
  assert.equal(JSON.parse(gated.stdout).status, 'gated');

  const decided = run(['gate', '--item', item.itemId, '--gate', 'merge', '--decision', 'approve', '--data', dir, '--json']);
  assert.equal(decided.code, 0);
  assert.equal(JSON.parse(decided.stdout).status, 'approved');

  const status = JSON.parse(run(['status', '--data', dir, '--json']).stdout);
  assert.equal(status.items.byStatus.done, 1);
  assert.equal(status.gates.pending, 0);
});

test('reports engine errors with a next action', (t) => {
  const dir = tempDir(t);
  const workflowPath = path.join(dir, 'workflow.json');
  writeFileSync(workflowPath, JSON.stringify({
    apiVersion: 1,
    name: 'cli-errors',
    roles: [{ id: 'worker', instances: 1 }],
    stages: [{ id: 'work', role: 'worker' }],
  }));
  run(['define', workflowPath, '--data', dir]);
  const result = run(['complete', '--attempt', 'attempt-missing', '--data', dir]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /attempt_not_found/);
});

test('simulates a definition with demo or explicit tasks', (t) => {
  const dir = tempDir(t);
  const demo = run(['simulate', 'examples/three-lane.json', '--ticks', '3', '--json']);
  assert.equal(demo.code, 0);
  const parsed = JSON.parse(demo.stdout);
  assert.equal(parsed.source, 'demo');
  assert.equal(parsed.completed.length, 3);
  assert.ok(parsed.trace.length >= 1);

  const tasksFile = path.join(dir, 'tasks.json');
  writeFileSync(tasksFile, JSON.stringify([{ id: 'only', role: 'analyst', durationMs: 60_000 }]));
  const explicit = run(['simulate', 'examples/three-lane.json', '--tasks', tasksFile, '--ticks', '3', '--json']);
  assert.equal(explicit.code, 0);
  assert.equal(JSON.parse(explicit.stdout).completed[0], 'only');
});

test('init scaffolds the bundled dev-team workflow', (t) => {
  const dir = tempDir(t);
  const created = run(['init'], { cwd: dir });
  assert.equal(created.code, 0);
  assert.ok(existsSync(path.join(dir, 'workflow.json')));
  assert.match(created.stdout, /next: agent-team-workflow define workflow.json/);

  const again = run(['init'], { cwd: dir });
  assert.equal(again.code, 2);
  assert.match(again.stderr, /already exists/);

  const forced = run(['init', '--force'], { cwd: dir });
  assert.equal(forced.code, 0);
});

test('parks a lane when the provider reports an error', (t) => {
  const dir = tempDir(t);
  assert.equal(run(['define', 'examples/review-gate.json', '--data', dir]).code, 0);
  run(['enqueue', 'flaky task', '--data', dir]);
  const claimed = JSON.parse(run(['claim', '--role', 'analyst', '--member', 'a1', '--data', dir, '--json']).stdout);
  const failed = run(['fail', '--attempt', claimed.attempt.id, '--error', '429 rate limit', '--data', dir, '--json']);
  assert.equal(failed.code, 0);
  assert.equal(JSON.parse(failed.stdout).providerFailure, true);

  const status = JSON.parse(run(['status', '--data', dir, '--json']).stdout);
  assert.equal(status.providers.find(provider => provider.id === 'lane-a').health, 'blocked');
});
