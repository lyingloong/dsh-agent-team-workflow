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
import { dataPaths } from '../src/paths.mjs';

const SESSION = 'session-a';
const WORKFLOW = {
  apiVersion: 1,
  name: 'web-api-flow',
  roles: [{ id: 'worker', instances: 1 }],
  stages: [{ id: 'work', role: 'worker', on: { complete: 'done' } }, { id: 'done', role: 'worker' }],
};

function setup(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'team-workflow-api-'));
  const dataRoot = path.join(dir, '.data');
  const paths = dataPaths(path.join(dataRoot, 'sessions', SESSION));
  const store = Store.open(paths.dbPath);
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
      if (name === 'connection') return { requestRejection: () => undefined };
      if (name === 'webServer') {
        return {
          register(route) {
            routes.set(route.path, route.handler);
            return () => routes.delete(route.path);
          },
        };
      }
      return undefined;
    },
    effect(fn) {
      fn();
    },
    on() {},
  };
  installWebApi({ ctx, dataRoot, logger: { warn() {} } });
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }));
  return { dir, dataRoot, routes };
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

test('registers the embedded session API routes', (t) => {
  const { routes } = setup(t);
  assert.deepEqual([...routes.keys()].sort(), [
    '/plugins/dsh-agent-team-workflow/api/board',
    '/plugins/dsh-agent-team-workflow/api/enqueue',
    '/plugins/dsh-agent-team-workflow/api/gate',
  ]);
});

test('serves one session board projection', async (t) => {
  const { routes } = setup(t);
  const result = await invoke(routes.get('/plugins/dsh-agent-team-workflow/api/board'), {
    url: `/plugins/dsh-agent-team-workflow/api/board?session=${SESSION}`,
  });
  assert.equal(result.status, 200);
  assert.equal(result.json.session, SESSION);
  assert.equal(result.json.defined, true);
  assert.equal(result.json.board.workflow.name, 'web-api-flow');
  assert.equal(result.json.board.counts.items, 1);
  assert.equal(result.json.board.columns[0].items[0].title, 'demo item');
});

test('enqueues a task through the same-origin API', async (t) => {
  const { routes } = setup(t);
  const handler = routes.get('/plugins/dsh-agent-team-workflow/api/enqueue');
  const created = await invoke(handler, {
    method: 'POST',
    url: '/plugins/dsh-agent-team-workflow/api/enqueue',
    body: { session: SESSION, title: 'from panel' },
  });
  assert.equal(created.status, 201);
  assert.ok(created.json.itemId);

  const board = await invoke(routes.get('/plugins/dsh-agent-team-workflow/api/board'), {
    url: `/plugins/dsh-agent-team-workflow/api/board?session=${SESSION}`,
  });
  assert.equal(board.json.board.counts.items, 2);
});

test('rejects an unsafe session id', async (t) => {
  const { routes } = setup(t);
  const result = await invoke(routes.get('/plugins/dsh-agent-team-workflow/api/board'), {
    url: '/plugins/dsh-agent-team-workflow/api/board?session=..%2Fescape',
  });
  assert.equal(result.status, 400);
  assert.equal(result.json.error.code, 'invalid_session');
});

test('a session without a workflow reads as undefined', async (t) => {
  const { routes } = setup(t);
  const result = await invoke(routes.get('/plugins/dsh-agent-team-workflow/api/board'), {
    url: '/plugins/dsh-agent-team-workflow/api/board?session=session-empty',
  });
  assert.equal(result.status, 200);
  assert.equal(result.json.defined, false);
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
  assert.doesNotThrow(() => installWebApi({ ctx, dataRoot: os.tmpdir(), logger: { warn() {} } }));
});

test('rejects unauthenticated requests on the registered routes', async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'team-workflow-auth-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }));
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
      return undefined;
    },
    effect(fn) {
      fn();
    },
    on() {},
  };
  installWebApi({ ctx, dataRoot: path.join(dir, '.data'), logger: { warn() {} } });
  const result = await invoke(routes.get('/plugins/dsh-agent-team-workflow/api/board'), {
    url: `/plugins/dsh-agent-team-workflow/api/board?session=${SESSION}`,
  });
  assert.equal(result.status, 503);
  assert.deepEqual(result.json, { error: 'authentication unavailable' });
});
