import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

import { installWebApi } from '../src/web-api.mjs';
import { Store } from '../src/store.mjs';
import { Engine } from '../src/engine.mjs';
import { normalizeDefinition } from '../src/definition.mjs';

const WORKFLOW = {
  apiVersion: 1,
  name: 'web-api-flow',
  roles: [{ id: 'worker', instances: 1 }],
  stages: [{ id: 'work', role: 'worker', on: { complete: 'done' } }, { id: 'done', role: 'worker' }],
};

function setup(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'team-workflow-api-'));
  const stateDir = path.join(dir, '.state');
  const store = Store.open(path.join(stateDir, 'agent-team-workflow.sqlite3'));
  store.append({
    type: 'workflow.defined',
    entity: 'workflow',
    entityId: 'default',
    workflowId: 'default',
    payload: { workflowId: 'default', name: WORKFLOW.name, definition: WORKFLOW },
  });
  const engine = new Engine({ store, definition: normalizeDefinition(WORKFLOW) });
  engine.enqueue({ title: 'demo item' });
  store.close();

  const routes = new Map();
  const ctx = {
    get(name) {
      if (name === 'webServer') {
        return {
          register(route) {
            routes.set(route.path, route.handler);
            return () => routes.delete(route.path);
          },
        };
      }
      if (name === 'workspaceRegistry') {
        return { list: () => [{ path: dir, title: 'Demo Workspace' }] };
      }
      return undefined;
    },
    effect(fn) {
      fn();
    },
    on() {},
  };
  installWebApi({ ctx, settings: { stateDir: '.state' }, logger: { warn() {} } });
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }));
  return { dir, routes };
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
  return { status: res.status, headers: res.headers, json: res.body === '' ? null : JSON.parse(res.body) };
}

test('registers the embedded API routes', (t) => {
  const { routes } = setup(t);
  assert.deepEqual([...routes.keys()].sort(), [
    '/plugins/dsh-agent-team-workflow/api/board',
    '/plugins/dsh-agent-team-workflow/api/enqueue',
    '/plugins/dsh-agent-team-workflow/api/gate',
    '/plugins/dsh-agent-team-workflow/api/workspaces',
  ]);
});

test('lists registered workspaces and their workflow names', async (t) => {
  const { dir, routes } = setup(t);
  const result = await invoke(routes.get('/plugins/dsh-agent-team-workflow/api/workspaces'), {
    url: '/plugins/dsh-agent-team-workflow/api/workspaces',
  });
  assert.equal(result.status, 200);
  assert.deepEqual(result.json.workspaces, [{ path: dir, title: 'Demo Workspace', defined: true, name: 'web-api-flow' }]);
});

test('serves one workspace board projection', async (t) => {
  const { dir, routes } = setup(t);
  const result = await invoke(routes.get('/plugins/dsh-agent-team-workflow/api/board'), {
    url: `/plugins/dsh-agent-team-workflow/api/board?workspace=${encodeURIComponent(dir)}`,
  });
  assert.equal(result.status, 200);
  assert.equal(result.json.defined, true);
  assert.equal(result.json.board.workflow.name, 'web-api-flow');
  assert.equal(result.json.board.counts.items, 1);
  assert.equal(result.json.board.columns[0].items[0].title, 'demo item');
});

test('enqueues a task through the same-origin API', async (t) => {
  const { dir, routes } = setup(t);
  const handler = routes.get('/plugins/dsh-agent-team-workflow/api/enqueue');
  const created = await invoke(handler, {
    method: 'POST',
    url: '/plugins/dsh-agent-team-workflow/api/enqueue',
    body: { workspace: dir, title: 'from panel' },
  });
  assert.equal(created.status, 201);
  assert.ok(created.json.itemId);

  const board = await invoke(routes.get('/plugins/dsh-agent-team-workflow/api/board'), {
    url: `/plugins/dsh-agent-team-workflow/api/board?workspace=${encodeURIComponent(dir)}`,
  });
  assert.equal(board.json.board.counts.items, 2);
});

test('rejects an unregistered workspace path', async (t) => {
  const { routes } = setup(t);
  const result = await invoke(routes.get('/plugins/dsh-agent-team-workflow/api/board'), {
    url: '/plugins/dsh-agent-team-workflow/api/board?workspace=C%3A%2Fnot-registered',
  });
  assert.equal(result.status, 404);
  assert.equal(result.json.error.code, 'workspace_not_found');
});

test('ignores a host without a web server', () => {
  const ctx = {
    get() {
      return undefined;
    },
    effect(fn) {
      fn();
    },
    on() {},
  };
  assert.doesNotThrow(() => installWebApi({ ctx, settings: { stateDir: '.state' }, logger: { warn() {} } }));
});
