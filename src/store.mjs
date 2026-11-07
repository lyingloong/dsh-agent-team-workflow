/** Scoped, atomic v3 persistence. Old flat run documents and business files are never modified. */
import { mkdir, readFile, readdir, rename, rm, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { normalizeDefinition } from './definition.mjs';

const DEFAULT_MAX_ARTIFACT_BYTES = 256 * 1024;
const DEFAULT_HISTORY_LIMIT = 100;
const failure = (code, message) => Object.assign(new Error(message), { code });
function safeId(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(value)) throw failure(`invalid_${label}`, `${label} must be an opaque safe identifier, not a path`);
  return value;
}
async function jsonOrNull(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function atomicJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporary, `${JSON.stringify(value)}\n`, 'utf8');
    // Windows can transiently deny replacing an existing file while a reader,
    // indexer or antivirus holds it. Retry the same atomic rename briefly.
    for (let attempt = 0; ; attempt += 1) {
      try { await rename(temporary, file); break; }
      catch (error) {
        if (attempt >= 8 || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) throw error;
        await new Promise(resolve => setTimeout(resolve, 10 * (attempt + 1)));
      }
    }
  } finally { await rm(temporary, { force: true }); }
}
function compactState(state) {
  const { definition, ...document } = state;
  return { ...document, tokens: state.tokens.map(token => token.childRun ? { ...token, childRun: compactState(token.childRun) } : token) };
}
function restoreState(document, definition) {
  document.definition = definition;
  for (const token of document.tokens ?? []) if (token.childRun) {
    const childDefinition = definition.nodes.find(node => node.id === token.nodeId)?.config.definition;
    if (!childDefinition) throw failure('invalid_run_state', 'Nested state has no matching frozen definition');
    restoreState(token.childRun, childDefinition);
  }
  return document;
}
function referencedArtifacts(value) {
  const refs = new Set(), pending = [value];
  while (pending.length) {
    const item = pending.pop();
    if (typeof item === 'string' && /^artifact-[0-9a-f-]{36}$/.test(item)) refs.add(item);
    else if (Array.isArray(item)) { for (const child of item) pending.push(child); }
    else if (item && typeof item === 'object') { for (const child of Object.values(item)) pending.push(child); }
  }
  return [...refs];
}
function modelContract(definition) {
  const contract = structuredClone(definition);
  for (const provider of contract.providers ?? []) for (const key of ['adapter', 'model', 'reasoningEffort', 'maxTokens']) delete provider[key];
  for (const node of contract.nodes) {
    if (node.type === 'agent') for (const key of ['lane', 'provider', 'model', 'models', 'reasoningEffort']) delete node.config[key];
    if (node.type === 'subworkflow') node.config.definition = modelContract(node.config.definition);
  }
  return contract;
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
function historyRecord(record) {
  const allowed = ['type', 'id', 'packetId', 'nodeId', 'status', 'attempt', 'outcome', 'inputRef', 'outputRef', 'createdAt', 'updatedAt'];
  const result = Object.fromEntries(allowed.filter(key => record[key] !== undefined).map(key => [key, record[key]]));
  for (const key of ['error', 'activity']) if (record[key]) result[key] = String(typeof record[key] === 'string' ? record[key] : JSON.stringify(record[key])).slice(0, 1000);
  if (record.model) result.model = { provider: String(record.model.provider ?? '').slice(0, 120), model: String(record.model.model ?? '').slice(0, 200) };
  return result;
}

export class SessionStore {
  constructor(dataDir, { maxArtifactBytes = DEFAULT_MAX_ARTIFACT_BYTES } = {}) {
    this.dataDir = path.resolve(dataDir); this.definitionPath = path.join(this.dataDir, 'workflow.json');
    this.controlPath = path.join(this.dataDir, 'control.json'); this.runsDir = path.join(this.dataDir, 'runs');
    this.maxArtifactBytes = maxArtifactBytes; this.queues = new Map(); this.channels = new Map();
  }
  runDir(runId) { return path.join(this.runsDir, safeId(runId, 'run_id')); }
  serial(key, operation) {
    const previous = this.queues.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(operation);
    this.queues.set(key, next);
    next.finally(() => { if (this.queues.get(key) === next) this.queues.delete(key); }).catch(() => {});
    return next;
  }
  async saveDefinition({ definition, permissions = null, now = new Date().toISOString() }) {
    const document = { version: 2, definition, permissions, updatedAt: now };
    await this.serial('definition', () => atomicJson(this.definitionPath, document)); return document;
  }
  loadDefinition() { return jsonOrNull(this.definitionPath); }
  async loadControl() {
    const value = await jsonOrNull(this.controlPath);
    return { continuous: value?.continuous !== false, nodes: Object.fromEntries(Object.entries(value?.nodes ?? {}).filter(([, enabled]) => typeof enabled === 'boolean')), updatedAt: value?.updatedAt ?? null };
  }
  async saveControl(control = {}) {
    const document = { continuous: control.continuous !== false, nodes: Object.fromEntries(Object.entries(control.nodes ?? {}).filter(([, enabled]) => typeof enabled === 'boolean')), updatedAt: new Date().toISOString() };
    await this.serial('control', () => atomicJson(this.controlPath, document));
    for (const channel of this.channels.values()) channel.notify(); return document;
  }
  channel(runId) {
    this.runDir(runId);
    if (!this.channels.has(runId)) {
      const waiters = new Set();
      const issued = new Set(), pins = new Map();
      let generation = 0;
      this.channels.set(runId, { issued, pins, holds: 0, version: () => generation,
        notify() { generation += 1; for (const wake of [...waiters]) wake(); },
        waitForChange({ signal, since } = {}) {
        if (signal?.aborted || (since !== undefined && since !== generation)) return Promise.resolve();
        return new Promise(resolve => {
          const done = () => { waiters.delete(done); signal?.removeEventListener('abort', done); resolve(); };
          waiters.add(done); signal?.addEventListener('abort', done, { once: true });
        });
      } });
    }
    return this.channels.get(runId);
  }
  createIO(runId) {
    const directory = this.runDir(runId), channel = this.channel(runId), store = this;
    const io = {
      runId, historyLimit: DEFAULT_HISTORY_LIMIT,
      async put(value) {
        let text;
        try { text = JSON.stringify(value); } catch (error) { throw failure('invalid_artifact', `Artifact must be JSON: ${error.message}`); }
        if (text === undefined) throw failure('invalid_artifact', 'Artifact must be a JSON value');
        if (Buffer.byteLength(text, 'utf8') > store.maxArtifactBytes) throw failure('artifact_too_large', `Node output exceeds ${store.maxArtifactBytes} bytes. Persist large data in an external artifact and return a small reference envelope.`);
        const ref = `artifact-${randomUUID()}`;
        channel.issued.add(ref);
        const dependencies = referencedArtifacts(value);
        for (const dependency of dependencies) channel.issued.add(dependency);
        channel.holds += 1;
        try {
          await atomicJson(path.join(directory, 'artifacts', `${ref}.json`), value);
          if (dependencies.length) await atomicJson(path.join(directory, 'artifacts', `${ref}.refs.json`), dependencies);
        } catch (error) { channel.issued.delete(ref); throw error; }
        finally { channel.holds -= 1; }
        return ref;
      },
      get: ref => store.readArtifact(runId, ref),
      archive: record => store.serial(`history:${runId}`, async () => {
        const file = path.join(directory, 'history.json');
        const current = await jsonOrNull(file) ?? [];
        const limit = Math.max(0, Math.min(1000, Number(io.historyLimit) || 0));
        await atomicJson(file, limit ? [...current, historyRecord(record)].slice(-limit) : []);
      }),
      notify: () => channel.notify(), version: () => channel.version(), waitForChange: options => channel.waitForChange(options),
      // A mutation pins only its refs. Broad holds cover the short interval
      // before an asynchronous put has returned the reference it allocated.
      retain(ref) {
        safeId(ref, 'artifact_ref');
        channel.pins.set(ref, (channel.pins.get(ref) ?? 0) + 1);
        let active = true;
        return () => { if (!active) return; active = false; const count = channel.pins.get(ref); if (count > 1) channel.pins.set(ref, count - 1); else channel.pins.delete(ref); };
      },
      hold() {
        channel.holds += 1; let active = true;
        return () => { if (active) { active = false; channel.holds -= 1; } };
      },
      prune: state => store.pruneArtifacts(runId, state),
    };
    return io;
  }
  async saveRun(run) {
    if (run?.version !== 3) throw failure('unsupported_run_version', 'Only version:3 run state may be saved; older history is left untouched');
    const directory = this.runDir(run.runId);
    const snapshot = compactState(structuredClone(run));
    return this.serial(`state:${run.runId}`, async () => {
      const file = path.join(directory, 'definition.json');
      if (!await jsonOrNull(file)) await atomicJson(file, run.definition);
      await atomicJson(path.join(directory, 'state.json'), snapshot); return run;
    });
  }
  async updateRunDefinition(runId, definition) {
    const directory = this.runDir(runId);
    const normalized = normalizeDefinition(definition);
    return this.serial(`state:${runId}`, async () => {
      const current = await jsonOrNull(path.join(directory, 'definition.json'));
      const document = await jsonOrNull(path.join(directory, 'state.json'));
      if (!current || !document) throw failure('ENOENT', `Run ${runId} does not exist`);
      if (document.version !== 3) throw failure('unsupported_run_version', 'Only version:3 runs accept explicit model edits');
      if (document.execution?.active || document.tokens.some(token => token.status === 'running')) throw failure('run_active', 'Stop or drain the active run before changing models');
      if (JSON.stringify(canonical(modelContract(current))) !== JSON.stringify(canonical(modelContract(normalized)))) throw failure('run_definition_contract_changed', 'An idle run may change agent model/lane/provider routing or provider model settings only. Start a new run to change graph topology, capacities, prompts or input mappings.');
      await atomicJson(path.join(directory, 'definition.json'), normalized);
      return normalized;
    });
  }
  async loadRun(runId) {
    const directory = this.runDir(runId);
    const value = await jsonOrNull(path.join(directory, 'state.json'));
    if (!value) {
      if (await jsonOrNull(path.join(this.runsDir, `${runId}.json`))) throw failure('unsupported_run_version', 'Legacy flat run history cannot execute; it has been preserved unchanged');
      throw failure('ENOENT', `Run ${runId} does not exist`);
    }
    if (value.version !== 3 || value.runId !== runId || !Array.isArray(value.tokens) || !value.packets) throw failure('invalid_run_state', 'Stored version or run identity is invalid');
    const definition = await jsonOrNull(path.join(directory, 'definition.json'));
    if (!definition) throw failure('invalid_run_state', 'Run definition is missing');
    return restoreState(value, definition);
  }
  async listRuns() {
    let entries; try { entries = await readdir(this.runsDir, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const runs = [];
    for (const entry of entries) if (entry.isDirectory() && !entry.isSymbolicLink()) {
      try { runs.push(await this.loadRun(entry.name)); } catch { /* Old or corrupt history stays on disk, but is not executable. */ }
    }
    return runs.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }
  async latestRun() { return (await this.listRuns())[0] ?? null; }
  async readArtifact(runId, ref, { maxBytes = this.maxArtifactBytes } = {}) {
    const file = path.join(this.runDir(runId), 'artifacts', `${safeId(ref, 'artifact_ref')}.json`);
    const cap = Math.min(this.maxArtifactBytes, Number.isFinite(maxBytes) ? Math.max(0, maxBytes) : this.maxArtifactBytes);
    if ((await stat(file)).size > cap + 1) throw failure('artifact_too_large', `Artifact exceeds read limit ${cap} bytes`);
    const text = await readFile(file, 'utf8');
    if (Buffer.byteLength(text.trimEnd(), 'utf8') > cap) throw failure('artifact_too_large', `Artifact exceeds read limit ${cap} bytes`);
    return JSON.parse(text);
  }
  async readHistory(runId, { nodeId, packetId, limit = DEFAULT_HISTORY_LIMIT } = {}) {
    const records = await jsonOrNull(path.join(this.runDir(runId), 'history.json')) ?? [];
    const bounded = Math.max(0, Math.min(1000, Number(limit) || 0));
    return bounded ? records.filter(record => (!nodeId || record.nodeId === nodeId) && (!packetId || record.packetId === packetId)).slice(-bounded) : [];
  }
  pruneArtifacts(runId, state) {
    return this.serial(`prune:${runId}`, () => this.pruneArtifactsNow(runId, state));
  }
  async pruneArtifactsNow(runId, state) {
    const directory = path.join(this.runDir(runId), 'artifacts'), channel = this.channel(runId);
    if (channel.holds) return { removed: 0 };
    // One-pass grace handles unclaimed outputs; scoped pins protect unpublished
    // inputs across arbitrarily many pruning passes, including nested mappings.
    const protectedRefs = new Set(channel.issued);
    const refs = new Set([...protectedRefs, ...channel.pins.keys()]);
    const add = value => { if (typeof value === 'string') refs.add(value); };
    const collect = current => {
      add(current.outputRef);
      for (const packet of Object.values(current.packets ?? {})) {
        add(packet.inputRef); add(packet.lastRef); add(packet.itemRef);
        for (const result of Object.values(packet.results ?? {})) add(result.outputRef);
      }
      for (const token of current.tokens ?? []) {
        add(token.inputRef); add(token.outputRef); add(token.itemsRef);
        for (const result of Object.values(token.results ?? {})) add(result.outputRef);
        for (const result of token.join?.outputs ?? []) add(result.outputRef);
        if (token.childRun) collect(token.childRun);
      }
      for (const record of current.recent ?? []) { add(record.inputRef); add(record.outputRef); }
    };
    let files; try { files = await readdir(directory, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return { removed: 0 }; throw error; }
    collect(state);
    for (const record of await this.readHistory(runId, { limit: 1000 })) { add(record.inputRef); add(record.outputRef); }
    // Traverse only small reference sidecars, never full artifacts or external dataRef paths.
    const visited = new Set();
    const expand = async () => {
      collect(state);
      for (const ref of channel.pins.keys()) refs.add(ref);
      for (const ref of channel.issued) refs.add(ref);
      for (const ref of refs) {
        if (visited.has(ref) || !/^artifact-[0-9a-f-]{36}$/.test(ref)) continue;
        visited.add(ref);
        for (const dependency of await jsonOrNull(path.join(directory, `${ref}.refs.json`)) ?? []) {
          if (typeof dependency === 'string' && /^artifact-[0-9a-f-]{36}$/.test(dependency)) refs.add(dependency);
        }
      }
    };
    await expand();
    let removed = 0;
    for (const file of files) {
      if (!file.isFile() || !/^artifact-[A-Za-z0-9_-]+\.json$/.test(file.name)) continue;
      if (channel.holds) return { removed };
      const ref = file.name.slice(0, -5);
      await expand();
      if (channel.holds) return { removed };
      if (!refs.has(ref) && !channel.issued.has(ref) && !channel.pins.has(ref)) {
        await rm(path.join(directory, file.name), { force: true });
        await rm(path.join(directory, `${ref}.refs.json`), { force: true }); removed += 1;
      }
    }
    for (const ref of protectedRefs) if (!channel.pins.has(ref)) channel.issued.delete(ref);
    return { removed };
  }
}
