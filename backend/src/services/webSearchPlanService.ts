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
 * Planned web search: a chat message is rarely a good search query, so the
 * session's own model first turns it into a few keyword queries plus an
 * optional freshness window and engine category. Every failure along the
 * way — planning, parsing, individual searches — degrades to the plain
 * raw-message search this replaced, never below it.
 */

import chatGenerationService from './chatGenerationService.js';
import {
  getWebSearchConfig,
  webSearch,
  WebSearchCategory,
  WebSearchResult,
  WebSearchTimeRange,
} from './webSearchService.js';
import { normalizeChatProviderSelection } from '../utils/chatProviderSelection.js';
import { throwIfChatGenerationCancelled } from '../utils/chatCancellation.js';
import { createLogger } from '../utils/logger.js';
import { ChatSession } from '../types/index.js';

const logger = createLogger('services:web-search-plan');

const PLAN_MESSAGE_MAX_CHARS = 2_000;
const PLAN_QUERY_MAX_CHARS = 200;
const PLAN_MAX_QUERIES = 3;

const TIME_RANGES: readonly string[] = ['day', 'week', 'month', 'year'];
const CATEGORIES: readonly string[] = ['news', 'science', 'it'];

interface WebSearchPlan {
  queries: string[];
  timeRange?: WebSearchTimeRange;
  category?: WebSearchCategory;
}

export interface PlannedWebSearchOutcome {
  results: WebSearchResult[];
  /** The queries that were actually sent to the search engine. */
  queries: string[];
}

const buildPlanPrompt = (message: string): string =>
  `Turn the user message below into web search queries. Answer with only a JSON object in exactly this shape, no other text:
{"queries": ["..."], "time_range": "day" | "week" | "month" | "year" | null, "category": "news" | "science" | "it" | null}

Rules:
- 1 to ${PLAN_MAX_QUERIES} short keyword queries that together cover the message. Use search keywords, not sentences or instructions.
- Set time_range only when the message asks for recent information: "last 24 hours" or "today" means "day", "this week" means "week", "this month" means "month".
- Set category to "news" for current events, "science" for research and papers, "it" for software topics; otherwise null.

User message:
"""
${message.slice(0, PLAN_MESSAGE_MAX_CHARS)}
"""`;

const parsePlan = (raw: string): WebSearchPlan | null => {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const queries = (Array.isArray(record.queries) ? record.queries : [])
    .filter((query): query is string => typeof query === 'string')
    .map(query =>
      query.replace(/\s+/g, ' ').trim().slice(0, PLAN_QUERY_MAX_CHARS)
    )
    .filter(query => query.length > 0)
    .slice(0, PLAN_MAX_QUERIES);
  if (queries.length === 0) return null;
  return {
    queries,
    ...(typeof record.time_range === 'string' &&
    TIME_RANGES.includes(record.time_range)
      ? { timeRange: record.time_range as WebSearchTimeRange }
      : {}),
    ...(typeof record.category === 'string' &&
    CATEGORIES.includes(record.category)
      ? { category: record.category as WebSearchCategory }
      : {}),
  };
};

const planWebSearch = async (
  message: string,
  session: ChatSession,
  userId: string,
  signal?: AbortSignal
): Promise<WebSearchPlan | null> => {
  const target = await chatGenerationService.prepareGenerationTarget(
    session.model,
    userId,
    { temperature: 0.1, num_predict: 256 },
    normalizeChatProviderSelection(session),
    signal
  );
  const prompt = buildPlanPrompt(message);
  const result = await chatGenerationService.executeNonStreaming({
    target,
    ollamaMessages: [{ role: 'user', content: prompt }],
    pluginMessages: [
      {
        id: `web-search-plan-${session.id}`,
        role: 'user',
        content: prompt,
        timestamp: Date.now(),
      },
    ],
    userId,
    signal,
  });
  return parsePlan(result.assistantContent);
};

const rawMessageSearch = async (
  message: string,
  signal?: AbortSignal
): Promise<PlannedWebSearchOutcome> => ({
  results: await webSearch(message, undefined, signal),
  queries: [message],
});

export async function runPlannedWebSearch(input: {
  message: string;
  session: ChatSession;
  userId: string;
  signal?: AbortSignal;
}): Promise<PlannedWebSearchOutcome> {
  let plan: WebSearchPlan | null = null;
  try {
    plan = await planWebSearch(
      input.message,
      input.session,
      input.userId,
      input.signal
    );
  } catch (error) {
    throwIfChatGenerationCancelled(input.signal);
    logger.warn('Web search planning failed; using the raw message:', error);
  }
  if (!plan) {
    return rawMessageSearch(input.message, input.signal);
  }

  const { maxResults } = await getWebSearchConfig();
  const perQuery = Math.max(1, Math.ceil(maxResults / plan.queries.length));
  const options = { timeRange: plan.timeRange, category: plan.category };
  const perQueryResults = await Promise.all(
    plan.queries.map(async query => {
      try {
        return await webSearch(query, perQuery, input.signal, options);
      } catch (error) {
        throwIfChatGenerationCancelled(input.signal);
        logger.warn(`Planned web search "${query}" failed:`, error);
        return [] as WebSearchResult[];
      }
    })
  );

  // Round-robin merge so every query contributes before any one dominates,
  // deduplicated by URL and bounded by the administrator's ceiling.
  const merged: WebSearchResult[] = [];
  const seen = new Set<string>();
  for (let rank = 0; rank < perQuery && merged.length < maxResults; rank++) {
    for (const results of perQueryResults) {
      const result = results[rank];
      if (!result || seen.has(result.url)) continue;
      seen.add(result.url);
      merged.push(result);
      if (merged.length >= maxResults) break;
    }
  }
  if (merged.length > 0) {
    return { results: merged, queries: plan.queries };
  }

  // A plan that finds nothing falls back to the raw message so the planned
  // search never returns less than the unplanned one would have.
  try {
    return await rawMessageSearch(input.message, input.signal);
  } catch (error) {
    throwIfChatGenerationCancelled(input.signal);
    logger.warn('Fallback web search failed:', error);
    return { results: [], queries: plan.queries };
  }
}

export default { runPlannedWebSearch };
