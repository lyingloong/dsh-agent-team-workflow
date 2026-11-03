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

const execAsync = promisify(exec);

export function createExecutors({ ctx, exec, settings, cwd }) {
  const subagents = ctx.get?.('subagents');
  return {
    async agent({ node, input, context, definition }) {
      if (!subagents || typeof subagents.startActivation !== 'function') {
        throw new Error('no subagent service is mounted');
      }
      const lane = definition.providers.find(provider => provider.id === node.config.lane) ?? null;
      const agentOptions = {};
      if (lane?.adapter) agentOptions.provider = lane.adapter;
      if (lane?.model && lane.model !== 'host-default') agentOptions.model = lane.model;
      if (lane?.reasoningEffort) agentOptions.reasoningEffort = lane.reasoningEffort;
      if (lane?.maxTokens) agentOptions.maxTokens = lane.maxTokens;
      const outcomes = Array.isArray(node.config.outcomes) && node.config.outcomes.length > 0
        ? node.config.outcomes
        : node.config.outcome ? [node.config.outcome] : ['complete'];
      const prompt = agentPrompt({ definition, node, input, context, outcomes });
      const activation = await subagents.startActivation({
        provider: settings.subagentProvider,
        label: `workflow:${node.id}`,
        request: {
          prompt: [{ type: 'text', text: prompt }],
          parent: exec.agent,
          cwd,
          ...(Object.keys(agentOptions).length > 0 ? { agentOptions } : {}),
        },
        signal: exec.signal,
        delivery: 'caller',
      });
      const result = await activation.result;
      if (result?.stopReason !== 'completed') throw new Error(result?.diagnostic ?? `subagent stopped: ${result?.stopReason ?? 'unknown'}`);
      return parseAgentText(textOf(result?.output), { outcomes, fallback: outcomes[0] });
    },
    async command({ node }) {
      try {
        const { stdout, stderr } = await execAsync(node.config.command, {
          cwd: node.config.cwd ? path.resolve(cwd, node.config.cwd) : cwd,
          timeout: node.config.timeoutMs ?? 120_000,
          maxBuffer: 1_000_000,
          windowsHide: true,
        });
        return { outcome: 'complete', output: { stdout, stderr, code: 0 } };
      } catch (error) {
        return {
          outcome: 'fail',
          output: { stdout: error.stdout ?? '', stderr: error.stderr ?? '', code: error.code ?? 1 },
        };
      }
    },
    async http({ node }) {
      const method = (node.config.method ?? 'GET').toUpperCase();
      const headers = { ...(node.config.headers ?? {}) };
      let body;
      if (node.config.body !== undefined) {
        body = typeof node.config.body === 'string' ? node.config.body : JSON.stringify(node.config.body);
        if (!Object.keys(headers).some(key => key.toLowerCase() === 'content-type')) headers['content-type'] = 'application/json';
      }
      const response = await fetch(node.config.url, {
        method,
        headers,
        body,
        signal: AbortSignal.timeout(node.config.timeoutMs ?? 30_000),
      });
      const text = await response.text();
      return {
        outcome: response.ok ? 'complete' : 'fail',
        output: { status: response.status, ok: response.ok, body: text.slice(0, 40_000) },
      };
    },
  };
}

export function agentPrompt({ definition, node, input, context, outcomes }) {
  return [
    `You are executing node "${node.id}" of workflow "${definition.name}".`,
    node.role ? `Role: ${node.role}` : '',
    node.config.prompt ? `Instructions:\n${node.config.prompt}` : '',
    `Input:\n${JSON.stringify(input, null, 2)}`,
    `Context:\n${JSON.stringify(context, null, 2)}`,
    `Allowed outcomes: ${outcomes.join(', ')}`,
    'Do the work with the tools you have. Do not create workflows or spawn agents.',
    'Reply with a JSON object: {"outcome":"<one of the allowed outcomes>","output":<any JSON>}.',
    'If you cannot decide an outcome, use the first allowed outcome and explain in output.',
  ].filter(Boolean).join('\n\n');
}

export function parseAgentText(text, { outcomes, fallback }) {
  const trimmed = text.trim();
  if (trimmed !== '') {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed !== null && typeof parsed === 'object') {
        const outcome = outcomes.includes(parsed.outcome) ? parsed.outcome : fallback;
        return { outcome, output: parsed.output ?? parsed };
      }
    } catch {
      // Plain text is a valid output.
    }
    if (outcomes.includes(trimmed)) return { outcome: trimmed, output: { text: trimmed } };
  }
  return { outcome: fallback, output: { text } };
}

export function textOf(blocks) {
  if (!Array.isArray(blocks)) return '';
  return blocks.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n').trim();
}
