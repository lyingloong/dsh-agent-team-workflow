/**
 * v2 session store: one workflow definition plus JSON run documents.
 *
 * A run is a plain document written atomically, so a host restart resumes the
 * same token state. This replaces the v1 SQLite event log; there is no v1
 * compatibility layer.
 */

import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export class SessionStore {
  constructor(dataDir) {
    this.dataDir = path.resolve(dataDir);
    this.definitionPath = path.join(this.dataDir, 'workflow.json');
    this.runsDir = path.join(this.dataDir, 'runs');
  }

  async saveDefinition({ definition, permissions = null, now = new Date().toISOString() }) {
    await mkdir(this.dataDir, { recursive: true });
    const document = { version: 2, definition, permissions, updatedAt: now };
    await atomicJson(this.definitionPath, document);
    return document;
  }

  async loadDefinition() {
    try {
      const text = await readFile(this.definitionPath, 'utf8');
      return JSON.parse(text);
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async saveRun(run) {
    await mkdir(this.runsDir, { recursive: true });
    await atomicJson(path.join(this.runsDir, `${run.runId}.json`), run);
    return run;
  }

  async loadRun(runId) {
    const text = await readFile(path.join(this.runsDir, `${runId}.json`), 'utf8');
    return JSON.parse(text);
  }

  async listRuns() {
    let names;
    try {
      names = await readdir(this.runsDir);
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    const runs = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      try {
        runs.push(JSON.parse(await readFile(path.join(this.runsDir, name), 'utf8')));
      } catch {
        // A corrupt run is skipped rather than breaking the list.
      }
    }
    return runs.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  async latestRun() {
    const runs = await this.listRuns();
    return runs[0] ?? null;
  }
}

async function atomicJson(file, value) {
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporary, file);
}
