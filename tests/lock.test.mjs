import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { LockError, acquireLock, readLock } from '../src/lock.mjs';

function tempDir(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'agent-team-workflow-lock-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return dir;
}

test('acquires, records and releases a lock', (t) => {
  const dir = tempDir(t);
  const lock = acquireLock({ dataDir: dir, pid: 4242, host: 'unit-host' });
  const record = readLock(dir);
  assert.equal(record.pid, 4242);
  assert.equal(record.host, 'unit-host');
  assert.equal(lock.token, record.token);
  lock.release();
  assert.equal(readLock(dir), null);
});

test('refuses a second live owner', (t) => {
  const dir = tempDir(t);
  const lock = acquireLock({ dataDir: dir });
  t.after(() => lock.release());
  assert.throws(
    () => acquireLock({ dataDir: dir }),
    error => {
      assert.ok(error instanceof LockError);
      assert.equal(error.holder.pid, process.pid);
      assert.match(error.message, /another coordinator is running/);
      return true;
    },
  );
});

test('takes over a lock whose owner is gone', (t) => {
  const dir = tempDir(t);
  const lockPath = path.join(dir, 'agent-team-workflow.lock');
  writeFileSync(lockPath, JSON.stringify({
    pid: 2_000_000_000,
    host: os.hostname(),
    token: 'dead',
    acquiredAt: '2026-01-01T00:00:00.000Z',
    heartbeatAt: new Date().toISOString(),
  }));
  const lock = acquireLock({ dataDir: dir });
  t.after(() => lock.release());
  assert.equal(readLock(dir).token, lock.token);
});

test('takes over a lock with an old heartbeat', (t) => {
  const dir = tempDir(t);
  writeFileSync(path.join(dir, 'agent-team-workflow.lock'), JSON.stringify({
    pid: process.pid,
    host: 'another-host',
    token: 'old',
    acquiredAt: '2026-01-01T00:00:00.000Z',
    heartbeatAt: '2026-01-01T00:00:00.000Z',
  }));
  const lock = acquireLock({ dataDir: dir, clock: () => new Date('2026-01-02T00:00:00.000Z') });
  t.after(() => lock.release());
  assert.equal(readLock(dir).token, lock.token);
});

test('heartbeat refreshes the timestamp', (t) => {
  const dir = tempDir(t);
  let now = new Date('2026-01-01T00:00:00.000Z');
  const lock = acquireLock({ dataDir: dir, clock: () => now });
  t.after(() => lock.release());
  now = new Date('2026-01-01T00:10:00.000Z');
  lock.heartbeat();
  assert.equal(readLock(dir).heartbeatAt, '2026-01-01T00:10:00.000Z');
});

test('release by a different owner leaves the file intact', (t) => {
  const dir = tempDir(t);
  const lock = acquireLock({ dataDir: dir });
  const lockPath = path.join(dir, 'agent-team-workflow.lock');
  const hijacked = { ...readLock(dir), token: 'someone-else' };
  writeFileSync(lockPath, JSON.stringify(hijacked));
  lock.release();
  assert.equal(readFileSync(lockPath, 'utf8'), JSON.stringify(hijacked));
  rmSync(lockPath, { force: true });
});
