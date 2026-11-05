/** Bounded run summaries and detailed board projections; never mutates a run. */
import { describeDefinition } from './definition.mjs';
import { humanOutcomes, waitingHumanTokens } from './runtime.mjs';

export function summarizeRun(state) {
  const failed = state.tokens.find(token => ['failed', 'interrupted'].includes(token.status));
  const current = state.tokens.find(token => token.status === 'running') ?? state.tokens.at(-1);
  const nodes = new Map(state.definition.nodes.map(node => [node.id, node]));
  return {
    runId: state.runId,
    status: state.status,
    cwd: state.cwd ?? '',
    jobId: state.execution?.jobId ?? '',
    execution: state.execution ?? { active: false },
    updatedAt: state.updatedAt,
    pauseReason: state.pauseReason ?? '',
    current: current ? { tokenId: current.id, nodeId: current.nodeId, status: current.status, activity: current.activity ?? null, updatedAt: current.updatedAt } : {},
    counts: state.tokens.reduce((counts, token) => { counts[token.status] = (counts[token.status] || 0) + 1; return counts; }, {}),
    waiting: waitingHumanTokens(state).map(token => ({
      tokenId: token.id,
      nodeId: token.nodeId,
      title: nodes.get(token.nodeId)?.title ?? token.nodeId,
      outcomes: humanOutcomes(nodes.get(token.nodeId)),
    })),
    error: state.lastError ?? (failed?.error ? `${failed.error.code}: ${failed.error.message}` : ''),
  };
}

export function publicRun(state) {
  return {
    ...summarizeRun(state),
    createdAt: state.createdAt,
    context: state.context,
    tokens: state.tokens.map(token => ({
      id: token.id, nodeId: token.nodeId, status: token.status, attempt: token.attempt,
      outcome: token.outcome, input: token.input ?? null, output: token.output,
      outputs: token.outputs ?? null, model: token.model ?? null, error: token.error,
      reason: token.reason ?? null, branch: token.branch, joinTokenId: token.joinTokenId,
      activity: token.activity ?? null, child: token.childRun ? summarizeRun(token.childRun) : null, createdAt: token.createdAt ?? null, updatedAt: token.updatedAt ?? null,
    })),
  };
}

export function panelState(stored, state) {
  return {
    defined: stored !== null,
    summary: stored ? describeDefinition(stored.definition) : 'no workflow defined',
    // A saved run always renders against its own definition, not a newer draft.
    definition: state?.definition ?? stored?.definition ?? null,
    permissions: state?.permissions ?? stored?.permissions ?? null,
    run: state ? publicRun(state) : null,
  };
}
