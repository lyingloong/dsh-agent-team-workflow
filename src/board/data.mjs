/**
 * Board projection.
 *
 * The board is a read model over the same snapshot the CLI uses: columns are
 * workflow stages, cards are items, and decisions are pending gates. Nothing
 * here mutates state, so a board refresh can never change the workflow.
 */

import { ACTIVE_TASK_STATES } from '../scheduler.mjs';

const STATUS_WEIGHT = {
  running: 6,
  claimed: 5,
  ready: 4,
  failed: 3,
  completed: 2,
  cancelled: 1,
};

/** Stages in traversal order from the entry, so columns match the flow. */
export function stageOrder(definition) {
  const byId = new Map(definition.stages.map(stage => [stage.id, stage]));
  const order = [];
  const seen = new Set();
  const queue = [definition.entry];
  while (queue.length > 0) {
    const id = queue.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    const stage = byId.get(id);
    if (!stage) continue;
    order.push(stage);
    for (const target of Object.values(stage.on)) queue.push(target);
  }
  for (const stage of definition.stages) {
    if (!seen.has(stage.id)) order.push(stage);
  }
  return order;
}

/** Build everything the board renders in one pass. */
export function buildBoardData({ snapshot, definition, now = new Date().toISOString() }) {
  const tasksByItem = groupBy(snapshot.tasks, task => task.itemId);
  const gatesByItem = groupBy(snapshot.gates, gate => gate.itemId);
  const activeTasks = snapshot.tasks.filter(task => ACTIVE_TASK_STATES.has(task.status));
  const attemptsByTask = countBy(snapshot.attempts, attempt => attempt.taskId);
  const nowMs = Date.parse(now);

  const itemsById = new Map(snapshot.items.map(item => [item.id, item]));
  const cards = new Map();
  for (const item of snapshot.items) {
    const task = latestTask(tasksByItem.get(item.id) ?? []);
    cards.set(item.id, {
      id: item.id,
      title: item.title,
      kind: item.kind,
      stage: item.stage,
      status: item.status,
      priority: item.priority,
      updatedAt: item.updatedAt,
      task: task
        ? {
            id: task.id,
            status: task.status,
            role: task.role,
            assignee: task.assignee,
            provider: task.provider,
            attemptCount: attemptsByTask[task.id] ?? 0,
            updatedAt: task.updatedAt,
          }
        : null,
      gates: (gatesByItem.get(item.id) ?? [])
        .map(gate => ({ id: gate.gate, status: gate.status, signal: gate.signal }))
        .sort((a, b) => a.id.localeCompare(b.id)),
      contract: task?.contract ?? null,
      result: task?.result ?? null,
    });
  }

  const columns = stageOrder(definition).map(stage => {
    const items = [...cards.values()]
      .filter(card => card.stage === stage.id)
      .sort(compareCards);
    return {
      id: stage.id,
      title: stage.title ?? stage.id,
      role: stage.role,
      providers: stage.providers,
      items,
    };
  });

  const providers = providerRows({ definition, snapshot, activeTasks, nowMs });
  const pendingGates = snapshot.gates
    .filter(gate => gate.status === 'pending')
    .map(gate => ({
      itemId: gate.itemId,
      itemTitle: itemsById.get(gate.itemId)?.title ?? gate.itemId,
      gate: gate.gate,
      signal: gate.signal,
      updatedAt: gate.updatedAt,
    }));

  const itemsByStatus = countBy(snapshot.items, item => item.status);
  const tasksByStatus = countBy(snapshot.tasks, task => task.status);

  return {
    generatedAt: now,
    workflow: {
      name: definition.name,
      description: definition.description,
      entry: definition.entry,
      createdAt: snapshot.workflow?.createdAt ?? null,
      updatedAt: snapshot.workflow?.updatedAt ?? null,
      stages: stageOrder(definition).map(stage => ({
        id: stage.id,
        title: stage.title ?? stage.id,
        role: stage.role,
        providers: stage.providers,
        outcomes: Object.keys(stage.on),
        on: { ...stage.on },
      })),
      roles: definition.roles.map(role => ({
        id: role.id,
        kind: role.kind,
        instances: role.instances,
        capacity: role.capacity,
        providers: role.providers,
      })),
      gates: definition.gates.map(gate => ({
        id: gate.id,
        after: gate.after,
        outcome: gate.outcome,
        kind: gate.kind,
        required: gate.required,
      })),
      policies: {
        globalConcurrency: definition.policies.concurrency.global,
        maxAttempts: definition.policies.retry.maxAttempts,
      },
    },
    columns,
    counts: {
      items: snapshot.items.length,
      active: itemsByStatus.active ?? 0,
      blocked: itemsByStatus.blocked ?? 0,
      done: itemsByStatus.done ?? 0,
      cancelled: itemsByStatus.cancelled ?? 0,
      tasksReady: tasksByStatus.ready ?? 0,
      tasksRunning: (tasksByStatus.running ?? 0) + (tasksByStatus.claimed ?? 0),
      pendingGates: pendingGates.length,
      activeTasks: activeTasks.length,
      capacity: definition.policies.concurrency.global,
    },
    providers,
    pendingGates,
  };
}

function providerRows({ definition, snapshot, activeTasks, nowMs }) {
  const ids = new Set([
    ...definition.providers.map(provider => provider.id),
    ...snapshot.providers.map(provider => provider.id),
  ]);
  return [...ids].sort().map(id => {
    const declared = definition.providers.find(provider => provider.id === id);
    const state = snapshot.providers.find(provider => provider.id === id);
    const blockedUntil = state?.blockedUntil ?? null;
    const expired = state?.health === 'blocked' && blockedUntil !== null && Date.parse(blockedUntil) <= nowMs;
    return {
      id,
      model: declared?.model ?? state?.model ?? null,
      health: expired ? 'ok' : state?.health ?? 'ok',
      blockedUntil: expired ? null : blockedUntil,
      reason: expired ? null : state?.reason ?? null,
      concurrency: declared?.concurrency ?? null,
      active: activeTasks.filter(task => task.provider === id).length,
    };
  });
}

function latestTask(tasks) {
  let best = null;
  for (const task of tasks) {
    if (best === null) {
      best = task;
      continue;
    }
    const weight = STATUS_WEIGHT[task.status] ?? 0;
    const bestWeight = STATUS_WEIGHT[best.status] ?? 0;
    if (weight !== bestWeight) {
      if (weight > bestWeight) best = task;
      continue;
    }
    if (String(task.updatedAt) > String(best.updatedAt)) best = task;
  }
  return best;
}

function compareCards(a, b) {
  const weight = statusWeight(b.status) - statusWeight(a.status);
  if (weight !== 0) return weight;
  return String(b.updatedAt).localeCompare(String(a.updatedAt));
}

function statusWeight(status) {
  return { blocked: 4, active: 3, done: 2, cancelled: 1 }[status] ?? 0;
}

function groupBy(values, keyOf) {
  const groups = new Map();
  for (const value of values) {
    const key = keyOf(value);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(value);
  }
  return groups;
}

function countBy(values, keyOf) {
  const counts = {};
  for (const value of values) {
    const key = keyOf(value);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}
