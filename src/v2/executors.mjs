/**
 * v2 execution plane: mount agent, command and HTTP executors.
 *
 * The runtime owns scheduling and permissions; these executors only perform one
 * node's work. Agent nodes use the host subagent service and the lane's
 * agentOptions; command nodes use a shell with a bounded buffer/timeout; HTTP
 * nodes use fetch with a timeout. Permission checks happen in the runtime
 * before any executor is called.
 */

import path from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { stat } from 'node:fs/promises';

const execAsync = promisify(exec);

// One agent node, including its model fallback list, has a ten-minute default
// deadline. node.config.timeoutMs overrides settings.agentTimeoutMs.
const DEFAULT_AGENT_TIMEOUT_MS = 10 * 60_000;

export function createExecutors({ ctx, exec, settings = {}, cwd, onActivity }) {
  const subagents = ctx.get?.('subagents');
  return {
    async agent({ node, input, context, definition, token }) {
      if (!subagents || typeof subagents.startActivation !== 'function') {
        throw new Error('no subagent service is mounted');
      }
      const lane = (definition.providers ?? []).find(provider => provider.id === node.config.lane) ?? null;
      const agentCwd = node.config.cwd ? path.resolve(cwd, node.config.cwd) : cwd;
      const outcomes = Array.isArray(node.config.outcomes) && node.config.outcomes.length > 0
        ? node.config.outcomes
        : node.config.outcome ? [node.config.outcome] : ['complete'];
      const prompt = agentPrompt({ definition, node, input, context, outcomes });
      const candidates = modelCandidates(node, lane);
      const scope = executionScope(exec.signal, node.config.timeoutMs ?? settings.agentTimeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS, `agent ${node.id}`);
      const failures = [];
      try {
        for (const candidate of candidates) {
          let activation;
          let failure;
          try {
            throwIfAborted(scope.signal);
            const options = agentOptionsFor(candidate, lane);
            const model = { provider: options?.provider ?? null, model: options?.model ?? null };
            // Startup receives the same deadline/cancellation signal. Drain its
            // admission before leaving, so a late handle cannot be orphaned.
            activation = await subagents.startActivation({
              provider: settings.subagentProvider ?? 'spawn',
              label: `workflow:${node.id}`,
              request: {
                prompt: [{ type: 'text', text: prompt }],
                parent: exec.agent,
                cwd: agentCwd,
                ...(options ? { agentOptions: options } : {}),
              },
              signal: scope.signal,
              delivery: 'caller',
            });
            const resultPromise = Promise.resolve(activation.result);
            // A fast rejection must stay handled while the activity checkpoint
            // is pending, even if that checkpoint subsequently fails.
            resultPromise.catch(() => {});
            throwIfAborted(scope.signal);
            if (onActivity) {
              try {
                await onActivity(token, { childId: activation.childId, ...model });
              } catch (error) {
                throw executionError('activity_persistence_failed', `cannot record child for ${node.id}: ${error.message ?? error}`, error);
              }
            }
            const result = await waitWithSignal(resultPromise, scope.signal);
            if (result?.stopReason === 'aborted') {
              throw executionError('execution_aborted', result.diagnostic ?? `agent ${node.id} was aborted`);
            }
            if (result?.stopReason !== 'completed') throw new Error(result?.diagnostic ?? `subagent stopped: ${result?.stopReason ?? 'unknown'}`);
            const parsed = parseAgentText(textOf(result?.output), { outcomes, fallback: outcomes[0] });
            return { ...parsed, model };
          } catch (error) {
            failure = cancellationError(error, scope.signal);
            if (['execution_aborted', 'execution_timeout', 'invalid_agent_output', 'activity_persistence_failed'].includes(failure.code)) throw failure;
            failures.push(`${candidateLabel(candidate)}: ${failure?.message ?? String(failure)}`);
          } finally {
            if (activation && typeof activation.dispose === 'function') {
              try {
                await activation.dispose();
              } catch (error) {
                // Never start another model while a previous child's release
                // failed. Preserve cancellation instead of hiding it in cleanup.
                if (failure) throw failure;
                throw cancellationError(executionError('activation_disposal_failed', `cannot release child for ${node.id}: ${error.message ?? error}`, error), scope.signal);
              }
            }
            throwIfAborted(scope.signal);
          }
        }
        throw new Error(`all model candidates failed: ${failures.join('; ')}`);
      } finally {
        scope.dispose();
      }
    },
    async command({ node }) {
      const commandCwd = node.config.cwd ? path.resolve(cwd, node.config.cwd) : cwd;
      const command = node.config.command;
      const scope = executionScope(exec.signal, node.config.timeoutMs ?? 120_000, `command ${node.id}`);
      try {
        throwIfAborted(scope.signal);
        await preflightCommand(command, commandCwd);
        throwIfAborted(scope.signal);
        try {
          const { stdout, stderr } = await execAsync(command, {
            cwd: commandCwd,
            signal: scope.signal,
            maxBuffer: 1_000_000,
            windowsHide: true,
          });
          throwIfAborted(scope.signal);
          return { outcome: 'complete', output: { stdout, stderr, code: 0, cwd: commandCwd, command } };
        } catch (error) {
          const failure = cancellationError(error, scope.signal);
          if (['execution_aborted', 'execution_timeout'].includes(failure.code)) throw failure;
          return {
            outcome: 'fail',
            output: { stdout: error.stdout ?? '', stderr: error.stderr ?? '', code: error.code ?? 1, cwd: commandCwd, command },
          };
        }
      } finally {
        scope.dispose();
      }
    },
    async http({ node }) {
      const scope = executionScope(exec.signal, node.config.timeoutMs ?? 30_000, `http ${node.id}`);
      try {
        throwIfAborted(scope.signal);
        const method = (node.config.method ?? 'GET').toUpperCase();
        const headers = { ...(node.config.headers ?? {}) };
        let body;
        if (node.config.body !== undefined) {
          body = typeof node.config.body === 'string' ? node.config.body : JSON.stringify(node.config.body);
          if (!Object.keys(headers).some(key => key.toLowerCase() === 'content-type')) headers['content-type'] = 'application/json';
        }
        const response = await waitWithSignal(fetch(node.config.url, { method, headers, body, signal: scope.signal }), scope.signal);
        const text = await waitWithSignal(response.text(), scope.signal);
        return {
          outcome: response.ok ? 'complete' : 'fail',
          output: { status: response.status, ok: response.ok, body: text.slice(0, 40_000) },
        };
      } catch (error) {
        throw cancellationError(error, scope.signal);
      } finally {
        scope.dispose();
      }
    },
  };
}

function executionError(code, message, cause) {
  return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), { code });
}

function executionScope(parentSignal, timeoutMs, label) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    throw executionError('invalid_execution_timeout', `${label} timeoutMs must be a positive integer no greater than 2147483647`);
  }
  const controller = new AbortController();
  const abort = () => controller.abort(executionError('execution_aborted', `${label} cancelled`, parentSignal?.reason));
  parentSignal?.addEventListener('abort', abort, { once: true });
  if (parentSignal?.aborted) abort();
  const timer = setTimeout(() => controller.abort(executionError('execution_timeout', `${label} exceeded ${timeoutMs}ms`)), timeoutMs);
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      parentSignal?.removeEventListener('abort', abort);
    },
  };
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason;
}

function cancellationError(error, signal) {
  if (signal.aborted) return signal.reason;
  if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') {
    return executionError('execution_aborted', error.message ?? 'execution aborted', error);
  }
  return error instanceof Error ? error : new Error(String(error));
}

function waitWithSignal(promise, signal) {
  // Attach to the producer even when already cancelled, containing a later
  // rejection while the activation's finally block drains its handle.
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    Promise.resolve(promise).then(
      value => { signal.removeEventListener('abort', abort); signal.aborted ? reject(signal.reason) : resolve(value); },
      error => { signal.removeEventListener('abort', abort); reject(signal.aborted ? signal.reason : error); },
    );
  });
}

async function preflightCommand(command, cwd) {
  // Check direct npm script invocations only. --prefix intentionally selects a
  // different project; shell programs that change directory own that behavior.
  const directNpmScript = /^\s*(?:npm(?:\.cmd|\.exe)?|["']npm(?:\.cmd|\.exe)?["'])\s+(?:test|t|run|run-script)(?:\s|$)/i.test(command);
  if (!directNpmScript || /(?:^|\s)--prefix(?:\s|=)/.test(command)) return;
  const manifest = path.join(cwd, 'package.json');
  try {
    if ((await stat(manifest)).isFile()) return;
  } catch (error) {
    if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
  }
  throw Object.assign(executionError('invalid_command_cwd', `cannot run ${command} in ${cwd}: package.json is missing; select the project cwd before retrying`), { cwd, command });
}

function modelCandidates(node, lane) {
  if (Array.isArray(node.config.models) && node.config.models.length > 0) {
    return node.config.models.map(entry => ({ provider: entry.provider ?? null, model: entry.model ?? null }));
  }
  const provider = node.config.provider ?? lane?.adapter ?? null;
  const model = node.config.model ?? lane?.model ?? null;
  if (provider !== null || model !== null) return [{ provider, model }];
  return [{ provider: null, model: null }];
}

function agentOptionsFor(candidate, lane) {
  const options = {};
  const provider = candidate.provider ?? lane?.adapter;
  const model = candidate.model ?? lane?.model;
  if (provider) options.provider = provider;
  if (model && model !== 'host-default') options.model = model;
  if (lane?.reasoningEffort) options.reasoningEffort = lane.reasoningEffort;
  if (lane?.maxTokens) options.maxTokens = lane.maxTokens;
  return Object.keys(options).length > 0 ? options : null;
}

function candidateLabel(candidate) {
  if (!candidate.provider && !candidate.model) return 'host-default';
  return `${candidate.provider ?? 'host-default'}/${candidate.model ?? 'host-default'}`;
}

export function agentPrompt({ definition, node, input, context, outcomes }) {  return [
    `You are executing node "${node.id}" of workflow "${definition.name}".`,
    node.role ? `Role: ${node.role}` : '',
    node.config.prompt ? `Instructions:\n${node.config.prompt}` : '',
    `Input:\n${JSON.stringify(input, null, 2)}`,
    `Context:\n${JSON.stringify(context, null, 2)}`,
    `Allowed outcomes: ${outcomes.join(', ')}`,
    'Do the work with the tools you have. Do not create workflows or spawn agents.',
    'Reply with a JSON object: {"outcome":"<one of the allowed outcomes>","output":<any JSON>}.',
    'Choose one outcome only when supported by the work. Never default to the first outcome; if none is justified, explain the uncertainty instead of claiming success.',
  ].filter(Boolean).join('\n\n');
}

export function parseAgentText(text, { outcomes, fallback = outcomes[0] }) {
  const trimmed = text.trim();
  const invalid = reason => executionError('invalid_agent_output', `${reason}; expected one explicit outcome: ${outcomes.join(', ')}`);
  if (trimmed === '') throw invalid('agent returned no text');
  if (outcomes.includes(trimmed)) return { outcome: trimmed, output: { text: trimmed } };

  let objects;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      if (outcomes.length === 1) return { outcome: outcomes[0], output: { text } };
      throw invalid('agent response is not an object');
    }
    objects = [{ value: parsed, end: trimmed.length }];
  } catch (error) {
    if (error.code === 'invalid_agent_output') throw error;
    // Accept fenced JSON and leading commentary without mistaking nested output
    // objects or braces inside strings for additional decisions.
    objects = jsonObjects(trimmed);
  }
  const decisions = objects.filter(({ value }) => Object.hasOwn(value, 'outcome'));
  if (decisions.length > 1) throw invalid('agent returned multiple decision objects');
  const candidate = decisions[0] ?? (objects.length === 1 ? objects[0] : null);
  if (candidate) {
    const suffix = trimmed.slice(candidate.end).trim();
    if (suffix !== '' && suffix !== '```') throw invalid('decision is not the final response');
    const parsed = candidate.value;
    if (Object.hasOwn(parsed, 'outcome') && !outcomes.includes(parsed.outcome)) throw invalid('agent returned an unknown outcome');
    if (!Object.hasOwn(parsed, 'outcome') && outcomes.length !== 1) throw invalid('agent omitted its outcome');
    return {
      outcome: parsed.outcome ?? outcomes[0],
      output: Object.hasOwn(parsed, 'output') ? parsed.output : parsed,
    };
  }
  if (outcomes.length !== 1 || !outcomes.includes(fallback)) throw invalid('agent response contains no unambiguous decision');
  return { outcome: outcomes[0], output: { text } };
}

function jsonObjects(text) {
  const objects = [];
  let start = -1;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (depth === 0) {
      if (char === '{') { start = index; depth = 1; }
      continue;
    }
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === '{') depth += 1;
    else if (char === '}' && --depth === 0) {
      try {
        objects.push({ value: JSON.parse(text.slice(start, index + 1)), end: index + 1 });
      } catch {
        // Prose/code braces are not a decision object.
      }
    }
  }
  return objects;
}

export function textOf(blocks) {
  if (!Array.isArray(blocks)) return '';
  return blocks.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n').trim();
}
