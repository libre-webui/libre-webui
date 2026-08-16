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
 * Context compaction (admin-configured, off by default).
 *
 * When a conversation's estimated context grows past the threshold, the
 * older half of the history is summarized by a model into one system
 * message; the summarized originals stay stored and visible but drop out
 * of model context (`isActive: false`). The summary carries provenance in
 * its content and every compaction failure fails open: generation
 * continues with the uncompacted history.
 *
 * This service only *plans* a compaction — estimation, message selection,
 * and the summarizer call. Applying the plan (the session write under the
 * distributed lease) belongs to chatService, which keeps the import graph
 * acyclic.
 */

import { randomUUID } from 'node:crypto';
import chatGenerationService from './chatGenerationService.js';
import {
  getSystemSettings,
  setSystemSettings,
} from './systemSettingsService.js';
import type { ChatMessage, ChatSession } from '../types/index.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('services:context-compaction');

const ENABLED_KEY = 'chat_compaction_enabled';
const THRESHOLD_KEY = 'chat_compaction_threshold_tokens';
const KEEP_RECENT_KEY = 'chat_compaction_keep_recent';
const MODEL_KEY = 'chat_compaction_model';
const PROMPT_KEY = 'chat_compaction_prompt';

export interface CompactionConfig {
  enabled: boolean;
  /** Estimated tokens above which older history is summarized. */
  thresholdTokens: number;
  /** Recent messages always kept verbatim. */
  keepRecentMessages: number;
  /** Summarizer model; empty string means "the session's own model". */
  model: string;
  /** Custom prompt; empty string means the built-in prompt. */
  prompt: string;
}

const DEFAULTS: CompactionConfig = {
  enabled: false,
  thresholdTokens: 8000,
  keepRecentMessages: 8,
  model: '',
  prompt: '',
};

const boundedInteger = (
  raw: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number
): number => {
  const parsed = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, minimum), maximum);
};

export const getCompactionConfig = async (): Promise<CompactionConfig> => {
  try {
    const stored = await getSystemSettings([
      ENABLED_KEY,
      THRESHOLD_KEY,
      KEEP_RECENT_KEY,
      MODEL_KEY,
      PROMPT_KEY,
    ]);
    return {
      enabled: stored[ENABLED_KEY] === 'true',
      thresholdTokens: boundedInteger(
        stored[THRESHOLD_KEY],
        DEFAULTS.thresholdTokens,
        500,
        1_000_000
      ),
      keepRecentMessages: boundedInteger(
        stored[KEEP_RECENT_KEY],
        DEFAULTS.keepRecentMessages,
        2,
        200
      ),
      model: stored[MODEL_KEY] ?? '',
      prompt: stored[PROMPT_KEY] ?? '',
    };
  } catch (error) {
    logger.warn('Compaction settings unavailable; staying disabled:', error);
    return { ...DEFAULTS };
  }
};

export const setCompactionConfig = async (
  update: Partial<CompactionConfig>
): Promise<CompactionConfig> => {
  const changes: Record<string, string> = {};
  if (update.enabled !== undefined) {
    changes[ENABLED_KEY] = update.enabled ? 'true' : 'false';
  }
  if (update.thresholdTokens !== undefined) {
    changes[THRESHOLD_KEY] = String(
      boundedInteger(
        String(update.thresholdTokens),
        DEFAULTS.thresholdTokens,
        500,
        1_000_000
      )
    );
  }
  if (update.keepRecentMessages !== undefined) {
    changes[KEEP_RECENT_KEY] = String(
      boundedInteger(
        String(update.keepRecentMessages),
        DEFAULTS.keepRecentMessages,
        2,
        200
      )
    );
  }
  if (update.model !== undefined) changes[MODEL_KEY] = update.model.trim();
  if (update.prompt !== undefined) {
    changes[PROMPT_KEY] = update.prompt.slice(0, 8_000);
  }
  if (Object.keys(changes).length > 0) await setSystemSettings(changes);
  return getCompactionConfig();
};

/**
 * Rough context estimate: ~4 characters per token plus per-message
 * framing. Deliberately simple — the threshold is a coarse safety valve,
 * not billing.
 */
export const estimateChatTokens = (
  messages: readonly Pick<ChatMessage, 'content' | 'thinking'>[]
): number =>
  messages.reduce(
    (total, message) =>
      total +
      4 +
      Math.ceil((message.content?.length ?? 0) / 4) +
      Math.ceil((message.thinking?.length ?? 0) / 4),
    0
  );

const DEFAULT_PROMPT = `Summarize the conversation below so it can replace the original messages as context for the assistant. Preserve: the user's goals and constraints, decisions made, facts established, names/identifiers, code or file references, and any unresolved questions. Be concise but complete. Reply with the summary only.

{{PREVIOUS_SUMMARY}}

Conversation:
{{MESSAGES}}`;

export const COMPACTION_SUMMARY_PREFIX = '[Conversation summary] ';

export interface CompactionPlan {
  summaryMessage: ChatMessage;
  deactivateIds: string[];
}

/**
 * Decide whether this session needs compaction and produce the plan.
 * Returns null when compaction is disabled, unnecessary, or fails.
 */
export const planCompaction = async (
  session: ChatSession,
  userId: string
): Promise<CompactionPlan | null> => {
  try {
    const config = await getCompactionConfig();
    if (!config.enabled) return null;

    const active = session.messages.filter(
      message => message.isActive !== false
    );
    if (estimateChatTokens(active) <= config.thresholdTokens) return null;

    const nonSystem = active.filter(message => message.role !== 'system');
    if (nonSystem.length <= config.keepRecentMessages + 2) return null;

    // Keep the most recent messages, extended so the survivors start on a
    // user turn — a turn is never split across the summary boundary.
    let cut = nonSystem.length - config.keepRecentMessages;
    while (cut < nonSystem.length && nonSystem[cut].role !== 'user') cut += 1;
    const summarize = nonSystem.slice(0, cut);
    if (summarize.length === 0) return null;

    // A previous summary is folded into the new one and then deactivated.
    const previousSummary = active.find(
      message =>
        message.role === 'system' &&
        message.content.startsWith(COMPACTION_SUMMARY_PREFIX)
    );

    const transcript = summarize
      .map(message => `${message.role}: ${message.content}`)
      .join('\n\n');
    const promptTemplate = config.prompt.trim() || DEFAULT_PROMPT;
    const prompt = promptTemplate
      .replace(
        '{{PREVIOUS_SUMMARY}}',
        previousSummary
          ? `Earlier summary (fold into the new one):\n${previousSummary.content.slice(COMPACTION_SUMMARY_PREFIX.length)}`
          : ''
      )
      .replace('{{MESSAGES}}', transcript);

    const model = config.model.trim() || session.model;
    const target = await chatGenerationService.prepareGenerationTarget(
      model,
      userId,
      { temperature: 0.3 }
    );
    const result = await chatGenerationService.executeNonStreaming({
      target,
      ollamaMessages: [{ role: 'user', content: prompt }],
      pluginMessages: [
        {
          id: `compaction-${session.id}`,
          role: 'user',
          content: prompt,
          timestamp: Date.now(),
        },
      ],
      userId,
    });
    const summary = result.assistantContent.trim();
    if (!summary) return null;

    return {
      summaryMessage: {
        id: randomUUID(),
        role: 'system',
        content: `${COMPACTION_SUMMARY_PREFIX}${summary}`,
        timestamp: Date.now(),
      },
      deactivateIds: [
        ...summarize.map(message => message.id),
        ...(previousSummary ? [previousSummary.id] : []),
      ],
    };
  } catch (error) {
    // Fail open: a broken summarizer must never block generation.
    logger.warn(`Context compaction skipped for session ${session.id}:`, error);
    return null;
  }
};
