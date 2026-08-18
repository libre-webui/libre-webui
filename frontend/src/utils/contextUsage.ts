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

/**
 * How much of a model's context a conversation is holding.
 *
 * Two numbers exist and they are not the same. The provider reports what the
 * last prompt actually cost, which is the truth but only arrives after a
 * reply. Everything else is an estimate at four characters per token, the same
 * rule the server compacts by, so the meter and the compaction it warns about
 * cannot disagree with each other.
 */

import type { ChatMessage, GenerationOptions, OllamaModel } from '@/types';

/** The server's estimate, kept in step with `estimateChatTokens`. */
const MESSAGE_FRAMING_TOKENS = 4;

export const estimateTextTokens = (text: string | undefined): number =>
  text ? Math.ceil(text.length / 4) : 0;

export const estimateMessageTokens = (
  message: Pick<ChatMessage, 'content' | 'thinking'>
): number =>
  MESSAGE_FRAMING_TOKENS +
  estimateTextTokens(message.content) +
  estimateTextTokens(message.thinking);

export interface ContextUsageSegment {
  key: 'systemPrompt' | 'messages' | 'reasoning';
  tokens: number;
}

export interface ContextUsage {
  /** Tokens the next request starts from. */
  used: number;
  /** The model's window, when it is known. */
  budget?: number;
  /** 0 to 1 of the window, absent when there is no window to divide by. */
  ratio?: number;
  /** Whether `used` came from the provider rather than from counting characters. */
  measured: boolean;
  segments: ContextUsageSegment[];
}

/**
 * The window the next message runs against, in order of authority: what this
 * chat overrides, what the user pinned for the model, what the model itself
 * recommends, and finally the application default. Provider models carry the
 * window their listing published, which nothing local overrides.
 */
export function resolveContextBudget({
  model,
  sessionOptions,
  pinnedOptions,
  modelDefaults,
  globalOptions,
}: {
  model?: Pick<OllamaModel, 'isPlugin' | 'contextLength'>;
  sessionOptions?: Partial<GenerationOptions>;
  pinnedOptions?: Partial<GenerationOptions>;
  modelDefaults?: Partial<GenerationOptions>;
  globalOptions?: Partial<GenerationOptions>;
}): number | undefined {
  if (model?.isPlugin) {
    return model.contextLength;
  }

  // A window has to be a positive size. Pins written while a hosted model was
  // selected can carry -1, and a zero says nothing, so those fall through to
  // the next setting rather than emptying the meter.
  return [
    sessionOptions?.num_ctx,
    pinnedOptions?.num_ctx,
    modelDefaults?.num_ctx,
    globalOptions?.num_ctx,
  ].find(
    (budget): budget is number => typeof budget === 'number' && budget > 0
  );
}

/**
 * What the last exchange actually cost, when the provider said so: its prompt
 * plus the reply it produced is what the next prompt carries forward.
 */
export function measuredContextTokens(
  messages: readonly ChatMessage[]
): number | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== 'assistant') continue;
    const promptTokens = message.statistics?.prompt_eval_count;
    if (typeof promptTokens !== 'number') return undefined;
    return promptTokens + (message.statistics?.eval_count ?? 0);
  }

  return undefined;
}

export function buildContextUsage({
  messages,
  budget,
  systemPrompt,
}: {
  messages: readonly ChatMessage[];
  budget?: number;
  /** A persona or preference prompt the server adds, which no message holds. */
  systemPrompt?: string;
}): ContextUsage {
  let systemTokens = estimateTextTokens(systemPrompt);
  let messageTokens = 0;
  let reasoningTokens = 0;

  for (const message of messages) {
    if (message.role === 'system') {
      systemTokens += estimateMessageTokens(message);
      continue;
    }
    messageTokens +=
      MESSAGE_FRAMING_TOKENS + estimateTextTokens(message.content);
    reasoningTokens += estimateTextTokens(message.thinking);
  }

  const measured = measuredContextTokens(messages);
  const estimated = systemTokens + messageTokens + reasoningTokens;
  const used = measured ?? estimated;

  return {
    used,
    budget,
    ratio: budget ? Math.min(used / budget, 1) : undefined,
    measured: measured !== undefined,
    segments: [
      { key: 'systemPrompt', tokens: systemTokens },
      { key: 'messages', tokens: messageTokens },
      { key: 'reasoning', tokens: reasoningTokens },
    ],
  };
}

/** Token counts read at a glance: 138, 6.4k, 262k. */
export function formatTokenCount(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  const thousands = tokens / 1000;
  return `${thousands < 10 ? thousands.toFixed(1).replace(/\.0$/, '') : Math.round(thousands)}k`;
}
