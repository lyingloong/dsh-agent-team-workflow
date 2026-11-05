/** One execution owner shared by model tools and both board transports. */
import path from 'node:path';
import { realpath, stat, readFile } from 'node:fs/promises';
import { createExecutors } from './executors.mjs';
import { RuntimeError, run } from './runtime.mjs';
import { summarizeRun } from './view.mjs';

function failure(code, message) {
  return Object.assign(new RuntimeError(code, message), { status: 409 });
}

export async function executionCwd(ctx, exec, requested, bound) {
  let value = requested ?? bound;
  if (value !== undefined && value !== null) {
    if (typeof value !== 'string' || !path.isAbsolute(value)) {
      throw failure('invalid_cwd', 'cwd must be an explicit absolute repository path');
    }
  } else {
    const service = ctx.get?.('workingDirectory');
    // header.cwd is the original directory, not the current committed one.
    if (service?.ensure) value = await service.ensure(exec.agent, exec.signal);
    else if (service?.get && exec?.agent?.session) value = service.get(exec.agent.session);
    else value = exec?.agent?.session?.header?.cwd;
  }
  if (typeof value !== 'string' || !path.isAbsolute(value)) {
    throw failure('cwd_required', 'No effective repository directory is available. Supply cwd when starting the run.');
  }
  const resolved = await realpath(value);
  if (!(await stat(resolved)).isDirectory()) throw failure('invalid_cwd', `Not a directory: ${value}`);
  return resolved;
}

/** Validate static targets without invoking tools or changing either repository. */
export async function preflightRun(state) {
  if (!state.cwd) throw failure('run_cwd_unbound', 'This run has no bound cwd. Preserve its history and start a new run with an explicit repository directory.');
  await executionCwd({}, {}, state.cwd);
  for (const node of state.definition.nodes) {
    if (!['agent', 'command'].includes(node.type)) continue;
    const cwd = node.config.cwd ? path.resolve(state.cwd, node.config.cwd) : state.cwd;
    if (!(await stat(cwd)).isDirectory()) throw failure('invalid_cwd', `${node.id}: directory unavailable: ${cwd}`);
    if (node.type === 'command' && /^\s*npm(?:\.cmd)?\s+(?:test|run(?:-script)?)(?:\s|$)/i.test(node.config.command)) {
      const file = path.join(cwd, 'package.json');
      let pkg;
      try { pkg = JSON.parse(await readFile(file, 'utf8')); }
      catch (error) { throw failure('invalid_command_cwd', `${node.id}: ${node.config.command} cannot run in ${cwd}: ${file} is missing or invalid (${error.code ?? error.message}). Fix cwd/verification, not application code.`); }
      if (/^\s*npm(?:\.cmd)?\s+test(?:\s|$)/i.test(node.config.command) && !pkg.scripts?.test) {
        throw failure('invalid_verify_command', `${node.id}: package.json in ${cwd} has no scripts.test. Configure the repository's actual verification command.`);
      }
    }
  }
}

export class WorkflowRunner {
  constructor({ ctx, storeFor, agents = new Map(), settings = {}, logger = console }) {
    this.ctx = ctx;
    this.storeFor = storeFor;
    this.agents = agents;
    this.settings = settings;
    this.logger = logger;
    this.active = new Map();
    this.locks = new Map();
    this.closed = false;
  }

  async locked(session, operation) {
    const prior = this.locks.get(session) ?? Promise.resolve();
    let release;
    const next = new Promise(resolve => { release = resolve; });
    this.locks.set(session, next);
    await prior;
    try { return await operation(); }
    finally {
      release();
      if (this.locks.get(session) === next) this.locks.delete(session);
    }
  }

  async mutate(session, operation) {
    return this.locked(session, async () => {
      if (this.closed) throw failure('runner_closed', 'Workflow runner is shutting down.');
      if (this.active.has(session)) throw failure('run_active', 'A workflow job is still executing. Stop it or wait before changing its definition, models, decisions or run.');
      return operation();
    });
  }

  async load(session, runId) {
    const store = this.storeFor(session);
    const state = runId ? await store.loadRun(runId) : await store.latestRun();
    if (!state) throw failure('no_run', 'No run exists; start one with a bound repository cwd.');
    return state;
  }

  parent(session, exec) {
    const registry = this.ctx.get?.('agents');
    const cached = exec?.agent ?? this.agents.get(session)?.agent;
    const agent = registry?.get ? registry.get(session) : cached;
    if (!agent || (exec?.agent && agent !== exec.agent)) {
      throw failure('no_session_agent', 'The owning Agent is no longer live. Reconnect from the assistant session before running.');
    }
    return agent;
  }

  async dispatch(session, runId, exec) {
    return this.locked(session, async () => {
      if (this.closed) throw failure('runner_closed', 'Workflow runner is shutting down.');
      const existing = this.active.get(session);
      if (existing) {
        if (runId && runId !== existing.state.runId) throw failure('run_active', 'Another run already owns this session.');
        return structuredClone(existing.state);
      }
      exec?.signal?.throwIfAborted();
      const store = this.storeFor(session);
      const state = await this.load(session, runId);
      // Never replay old failed/cancelled/unknown side effects by clicking Run.
      if (['done', 'failed', 'interrupted'].includes(state.status)) return state;
      if (state.execution?.active || state.tokens.some(token => token.status === 'running')) {
        const registry = this.ctx.get?.('jobs');
        if (state.execution?.jobId) {
          if (!registry?.list) throw failure('execution_owner_unknown', 'Cannot verify the persisted job owner; do not replay it.');
          const live = registry.list(session).find(job => job.id === state.execution.jobId);
          if (live && !['completed', 'failed', 'killed'].includes(live.status)) {
            throw failure('run_active', 'The persisted job is still live in the host registry; collect or stop it before continuing.');
          }
        }
        state.status = 'interrupted';
        state.lastError = 'Previous execution has no live owner after restart/unload. Inspect its effects; automatic replay is disabled.';
        for (const token of state.tokens.filter(item => item.status === 'running')) {
          token.status = 'interrupted';
          token.error = { code: 'execution_unknown', message: state.lastError };
        }
        state.execution = { ...state.execution, active: false, interruptedAt: new Date().toISOString() };
        await store.saveRun(state);
        return state;
      }
      await preflightRun(state);
      if (this.closed) throw failure('runner_closed', 'Workflow runner was disposed during preflight.');
      exec?.signal?.throwIfAborted();
      const agent = this.parent(session, exec);
      const jobs = this.ctx.get?.('jobs');
      if (!jobs?.start) throw failure('jobs_unavailable', 'Workflow execution requires the DSH managed jobs service; no work was started.');
      const controller = new AbortController();
      let ready, refuse;
      const admitted = new Promise((resolve, reject) => { ready = resolve; refuse = reject; });
      const entry = { state, controller, jobs, done: null, jobId: null, writes: Promise.resolve() };
      entry.save = () => {
        state.updatedAt = new Date().toISOString();
        const snapshot = structuredClone(state);
        entry.writes = entry.writes.then(() => store.saveRun(snapshot));
        return entry.writes;
      };
      this.active.set(session, entry);
      try {
        const jobId = jobs.start({
          kind: 'team-workflow', // Plugin-owned job kind, not a built-in shell job.
          label: `workflow:${state.definition.name}`,
          owner: session,
          run: job => {
            entry.jobId = job.id;
            entry.done = admitted.then(() => this.execute(entry, agent, store, job)).catch(error => ({ status: 'failed', detail: error.message })).finally(() => {
              if (this.active.get(session) === entry) this.active.delete(session);
            });
            return {
              cancel: reason => controller.abort(Object.assign(new Error(reason || 'Workflow job cancelled'), { code: 'execution_aborted' })),
              done: entry.done,
            };
          },
        });
        entry.jobId = jobId;
        state.execution = { jobId, active: true, startedAt: new Date().toISOString() };
        await entry.save();
        ready();
        return structuredClone(state);
      } catch (error) {
        controller.abort(error);
        refuse(error);
        if (entry.done) await entry.done;
        else { admitted.catch(() => {}); this.active.delete(session); }
        throw error;
      }
    });
  }

  async execute(entry, agent, store, job) {
    const { state, controller } = entry;
    let lastProgress = '';
    const checkpoint = async () => {
      await entry.save();
      const token = state.tokens.find(item => item.status === 'running') ?? state.tokens.at(-1);
      const progress = `${state.status} · ${token?.nodeId ?? '—'} · ${token?.status ?? '—'} · ${state.tokens.filter(item => item.status === 'completed').length} completed`;
      if (progress !== lastProgress) {
        job.updateProgress(progress);
        job.append(progress + '\n');
        lastProgress = progress;
      }
    };
    try {
      const executors = createExecutors({
        ctx: this.ctx, exec: { agent, signal: controller.signal }, settings: this.settings, cwd: state.cwd,
        onActivity: async (token, activity) => { token.activity = { ...activity, startedAt: new Date().toISOString() }; await checkpoint(); },
      });
      // maxSteps is a cooperative scheduler slice, not a lifetime task limit.
      do {
        await run(state, executors, {
          maxSteps: this.settings.maxSteps ?? 40,
          maxFailures: this.settings.maxFailures ?? 3,
          control: () => store.loadControl(), signal: controller.signal, checkpoint,
        });
        if (state.status !== 'paused' || state.pauseReason !== 'step_budget' || controller.signal.aborted) break;
        await new Promise(resolve => setImmediate(resolve));
      } while (true);
    } catch (error) {
      state.status = controller.signal.aborted ? 'interrupted' : 'failed';
      state.lastError = error.message;
    } finally {
      state.execution = { ...state.execution, active: false, finishedAt: new Date().toISOString() };
      // Settlement follows persistence and executor cleanup, not the HTTP call.
      await checkpoint();
    }
    return {
      status: state.status === 'interrupted' ? 'killed' : state.status === 'failed' ? 'failed' : 'completed',
      detail: state.lastError ?? state.pauseReason ?? state.status,
      result: JSON.stringify(summarizeRun(state)),
    };
  }

  stop(session, reason = 'Stopped from workflow board') {
    const entry = this.active.get(session);
    if (!entry) return { requested: false };
    entry.jobs.kill(entry.jobId, session, reason);
    return { requested: true, jobId: entry.jobId };
  }

  async dispose() {
    this.closed = true;
    const entries = [...this.active.values()];
    for (const entry of entries) entry.controller.abort(Object.assign(new Error('Workflow plugin disposed'), { code: 'execution_aborted' }));
    await Promise.allSettled(entries.map(entry => entry.done));
  }
}
