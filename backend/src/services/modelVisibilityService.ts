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
 * Which models administrators removed from the shared model pickers. The set
 * is a persisted system setting holding hidden model keys: an Ollama model is
 * keyed by its plain name, a plugin model by `${pluginId}/${modelName}`.
 *
 * Visibility is a listing refinement, not an authorization gate: hidden
 * models drop out of the pickers non-administrators see, while administrators
 * always keep the full list.
 */

import { createLogger } from '../utils/logger.js';
import { getSystemSetting, setSystemSetting } from './systemSettingsService.js';

const logger = createLogger('services:model-visibility');

export const MODEL_VISIBILITY_KEY = 'model_visibility';

/** Upper bound on stored hidden keys, keeping the setting row bounded. */
export const MODEL_VISIBILITY_MAX_KEYS = 5000;

/** Longer than any real model key; guards the row against garbage input. */
const MODEL_KEY_MAX_CHARS = 512;

/**
 * The hidden model keys, or [] when nothing is hidden. Fails open: an
 * unreadable or corrupted setting must never blank every model picker.
 */
export async function getHiddenModels(): Promise<string[]> {
  try {
    const raw = await getSystemSetting(MODEL_VISIBILITY_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (key): key is string => typeof key === 'string' && key.length > 0
    );
  } catch (error) {
    logger.warn(
      'Could not read model visibility; treating every model as visible:',
      error
    );
    return [];
  }
}

/** Validates and dedupes a hidden-model list; throws on invalid input. */
export function normalizeHiddenModels(keys: unknown): string[] {
  if (!Array.isArray(keys)) {
    throw new Error('hidden must be an array of model keys.');
  }
  if (keys.length > MODEL_VISIBILITY_MAX_KEYS) {
    throw new Error(
      `At most ${MODEL_VISIBILITY_MAX_KEYS} models can be hidden.`
    );
  }
  const deduped = new Set<string>();
  for (const key of keys) {
    if (typeof key !== 'string') {
      throw new Error('Every hidden model key must be a string.');
    }
    const trimmed = key.trim();
    if (!trimmed) {
      throw new Error('Hidden model keys must be non-empty.');
    }
    if (trimmed.length > MODEL_KEY_MAX_CHARS) {
      throw new Error(
        `Hidden model keys are limited to ${MODEL_KEY_MAX_CHARS} characters.`
      );
    }
    deduped.add(trimmed);
  }
  return [...deduped];
}

/** Persists the hidden-model set and returns the normalized list. */
export async function setHiddenModels(keys: string[]): Promise<string[]> {
  const normalized = normalizeHiddenModels(keys);
  await setSystemSetting(MODEL_VISIBILITY_KEY, JSON.stringify(normalized));
  return normalized;
}

export default {
  getHiddenModels,
  setHiddenModels,
  normalizeHiddenModels,
};
