/**
 * Same-origin Web API for the embedded workflow panel.
 *
 * The Web GUI client panel cannot read the plugin's loopback board server
 * cross-origin, so the host registers these routes on the GUI's own web server.
 * Every route is read-only except gate decisions and enqueue; they use the same
 * engine and event log as the tools.
 *
 * Workspace scoping is deliberate: a workflow belongs to one registered
 * workspace (`<workspace>/.agent-team-workflow`). Arbitrary paths are rejected,
 * and the only writable roots are the ones the host already knows about.
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

/**
 * Install the API routes on the host web server. Safe in a headless profile:
 * when no web server service exists the call is a no-op and later service
 * binding retries.
 */
export function installWebApi({ ctx, settings, logger = console }) {
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

  const workspaceRoots = () => {
    const registry = ctx.get?.('workspaceRegistry') ?? ctx.get?.('workspace');
    if (!registry || typeof registry.list !== 'function') return [];
    return registry.list().map(workspace => ({
      path: path.resolve(String(workspace.path)),
      title: typeof workspace.title === 'string' && workspace.title !== '' ? workspace.title : String(workspace.path),
    })).filter(workspace => workspace.path !== '');
  };

  const stateDirOf = root => path.resolve(root, settings.stateDir);

  const stateExists = root => existsSync(dataPaths(stateDirOf(root)).dbPath);

  const openState = root => {
    const dataDir = stateDirOf(root);
    const paths = dataPaths(dataDir);
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

  const selectRoot = raw => {
    const roots = workspaceRoots();
    if (roots.length === 0) return null;
    if (raw !== null && raw !== undefined && raw !== '') {
      const resolved = path.resolve(String(raw));
      return roots.find(workspace => workspace.path === resolved) ?? null;
    }
    return roots.find(workspace => stateExists(workspace.path)) ?? roots[0];
  };

  route('/api/workspaces', async (req, res) => {
    const workspaces = workspaceRoots().map(workspace => {
      let defined = false;
      let name = null;
      if (stateExists(workspace.path)) {
        try {
          const state = openState(workspace.path);
          defined = state !== null;
          name = state?.definition.name ?? null;
          state?.store.close();
        } catch (error) {
          logger.warn(`dsh-agent-team-workflow: workspace state unreadable at ${workspace.path}: ${error.message}`);
        }
      }
      return { path: workspace.path, title: workspace.title, defined, name };
    });
    sendJson(res, 200, { workspaces });
  });

  route('/api/board', async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://local');
    const root = selectRoot(url.searchParams.get('workspace'));
    if (!root) {
      sendJson(res, 404, { error: { code: 'workspace_not_found', message: 'no registered workspace matches the request' } });
      return;
    }
    const state = openState(root.path);
    if (!state) {
      sendJson(res, 200, { workspace: root.path, title: root.title, defined: false });
      return;
    }
    try {
      sendJson(res, 200, {
        workspace: root.path,
        title: root.title,
        defined: true,
        board: buildBoardData({ snapshot: state.snapshot, definition: state.definition }),
      });
    } finally {
      state.store.close();
    }
  });

  route('/api/gate', async (req, res) => {
    const body = await readJson(req);
    const root = selectRoot(body.workspace);
    if (!root) return sendJson(res, 404, { error: { code: 'workspace_not_found', message: 'no registered workspace matches the request' } });
    const state = openState(root.path);
    if (!state) return sendJson(res, 409, { error: { code: 'no_workflow', message: 'this workspace has no workflow yet' } });
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
    const root = selectRoot(body.workspace);
    if (!root) return sendJson(res, 404, { error: { code: 'workspace_not_found', message: 'no registered workspace matches the request' } });
    const state = openState(root.path);
    if (!state) return sendJson(res, 409, { error: { code: 'no_workflow', message: 'this workspace has no workflow yet' } });
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
  const attach = () => {
    if (attached) return true;
    const server = ctx.get?.('webServer') ?? ctx.get?.('httpServer');
    if (!server || typeof server.register !== 'function') return false;
    attached = true;
    for (const [routePath, handler] of routes) {
      const register = () => server.register({ kind: 'exact', path: routePath, handler });
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
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
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
