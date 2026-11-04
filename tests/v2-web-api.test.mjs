import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

import { installWebApi } from '../src/v2/web-api.mjs';
import { normalizeDefinition } from '../src/v2/definition.mjs';
import { SessionStore } from '../src/v2/store.mjs';

const SESSION = 'session-v2-api';
const FLOW = normalizeDefinition({
  apiVersion: 2,
  name: 'api-flow',
  entry: 'seed',
  nodes: [
    { id: 'seed', type: 'human', config: { outcomes: ['approve'] } },
    { id: 'run', type: 'command', config: { command: 'echo ok' } },
  ],
  edges: [{ from: 'seed', to: 'run', on: 'approve' }],
});

const MODEL_FLOW = normalizeDefinition({
  apiVersion: 2,
  name: 'model-api-flow',
  entry: 'worker',
  nodes: [{ id: 'worker', type: 'agent', config: { prompt: 'work' } }],
  edges: [],
});

const FANOUT_FLOW = normalizeDefinition({
  apiVersion: 2,
  name: 'fanout-api-flow',
  entry: 'split',
  nodes: [
    { id: 'split', type: 'fanout', config: { items: '$input.items', target: 'gate', join: 'join' } },
    { id: 'gate', type: 'human' },
    { id: 'join', type: 'join', config: { mode: 'all' } },
    { id: 'after', type: 'human' },
  ],
  edges: [{ from: 'join', to: 'after', on: 'complete' }],
});

function setup(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'workflow-v2-api-'));
  const dataRoot = path.join(dir, '.data');
  const routes = new Map();
  const agents = new Map();
  const exec = { agent: { id: SESSION, session: { header: { cwd: dir } } }, signal: new AbortController().signal };
  agents.set(SESSION, exec);
  const ctx = {
    get(name) {
      if (name === 'webServer') {
        return {
          getOrigin: () => 'http://127.0.0.1:1234',
          register(route) {
            routes.set(route.path, route.handler);
            return () => routes.delete(route.path);
          },
        };
      }
      if (name === 'connection') return { requestRejection: () => undefined };
      if (name === 'llm') {
        return {
          async listProviders() {
            return [{ id: 'provider-a', name: 'Provider A' }];
          },
          async listModels(provider) {
            return provider === 'provider-a'
              ? [{ provider, id: 'model-1', name: 'Model One' }]
              : [];
          },
        };
      }
      if (name === 'agentDefaultModel') {
        return { currentSelection: () => ({ provider: 'provider-a', model: 'model-1' }) };
      }
      return undefined;
    },
    effect(fn) {
      fn();
    },
    on() {},
  };
  const api = installWebApi({ ctx, dataRoot, agents, settings: { subagentProvider: 'spawn', maxSteps: 10 }, logger: { warn() {} } });
  const store = new SessionStore(path.join(dataRoot, 'sessions', SESSION));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }));
  return { routes, store, api };
}

function response() {
  return {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(body) {
      this.body = body;
    },
  };
}

async function invoke(handler, { method = 'GET', url, body } = {}) {
  const res = response();
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.destroy = () => {};
  queueMicrotask(() => {
    if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body)));
    req.emit('end');
  });
  await handler(req, res);
  return { status: res.status, json: res.body === '' ? null : JSON.parse(res.body) };
}

async function invokeRaw(handler, { method = 'GET', url } = {}) {
  const res = response();
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.destroy = () => {};
  queueMicrotask(() => req.emit('end'));
  await handler(req, res);
  return { status: res.status, headers: res.headers, body: res.body };
}

test('v2 web API supports state, start, decide and run', async (t) => {
  const { routes, store } = setup(t);
  assert.deepEqual([...routes.keys()].sort(), [
    '/plugins/dsh-agent-team-workflow/api/board-url',
    '/plugins/dsh-agent-team-workflow/api/decide',
    '/plugins/dsh-agent-team-workflow/api/models',
    '/plugins/dsh-agent-team-workflow/api/node-model',
    '/plugins/dsh-agent-team-workflow/api/run',
    '/plugins/dsh-agent-team-workflow/api/start',
    '/plugins/dsh-agent-team-workflow/api/state',
    '/plugins/dsh-agent-team-workflow/board',
    '/plugins/dsh-agent-team-workflow/public/api/decide',
    '/plugins/dsh-agent-team-workflow/public/api/run',
    '/plugins/dsh-agent-team-workflow/public/api/start',
    '/plugins/dsh-agent-team-workflow/public/api/state',
    '/plugins/dsh-agent-team-workflow/public/board',
  ]);
  await store.saveDefinition({ definition: FLOW, permissions: { command: { mode: 'full', allow: [] } } });

  const state0 = await invoke(routes.get('/plugins/dsh-agent-team-workflow/api/state'), {
    url: `/plugins/dsh-agent-team-workflow/api/state?session=${SESSION}`,
  });
  assert.equal(state0.status, 200);
  assert.equal(state0.json.defined, true);
  assert.equal(state0.json.run, null);

  const started = await invoke(routes.get('/plugins/dsh-agent-team-workflow/api/start'), {
    method: 'POST',
    url: '/plugins/dsh-agent-team-workflow/api/start',
    body: { session: SESSION, input: {} },
  });
  assert.equal(started.status, 201);
  assert.equal(started.json.run.status, 'running');

  const waiting = await invoke(routes.get('/plugins/dsh-agent-team-workflow/api/run'), {
    method: 'POST',
    url: '/plugins/dsh-agent-team-workflow/api/run',
    body: { session: SESSION, runId: started.json.run.runId },
  });
  assert.equal(waiting.status, 200);
  assert.equal(waiting.json.run.status, 'waiting');
  const tokenId = waiting.json.run.tokens.find(token => token.status === 'waiting').id;

  const decided = await invoke(routes.get('/plugins/dsh-agent-team-workflow/api/decide'), {
    method: 'POST',
    url: '/plugins/dsh-agent-team-workflow/api/decide',
    body: { session: SESSION, runId: started.json.run.runId, tokenId, outcome: 'approve' },
  });
  assert.equal(decided.status, 200);

  const done = await invoke(routes.get('/plugins/dsh-agent-team-workflow/api/run'), {
    method: 'POST',
    url: '/plugins/dsh-agent-team-workflow/api/run',
    body: { session: SESSION, runId: started.json.run.runId },
  });
  assert.equal(done.status, 200);
  assert.equal(done.json.run.status, 'done');
});

test('v2 web API lists host models and updates an agent node model', async (t) => {
  const { routes, store } = setup(t);
  await store.saveDefinition({ definition: MODEL_FLOW, permissions: {} });
  const started = await invoke(routes.get('/plugins/dsh-agent-team-workflow/api/start'), {
    method: 'POST',
    url: '/plugins/dsh-agent-team-workflow/api/start',
    body: { session: SESSION, input: {} },
  });
  assert.equal(started.status, 201);

  const catalog = await invoke(routes.get('/plugins/dsh-agent-team-workflow/api/models'), {
    url: `/plugins/dsh-agent-team-workflow/api/models?session=${SESSION}`,
  });
  assert.equal(catalog.status, 200);
  assert.equal(catalog.json.providers[0].id, 'provider-a');
  assert.equal(catalog.json.providers[0].models[0].id, 'model-1');
  assert.deepEqual(catalog.json.default, { provider: 'provider-a', model: 'model-1' });

  const updated = await invoke(routes.get('/plugins/dsh-agent-team-workflow/api/node-model'), {
    method: 'POST',
    url: '/plugins/dsh-agent-team-workflow/api/node-model',
    body: { session: SESSION, runId: started.json.run.runId, nodeId: 'worker', provider: 'provider-a', model: 'model-1' },
  });
  assert.equal(updated.status, 200, JSON.stringify(updated.json));
  assert.equal(updated.json.definition.nodes[0].config.provider, 'provider-a');
  assert.equal(updated.json.definition.nodes[0].config.model, 'model-1');

  const stored = await store.loadDefinition();
  assert.equal(stored.definition.nodes[0].config.provider, 'provider-a');
  const run = await store.loadRun(started.json.run.runId);
  assert.equal(run.definition.nodes[0].config.model, 'model-1');

  const multi = await invoke(routes.get('/plugins/dsh-agent-team-workflow/api/node-model'), {
    method: 'POST',
    url: '/plugins/dsh-agent-team-workflow/api/node-model',
    body: {
      session: SESSION,
      runId: started.json.run.runId,
      nodeId: 'worker',
      models: [
        { provider: 'provider-a', model: 'model-1' },
        { provider: 'provider-b', model: 'model-2' },
      ],
    },
  });
  assert.equal(multi.status, 200, JSON.stringify(multi.json));
  assert.equal(multi.json.definition.nodes[0].config.models.length, 2);
  assert.equal(multi.json.definition.nodes[0].config.provider, undefined);
  const storedMulti = await store.loadDefinition();
  assert.deepEqual(storedMulti.definition.nodes[0].config.models, [
    { provider: 'provider-a', model: 'model-1' },
    { provider: 'provider-b', model: 'model-2' },
  ]);
  const runMulti = await store.loadRun(started.json.run.runId);
  assert.equal(runMulti.definition.nodes[0].config.models[1].model, 'model-2');
});

test('web API panel state excludes internal join waits', async (t) => {
  const { routes, store } = setup(t);
  await store.saveDefinition({ definition: FANOUT_FLOW, permissions: {} });
  const started = await invoke(routes.get('/plugins/dsh-agent-team-workflow/api/start'), {
    method: 'POST',
    url: '/plugins/dsh-agent-team-workflow/api/start',
    body: { session: SESSION, input: { items: ['a', 'b'] } },
  });
  assert.equal(started.status, 201);
  const runId = started.json.run.runId;

  const waiting = await invoke(routes.get('/plugins/dsh-agent-team-workflow/api/run'), {
    method: 'POST',
    url: '/plugins/dsh-agent-team-workflow/api/run',
    body: { session: SESSION, runId },
  });
  assert.equal(waiting.status, 200);
  assert.equal(waiting.json.run.status, 'waiting');
  assert.deepEqual(waiting.json.run.waiting.map(token => token.nodeId), ['gate', 'gate']);
  const joinToken = waiting.json.run.tokens.find(token => token.nodeId === 'join');
  assert.equal(joinToken.status, 'waiting');

  const panel = await invoke(routes.get('/plugins/dsh-agent-team-workflow/api/state'), {
    url: `/plugins/dsh-agent-team-workflow/api/state?session=${SESSION}`,
  });
  assert.equal(panel.status, 200);
  assert.deepEqual(panel.json.run.waiting.map(token => token.nodeId), ['gate', 'gate']);

  const rejected = await invoke(routes.get('/plugins/dsh-agent-team-workflow/api/decide'), {
    method: 'POST',
    url: '/plugins/dsh-agent-team-workflow/api/decide',
    body: { session: SESSION, runId, tokenId: joinToken.id, outcome: 'approve' },
  });
  assert.equal(rejected.status, 400);
  assert.equal(rejected.json.error.code, 'not_decidable');
});

test('board URL serves the standalone HTML board', async (t) => {
  const { routes } = setup(t);
  const board = await invokeRaw(routes.get('/plugins/dsh-agent-team-workflow/board'), {
    url: `/plugins/dsh-agent-team-workflow/board?session=${SESSION}`,
  });
  assert.equal(board.status, 200);
  assert.match(board.headers['content-type'], /^text\/html/);
  assert.match(board.body, /工作流看板/);
  assert.match(board.body, /\/state\?session=/);
});

test('public board URL is token-scoped and served on the alternate localhost origin', async (t) => {
  const { api, store } = setup(t);
  const url = api.boardUrl(SESSION);
  assert.match(url, /^http:\/\/localhost:1234\//);
  assert.match(url, /token=/);
  await store.saveDefinition({ definition: FLOW, permissions: { command: { mode: 'full', allow: [] } } });

  const board = await invokeRaw(api.publicRoutes.get('/plugins/dsh-agent-team-workflow/public/board'), {
    url: `/plugins/dsh-agent-team-workflow/public/board?session=${SESSION}&token=${encodeURIComponent(api.publicToken)}`,
  });
  assert.equal(board.status, 200);
  assert.match(board.body, /工作流看板/);

  const denied = await invokeRaw(api.publicRoutes.get('/plugins/dsh-agent-team-workflow/public/api/state'), {
    url: `/plugins/dsh-agent-team-workflow/public/api/state?session=${SESSION}`,
  });
  assert.equal(denied.status, 401, denied.body);

  const state = await invoke(api.publicRoutes.get('/plugins/dsh-agent-team-workflow/public/api/state'), {
    url: `/plugins/dsh-agent-team-workflow/public/api/state?session=${SESSION}&token=${encodeURIComponent(api.publicToken)}`,
  });
  assert.equal(state.status, 200);
  assert.equal(state.json.defined, true);
});
