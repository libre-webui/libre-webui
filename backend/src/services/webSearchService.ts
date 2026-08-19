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
 * Web search through a SearXNG instance. The connection is an
 * administrator-managed persisted setting (the SEARXNG_URL environment
 * variable seeds the default, so the bundled deploy stack works out of the
 * box once an admin flips the toggle). Search stays off until enabled.
 *
 * The backend queries SearXNG's JSON API server-side; result text is
 * bounded before it reaches any model context. The URL is admin-supplied
 * configuration — treated like the Ollama endpoint, not user input.
 */

import { createLogger } from '../utils/logger.js';
import { throwIfChatGenerationCancelled } from '../utils/chatCancellation.js';
import {
  getSystemSetting,
  getSystemSettings,
  setSystemSetting,
  setSystemSettings,
} from './systemSettingsService.js';

const logger = createLogger('services:web-search');

export const WEB_SEARCH_ENABLED_KEY = 'web_search_enabled';
export const WEB_SEARCH_URL_KEY = 'web_search_url';
export const WEB_SEARCH_ACCESS_KEY = 'web_search_access';
export const WEB_SEARCH_MAX_RESULTS_KEY = 'web_search_max_results';
export const WEB_SEARCH_SAFE_SEARCH_KEY = 'web_search_safe_search';

export const WEB_SEARCH_DEFAULT_MAX_RESULTS = 6;
export const WEB_SEARCH_RESULTS_CEILING = 100;

export type WebSearchAccessMode = 'admins' | 'all-users';

export type WebSearchTimeRange = 'day' | 'week' | 'month' | 'year';
export type WebSearchCategory = 'news' | 'science' | 'it';

export interface WebSearchRequestOptions {
  timeRange?: WebSearchTimeRange;
  category?: WebSearchCategory;
}

export function isWebSearchAccessMode(
  value: unknown
): value is WebSearchAccessMode {
  return value === 'admins' || value === 'all-users';
}

const SEARCH_TIMEOUT_MS = 12_000;
const RESULT_TEXT_MAX_CHARS = 500;
const QUERY_MAX_CHARS = 400;

export interface WebSearchResult {
  title: string;
  url: string;
  content: string;
  engine?: string;
}

export interface WebSearchConfig {
  enabled: boolean;
  url: string;
  /** Enabled and a URL is set — search can actually run. */
  available: boolean;
  /** Admin ceiling on results per search, 1-100. */
  maxResults: number;
  safeSearch: boolean;
}

export function normalizeWebSearchMaxResults(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return WEB_SEARCH_DEFAULT_MAX_RESULTS;
  return Math.min(Math.max(parsed, 1), WEB_SEARCH_RESULTS_CEILING);
}

async function readSetting(key: string): Promise<string | undefined> {
  try {
    return (await getSystemSetting(key)) ?? undefined;
  } catch {
    return undefined;
  }
}

export function normalizeWebSearchUrl(value: unknown): string {
  if (typeof value !== 'string') return '';
  // Strip trailing slashes without a regex: an end-anchored /\/+$/ backtracks
  // polynomially on a long run of slashes (CodeQL js/polynomial-redos).
  let trimmed = value.trim();
  let end = trimmed.length;
  while (end > 0 && trimmed.charCodeAt(end - 1) === 0x2f) {
    end--;
  }
  trimmed = trimmed.slice(0, end);
  if (!trimmed) return '';
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('Search URL must be a valid http(s) URL.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Search URL must use http or https.');
  }
  return trimmed;
}

export async function getWebSearchConfig(): Promise<WebSearchConfig> {
  const stored = await getSystemSettings([
    WEB_SEARCH_ENABLED_KEY,
    WEB_SEARCH_URL_KEY,
    WEB_SEARCH_MAX_RESULTS_KEY,
    WEB_SEARCH_SAFE_SEARCH_KEY,
  ]);
  const enabled = stored[WEB_SEARCH_ENABLED_KEY] === 'true';
  const storedUrl = stored[WEB_SEARCH_URL_KEY];
  const url =
    storedUrl !== undefined ? storedUrl : (process.env.SEARXNG_URL ?? '');
  const storedMax = stored[WEB_SEARCH_MAX_RESULTS_KEY];
  return {
    enabled,
    url,
    available: enabled && url.length > 0,
    maxResults:
      storedMax !== undefined
        ? normalizeWebSearchMaxResults(storedMax)
        : WEB_SEARCH_DEFAULT_MAX_RESULTS,
    // Safe search is on unless an administrator turned it off.
    safeSearch: stored[WEB_SEARCH_SAFE_SEARCH_KEY] !== 'false',
  };
}

export async function setWebSearchConfig(input: {
  enabled: boolean;
  url: string;
  maxResults?: number;
  safeSearch?: boolean;
}): Promise<WebSearchConfig> {
  const url = normalizeWebSearchUrl(input.url);
  if (input.enabled && !url) {
    throw new Error('Enable web search only with a SearXNG URL configured.');
  }
  const updates: Record<string, string> = {
    [WEB_SEARCH_ENABLED_KEY]: input.enabled ? 'true' : 'false',
    [WEB_SEARCH_URL_KEY]: url,
  };
  if (input.maxResults !== undefined) {
    updates[WEB_SEARCH_MAX_RESULTS_KEY] = String(
      normalizeWebSearchMaxResults(input.maxResults)
    );
  }
  if (input.safeSearch !== undefined) {
    updates[WEB_SEARCH_SAFE_SEARCH_KEY] = input.safeSearch ? 'true' : 'false';
  }
  await setSystemSettings(updates);
  return getWebSearchConfig();
}

export async function isWebSearchAvailable(): Promise<boolean> {
  return (await getWebSearchConfig()).available;
}

/**
 * Who may use web search, mirroring the Work access mode: administrators
 * always may; other active users only when an administrator opens it up in
 * User Management. Defaults to admins-only and fails closed.
 */
export async function getWebSearchAccessMode(): Promise<WebSearchAccessMode> {
  const value = await readSetting(WEB_SEARCH_ACCESS_KEY);
  return isWebSearchAccessMode(value) ? value : 'admins';
}

export async function setWebSearchAccessMode(
  mode: WebSearchAccessMode
): Promise<void> {
  if (!isWebSearchAccessMode(mode)) {
    throw new Error(`Invalid web search access mode "${String(mode)}".`);
  }
  await setSystemSetting(WEB_SEARCH_ACCESS_KEY, mode);
}

/** Whether this user may run web searches right now (search must also be available). */
export async function userCanUseWebSearch(
  user: { id?: string; role?: string; status?: string } | undefined | null
): Promise<boolean> {
  if (!user) return false;
  const { authorize } = await import('./authorizationService.js');
  const decision = await authorize(
    { userId: user.id ?? '', role: user.role, status: user.status },
    'use',
    { type: 'feature', id: 'web-search' }
  );
  return decision.allowed;
}

interface SearxngResult {
  title?: unknown;
  url?: unknown;
  content?: unknown;
  engine?: unknown;
}

const bounded = (value: unknown, max: number): string =>
  typeof value === 'string'
    ? value.replace(/\s+/g, ' ').trim().slice(0, max)
    : '';

export async function webSearch(
  query: string,
  maxResults?: number,
  signal?: AbortSignal,
  options?: WebSearchRequestOptions
): Promise<WebSearchResult[]> {
  throwIfChatGenerationCancelled(signal);
  const config = await getWebSearchConfig();
  if (!config.available) {
    throw new Error('Web search is not enabled on this server.');
  }
  const trimmedQuery = query.trim().slice(0, QUERY_MAX_CHARS);
  if (!trimmedQuery) {
    throw new Error('A search query is required.');
  }
  // Callers (including model tool calls) can request fewer results, never
  // more than the administrator's ceiling.
  const requested =
    maxResults === undefined
      ? config.maxResults
      : Math.max(1, Math.trunc(maxResults));
  const limit = Math.min(requested, config.maxResults);

  const target = new URL(`${config.url}/search`);
  target.searchParams.set('q', trimmedQuery);
  target.searchParams.set('format', 'json');
  target.searchParams.set('safesearch', config.safeSearch ? '1' : '0');
  if (options?.timeRange) {
    target.searchParams.set('time_range', options.timeRange);
  }
  if (options?.category) {
    target.searchParams.set('categories', options.category);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
  const cancel = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  let response: globalThis.Response;
  try {
    response = await fetch(target, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
  } catch (error) {
    throwIfChatGenerationCancelled(signal);
    logger.warn('Web search request failed:', error);
    throw new Error(
      'The search service could not be reached. Check the SearXNG URL.'
    );
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
  if (!response.ok) {
    throw new Error(
      `The search service answered with HTTP ${response.status}. Confirm the instance allows the JSON format.`
    );
  }
  let payload: { results?: SearxngResult[] };
  try {
    payload = (await response.json()) as { results?: SearxngResult[] };
  } catch {
    throw new Error(
      'The search service did not return JSON. Enable the json format in the SearXNG settings.'
    );
  }

  const results: WebSearchResult[] = [];
  for (const raw of payload.results ?? []) {
    const url = typeof raw.url === 'string' ? raw.url.trim() : '';
    if (!/^https?:\/\//i.test(url)) continue;
    results.push({
      title: bounded(raw.title, 200) || url,
      url: url.slice(0, 1_000),
      content: bounded(raw.content, RESULT_TEXT_MAX_CHARS),
      ...(typeof raw.engine === 'string' ? { engine: raw.engine } : {}),
    });
    if (results.length >= limit) break;
  }
  return results;
}

/**
 * The latest user message enhanced with search context, mirroring the
 * document-RAG enhancement shape so every provider path benefits.
 */
export function buildWebSearchEnhancedContent(
  content: string,
  results: readonly WebSearchResult[],
  query: string
): string {
  if (results.length === 0) return content;
  const blocks = results.map(
    (result, index) =>
      `[${index + 1}] ${result.title}\n${result.url}${
        result.content ? `\n${result.content}` : ''
      }`
  );
  return `Web search results for "${query}":\n\n${blocks.join(
    '\n\n'
  )}\n\n---\n\nUsing the search results above when they are relevant, answer the user's message. Cite sources inline with bracketed numbers like [1] where you rely on them.\n\nUser message: ${content}`;
}

export default {
  getWebSearchConfig,
  setWebSearchConfig,
  isWebSearchAvailable,
  getWebSearchAccessMode,
  setWebSearchAccessMode,
  userCanUseWebSearch,
  webSearch,
  buildWebSearchEnhancedContent,
};
