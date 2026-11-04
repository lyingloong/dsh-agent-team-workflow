/**
 * Read models for tools and the panel: never mutates a run.
 */

import { describeDefinition } from './definition.mjs';
import { humanOutcomes, waitingHumanTokens } from './runtime.mjs';

export function summarizeRun(state) {
  const failed = state.tokens.find(token => token.status === 'failed');
  const nodes = new Map(state.definition.nodes.map(node => [node.id, node]));
  return {
    runId: state.runId,
    status: state.status,
    waiting: waitingHumanTokens(state).map(token => {
      const node = nodes.get(token.nodeId);
      return {
        tokenId: token.id,
        nodeId: token.nodeId,
        title: node?.title ?? token.nodeId,
        outcomes: humanOutcomes(node),
      };
    }),
    error: state.lastError ?? (failed ? `${failed.error.code}: ${failed.error.message}` : ''),
  };
}

/** Full run document for the panel; token outputs are included for inspection. */
export function publicRun(state) {
  return {
    ...summarizeRun(state),
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    context: state.context,
    tokens: state.tokens.map(token => ({
      id: token.id,
      nodeId: token.nodeId,
      status: token.status,
      attempt: token.attempt,
      outcome: token.outcome,
      output: token.output,
      error: token.error,
      branch: token.branch,
      joinTokenId: token.joinTokenId,
    })),
  };
}

export function panelState(stored, state) {
  return {
    defined: stored !== null,
    summary: stored ? describeDefinition(stored.definition) : 'no workflow defined',
    definition: stored?.definition ?? null,
    permissions: stored?.permissions ?? null,
    run: state ? publicRun(state) : null,
  };
}
