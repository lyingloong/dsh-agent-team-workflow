/**
 * Public surface of the agent-team-workflow engine.
 *
 * Host adapters (a DSH plugin, a CI tick, a desktop shell) import from here.
 * Nothing in this package imports a host, a model vendor or a forge.
 */

export {
  API_VERSION,
  DefinitionError,
  defaultGlobalCapacity,
  describeDefinition,
  normalizeDefinition,
} from './definition.mjs';
export { Store } from './store.mjs';
export { Engine, EngineError, inferProviderError } from './engine.mjs';
export { applyEvent, PROJECTION_TABLES } from './projections.mjs';
export { LockError, acquireLock, readLock } from './lock.mjs';
export { ACTIVE_TASK_STATES, TERMINAL_TASK_STATES, buildSlots, planDispatch, simulate } from './scheduler.mjs';
export { buildStatus, formatRoster, formatStatus } from './status.mjs';
export { dataPaths, defaultDataDir, ensureDataDir, repoDir } from './paths.mjs';
export { buildBoardData, stageOrder } from './board/data.mjs';
export { startBoardServer } from './board/server.mjs';
