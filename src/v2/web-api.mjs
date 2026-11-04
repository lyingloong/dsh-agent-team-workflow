/**
 * v2 Web API for the node/run board.
 *
 * Routes are session-scoped and use the same JSON store as the tools. The run
 * route executes nodes with the last Agent object observed for that session, so
 * a board button can continue a run after a human decision.
 */

import path from 'node:path';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { normalizeDefinition } from './definition.mjs';
import { SessionStore } from './store.mjs';
import { DEFAULT_PERMISSIONS, decide, newRunState, run } from './runtime.mjs';
import { panelState } from './view.mjs';
import { createExecutors } from './executors.mjs';

export const ROUTE_PREFIX = '/plugins/dsh-agent-team-workflow';
const MAX_BODY_BYTES = 64 * 1024;
const SESSION_PATTERN = /^[A-Za-z0-9._-]{1,200}$/;
const BOARD_HTML = readFileSync(new URL('./board.html', import.meta.url), 'utf8');

export function installWebApi({ ctx, dataRoot, agents, settings = {}, logger = console }) {
  const root = path.resolve(dataRoot);
  const stores = new Map();
  const routes = new Map();
  const publicRoutes = new Map();
  const publicToken = typeof settings.boardToken === 'string' && settings.boardToken !== '' ? settings.boardToken : randomUUID();

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
      sendJson(res, error?.status ?? (error?.code ? 400 : 500), {
        error: { code: error?.code ?? 'internal', message: error?.message ?? String(error) },
      });
    }
  };
  const route = (suffix, handler) => routes.set(`${ROUTE_PREFIX}${suffix}`, guard(handler));
  const routePublic = (suffix, handler) => publicRoutes.set(`${ROUTE_PREFIX}${suffix}`, guard(handler));
  let boardBase = '';
  let boardServer = null;
  let resolveBoardReady;
  const boardReady = new Promise(resolve => { resolveBoardReady = resolve; });
  const boardUrl = session => {
    if (!boardBase || typeof session !== 'string' || !SESSION_PATTERN.test(session)) return null;
    return `${boardBase}${ROUTE_PREFIX}/public/board?session=${encodeURIComponent(session)}&token=${encodeURIComponent(publicToken)}`;
  };
  const authorizePublic = req => {
    const url = new URL(req.url ?? '/', 'http://local');
    const token = url.searchParams.get('token') || req.headers?.['x-atw-token'];
    if (token !== publicToken) throw Object.assign(new Error('invalid board token'), { code: 'unauthorized', status: 401 });
    return url;
  };

  const loadState = async (store, runId) => {
    if (typeof runId === 'string' && runId !== '') return store.loadRun(runId);
    return store.latestRun();
  };

  route('/board', async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://local');
    storeFor(url.searchParams.get('session'));
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    res.end(BOARD_HTML);
  });

  route('/api/state', async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://local');
    const session = url.searchParams.get('session');
    const store = storeFor(session);
    const stored = await store.loadDefinition();
    const state = await loadState(store, url.searchParams.get('runId'));
    sendJson(res, 200, panelState(stored, state));
  });

  route('/api/models', async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://local');
    const store = storeFor(url.searchParams.get('session'));
    const stored = await store.loadDefinition();
    sendJson(res, 200, await readModelCatalog(ctx, stored?.definition));
  });

  route('/api/board-url', async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://local');
    const base = boardBase || await boardReady;
    sendJson(res, 200, { url: base ? (boardUrl(url.searchParams.get('session')) ?? '') : '' });
  });

  route('/api/node-model', async (req, res) => {
    const body = await readJson(req);
    const store = storeFor(body.session);
    const stored = await store.loadDefinition();
    if (!stored) return sendJson(res, 409, { error: { code: 'no_workflow', message: 'no workflow defined' } });
    const nodeId = requireText(body.nodeId, 'nodeId');
    const node = stored.definition.nodes.find(candidate => candidate.id === nodeId);
    if (!node) return sendJson(res, 404, { error: { code: 'no_node', message: `unknown node ${nodeId}` } });
    if (node.type !== 'agent') {
      return sendJson(res, 400, { error: { code: 'not_model_node', message: `node ${nodeId} does not use a model` } });
    }
    const provider = optionalText(body.provider);
    const model = optionalText(body.model);
    const models = readModels(body.models);
    if (models === null && (provider === null) !== (model === null)) {
      return sendJson(res, 400, { error: { code: 'invalid_model', message: 'provider and model must be set or cleared together' } });
    }
    let definition;
    try {
      definition = normalizeDefinition({
        ...stored.definition,
        nodes: stored.definition.nodes.map(candidate => {
          if (candidate.id !== nodeId) return candidate;
          return { ...candidate, config: updatedModelConfig(candidate.config, { models, provider, model }) };
        }),
      });
    } catch (error) {
      return sendJson(res, 400, { error: { code: error.code ?? 'invalid_definition', message: error.message } });
    }
    await store.saveDefinition({ definition, permissions: stored.permissions });
    let state = await loadState(store, body.runId);
    if (state) {
      const target = state.definition.nodes.find(candidate => candidate.id === nodeId);
      if (target) {
        target.config = updatedModelConfig(target.config, { models, provider, model });
        await store.saveRun(state);
      }
    }
    sendJson(res, 200, { ...panelState({ definition, permissions: stored.permissions }, state), models: await readModelCatalog(ctx, definition) });
  });

  route('/api/start', async (req, res) => {    const body = await readJson(req);
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
      logger.warn?.(`dsh-agent-team-workflow: board run failed: ${error.message}`);
    }
    await store.saveRun(state);
    sendJson(res, 200, panelState(stored, state));
  });

  // Token-protected loopback routes for the native Browser sidebar tab. They
  // intentionally skip the DSH Connection fence so a different localhost origin
  // (required by the Browser tab) can load the board.
  routePublic('/public/board', async (req, res) => {
    const url = authorizePublic(req);
    storeFor(url.searchParams.get('session'));
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    res.end(BOARD_HTML);
  });

  routePublic('/public/api/state', async (req, res) => {
    const url = authorizePublic(req);
    const session = url.searchParams.get('session');
    const store = storeFor(session);
    const stored = await store.loadDefinition();
    const state = await loadState(store, url.searchParams.get('runId'));
    sendJson(res, 200, panelState(stored, state));
  });

  routePublic('/public/api/start', async (req, res) => {
    authorizePublic(req);
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

  routePublic('/public/api/decide', async (req, res) => {
    authorizePublic(req);
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

  routePublic('/public/api/run', async (req, res) => {
    authorizePublic(req);
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
      logger.warn?.(`dsh-agent-team-workflow: public board run failed: ${error.message}`);
    }
    await store.saveRun(state);
    sendJson(res, 200, panelState(stored, state));
  });

  let attached = false;
  const closeBoardServer = () => {
    const server = boardServer;
    boardServer = null;
    boardBase = '';
    resolveBoardReady(null);
    if (server) server.close();
  };
  const startBoardServer = () => {
    if (boardServer) return;
    const server = createServer((req, res) => {
      const pathname = new URL(req.url ?? '/', 'http://local').pathname;
      const handler = publicRoutes.get(pathname);
      if (!handler) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        res.end('not found');
        return;
      }
      Promise.resolve(handler(req, res)).catch(error => {
        logger.warn?.(`dsh-agent-team-workflow: board server failed: ${error?.message ?? error}`);
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
          res.end('board server error');
        } else {
          res.destroy?.();
        }
      });
    });
    server.on('error', error => {
      logger.warn?.(`dsh-agent-team-workflow: board server unavailable: ${error?.message ?? error}`);
      resolveBoardReady(null);
    });
    server.listen(Number(settings.boardPort ?? 0), '127.0.0.1', () => {
      const address = server.address();
      if (address && typeof address === 'object') {
        boardBase = `http://127.0.0.1:${address.port}`;
        resolveBoardReady(boardBase);
      } else {
        resolveBoardReady(null);
      }
    });
    server.unref?.();
    boardServer = server;
  };
  if (typeof ctx.effect === 'function') ctx.effect(() => {
    startBoardServer();
    return closeBoardServer;
  }, 'dsh-agent-team-workflow: board server');
  else startBoardServer();

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

  return { routes, publicRoutes, attach, boardUrl, boardReady, closeBoardServer, publicToken };
}

async function readModelCatalog(ctx, definition) {
  const providers = new Map();
  const addProvider = (id, name) => {
    if (typeof id !== 'string' || id === '') return null;
    if (!providers.has(id)) providers.set(id, { id, name: typeof name === 'string' && name !== '' ? name : id, models: [] });
    return providers.get(id);
  };
  const addModel = (provider, model) => {
    if (!model || typeof model.id !== 'string' || model.id === '') return;
    if (provider.models.some(existing => existing.id === model.id)) return;
    provider.models.push({
      id: model.id,
      name: typeof model.name === 'string' && model.name !== '' ? model.name : model.id,
      ...(typeof model.description === 'string' ? { description: model.description } : {}),
    });
  };

  const llm = ctx.get?.('llm');
  if (llm && typeof llm.listProviders === 'function') {
    try {
      const list = await llm.listProviders();
      for (const entry of Array.isArray(list) ? list : []) {
        const provider = addProvider(entry.id, entry.name);
        if (!provider || typeof llm.listModels !== 'function') continue;
        const models = await Promise.resolve(llm.listModels(entry.id)).catch(() => []);
        for (const model of Array.isArray(models) ? models : []) addModel(provider, model);
      }
    } catch {
      // The catalog is advisory; the definition's lanes below still provide fallback entries.
    }
  }
  for (const lane of definition?.providers ?? []) {
    if (typeof lane.adapter !== 'string' || lane.adapter === '') continue;
    const provider = addProvider(lane.adapter, lane.adapter);
    if (provider && typeof lane.model === 'string' && lane.model !== '' && lane.model !== 'host-default') {
      addModel(provider, { id: lane.model, name: lane.model });
    }
  }

  let defaultSelection = null;
  try {
    defaultSelection = ctx.get?.('agentDefaultModel')?.currentSelection?.() ?? null;
  } catch {
    // A host without a default selection still shows the discovered list.
  }
  return { providers: [...providers.values()], default: defaultSelection };
}

function optionalText(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw Object.assign(new Error('model fields must be strings'), { code: 'invalid_model' });
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function readModels(value) {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) throw Object.assign(new Error('models must be an array'), { code: 'invalid_model' });
  if (value.length > 8) throw Object.assign(new Error('models must contain at most 8 entries'), { code: 'invalid_model' });
  return value.map((entry, index) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw Object.assign(new Error(`models[${index}] must be an object`), { code: 'invalid_model' });
    }
    const provider = optionalText(entry.provider);
    const model = optionalText(entry.model);
    if (provider === null || model === null) {
      throw Object.assign(new Error(`models[${index}] needs provider and model`), { code: 'invalid_model' });
    }
    return { provider, model };
  });
}

function updatedModelConfig(config, { models, provider, model }) {
  const next = { ...config };
  if (models !== null) {
    delete next.provider;
    delete next.model;
    if (models.length === 0) delete next.models;
    else next.models = models;
    return next;
  }
  delete next.models;
  if (provider === null) {
    delete next.provider;
    delete next.model;
  } else {
    next.provider = provider;
    next.model = model;
  }
  return next;
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
