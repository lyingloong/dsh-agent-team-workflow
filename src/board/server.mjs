/**
 * Local kanban board over the event store.
 *
 * The server binds to loopback by default and exposes four things: the board
 * page, a read-only board projection, gate decisions, and enqueue. It never
 * merges, closes or pushes anything; those actions do not exist in the engine.
 */

import http from 'node:http';
import { existsSync, readFileSync } from 'node:fs';

import { DefinitionError, normalizeDefinition } from '../definition.mjs';
import { Engine, EngineError } from '../engine.mjs';
import { Store } from '../store.mjs';
import { dataPaths } from '../paths.mjs';
import { buildBoardData } from './data.mjs';

const BOARD_HTML = readFileSync(new URL('./board.html', import.meta.url), 'utf8');
const MAX_BODY_BYTES = 64 * 1024;

/**
 * Start the board. Returns synchronously with `{server, ready, close}`;
 * await `ready` for the URL, then `close()` to release the port and the store.
 */
export function startBoardServer({ dataDir, host = '127.0.0.1', port = 7171, clock = () => new Date(), leaseMs } = {}) {
  const paths = dataPaths(dataDir);
  if (!existsSync(paths.dbPath)) {
    throw new Error(`no workflow defined in ${paths.dataDir}; run: agent-team-workflow define <workflow.json>`);
  }
  const store = Store.open(paths.dbPath, { clock });
  const snapshot = store.snapshot();
  if (!snapshot.workflow) {
    store.close();
    throw new Error(`no workflow defined in ${paths.dataDir}; run: agent-team-workflow define <workflow.json>`);
  }
  const definition = normalizeDefinition(snapshot.workflow.definition);
  const engine = new Engine({
    store,
    definition,
    workflowId: snapshot.workflow.id,
    clock,
    ...(leaseMs === undefined ? {} : { leaseMs }),
  });

  let closed = false;
  const server = http.createServer((request, response) => {
    handle(request, response).catch(error => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      respondError(response, error);
    });
  });
  const ready = new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const address = server.address();
      const shownHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
      resolve(`http://${shownHost}:${address.port}/`);
    });
  });
  // Leases are wall-clock facts. Reaping them keeps a crashed worker from
  // holding a slot until someone remembers to run the CLI.
  const reaper = setInterval(() => {
    try {
      engine.expireLeases();
    } catch {
      // A transient write failure is retried on the next interval.
    }
  }, 60_000);
  reaper.unref?.();

  async function handle(request, response) {
    const url = new URL(request.url ?? '/', 'http://board.local');
    if (request.method === 'GET' && url.pathname === '/') {
      send(response, 200, 'text/html; charset=utf-8', BOARD_HTML);
      return;
    }
    if (request.method === 'GET' && url.pathname === '/favicon.ico') {
      response.writeHead(204).end();
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/board') {
      sendJson(response, 200, buildBoardData({
        snapshot: store.snapshot(),
        definition,
        now: clock().toISOString(),
      }));
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/health') {
      sendJson(response, 200, { ok: true, workflow: definition.name });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/gate') {
      const body = await readJson(request);
      const result = engine.decideGate({
        itemId: body.itemId,
        gate: body.gate,
        decision: body.decision,
        by: body.by ?? 'board',
        note: body.note ?? '',
      });
      sendJson(response, 200, result);
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/enqueue') {
      const body = await readJson(request);
      const result = engine.enqueue({
        title: body.title,
        kind: body.kind ?? 'item',
        data: body.input ?? {},
        priority: Number(body.priority ?? 0),
      });
      sendJson(response, 201, result);
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/expire') {
      sendJson(response, 200, { expired: engine.expireLeases() });
      return;
    }
    sendJson(response, 404, { error: { code: 'not_found', message: `no route ${request.method} ${url.pathname}` } });
  }

  const close = () => new Promise(resolve => {
    if (closed) {
      resolve();
      return;
    }
    closed = true;
    clearInterval(reaper);
    server.closeAllConnections?.();
    server.close(() => {
      try {
        store.close();
      } finally {
        resolve();
      }
    });
  });

  return { server, engine, store, ready, close };
}

function send(response, status, contentType, body) {
  response.writeHead(status, {
    'content-type': contentType,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(body);
}

function sendJson(response, status, value) {
  send(response, status, 'application/json; charset=utf-8', JSON.stringify(value));
}

function respondError(response, error) {
  const known = error instanceof EngineError || error instanceof DefinitionError;
  const code = error?.code ?? 'internal';
  sendJson(response, known ? 400 : 500, {
    error: {
      code,
      message: error?.message ?? 'internal error',
      ...(error?.nextAction ? { nextAction: error.nextAction } : {}),
    },
  });
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(httpError('payload_too_large', `request body exceeds ${MAX_BODY_BYTES} bytes`));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (text.trim() === '') {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(httpError('invalid_json', 'request body is not valid JSON'));
      }
    });
    request.on('error', reject);
  });
}

function httpError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
