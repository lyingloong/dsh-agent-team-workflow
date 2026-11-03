/**
 * Same-origin Web API for the embedded workflow panel.
 *
 * Workflow state is session-scoped: one state directory per DSH Session under
 * `<data-root>/sessions/<sessionId>`. A directory can host many sessions, so a
 * project can have several workflows without them colliding.
 *
 * The panel receives its session id from the session-scoped sidebar slot and
 * passes it to these routes. Arbitrary path segments are rejected.
 */

import path from 'node:path';
import { existsSync } from 'node:fs';

import { normalizeDefinition } from './definition.mjs';
import { Engine } from './engine.mjs';
import { Store } from './store.mjs';
import { dataPaths } from './paths.mjs';
import { buildBoardData } from './board/data.mjs';

export const ROUTE_PREFIX = '/plugins/dsh-agent-team-workflow';
const MAX_BODY_BYTES = 64 * 1024;
const SESSION_PATTERN = /^[A-Za-z0-9._-]{1,200}$/;

/**
 * Install the API routes on the host web server. Safe in a headless profile:
 * when no web server service exists the call is a no-op and later service
 * binding retries.
 */
export function installWebApi({ ctx, dataRoot, logger = console }) {
  const root = path.resolve(dataRoot);
  const routes = new Map();

  const guard = handler => async (req, res) => {
    try {
      await handler(req, res);
    } catch (error) {
      if (res.headersSent) {
        res.destroy?.();
        return;
      }
      sendJson(res, error?.code ? 400 : 500, {
        error: {
          code: error?.code ?? 'internal',
          message: error?.message ?? String(error),
        },
      });
    }
  };
  const route = (suffix, handler) => routes.set(`${ROUTE_PREFIX}${suffix}`, guard(handler));

  const stateDir = session => {
    if (typeof session !== 'string' || !SESSION_PATTERN.test(session)) {
      throw Object.assign(new Error('session must be a safe session id'), { code: 'invalid_session' });
    }
    return path.join(root, 'sessions', session);
  };

  const openState = dir => {
    const paths = dataPaths(dir);
    if (!existsSync(paths.dbPath)) return null;
    const store = Store.open(paths.dbPath);
    try {
      const snapshot = store.snapshot();
      if (!snapshot.workflow) {
        store.close();
        return null;
      }
      const definition = normalizeDefinition(snapshot.workflow.definition);
      return {
        store,
        snapshot,
        definition,
        engine: new Engine({ store, definition, workflowId: snapshot.workflow.id }),
      };
    } catch (error) {
      store.close();
      throw error;
    }
  };

  route('/api/board', async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://local');
    const session = url.searchParams.get('session');
    const state = openState(stateDir(session));
    if (!state) {
      sendJson(res, 200, { session, defined: false });
      return;
    }
    try {
      sendJson(res, 200, {
        session,
        defined: true,
        board: buildBoardData({ snapshot: state.snapshot, definition: state.definition }),
      });
    } finally {
      state.store.close();
    }
  });

  route('/api/gate', async (req, res) => {
    const body = await readJson(req);
    const state = openState(stateDir(body.session));
    if (!state) return sendJson(res, 409, { error: { code: 'no_workflow', message: 'this session has no workflow yet' } });
    try {
      const result = state.engine.decideGate({
        itemId: requireString(body.itemId, 'itemId'),
        gate: requireString(body.gate, 'gate'),
        decision: requireString(body.decision, 'decision'),
        by: typeof body.by === 'string' && body.by !== '' ? body.by : 'web',
        note: typeof body.note === 'string' ? body.note : '',
      });
      sendJson(res, 200, result);
    } finally {
      state.store.close();
    }
  });

  route('/api/enqueue', async (req, res) => {
    const body = await readJson(req);
    const state = openState(stateDir(body.session));
    if (!state) return sendJson(res, 409, { error: { code: 'no_workflow', message: 'this session has no workflow yet' } });
    try {
      const result = state.engine.enqueue({
        title: requireString(body.title, 'title'),
        kind: typeof body.kind === 'string' && body.kind !== '' ? body.kind : 'item',
        data: isPlainObject(body.input) ? body.input : {},
        priority: Number.isInteger(body.priority) ? body.priority : 0,
      });
      sendJson(res, 201, result);
    } finally {
      state.store.close();
    }
  });

  let attached = false;
  const connection = () => ctx.get?.('connection');
  const authenticated = handler => async (req, res) => {
    const gate = connection();
    const rejection = gate === undefined
      ? 503
      : typeof gate.requestRejection === 'function' ? gate.requestRejection(req) : undefined;
    if (rejection !== undefined) {
      sendJson(res, rejection, {
        error: rejection === 503 ? 'authentication unavailable' : rejection === 401 ? 'unauthorized' : 'forbidden',
      });
      return;
    }
    await handler(req, res);
  };
  const attach = () => {
    if (attached) return true;
    const server = ctx.get?.('webServer') ?? ctx.get?.('httpServer');
    if (!server || typeof server.register !== 'function') return false;
    attached = true;
    for (const [routePath, handler] of routes) {
      const register = () => server.register({ kind: 'exact', path: routePath, handler: authenticated(handler) });
      if (typeof ctx.effect === 'function') {
        ctx.effect(register, `dsh-agent-team-workflow: ${routePath}`);
      } else {
        register();
      }
    }
    return true;
  };

  attach();
  if (!attached && typeof ctx.on === 'function') {
    ctx.on('internal/service', name => {
      if (name === 'webServer' || name === 'httpServer') attach();
    });
  }

  return { routes, attach };
}

function sendJson(res, status, value) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(JSON.stringify(value));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('request body too large'), { code: 'payload_too_large' }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (text.trim() === '') {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(Object.assign(new Error('request body is not valid JSON'), { code: 'invalid_json' }));
      }
    });
    req.on('error', reject);
  });
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw Object.assign(new Error(`${label} must be a non-empty string`), { code: 'invalid_argument' });
  }
  return value.trim();
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
