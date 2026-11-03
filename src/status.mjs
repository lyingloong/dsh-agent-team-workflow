/**
 * Read-only status projections for the CLI and for host integrations.
 *
 * Status is derived from the projected snapshot, never from in-memory scheduler
 * state, so what a user sees after a restart matches what the engine will do.
 */

import { buildSlots } from './scheduler.mjs';

/** Build a transport-neutral status object. */
export function buildStatus({ snapshot, definition = null, lock = null, now = new Date().toISOString() }) {
  const resolvedDefinition = definition ?? snapshot.workflow?.definition ?? null;
  const slots = snapshot.slots.length > 0
    ? snapshot.slots
    : resolvedDefinition ? buildSlots(resolvedDefinition) : [];
  const activeTasks = snapshot.tasks.filter(task => task.status === 'claimed' || task.status === 'running');
  const busy = activeTasks.length;
  const tasksByStatus = countBy(snapshot.tasks, task => task.status);
  const itemsByStage = countBy(snapshot.items, item => item.stage);
  const itemsByStatus = countBy(snapshot.items, item => item.status);

  const providerIds = new Set([
    ...(resolvedDefinition?.providers ?? []).map(provider => provider.id),
    ...snapshot.providers.map(provider => provider.id),
  ]);
  const providers = [...providerIds].sort().map(id => {
    const declared = resolvedDefinition?.providers?.find(provider => provider.id === id);
    const state = snapshot.providers.find(provider => provider.id === id);
    const blockedUntil = state?.blockedUntil ?? null;
    const expired = state?.health === 'blocked' && blockedUntil !== null && Date.parse(blockedUntil) <= Date.parse(now);
    return {
      id,
      health: expired ? 'ok' : state?.health ?? 'ok',
      blockedUntil: expired ? null : blockedUntil,
      reason: expired ? null : state?.reason ?? null,
      concurrency: declared?.concurrency ?? null,
      model: declared?.model ?? state?.model ?? null,
      active: activeTasks.filter(task => task.provider === id).length,
    };
  });

  const roles = (resolvedDefinition?.roles ?? []).map(role => {
    const roleSlots = slots.filter(slot => slot.role === role.id);
    const roleBusy = activeTasks.filter(task => task.role === role.id).length;
    return {
      id: role.id,
      kind: role.kind,
      instances: role.instances,
      capacity: role.capacity,
      providers: role.providers,
      slots: roleSlots.length,
      busy: roleBusy,
      idle: Math.max(0, roleSlots.length - roleBusy),
    };
  });

  const pendingGates = snapshot.gates.filter(gate => gate.status === 'pending');
  const attention = [];
  for (const provider of providers) {
    if (provider.health !== 'ok') {
      attention.push(`${provider.id}: ${provider.health}${provider.reason ? ` (${provider.reason})` : ''}`);
    }
  }
  if (itemsByStatus.blocked) attention.push(`${itemsByStatus.blocked} item(s) blocked`);
  if (pendingGates.length > 0) {
    attention.push(`${pendingGates.length} gate(s) waiting for a decision: ${pendingGates.map(gate => `${gate.itemId}/${gate.gate}`).join(', ')}`);
  }
  for (const role of roles) {
    const ready = snapshot.tasks.filter(task => task.status === 'ready' && task.role === role.id).length;
    if (ready > role.idle) {
      attention.push(`${role.id}: ${ready} ready task(s), ${role.idle} idle slot(s)`);
    }
  }

  return {
    now,
    workflow: resolvedDefinition
      ? {
          name: resolvedDefinition.name,
          apiVersion: resolvedDefinition.apiVersion,
          entry: resolvedDefinition.entry,
          stages: resolvedDefinition.stages.length,
          gates: resolvedDefinition.gates.length,
        }
      : null,
    events: snapshot.eventCount ?? null,
    capacity: {
      global: resolvedDefinition?.policies.concurrency.global ?? null,
      slots: slots.length,
      busy,
      idle: Math.max(0, slots.length - busy),
    },
    items: {
      total: snapshot.items.length,
      byStage: itemsByStage,
      byStatus: itemsByStatus,
    },
    tasks: {
      total: snapshot.tasks.length,
      byStatus: tasksByStatus,
      ready: tasksByStatus.ready ?? 0,
      active: (tasksByStatus.claimed ?? 0) + (tasksByStatus.running ?? 0),
    },
    roles,
    providers,
    gates: {
      total: snapshot.gates.length,
      pending: pendingGates.length,
    },
    lock: lock
      ? { held: true, pid: lock.pid, host: lock.host, heartbeatAt: lock.heartbeatAt }
      : { held: false },
    attention,
  };
}

/** Human-readable status, used by `agent-team-workflow status`. */
export function formatStatus(status) {
  const lines = [];
  if (!status.workflow) {
    lines.push('agent-team-workflow: no workflow defined yet');
    lines.push('run: agent-team-workflow define <workflow.json>');
    return lines.join('\n');
  }
  lines.push(`agent-team-workflow ${status.workflow.name} (apiVersion ${status.workflow.apiVersion}, entry ${status.workflow.entry})`);
  lines.push(`events: ${status.events ?? '?'} | items: ${status.items.total} | tasks: ${status.tasks.total}`);
  lines.push(`slots: ${status.capacity.busy}/${status.capacity.slots} busy (global limit ${status.capacity.global})`);
  lines.push(`tasks: ${formatCounts(status.tasks.byStatus)}`);
  lines.push(`items: ${formatCounts(status.items.byStage)}`);
  if (status.providers.length > 0) {
    const providers = status.providers.map(provider => {
      const blocked = provider.health === 'blocked' && provider.blockedUntil ? ` until ${provider.blockedUntil}` : '';
      return `${provider.id} ${provider.health}${blocked}`;
    });
    lines.push(`providers: ${providers.join(', ')}`);
  }
  if (status.gates.total > 0) lines.push(`gates: ${status.gates.pending} pending / ${status.gates.total} total`);
  lines.push(`lock: ${status.lock.held ? `held by pid ${status.lock.pid} since ${status.lock.heartbeatAt}` : 'not held'}`);
  if (status.attention.length > 0) {
    lines.push('attention:');
    for (const entry of status.attention) lines.push(`  - ${entry}`);
  }
  return lines.join('\n');
}

/** Compact roster table, used by `agent-team-workflow roster`. */
export function formatRoster(status) {
  if (!status.workflow) return 'agent-team-workflow: no workflow defined yet';
  const header = ['role', 'kind', 'members', 'slots', 'busy', 'providers'];
  const rows = status.roles.map(role => [
    role.id,
    role.kind,
    String(role.instances),
    String(role.slots),
    String(role.busy),
    role.providers.length > 0 ? role.providers.join(', ') : 'any',
  ]);
  const widths = header.map((value, index) => Math.max(value.length, ...rows.map(row => row[index].length)));
  const render = row => row.map((value, index) => value.padEnd(widths[index])).join('  ').trimEnd();
  return [render(header), ...rows.map(render)].join('\n');
}

function countBy(values, keyOf) {
  const counts = {};
  for (const value of values) {
    const key = keyOf(value);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function formatCounts(counts) {
  const entries = Object.entries(counts).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return 'none';
  return entries.map(([key, value]) => `${value} ${key}`).join(', ');
}
