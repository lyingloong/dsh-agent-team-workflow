/**
 * Event types and their SQLite projections.
 *
 * Events are the only write path: a coordinator appends an event, and the
 * projection tables are derived from it. Rebuilding drops every projection and
 * replays the log, which is how crash recovery proves the same state.
 *
 * Unknown event types are ignored on purpose so that an older reader can open a
 * database written by a newer engine without corrupting the projections it does
 * understand.
 */

/** Apply one persisted event row to the projection tables. */
export function applyEvent(db, event) {
  const payload = event.payload ?? {};
  const at = event.created_at ?? event.createdAt ?? new Date().toISOString();
  switch (event.type) {
    case 'workflow.defined':
      db.prepare(`
        INSERT INTO workflows (id, name, version, definition_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          version = excluded.version,
          definition_json = excluded.definition_json,
          updated_at = excluded.updated_at
      `).run(
        payload.workflowId ?? 'default',
        String(payload.name ?? event.workflow_id ?? 'workflow'),
        Number(payload.definition?.apiVersion ?? 1),
        JSON.stringify(payload.definition ?? {}),
        at,
        at,
      );
      return;
    case 'provider.health':
      db.prepare(`
        INSERT INTO providers (id, model, health, blocked_until, reason, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          model = COALESCE(excluded.model, providers.model),
          health = excluded.health,
          blocked_until = excluded.blocked_until,
          reason = excluded.reason,
          updated_at = excluded.updated_at
      `).run(
        payload.providerId,
        payload.model ?? null,
        payload.health ?? 'ok',
        payload.blockedUntil ?? null,
        payload.reason ?? null,
        at,
      );
      return;
    case 'slot.observed':
      db.prepare(`
        INSERT INTO slots (id, role, provider, member, status, task_id, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          role = excluded.role,
          provider = excluded.provider,
          member = excluded.member,
          status = excluded.status,
          task_id = excluded.task_id,
          updated_at = excluded.updated_at
      `).run(
        payload.slotId,
        payload.role,
        payload.provider ?? null,
        payload.member ?? null,
        payload.status ?? 'idle',
        payload.taskId ?? null,
        at,
      );
      return;
    case 'item.created':
      db.prepare(`
        INSERT INTO items (id, workflow_id, kind, title, stage, status, priority, data_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          title = excluded.title,
          stage = excluded.stage,
          status = excluded.status,
          priority = excluded.priority,
          data_json = excluded.data_json,
          updated_at = excluded.updated_at
      `).run(
        payload.itemId,
        event.workflow_id ?? payload.workflowId ?? 'default',
        payload.kind ?? 'item',
        payload.title ?? '',
        payload.stage ?? '',
        payload.status ?? 'inbox',
        Number(payload.priority ?? 0),
        JSON.stringify(payload.data ?? {}),
        at,
        at,
      );
      return;
    case 'item.moved':
      db.prepare(`
        UPDATE items SET stage = COALESCE(?, stage), status = COALESCE(?, status), updated_at = ?
        WHERE id = ?
      `).run(payload.stage ?? null, payload.status ?? null, at, payload.itemId);
      return;
    case 'task.created':
      db.prepare(`
        INSERT INTO tasks (
          id, item_id, workflow_id, stage, role, status, priority, provider,
          assignee, attempt_id, dependencies_json, contract_json, result_json,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          stage = excluded.stage,
          role = excluded.role,
          priority = excluded.priority,
          dependencies_json = excluded.dependencies_json,
          contract_json = excluded.contract_json,
          updated_at = excluded.updated_at
      `).run(
        payload.taskId,
        payload.itemId,
        event.workflow_id ?? payload.workflowId ?? 'default',
        payload.stage,
        payload.role,
        payload.status ?? 'pending',
        Number(payload.priority ?? 0),
        payload.provider ?? null,
        payload.assignee ?? null,
        payload.attemptId ?? null,
        JSON.stringify(payload.dependencies ?? []),
        JSON.stringify(payload.contract ?? {}),
        null,
        at,
        at,
      );
      return;
    case 'task.updated':
      db.prepare(`
        UPDATE tasks SET
          status = COALESCE(?, status),
          provider = COALESCE(?, provider),
          assignee = COALESCE(?, assignee),
          attempt_id = COALESCE(?, attempt_id),
          available_at = COALESCE(?, available_at),
          result_json = COALESCE(?, result_json),
          updated_at = ?
        WHERE id = ?
      `).run(
        payload.status ?? null,
        payload.provider ?? null,
        payload.assignee ?? null,
        payload.attemptId ?? null,
        payload.availableAt ?? null,
        payload.result === undefined ? null : JSON.stringify(payload.result),
        at,
        payload.taskId,
      );
      return;
    case 'attempt.started':
      db.prepare(`
        INSERT INTO attempts (id, task_id, member, provider, status, started_at, ended_at, error, expires_at)
        VALUES (?, ?, ?, ?, 'running', ?, NULL, NULL, ?)
        ON CONFLICT(id) DO UPDATE SET
          member = excluded.member,
          provider = excluded.provider,
          status = 'running',
          started_at = excluded.started_at,
          ended_at = NULL,
          error = NULL,
          expires_at = excluded.expires_at
      `).run(
        payload.attemptId,
        payload.taskId,
        payload.member ?? null,
        payload.provider ?? null,
        payload.startedAt ?? at,
        payload.expiresAt ?? null,
      );
      return;
    case 'attempt.ended':
      db.prepare(`
        UPDATE attempts SET status = ?, ended_at = ?, error = ? WHERE id = ?
      `).run(payload.status ?? 'unknown', payload.endedAt ?? at, payload.error ?? null, payload.attemptId);
      return;
    case 'review.submitted':
      db.prepare(`
        INSERT INTO reviews (id, task_id, verdict, findings_json, evidence_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          verdict = excluded.verdict,
          findings_json = excluded.findings_json,
          evidence_json = excluded.evidence_json
      `).run(
        payload.reviewId,
        payload.taskId,
        payload.verdict ?? 'pass',
        JSON.stringify(payload.findings ?? []),
        JSON.stringify(payload.evidence ?? {}),
        at,
      );
      return;
    case 'gate.observed': {
      const gateId = `${payload.itemId}:${payload.gate}`;
      db.prepare(`
        INSERT INTO gates (id, item_id, gate, status, signal_json, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          status = excluded.status,
          signal_json = excluded.signal_json,
          updated_at = excluded.updated_at
      `).run(
        gateId,
        payload.itemId,
        payload.gate,
        payload.status ?? 'pending',
        JSON.stringify(payload.signal ?? {}),
        at,
      );
      return;
    }
    default:
      return;
  }
}

/** Tables cleared by a rebuild, in no particular order (no foreign keys). */
export const PROJECTION_TABLES = [
  'workflows', 'items', 'tasks', 'attempts', 'reviews', 'gates', 'providers', 'slots',
];
