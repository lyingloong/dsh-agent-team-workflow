/**
 * Append-only event store with SQLite projections.
 *
 * Every mutation is an event. `append()` writes the event and updates the
 * projections in one transaction; `rebuild()` drops the projections and replays
 * the log. Callers never write projection tables directly.
 */

import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import { applyEvent, PROJECTION_TABLES } from './projections.mjs';

const MIGRATIONS = [
  `
  CREATE TABLE workflows (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    version INTEGER NOT NULL,
    definition_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    type TEXT NOT NULL,
    entity TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    workflow_id TEXT,
    request_id TEXT UNIQUE,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_events_type ON events(type);
  CREATE INDEX idx_events_entity ON events(entity, entity_id);

  CREATE TABLE items (
    id TEXT PRIMARY KEY,
    workflow_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    stage TEXT NOT NULL,
    status TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 0,
    data_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX idx_items_stage ON items(stage, status);

  CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    item_id TEXT NOT NULL,
    workflow_id TEXT NOT NULL,
    stage TEXT NOT NULL,
    role TEXT NOT NULL,
    status TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 0,
    provider TEXT,
    assignee TEXT,
    attempt_id TEXT,
    dependencies_json TEXT NOT NULL DEFAULT '[]',
    contract_json TEXT NOT NULL DEFAULT '{}',
    result_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX idx_tasks_status ON tasks(status, role);
  CREATE INDEX idx_tasks_item ON tasks(item_id);

  CREATE TABLE attempts (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    member TEXT,
    provider TEXT,
    status TEXT NOT NULL,
    started_at TEXT,
    ended_at TEXT,
    error TEXT
  );
  CREATE INDEX idx_attempts_task ON attempts(task_id);

  CREATE TABLE reviews (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    verdict TEXT NOT NULL,
    findings_json TEXT NOT NULL DEFAULT '[]',
    evidence_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  );

  CREATE TABLE gates (
    id TEXT PRIMARY KEY,
    item_id TEXT NOT NULL,
    gate TEXT NOT NULL,
    status TEXT NOT NULL,
    signal_json TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL
  );

  CREATE TABLE providers (
    id TEXT PRIMARY KEY,
    model TEXT,
    health TEXT NOT NULL DEFAULT 'ok',
    blocked_until TEXT,
    reason TEXT,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE slots (
    id TEXT PRIMARY KEY,
    role TEXT NOT NULL,
    provider TEXT,
    member TEXT,
    status TEXT NOT NULL DEFAULT 'idle',
    task_id TEXT,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  `
  ALTER TABLE tasks ADD COLUMN available_at TEXT;
  ALTER TABLE attempts ADD COLUMN expires_at TEXT;
  `,
];

export class Store {
  constructor(db, { clock = () => new Date() } = {}) {
    this.db = db;
    this.clock = clock;
    this.closed = false;
  }

  static open(dbPath, { clock } = {}) {
    const absolute = path.resolve(dbPath);
    mkdirSync(path.dirname(absolute), { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(absolute);
    try {
      db.exec('PRAGMA busy_timeout = 5000');
      db.exec('PRAGMA journal_mode = WAL');
    } catch {
      // Some filesystems and in-memory databases reject WAL; the store still works
      // with the default journal mode.
    }
    const store = new Store(db, { clock });
    store.migrate();
    return store;
  }

  migrate() {
    const current = Number(this.db.prepare('PRAGMA user_version').get().user_version);
    if (current > MIGRATIONS.length) {
      throw new Error(`database schema ${current} is newer than this engine (${MIGRATIONS.length}); upgrade agent-team-workflow`);
    }
    for (let version = current; version < MIGRATIONS.length; version += 1) {
      this.transaction(() => {
        this.db.exec(MIGRATIONS[version]);
        this.db.exec(`PRAGMA user_version = ${version + 1}`);
      });
    }
  }

  get schemaVersion() {
    return Number(this.db.prepare('PRAGMA user_version').get().user_version);
  }

  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // The transaction may already be gone; preserve the original error.
      }
      throw error;
    }
  }

  /**
   * Append one event. With `requestId`, the call is idempotent: a retry returns
   * the original sequence number instead of appending twice.
   */
  append(event, { requestId = null } = {}) {
    const result = this.appendMany([event], { requestId });
    if (result.deduped) return result;
    return { deduped: false, seq: result.seq, event: result.events[0].event };
  }

  /** Append several events atomically. */
  appendMany(events, options = {}) {
    return this.transaction(() => this.appendManyInTransaction(events, options));
  }

  /**
   * Append several events inside a transaction the caller already holds.
   * Used by `claim`, whose capacity check, task selection and write must not be
   * interleaved with another worker's claim.
   */
  appendManyInTransaction(events, { requestId = null } = {}) {
    if (!Array.isArray(events) || events.length === 0) {
      throw new TypeError('appendMany requires at least one event');
    }
    const prepared = events.map(event => this.prepareEvent(event));
    if (requestId) {
      const existing = this.db
        .prepare('SELECT * FROM events WHERE request_id = ?')
        .get(requestId);
      if (existing) return { deduped: true, seq: Number(existing.seq), event: decodeEvent(existing) };
    }
    const results = [];
    for (const [index, event] of prepared.entries()) {
      const info = this.db.prepare(`
        INSERT INTO events (id, type, entity, entity_id, workflow_id, request_id, payload_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        event.id,
        event.type,
        event.entity,
        event.entityId,
        event.workflowId,
        index === 0 ? requestId : null,
        JSON.stringify(event.payload),
        event.createdAt,
      );
      applyEvent(this.db, {
        seq: Number(info.lastInsertRowid),
        id: event.id,
        type: event.type,
        entity: event.entity,
        entity_id: event.entityId,
        workflow_id: event.workflowId,
        payload: event.payload,
        created_at: event.createdAt,
      });
      results.push({ seq: Number(info.lastInsertRowid), event });
    }
    return { deduped: false, events: results, seq: results[0].seq };
  }

  prepareEvent(event) {
    if (!event || typeof event !== 'object') throw new TypeError('event must be an object');
    if (typeof event.type !== 'string' || event.type.trim() === '') {
      throw new TypeError('event.type must be a non-empty string');
    }
    if (typeof event.entity !== 'string' || event.entity.trim() === '') {
      throw new TypeError('event.entity must be a non-empty string');
    }
    if (typeof event.entityId !== 'string' || event.entityId.trim() === '') {
      throw new TypeError('event.entityId must be a non-empty string');
    }
    const payload = event.payload ?? {};
    if (typeof payload !== 'object' || Array.isArray(payload)) {
      throw new TypeError('event.payload must be an object');
    }
    return {
      id: event.id ?? randomUUID(),
      type: event.type,
      entity: event.entity,
      entityId: event.entityId,
      workflowId: event.workflowId ?? null,
      payload,
      createdAt: event.createdAt ?? this.clock().toISOString(),
    };
  }

  /** Drop every projection and replay the complete log. Returns the event count. */
  rebuild() {
    return this.transaction(() => {
      for (const table of PROJECTION_TABLES) this.db.exec(`DELETE FROM ${table}`);
      const rows = this.db.prepare('SELECT * FROM events ORDER BY seq').all();
      for (const row of rows) applyEvent(this.db, decodeEvent(row));
      return rows.length;
    });
  }

  /** Read events in append order. */
  events({ after = 0, limit = 1000 } = {}) {
    return this.db
      .prepare('SELECT * FROM events WHERE seq > ? ORDER BY seq LIMIT ?')
      .all(after, limit)
      .map(decodeEvent);
  }

  /** Find the event that consumed a request id, or null. */
  findEventByRequestId(requestId) {
    const row = this.db.prepare('SELECT * FROM events WHERE request_id = ?').get(requestId);
    return row ? decodeEvent(row) : null;
  }

  /** Current projected state, decoded into plain objects. */
  snapshot() {
    const workflowRow = this.db
      .prepare('SELECT * FROM workflows ORDER BY updated_at DESC LIMIT 1')
      .get();
    return {
      workflow: workflowRow
        ? {
            id: workflowRow.id,
            name: workflowRow.name,
            version: workflowRow.version,
            definition: parseJson(workflowRow.definition_json, null),
            createdAt: workflowRow.created_at,
            updatedAt: workflowRow.updated_at,
          }
        : null,
      items: this.db.prepare('SELECT * FROM items ORDER BY created_at, id').all().map(row => ({
        id: row.id,
        workflowId: row.workflow_id,
        kind: row.kind,
        title: row.title,
        stage: row.stage,
        status: row.status,
        priority: row.priority,
        data: parseJson(row.data_json, {}),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })),
      tasks: this.db.prepare('SELECT * FROM tasks ORDER BY created_at, id').all().map(row => ({
        id: row.id,
        itemId: row.item_id,
        workflowId: row.workflow_id,
        stage: row.stage,
        role: row.role,
        status: row.status,
        priority: row.priority,
        provider: row.provider,
        assignee: row.assignee,
        attemptId: row.attempt_id,
        dependencies: parseJson(row.dependencies_json, []),
        contract: parseJson(row.contract_json, {}),
        result: row.result_json === null ? null : parseJson(row.result_json, null),
        availableAt: row.available_at ?? null,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })),
      attempts: this.db.prepare('SELECT * FROM attempts ORDER BY started_at, id').all().map(row => ({
        id: row.id,
        taskId: row.task_id,
        member: row.member,
        provider: row.provider,
        status: row.status,
        startedAt: row.started_at,
        endedAt: row.ended_at,
        error: row.error,
        expiresAt: row.expires_at ?? null,
      })),
      reviews: this.db.prepare('SELECT * FROM reviews ORDER BY created_at, id').all().map(row => ({
        id: row.id,
        taskId: row.task_id,
        verdict: row.verdict,
        findings: parseJson(row.findings_json, []),
        evidence: parseJson(row.evidence_json, {}),
        createdAt: row.created_at,
      })),
      gates: this.db.prepare('SELECT * FROM gates ORDER BY id').all().map(row => ({
        id: row.id,
        itemId: row.item_id,
        gate: row.gate,
        status: row.status,
        signal: parseJson(row.signal_json, {}),
        updatedAt: row.updated_at,
      })),
      providers: this.db.prepare('SELECT * FROM providers ORDER BY id').all().map(row => ({
        id: row.id,
        model: row.model,
        health: row.health,
        blockedUntil: row.blocked_until,
        reason: row.reason,
        updatedAt: row.updated_at,
      })),
      slots: this.db.prepare('SELECT * FROM slots ORDER BY id').all().map(row => ({
        id: row.id,
        role: row.role,
        provider: row.provider,
        member: row.member,
        status: row.status,
        taskId: row.task_id,
        updatedAt: row.updated_at,
      })),
    };
  }

  /** Event count, used by status output and recovery checks. */
  get eventCount() {
    return Number(this.db.prepare('SELECT COUNT(*) AS count FROM events').get().count);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}

function decodeEvent(row) {
  return {
    seq: Number(row.seq),
    id: row.id,
    type: row.type,
    entity: row.entity,
    entityId: row.entity_id,
    workflowId: row.workflow_id,
    payload: parseJson(row.payload_json, {}),
    createdAt: row.created_at,
  };
}

function parseJson(value, fallback) {
  if (value === null || value === undefined) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}
