/**
 * Filesystem layout for local engine state.
 *
 * The event log lives outside any repository by default so that a checkout can
 * be replaced, moved or re-cloned without losing orchestration history. A
 * repository may still opt into a local export directory; exported artifacts are
 * never the source of truth.
 */

import os from 'node:os';
import path from 'node:path';
import { mkdirSync } from 'node:fs';

/** Default per-user data directory, independent of the current repository. */
export function defaultDataDir({ env = process.env, platform = process.platform, home = os.homedir() } = {}) {
  if (env.AGENT_TEAM_WORKFLOW_DATA) return path.resolve(env.AGENT_TEAM_WORKFLOW_DATA);
  if (platform === 'win32') {
    return path.join(env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'), 'agent-team-workflow');
  }
  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'agent-team-workflow');
  }
  return path.join(env.XDG_DATA_HOME ?? path.join(home, '.local', 'share'), 'agent-team-workflow');
}

/** Absolute paths derived from a data directory. */
export function dataPaths(dataDir) {
  const absolute = path.resolve(dataDir);
  return {
    dataDir: absolute,
    dbPath: path.join(absolute, 'agent-team-workflow.sqlite3'),
    lockPath: path.join(absolute, 'agent-team-workflow.lock'),
    exportDir: path.join(absolute, 'exports'),
    logDir: path.join(absolute, 'logs'),
  };
}

/** Create the data directory (owner-only where the platform supports it). */
export function ensureDataDir(dataDir) {
  const paths = dataPaths(dataDir);
  mkdirSync(paths.dataDir, { recursive: true, mode: 0o700 });
  return paths;
}

/** Optional repository-local directory for exports and human-facing reports. */
export function repoDir(root) {
  return path.join(path.resolve(root), '.agent-team-workflow');
}
