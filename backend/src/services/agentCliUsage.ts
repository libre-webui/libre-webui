/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at:
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/** Reported CLI token snapshots; never estimate usage from emitted text. */
import type { ProviderTokenUsage } from './pluginUsageService.js';

type Counts = Partial<
  Record<
    'input' | 'output' | 'cacheRead' | 'cacheWrite' | 'reasoning' | 'total',
    number
  >
>;
export interface AgentCliUsageState {
  parts: Map<string, Counts>;
  aggregate?: ProviderTokenUsage;
  claudeMessages: Map<string, string>;
  piTurn: number;
}

interface UsageCarrier {
  usage?: AgentCliUsageState;
}

const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const count = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

function counts(
  raw: unknown,
  fields: Partial<Record<keyof Counts, string>>
): Counts | undefined {
  const value = object(raw);
  if (!value) return undefined;
  const result: Counts = {};
  for (const [target, source] of Object.entries(fields)) {
    if (count(value[source])) result[target as keyof Counts] = value[source];
  }
  return Object.keys(result).length ? result : undefined;
}

function total(parts: readonly Counts[]): ProviderTokenUsage | undefined {
  if (!parts.length) return undefined;
  const result = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  for (const part of parts) {
    const prompt =
      (part.input ?? 0) + (part.cacheRead ?? 0) + (part.cacheWrite ?? 0);
    const output = (part.output ?? 0) + (part.reasoning ?? 0);
    result.promptTokens += prompt;
    result.completionTokens += output;
    result.totalTokens += part.total ?? prompt + output;
  }
  return Object.values(result).every(count) ? result : undefined;
}

function snapshot(
  state: AgentCliUsageState,
  key: string,
  next: Counts | undefined
): void {
  if (!next) return;
  const merged = { ...state.parts.get(key), ...next };
  // A partial snapshot without a total cannot retain a previous stale total.
  if (next.total === undefined) delete merged.total;
  state.parts.set(key, merged);
}

export function agentCliTokenUsage(
  state: AgentCliUsageState | undefined
): ProviderTokenUsage | undefined {
  return (
    state?.aggregate ?? (state ? total([...state.parts.values()]) : undefined)
  );
}

/**
 * Source contracts: Codex rust-v0.154.0 exec JSONL uses ThreadTokenUsage.total;
 * OpenCode v1.18.31 step-finish uses disjoint input/cache and output/reasoning;
 * Pi 0.84.3 JSON events repeat per-turn usage; Claude SDK result.modelUsage is
 * query-cumulative and includes main-loop/subagent/auxiliary model calls.
 */
export function captureAgentCliUsage(
  parser: 'claude' | 'codex' | 'opencode' | 'pi',
  event: Record<string, unknown>,
  carrier: UsageCarrier
): void {
  const state: AgentCliUsageState = (carrier.usage ??= {
    parts: new Map<string, Counts>(),
    claudeMessages: new Map<string, string>(),
    piTurn: 0,
  });
  if (parser === 'codex') {
    if (event.type === 'turn.completed') {
      // Cached input and reasoning output are subsets, already included.
      const next = counts(event.usage, {
        input: 'input_tokens',
        output: 'output_tokens',
      });
      if (next) state.aggregate = total([next]);
    }
    return;
  }
  if (parser === 'opencode') {
    const part = object(event.part);
    if (part?.type !== 'step-finish' || typeof part.id !== 'string' || !part.id)
      return;
    const raw = object(part.tokens);
    const next = counts(raw, {
      input: 'input',
      output: 'output',
      reasoning: 'reasoning',
      total: 'total',
    });
    const cached = counts(raw?.cache, {
      cacheRead: 'read',
      cacheWrite: 'write',
    });
    if (next || cached)
      snapshot(state, `opencode:${part.id}`, { ...next, ...cached });
    return;
  }
  if (parser === 'claude') {
    const fields = {
      input: 'input_tokens',
      output: 'output_tokens',
      cacheRead: 'cache_read_input_tokens',
      cacheWrite: 'cache_creation_input_tokens',
    };
    if (event.type === 'result') {
      const modelUsage = object(event.modelUsage);
      const models = modelUsage
        ? Object.values(modelUsage).flatMap(value => {
            const next = counts(value, {
              input: 'inputTokens',
              output: 'outputTokens',
              cacheRead: 'cacheReadInputTokens',
              cacheWrite: 'cacheCreationInputTokens',
            });
            return next ? [next] : [];
          })
        : [];
      const fallback = counts(event.usage, fields);
      const aggregate = total(
        models.length ? models : fallback ? [fallback] : []
      );
      // Startup/crash results may zero their accounting. Do not discard
      // positive per-message counters already observed on a failed run.
      if (
        aggregate &&
        !(
          event.is_error &&
          aggregate.totalTokens === 0 &&
          (agentCliTokenUsage(state)?.totalTokens ?? 0) > 0
        )
      )
        state.aggregate = aggregate;
      return;
    }
    const inner =
      event.type === 'stream_event' ? object(event.event) : undefined;
    const message = object(inner?.message ?? event.message);
    const scope =
      typeof event.parent_tool_use_id === 'string'
        ? event.parent_tool_use_id
        : 'main';
    if (typeof message?.id === 'string' && message.id)
      state.claudeMessages.set(scope, message.id);
    const messageId = state.claudeMessages.get(scope);
    if (inner?.type === 'message_start' || event.type === 'assistant') {
      if (messageId)
        snapshot(state, `claude:${messageId}`, counts(message?.usage, fields));
    } else if (inner?.type === 'message_delta' && messageId) {
      snapshot(state, `claude:${messageId}`, counts(inner.usage, fields));
    }
    return;
  }
  if (event.type === 'turn_start') {
    state.piTurn++;
    return;
  }
  const message = object(event.message);
  const inner = object(event.assistantMessageEvent);
  const raw =
    event.type === 'message_update'
      ? (event.usage ?? message?.usage)
      : message?.usage;
  const next = counts(raw, {
    input: 'input',
    output: 'output',
    cacheRead: 'cacheRead',
    cacheWrite: 'cacheWrite',
    total: 'totalTokens',
  });
  if (
    ['message_update', 'message_end', 'turn_end'].includes(
      String(event.type)
    ) &&
    (event.type === 'message_update' || message?.role === 'assistant') &&
    next
  ) {
    // Pi initializes streaming usage to zero before any provider report. Only
    // completed/error snapshots can establish a genuinely reported zero.
    const terminal =
      event.type !== 'message_update' ||
      inner?.type === 'done' ||
      inner?.type === 'error';
    if (terminal || (total([next])?.totalTokens ?? 0) > 0)
      snapshot(state, `pi:${state.piTurn}`, next);
  } else if (
    event.type === 'agent_end' &&
    !state.parts.size &&
    Array.isArray(event.messages)
  ) {
    // Older producers may expose only the final complete message list.
    event.messages.forEach((value, index) => {
      const item = object(value);
      if (item?.role === 'assistant')
        snapshot(
          state,
          `pi-final:${index}`,
          counts(item.usage, {
            input: 'input',
            output: 'output',
            cacheRead: 'cacheRead',
            cacheWrite: 'cacheWrite',
            total: 'totalTokens',
          })
        );
    });
  }
}
