import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { apply } from '../src/plugin.mjs';

const WORKFLOW = {
  apiVersion: 1,
  name: 'dsh-flow',
  description: 'workflow fixture',
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

const TOOL_NAMES = [
  'team_workflow_board',
  'team_workflow_claim',
  'team_workflow_complete',
  'team_workflow_define',
  'team_workflow_delegate',
  'team_workflow_enqueue',
  'team_workflow_fail',
  'team_workflow_gate',
  'team_workflow_plan',
  'team_workflow_status',
];

function makeCtx({ subagents } = {}) {
  const tools = new Map();
  const sections = [];
  const cleanups = [];
  const ctx = {
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    },
    systemPrompt: {
      section(section) {
        sections.push(section);
      },
    },
    effect(fn) {
      const cleanup = fn();
      if (typeof cleanup === 'function') cleanups.push(cleanup);
    },
    logger: { info() {}, warn() {} },
    get(key) {
      return key === 'subagents' ? subagents : undefined;
    },
  };
  return { ctx, tools, sections, cleanups };
}

function assertOutputValue(schema, value, where) {
  if (schema.enum !== undefined) {
    assert.ok(schema.enum.includes(value), `${where}: ${JSON.stringify(value)} is not one of ${schema.enum.join(', ')}`);
  }
  switch (schema.type) {
    case 'object': {
      assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), `${where}: expected an object`);
      for (const name of schema.required ?? []) {
        assert.ok(Object.hasOwn(value, name), `${where}: missing required property "${name}"`);
      }
      const properties = schema.properties ?? {};
      for (const [name, child] of Object.entries(value)) {
        if (schema.additionalProperties === false) {
          assert.ok(Object.hasOwn(properties, name), `${where}: undeclared property "${name}"`);
        }
        if (Object.hasOwn(properties, name)) assertOutputValue(properties[name], child, `${where}.${name}`);
      }
      return;
    }
    case 'array':
      assert.ok(Array.isArray(value), `${where}: expected an array`);
      value.forEach((item, index) => assertOutputValue(schema.items ?? {}, item, `${where}[${index}]`));
      return;
    case 'string':
      assert.equal(typeof value, 'string', `${where}: expected a string`);
      return;
    case 'integer':
      assert.ok(Number.isInteger(value), `${where}: expected an integer`);
      return;
    case 'number':
      assert.ok(typeof value === 'number' && Number.isFinite(value), `${where}: expected a number`);
      return;
    case 'boolean':
      assert.equal(typeof value, 'boolean', `${where}: expected a boolean`);
      return;
    case 'null':
      assert.equal(value, null, `${where}: expected null`);
      return;
    default:
      return;
  }
}

function setup(t, { config = {}, subagents } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'team-workflow-plugin-'));
  const { ctx, tools, sections, cleanups } = makeCtx({ subagents });
  apply(ctx, { stateDir: '.state', autoBoard: false, ...config });
  const exec = { agent: { session: { header: { cwd: dir } } }, signal: new AbortController().signal };
  const call = async (name, args = {}) => {
    const tool = tools.get(name);
    const value = await tool.execute(args, exec);
    // Mirror the host's output contract: an undeclared property is an error.
    assertOutputValue(tool.output.schema, value, `${name} output`);
    return value;
  };
  t.after(async () => {
    for (const cleanup of cleanups) await cleanup();
    await new Promise(resolve => setTimeout(resolve, 60));
    rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
  });
  return { dir, tools, sections, call, exec };
}

async function define(call) {
  const result = await call('team_workflow_define', { definition: WORKFLOW });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  return result;
}

test('registers the workflow tools and one usage section', (t) => {
  const { tools, sections } = setup(t);
  assert.deepEqual([...tools.keys()].sort(), TOOL_NAMES);
  assert.equal(sections.length, 1);
  assert.equal(sections[0].name, 'dsh-agent-team-workflow:usage');
  assert.match(sections[0].text, /team_workflow_define/);
  assert.match(sections[0].text, /Do not ask the user to write JSON/);
});

test('defines a workflow and reports its projected state', async (t) => {
  const { call, tools } = setup(t);
  const result = await define(call);
  assert.equal(result.name, 'dsh-flow');
  assert.match(result.summary, /entry: specify/);
  assert.match(tools.get('team_workflow_define').output.render({}, result)[0].text, /Defined "dsh-flow"/);

  const status = await call('team_workflow_status');
  assert.equal(status.defined, true);
  assert.deepEqual(status.columns.map(column => column.id), ['specify', 'implement', 'review', 'approved']);
  assert.equal(status.counts.items, 0);
  assert.equal(status.providers.length, 2);
});

test('returns definition errors with JSON paths', async (t) => {
  const { call } = setup(t);
  const result = await call('team_workflow_define', {
    definition: { apiVersion: 1, name: 'broken', roles: [], stages: [] },
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(error => error.path === '$.roles'));
  assert.ok(result.errors.some(error => error.path === '$.stages'));
});

test('runs the pull-mode lifecycle through tools', async (t) => {
  const { call } = setup(t);
  await define(call);

  const enqueued = await call('team_workflow_enqueue', { title: 'ship it', input: { prompt: 'go' } });
  assert.equal(enqueued.stage, 'specify');

  const spec = await call('team_workflow_claim', { role: 'analyst', member: 'a1' });
  assert.equal(spec.claimed, true);
  assert.equal(spec.stage, 'specify');
  assert.equal(spec.contract.input.prompt, 'go');

  const advanced = await call('team_workflow_complete', { attemptId: spec.attemptId });
  assert.equal(advanced.status, 'advanced');
  assert.equal(advanced.stage, 'implement');

  const plan = await call('team_workflow_plan');
  assert.equal(plan.ready.length, 1);
  assert.equal(plan.ready[0].role, 'engineer');

  const impl = await call('team_workflow_claim', { role: 'engineer' });
  await call('team_workflow_complete', { attemptId: impl.attemptId });
  const review = await call('team_workflow_claim', { role: 'reviewer' });
  const gated = await call('team_workflow_complete', { attemptId: review.attemptId, outcome: 'pass' });
  assert.equal(gated.status, 'gated');

  const status = await call('team_workflow_status');
  assert.equal(status.pendingGates.length, 1);
  assert.equal(status.counts.blocked, 1);

  const decided = await call('team_workflow_gate', {
    itemId: enqueued.itemId,
    gate: 'merge',
    decision: 'approve',
  });
  assert.equal(decided.status, 'approved');
  const after = await call('team_workflow_status');
  assert.equal(after.counts.done, 1);
});

test('serves the board over HTTP', async (t) => {
  const { call } = setup(t);
  await define(call);
  const board = await call('team_workflow_board', { port: 0 });
  assert.match(board.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  const response = await fetch(new URL('/api/health', board.url));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, workflow: 'dsh-flow' });
});

test('delegates a single-outcome task to a subagent and records its result', async (t) => {
  const calls = [];
  const subagents = {
    async startActivation(spec) {
      calls.push(spec);
      return {
        childId: 'child-1',
        result: Promise.resolve({ output: [{ type: 'text', text: 'implemented and tested' }], stopReason: 'completed' }),
        dispose: async () => {},
      };
    },
  };
  const { call, exec } = setup(t, { subagents });
  await define(call);
  const enqueued = await call('team_workflow_enqueue', { title: 'delegate me' });

  const delegated = await call('team_workflow_delegate', { role: 'analyst' });
  assert.equal(delegated.spawned, true);
  assert.equal(delegated.outcome, 'complete');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].provider, 'spawn');
  assert.equal(calls[0].request.parent, exec.agent);
  assert.match(calls[0].request.prompt[0].text, /dsh-flow/);
  assert.match(calls[0].request.prompt[0].text, /delegate me/);

  await new Promise(resolve => setTimeout(resolve, 120));
  const status = await call('team_workflow_status');
  assert.equal(status.columns.find(column => column.id === 'implement').count, 1);

  const plan = await call('team_workflow_plan');
  assert.equal(plan.ready[0].role, 'engineer');
  const snapshot = await call('team_workflow_status');
  assert.equal(snapshot.counts.active, 1);
  assert.equal(enqueued.itemId.length > 0, true);
});

test('refuses to delegate a stage with several outcomes', async (t) => {
  const subagents = {
    async startActivation() {
      throw new Error('should not be called');
    },
  };
  const { call } = setup(t, { subagents });
  await call('team_workflow_define', {
    definition: {
      apiVersion: 1,
      name: 'branching',
      roles: [{ id: 'analyst', instances: 1 }],
      stages: [
        { id: 'decide', role: 'analyst', options: ['yes', 'no'], on: { yes: 'accepted', no: 'rejected' } },
        { id: 'accepted', role: 'analyst' },
        { id: 'rejected', role: 'analyst' },
      ],
    },
  });
  await call('team_workflow_enqueue', { title: 'branch' });
  const delegated = await call('team_workflow_delegate', { role: 'analyst' });
  assert.equal(delegated.spawned, false);
  assert.match(delegated.reason, /2 outcomes/);
});

test('delegate explains when the host has no subagent service', async (t) => {
  const { call } = setup(t);
  await define(call);
  await call('team_workflow_enqueue', { title: 'no subagents' });
  await assert.rejects(
    () => call('team_workflow_delegate', { role: 'analyst' }),
    /requires the host subagent service/,
  );
});

test('tool schemas stay inside the host JSON-schema subset', (t) => {
  const { tools } = setup(t);
  const allowedKeys = new Set([
    'type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items',
    'enum', 'const', 'description', 'title', 'default', 'examples',
  ]);
  const types = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);
  const visit = (node, where) => {
    assert.ok(node !== null && typeof node === 'object' && !Array.isArray(node), `${where} must be a schema object`);
    for (const key of Object.keys(node)) {
      assert.ok(allowedKeys.has(key), `${where}: unsupported keyword "${key}"`);
    }
    if (node.type !== undefined) assert.ok(types.has(node.type), `${where}: unsupported type ${node.type}`);
    if (node.additionalProperties !== undefined) {
      assert.equal(typeof node.additionalProperties, 'boolean', `${where}.additionalProperties must be boolean`);
    }
    if (node.required !== undefined) {
      assert.ok(Array.isArray(node.required), `${where}.required must be an array`);
      for (const name of node.required) {
        assert.ok(node.properties && Object.hasOwn(node.properties, name), `${where}.required names missing property "${name}"`);
      }
    }
    for (const [name, property] of Object.entries(node.properties ?? {})) {
      visit(property, `${where}.${name}`);
    }
    if (node.items !== undefined) visit(node.items, `${where}.items`);
    if (node.enum !== undefined) {
      assert.ok(Array.isArray(node.enum) && node.enum.length > 0, `${where}.enum must be a non-empty array`);
      for (const value of node.enum) {
        assert.ok(value === null || ['string', 'number', 'boolean'].includes(typeof value), `${where}.enum values must be scalars`);
      }
    }
    if (node.oneOf !== undefined) {
      assert.ok(Array.isArray(node.oneOf) && node.oneOf.length >= 2, `${where}.oneOf needs at least two branches`);
      node.oneOf.forEach((branch, index) => visit(branch, `${where}.oneOf[${index}]`));
    }
  };
  for (const tool of tools.values()) {
    assert.equal(tool.parameters.type, 'object', `${tool.name}.parameters must be an object root`);
    visit(tool.parameters, `${tool.name}.parameters`);
    visit(tool.output.schema, `${tool.name}.output.schema`);
    assert.equal(typeof tool.output.render, 'function', `${tool.name} needs output.render`);
    assert.equal(typeof tool.execute, 'function', `${tool.name} needs execute`);
    assert.ok(tool.description.length > 20, `${tool.name} needs a useful description`);
  }
});

test('reports provider errors and retries on another lane through tools', async (t) => {
  const { call } = setup(t);
  await call('team_workflow_define', {
    definition: {
      apiVersion: 1,
      name: 'lane-flow',
      roles: [{ id: 'worker', instances: 1, providers: ['lane-a', 'lane-b'] }],
      providers: [{ id: 'lane-a', concurrency: 1, backoffMinutes: [10] }, { id: 'lane-b', concurrency: 1 }],
      stages: [{ id: 'work', role: 'worker' }],
    },
  });
  await call('team_workflow_enqueue', { title: 'flaky' });
  const claimed = await call('team_workflow_claim', { role: 'worker', member: 'w1', provider: 'lane-a' });
  const failed = await call('team_workflow_fail', {
    attemptId: claimed.attemptId,
    error: '429 rate limit',
  });
  assert.equal(failed.providerFailure, true);
  assert.equal(failed.status, 'retried');

  const next = await call('team_workflow_claim', { role: 'worker', member: 'w2' });
  assert.equal(next.claimed, true);
  const status = await call('team_workflow_status');
  assert.equal(status.providers.find(provider => provider.id === 'lane-a').health, 'blocked');
});
