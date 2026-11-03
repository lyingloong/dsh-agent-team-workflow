/**
 * v2 Web API for the node/run panel.
 *
 * Routes are session-scoped and use the same JSON store as the tools. The run
 * route executes nodes with the last Agent object observed for that session, so
 * a panel button can continue a run after a human decision.
 */

import path from 'node:path';
import { SessionStore } from './store.mjs';
import { DEFAULT_PERMISSIONS, decide, newRunState, run } from './runtime.mjs';
import { panelState } from './view.mjs';
import { createExecutors } from './executors.mjs';

export const ROUTE_PREFIX = '/plugins/dsh-agent-team-workflow';
const MAX_BODY_BYTES = 64 * 1024;
const SESSION_PATTERN = /^[A-Za-z0-9._-]{1,200}$/;

export function installWebApi({ ctx, dataRoot, agents, settings = {}, logger = console }) {
  const root = path.resolve(dataRoot);
  const stores = new Map();
  const routes = new Map();

  const storeFor = session => {
    if (typeof session !== 'string' || !SESSION_PATTERN.test(session)) {
      throw Object.assign(new Error('session must be a safe session id'), { code: 'invalid_session' });
    }
    if (!stores.has(session)) stores.set(session, new SessionStore(path.join(root, 'sessions', session)));
    return stores.get(session);
  };

  const guard = handler => async (req, res) => {
    try {
      await handler(req, res);
    } catch (error) {
      if (res.headersSent) {
        res.destroy?.();
        return;
      }
      sendJson(res, error?.code ? 400 : 500, {
        error: { code: error?.code ?? 'internal', message: error?.message ?? String(error) },
      });
    }
  };
  const route = (suffix, handler) => routes.set(`${ROUTE_PREFIX}${suffix}`, guard(handler));

  const loadState = async (store, runId) => {
    if (typeof runId === 'string' && runId !== '') return store.loadRun(runId);
    return store.latestRun();
  };

  route('/api/state', async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://local');
    const session = url.searchParams.get('session');
    const store = storeFor(session);
    const stored = await store.loadDefinition();
    const state = await loadState(store, url.searchParams.get('runId'));
    sendJson(res, 200, panelState(stored, state));
  });

  route('/api/start', async (req, res) => {
    const body = await readJson(req);
    const store = storeFor(body.session);
    const stored = await store.loadDefinition();
    if (!stored) return sendJson(res, 409, { error: { code: 'no_workflow', message: 'no workflow defined' } });
    const state = newRunState({
      definition: stored.definition,
      permissions: stored.permissions ?? DEFAULT_PERMISSIONS,
      input: body.input !== null && typeof body.input === 'object' ? body.input : {},
    });
    await store.saveRun(state);
    sendJson(res, 201, panelState(stored, state));
  });

  route('/api/decide', async (req, res) => {
    const body = await readJson(req);
    const store = storeFor(body.session);
    const stored = await store.loadDefinition();
    if (!stored) return sendJson(res, 409, { error: { code: 'no_workflow', message: 'no workflow defined' } });
    const state = await loadState(store, body.runId);
    if (!state) return sendJson(res, 409, { error: { code: 'no_run', message: 'no run exists' } });
    decide(state, { tokenId: requireText(body.tokenId, 'tokenId'), outcome: requireText(body.outcome, 'outcome'), output: body.output ?? null });
    await store.saveRun(state);
    sendJson(res, 200, panelState(stored, state));
  });

  route('/api/run', async (req, res) => {
    const body = await readJson(req);
    const session = body.session;
    const store = storeFor(session);
    const stored = await store.loadDefinition();
    if (!stored) return sendJson(res, 409, { error: { code: 'no_workflow', message: 'no workflow defined' } });
    const agentExec = agents.get(session);
    if (!agentExec) {
      return sendJson(res, 409, { error: { code: 'no_session_agent', message: 'run once from the assistant session first' } });
    }
    const state = await loadState(store, body.runId);
    if (!state) return sendJson(res, 409, { error: { code: 'no_run', message: 'no run exists' } });
    const exec = { ...agentExec, signal: new AbortController().signal };
    const executors = createExecutors({
      ctx,
      exec,
      settings: { subagentProvider: settings.subagentProvider ?? 'spawn' },
      cwd: agentExec.agent?.session?.header?.cwd ?? process.cwd(),
    });
    try {
      await run(state, executors, { maxSteps: settings.maxSteps ?? 40 });
    } catch (error) {
      state.status = 'failed';
      state.lastError = error.message;
      logger.warn?.(`dsh-agent-team-workflow: panel run failed: ${error.message}`);
    }
    await store.saveRun(state);
    sendJson(res, 200, panelState(stored, state));
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
      if (typeof ctx.effect === 'function') ctx.effect(register, `dsh-agent-team-workflow: ${routePath}`);
      else register();
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
        reject(Object.assign(new Error('request body is too large'), { code: 'payload_too_large' }));
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

function requireText(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw Object.assign(new Error(`${label} must be a non-empty string`), { code: 'invalid_argument' });
  }
  return value.trim();
}
