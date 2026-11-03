/**
 * Single-instance lock for one data directory.
 *
 * Two coordinators against the same event log would double-dispatch every task,
 * so the second process must fail loudly instead of racing. A lock whose owner
 * is gone (dead pid on this host, or an old heartbeat) is taken over.
 */

import os from 'node:os';
import path from 'node:path';
import { openSync, closeSync, writeSync, readFileSync, unlinkSync, writeFileSync, renameSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

export class LockError extends Error {
  constructor(message, holder) {
    super(message);
    this.name = 'LockError';
    this.code = 'lock_held';
    this.holder = holder;
  }
}

/**
 * Acquire the lock for `dataDir`. Throws LockError when another live owner holds it.
 * Returns a handle with release() and heartbeat().
 */
export function acquireLock({ dataDir, pid = process.pid, host = os.hostname(), clock = () => new Date(), staleMs = 60_000 } = {}) {
  if (!dataDir) throw new TypeError('acquireLock requires a dataDir');
  const lockPath = path.join(path.resolve(dataDir), 'agent-team-workflow.lock');
  const token = randomUUID();
  const record = {
    pid,
    host,
    token,
    acquiredAt: clock().toISOString(),
    heartbeatAt: clock().toISOString(),
  };
  const write = () => {
    const fd = openSync(lockPath, 'wx', 0o600);
    try {
      writeSync(fd, JSON.stringify(record));
    } finally {
      closeSync(fd);
    }
  };

  try {
    write();
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const existing = readRecord(lockPath);
    if (existing && isLive(existing, { now: clock(), staleMs })) {
      throw new LockError(
        `another coordinator is running for ${path.dirname(lockPath)} (pid ${existing.pid} on ${existing.host})`,
        existing,
      );
    }
    // Stale owner: remove and retry exactly once. A concurrent takeover loses the
    // create('wx') race and gets a clear LockError instead of corrupting the file.
    try {
      unlinkSync(lockPath);
    } catch (unlinkError) {
      if (unlinkError.code !== 'ENOENT') throw unlinkError;
    }
    try {
      write();
    } catch (retryError) {
      if (retryError.code === 'EEXIST') {
        throw new LockError(`lock for ${path.dirname(lockPath)} was taken over concurrently`, readRecord(lockPath));
      }
      throw retryError;
    }
  }

  let released = false;
  return {
    path: lockPath,
    token,
    get released() {
      return released;
    },
    heartbeat() {
      if (released) return;
      record.heartbeatAt = clock().toISOString();
      try {
        // Never overwrite a lock another owner has taken over.
        if (readRecord(lockPath)?.token !== token) {
          released = true;
          return;
        }
        // Write-then-rename keeps a reader from observing a truncated file and
        // mistaking a live owner for a stale one.
        const temporary = `${lockPath}.${process.pid}.tmp`;
        writeFileSync(temporary, JSON.stringify(record), { mode: 0o600 });
        renameSync(temporary, lockPath);
      } catch {
        // A heartbeat failure is not fatal; the next tick retries.
      }
    },
    release() {
      if (released) return;
      released = true;
      try {
        const current = readRecord(lockPath);
        if (current?.token === token) unlinkSync(lockPath);
      } catch {
        // Already gone: nothing to release.
      }
    },
  };
}

/** Read lock metadata without acquiring; returns null when absent or unreadable. */
export function readLock(dataDir) {
  const lockPath = path.join(path.resolve(dataDir), 'agent-team-workflow.lock');
  return readRecord(lockPath);
}

function readRecord(lockPath) {
  try {
    const raw = readFileSync(lockPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && typeof parsed.pid === 'number') return parsed;
    return null;
  } catch {
    return null;
  }
}

function isLive(record, { now, staleMs }) {
  if (record.host === os.hostname() && record.pid !== process.pid) {
    if (!isProcessAlive(record.pid)) return false;
  }
  const heartbeat = Date.parse(record.heartbeatAt ?? record.acquiredAt ?? '');
  if (!Number.isFinite(heartbeat)) return false;
  return now.getTime() - heartbeat <= staleMs;
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}
