import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { apply } from '../src/v2/plugin.mjs';

function setup(t, { subagents = null } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'workflow-v2-plugin-'));
  const tools = new Map();
  const sections = [];
  const ctx = {
    tools: {
      register(tool) {
        tools.set(tool.name, tool);
        return () => tools.delete(tool.name);
      },
    },
    systemPrompt: {
      section(section) {
        sections.push(section);
      },
    },
    effect(fn) {
      fn();
    },
    get(name) {
      if (name === 'subagents') return subagents;
      return undefined;
    },
  };
  apply(ctx, { dataDir: path.join(dir, '.data') });
  const exec = { agent: { id: 'session-v2', session: { header: { cwd: dir } } }, signal: new AbortController().signal };
  const call = async (name, args = {}) => {
    const tool = tools.get(name);
    assert.ok(tool, `${name} is registered`);
    return tool.execute(args, exec);
  };
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }));
  return { dir, tools, sections, call, exec };
}

const HUMAN_AGENT = {
  apiVersion: 2,
  name: 'human-agent',
  entry: 'seed',
  nodes: [
    { id: 'seed', type: 'human', config: { outcomes: ['approve'] } },
    { id: 'impl', type: 'agent', role: 'engineer', inputs: { task: '$input.task' } },
  ],
  edges: [{ from: 'seed', to: 'impl', on: 'approve' }],
};

test('v2 plugin registers five tools and a usage section', (t) => {
  const { tools, sections } = setup(t);
  assert.deepEqual([...tools.keys()].sort(), [
    'team_workflow_decide',
    'team_workflow_define',
    'team_workflow_run',
    'team_workflow_start',
    'team_workflow_status',
  ]);
  assert.equal(sections.length, 1);
  assert.match(sections[0].text, /command\/http nodes/);
});

test('define, start, wait at human, decide, run to completion', async (t) => {
  const calls = [];
  const subagents = {
    async startActivation(spec) {
      calls.push(spec);
      return {
        childId: 'child-v2',
        result: Promise.resolve({
          output: [{ type: 'text', text: '{"outcome":"complete","output":{"files":["a.js"]}}' }],
          stopReason: 'completed',
        }),
        dispose: async () => {},
      };
    },
  };
  const { call } = setup(t, { subagents });
  const defined = await call('team_workflow_define', { definition: HUMAN_AGENT });
  assert.equal(defined.ok, true, JSON.stringify(defined.errors));
  const started = await call('team_workflow_start', { input: { task: 'build' } });
  assert.equal(started.status, 'running');

  const waiting = await call('team_workflow_run', { runId: started.runId });
  assert.equal(waiting.status, 'waiting');
  assert.equal(waiting.waiting.length, 1);
  assert.deepEqual(waiting.waiting[0].outcomes, ['approve']);

  await call('team_workflow_decide', { tokenId: waiting.waiting[0].tokenId, outcome: 'approve' });
  const done = await call('team_workflow_run', { runId: started.runId });
  assert.equal(done.status, 'done');
  assert.equal(calls.length, 1);
  assert.match(calls[0].request.prompt[0].text, /build/);
});

test('command nodes run only with a permission grant', async (t) => {
  const flow = {
    apiVersion: 2,
    name: 'command-flow',
    entry: 'run',
    nodes: [{ id: 'run', type: 'command', config: { command: 'echo ok' } }],
    edges: [],
  };
  const { call } = setup(t);
  await call('team_workflow_define', {
    definition: flow,
    permissions: { command: { mode: 'full', allow: [] } },
  });
  const started = await call('team_workflow_start', {});
  const done = await call('team_workflow_run', { runId: started.runId });
  assert.equal(done.status, 'done');
  const status = await call('team_workflow_status', { runId: started.runId });
  assert.equal(status.defined, true);
  assert.equal(status.run.status, 'done');
});

test('command nodes fail without a grant and report permission_denied', async (t) => {
  const flow = {
    apiVersion: 2,
    name: 'denied-flow',
    entry: 'run',
    nodes: [{ id: 'run', type: 'command', config: { command: 'echo no' } }],
    edges: [],
  };
  const { call } = setup(t);
  await call('team_workflow_define', { definition: flow });
  const started = await call('team_workflow_start', {});
  const failed = await call('team_workflow_run', { runId: started.runId });
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /permission/);
});

test('status reports no run before start and rejects malformed definitions', async (t) => {
  const { call } = setup(t);
  const noRun = await call('team_workflow_status', {});
  assert.equal(noRun.defined, false);
  assert.equal(noRun.run.status, 'none');

  const rejected = await call('team_workflow_define', {
    definition: { apiVersion: 2, name: 'bad', nodes: [{ id: 'x', type: 'unknown' }], edges: [] },
  });
  assert.equal(rejected.ok, false);
  assert.match(rejected.errors[0].path, /nodes/);
});
