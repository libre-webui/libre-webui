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
 * The count is anchored to what the provider reported for the last completed
 * reply — the truth about what the prompt actually cost — and everything the
 * conversation added since then is estimated at four characters per token,
 * the same rule the server compacts by. Only messages the server would
 * actually send are counted: deactivated branches, compacted history, and
 * turns older than the rolling window cost nothing.
 */

import type { ChatMessage, GenerationOptions, OllamaModel } from '@/types';

/** The server's estimate, kept in step with `estimateChatTokens`. */
const MESSAGE_FRAMING_TOKENS = 4;

/**
 * Mirrors the server's `selectChatMessagesForContext` default: active system
 * messages plus the most recent active conversation turns, aligned to start
 * on a user turn. If the server default changes, change this with it.
 */
const CONTEXT_WINDOW_MESSAGES = 10;

/** Mirrors the server's compaction summary marker in `chatContext.ts`. */
export const COMPACTION_SUMMARY_PREFIX = '[Conversation summary] ';

export const isCompactionSummaryContent = (content: string): boolean =>
  content.startsWith(COMPACTION_SUMMARY_PREFIX);

// CJK scripts tokenize near one token per character rather than one per
// four. Kept in step with the server's copy in `contextCompactionService.ts`.
const CJK_PATTERN =
  /[\u1100-\u11FF\u2E80-\uA4CF\uAC00-\uD7AF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFFEF]/g;

/** A vision model spends real tokens per image; same flat cost as the server. */
const IMAGE_TOKEN_ESTIMATE = 768;

export const estimateTextTokens = (text: string | undefined): number => {
  if (!text) return 0;
  const cjkCharacters = text.match(CJK_PATTERN)?.length ?? 0;
  return cjkCharacters + Math.ceil((text.length - cjkCharacters) / 4);
};

export const estimateMessageTokens = (
  message: Pick<ChatMessage, 'content' | 'thinking' | 'images'>
): number =>
  MESSAGE_FRAMING_TOKENS +
  estimateTextTokens(message.content) +
  estimateTextTokens(message.thinking) +
  (message.images?.length ?? 0) * IMAGE_TOKEN_ESTIMATE;

export interface ContextUsage {
  /** Tokens the next request starts from. */
  used: number;
  /** The model's window, when it is known. */
  budget?: number;
  /**
   * Fraction of the window, absent when there is no window to divide by.
   * Deliberately not clamped: past 1 the conversation is over budget, which
   * is worth showing rather than rounding away.
   */
  ratio?: number;
  /** Whether `used` is anchored to a provider-reported count. */
  measured: boolean;
}

/**
 * The window the next message runs against, in order of authority: what this
 * chat overrides, what the user pinned for the model, what the model itself
 * recommends, and finally the application default. Provider models carry the
 * window their listing published, which nothing local overrides. A model that
 * is not resolved yet — the list still loading, an agent, a persona alias —
 * has no known window: Ollama defaults must not stand in for it.
 */
export function resolveContextBudget({
  model,
  sessionOptions,
  pinnedOptions,
  modelDefaults,
  globalOptions,
}: {
  model?: Pick<OllamaModel, 'isPlugin' | 'contextLength'> & {
    isAgent?: boolean;
  };
  sessionOptions?: Partial<GenerationOptions>;
  pinnedOptions?: Partial<GenerationOptions>;
  modelDefaults?: Partial<GenerationOptions>;
  globalOptions?: Partial<GenerationOptions>;
}): number | undefined {
  if (!model || model.isAgent) {
    return undefined;
  }
  if (model.isPlugin) {
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
 * The messages the server would send with the next request: mirrors
 * `selectChatMessagesForContext` so the meter measures the actual prompt,
 * not the whole transcript.
 */
export function selectContextMessages(
  messages: readonly ChatMessage[],
  windowMessages: number = CONTEXT_WINDOW_MESSAGES
): ChatMessage[] {
  const active = messages.filter(message => message.isActive !== false);
  const system = active.filter(message => message.role === 'system');
  const conversation = active
    .filter(message => message.role !== 'system')
    .slice(-Math.max(1, windowMessages));
  const firstUserIndex = conversation.findIndex(
    message => message.role === 'user'
  );
  return [
    ...system,
    ...(firstUserIndex >= 0 ? conversation.slice(firstUserIndex) : []),
  ];
}

interface MeasuredAnchor {
  /** Prompt plus reply of the last exchange the provider measured. */
  tokens: number;
  /** Index into the full message list of the reply that reported it. */
  index: number;
}

/**
 * The last provider-measured exchange, skipping replies that have not
 * reported yet — the placeholder of a streaming reply must not flip the
 * meter from measured to estimated and back every turn.
 */
function measuredAnchor(
  messages: readonly ChatMessage[]
): MeasuredAnchor | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== 'assistant' || message.isActive === false) continue;
    const promptTokens = message.statistics?.prompt_eval_count;
    if (typeof promptTokens !== 'number') continue;
    return {
      tokens: promptTokens + (message.statistics?.eval_count ?? 0),
      index,
    };
  }

  return undefined;
}

export function buildContextUsage({
  messages,
  budget,
  systemPrompt,
  windowMessages,
}: {
  messages: readonly ChatMessage[];
  budget?: number;
  /** A persona or preference prompt the server adds, which no message holds. */
  systemPrompt?: string;
  /** The server's rolling window, when it has said; defaults to the mirror. */
  windowMessages?: number;
}): ContextUsage {
  // A persona prompt replaces stored system messages on the server, except a
  // compaction summary — count what is actually sent.
  const hasPersonaPrompt = Boolean(systemPrompt?.trim());
  const sent = selectContextMessages(messages, windowMessages).filter(
    message =>
      !hasPersonaPrompt ||
      message.role !== 'system' ||
      isCompactionSummaryContent(message.content)
  );

  const anchor = measuredAnchor(messages);
  if (anchor === undefined) {
    const estimated =
      estimateTextTokens(systemPrompt) +
      sent.reduce(
        (total, message) => total + estimateMessageTokens(message),
        0
      );
    return {
      used: estimated,
      budget,
      ratio: budget ? estimated / budget : undefined,
      measured: false,
    };
  }

  // Measured base plus an estimate of what the conversation added since the
  // provider last reported: stable while a reply streams, and it converges
  // back onto the measured number when the reply completes.
  let tailTokens = 0;
  for (let index = anchor.index + 1; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.isActive !== false) {
      tailTokens += estimateMessageTokens(message);
    }
  }

  const used = anchor.tokens + tailTokens;
  return {
    used,
    budget,
    ratio: budget ? used / budget : undefined,
    measured: true,
  };
}

/**
 * Token counts read at a glance — 138, 6.4K, 262K — in the reader's own
 * digits and notation.
 */
export function formatTokenCount(tokens: number, locale?: string): string {
  try {
    return new Intl.NumberFormat(locale, {
      notation: 'compact',
      maximumFractionDigits: 1,
    }).format(tokens);
  } catch {
    return String(tokens);
  }
}
