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

import {
  getSystemSettings,
  setSystemSettings,
} from './systemSettingsService.js';
import ollamaService from './ollamaService.js';
import { logger } from '../utils/logger.js';

const ENABLED_KEY = 'ollama.enabled';
const BASE_URL_KEY = 'ollama.base_url';

export interface OllamaRuntimeSettings {
  enabled: boolean;
  baseUrl: string;
}

const envDefaultBaseUrl = (): string =>
  process.env.OLLAMA_BASE_URL || 'http://localhost:11434';

let cache: OllamaRuntimeSettings | null = null;

export const validateOllamaBaseUrl = (raw: string): string | null => {
  const value = String(raw || '').trim();
  if (!value || value.length > 2048) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (parsed.username || parsed.password) return null;
  // Normalize away trailing slashes so request path joins stay predictable.
  // Character walk instead of /\/+$/: the anchored-quantifier regex
  // backtracks quadratically on adversarial slash runs (CodeQL js/polynomial-redos).
  let end = value.length;
  while (end > 1 && value.charCodeAt(end - 1) === 47) end--;
  return value.slice(0, end);
};

export const getOllamaRuntimeSettings =
  async (): Promise<OllamaRuntimeSettings> => {
    if (cache) return cache;
    const stored = await getSystemSettings([ENABLED_KEY, BASE_URL_KEY]);
    const enabled = stored[ENABLED_KEY] !== 'false';
    const baseUrl =
      validateOllamaBaseUrl(stored[BASE_URL_KEY] || '') ?? envDefaultBaseUrl();
    cache = { enabled, baseUrl };
    return cache;
  };

/** Load persisted settings and push them into the Ollama client. Call once at startup. */
export const initializeOllamaRuntime = async (): Promise<void> => {
  const settings = await getOllamaRuntimeSettings();
  ollamaService.configure(settings);
};

export const setOllamaRuntimeSettings = async (
  update: Partial<OllamaRuntimeSettings>
): Promise<OllamaRuntimeSettings> => {
  const current = await getOllamaRuntimeSettings();
  const next: OllamaRuntimeSettings = { ...current };
  const persist: Record<string, string> = {};

  if (typeof update.enabled === 'boolean') {
    next.enabled = update.enabled;
    persist[ENABLED_KEY] = String(update.enabled);
  }
  if (typeof update.baseUrl === 'string') {
    const validated = validateOllamaBaseUrl(update.baseUrl);
    if (!validated) {
      throw new Error(
        'Invalid Ollama base URL: must be an http(s) URL without credentials'
      );
    }
    next.baseUrl = validated;
    persist[BASE_URL_KEY] = validated;
  }

  if (Object.keys(persist).length > 0) {
    await setSystemSettings(persist);
  }
  cache = next;
  ollamaService.configure(next);
  logger.info('Ollama runtime settings updated', {
    enabled: next.enabled,
    baseUrl: next.baseUrl,
  });
  return next;
};
