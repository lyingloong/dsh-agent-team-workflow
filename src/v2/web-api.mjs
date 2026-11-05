/**
 * v2 Web API for the node/run board.
 *
 * Routes are session-scoped and share the tools' execution owner and JSON store.
 * Run requests dispatch managed jobs; polling reads their persisted checkpoints.
 * Board mutations cannot overwrite an active run's state.
 */

import path from 'node:path';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { normalizeDefinition } from './definition.mjs';
import { SessionStore } from './store.mjs';
import { DEFAULT_PERMISSIONS, decide, newRunState } from './runtime.mjs';
import { panelState } from './view.mjs';
import { WorkflowRunner, executionCwd, preflightRun } from './runner.mjs';

export const ROUTE_PREFIX = '/plugins/dsh-agent-team-workflow';
const MAX_BODY_BYTES = 64 * 1024;
const SESSION_PATTERN = /^[A-Za-z0-9._-]{1,200}$/;
const BOARD_HTML = readFileSync(new URL('./board.html', import.meta.url), 'utf8');

export function installWebApi({ ctx, dataRoot, agents = new Map(), settings = {}, logger = console, runner = null }) {
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
  const ownsRunner = runner === null;
  runner ??= new WorkflowRunner({ ctx, storeFor, agents, settings: { subagentProvider: 'spawn', ...settings }, logger });

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

  const readQueue = async state => {
    const cwd = state?.cwd;
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return null;
    const base = path.join(cwd, 'requirements');
    const read = async name => {
      try { return JSON.parse(await readFile(path.join(base, name), 'utf8')); } catch { return null; }
    };
    const requirements = await read('requirements.json');
    const seeds = await read('seeds.json');
    const list = Array.isArray(requirements) ? requirements : [];
    const seedList = Array.isArray(seeds) ? seeds : [];
    const queued = list.filter(item => item?.status === 'queued');
    return {
      path: base,
      total: list.length,
      queued: queued.length,
      items: queued.slice(0, 8).map(item => ({
        id: item.id ?? '',
        title: item.title ?? item.id ?? '',
        source: item.source ?? '',
        priority: item.priority ?? null,
        tags: Array.isArray(item.tags) ? item.tags : [],
      })),
      seedsReady: seedList.filter(item => item?.status === 'ready').length,
    };
  };

  const apiError = (status, code, message) => Object.assign(new Error(message), { status, code });
  const requestSession = (url, body = null) => {
    const query = url.searchParams.get('session');
    if (query !== null && body?.session !== undefined && query !== body.session) {
      throw apiError(400, 'invalid_session', 'body.session and query.session must match');
    }
    const session = body?.session ?? query;
    storeFor(session);
    return session;
  };
  const requestBody = async req => {
    if (req.method !== 'POST') throw apiError(405, 'method_not_allowed', 'this operation requires POST');
    const body = await readJson(req);
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      throw apiError(400, 'invalid_json', 'request body must be a JSON object');
    }
    return body;
  };
  const requireWorkflow = async store => {
    const stored = await store.loadDefinition();
    if (!stored) throw apiError(409, 'no_workflow', 'no workflow defined');
    return stored;
  };
  const changeModel = async (req, res, url) => {
    const body = await requestBody(req);
    const session = requestSession(url, body);
    const { definition, permissions, state } = await runner.mutate(session, async () => {
      const store = storeFor(session);
      const stored = await requireWorkflow(store);
      const nodeId = requireText(body.nodeId, 'nodeId');
      const node = stored.definition.nodes.find(candidate => candidate.id === nodeId);
      if (!node) throw apiError(404, 'no_node', `unknown node ${nodeId}`);
      if (node.type !== 'agent') throw apiError(400, 'not_model_node', `node ${nodeId} does not use a model`);
      const provider = optionalText(body.provider);
      const model = optionalText(body.model);
      const models = readModels(body.models);
      if (models === null && (provider === null) !== (model === null)) {
        throw apiError(400, 'invalid_model', 'provider and model must be set or cleared together');
      }
      const definition = normalizeDefinition({
        ...stored.definition,
        nodes: stored.definition.nodes.map(candidate => candidate.id !== nodeId ? candidate : {
          ...candidate, config: updatedModelConfig(candidate.config, { models, provider, model }),
        }),
      });
      const state = await loadState(store, body.runId);
      if (state) {
        const target = state.definition.nodes.find(candidate => candidate.id === nodeId);
        if (target) target.config = updatedModelConfig(target.config, { models, provider, model });
      }
      await store.saveDefinition({ definition, permissions: stored.permissions });
      if (state) await store.saveRun(state);
      return { definition, permissions: stored.permissions, state };
    });
    sendJson(res, 200, { ...panelState({ definition, permissions }, state), models: await readModelCatalog(ctx, definition) });
  };
  const startRun = async (req, res, url) => {
    const body = await requestBody(req);
    const session = requestSession(url, body);
    const result = await runner.mutate(session, async () => {
      const store = storeFor(session);
      const stored = await requireWorkflow(store);
      const previous = await store.latestRun();
      if (previous && !['done', 'failed', 'interrupted'].includes(previous.status)) {
        throw apiError(409, 'unfinished_run', 'An unfinished run already exists. Continue or inspect it instead of creating a duplicate.');
      }
      const exec = body.cwd === undefined || body.cwd === null ? { agent: runner.parent(session) } : {};
      const cwd = await executionCwd(ctx, exec, body.cwd);
      const state = newRunState({
        definition: stored.definition,
        permissions: stored.permissions ?? DEFAULT_PERMISSIONS,
        input: body.input !== null && typeof body.input === 'object' ? body.input : {},
        cwd,
      });
      await preflightRun(state);
      await store.saveRun(state);
      return panelState(stored, state);
    });
    sendJson(res, 201, result);
  };
  const decideRun = async (req, res, url) => {
    const body = await requestBody(req);
    const session = requestSession(url, body);
    const result = await runner.mutate(session, async () => {
      const store = storeFor(session);
      const stored = await requireWorkflow(store);
      const state = await runner.load(session, body.runId);
      decide(state, { tokenId: requireText(body.tokenId, 'tokenId'), outcome: requireText(body.outcome, 'outcome'), output: body.output ?? null });
      await store.saveRun(state);
      return panelState(stored, state);
    });
    sendJson(res, 200, result);
  };
  const dispatchRun = async (req, res, url) => {
    const body = await requestBody(req);
    const session = requestSession(url, body);
    const stored = await requireWorkflow(storeFor(session));
    const state = await runner.dispatch(session, body.runId);
    sendJson(res, state.execution?.active ? 202 : 200, { ...panelState(stored, state), execution: state.execution ?? null });
  };
  const stopRun = async (req, res, url) => {
    const body = await requestBody(req);
    const session = requestSession(url, body);
    const result = await runner.stop(session);
    sendJson(res, result.requested ? 202 : 200, result);
  };
  const changeControl = async (req, res, url) => {
    if (req.method === 'GET') {
      const store = storeFor(requestSession(url));
      return sendJson(res, 200, { control: await store.loadControl() });
    }
    const body = await requestBody(req);
    const store = storeFor(requestSession(url, body));
    const control = await store.saveControl({ continuous: body.continuous !== false });
    sendJson(res, 200, { control });
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
    sendJson(res, 200, { ...panelState(stored, state), control: await store.loadControl(), queue: await readQueue(state) });
  });

  route('/api/control', (req, res) => changeControl(req, res, new URL(req.url ?? '/', 'http://local')));

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

  route('/api/node-model', (req, res) => changeModel(req, res, new URL(req.url ?? '/', 'http://local')));

  routePublic('/public/api/models', async (req, res) => {
    const url = authorizePublic(req);
    const store = storeFor(url.searchParams.get('session'));
    const stored = await store.loadDefinition();
    sendJson(res, 200, await readModelCatalog(ctx, stored?.definition));
  });

  routePublic('/public/api/node-model', (req, res) => changeModel(req, res, authorizePublic(req)));

  route('/api/start', (req, res) => startRun(req, res, new URL(req.url ?? '/', 'http://local')));
  route('/api/decide', (req, res) => decideRun(req, res, new URL(req.url ?? '/', 'http://local')));
  route('/api/run', (req, res) => dispatchRun(req, res, new URL(req.url ?? '/', 'http://local')));
  route('/api/stop', (req, res) => stopRun(req, res, new URL(req.url ?? '/', 'http://local')));

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
    sendJson(res, 200, { ...panelState(stored, state), control: await store.loadControl(), queue: await readQueue(state) });
  });

  routePublic('/public/api/control', (req, res) => changeControl(req, res, authorizePublic(req)));

  routePublic('/public/api/start', (req, res) => startRun(req, res, authorizePublic(req)));
  routePublic('/public/api/decide', (req, res) => decideRun(req, res, authorizePublic(req)));
  routePublic('/public/api/run', (req, res) => dispatchRun(req, res, authorizePublic(req)));
  routePublic('/public/api/stop', (req, res) => stopRun(req, res, authorizePublic(req)));

  let attached = false;
  const closeBoardServer = async () => {
    const server = boardServer;
    boardServer = null;
    boardBase = '';
    resolveBoardReady(null);
    if (server) server.close();
    if (ownsRunner) await runner.dispose();
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

  return { routes, publicRoutes, attach, boardUrl, boardReady, closeBoardServer, publicToken, runner };
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
