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

export const MODEL_ORDER_KEY = 'model_order';
export const MODEL_METADATA_KEY = 'model_metadata';

/** Data URLs are stored inline, so each one stays small enough to serve. */
const MODEL_AVATAR_MAX_CHARS = 256_000;
const MODEL_LABEL_MAX_CHARS = 128;
const MODEL_METADATA_MAX_ENTRIES = 2000;

/** Presentation an administrator set for one model. */
export interface ModelMetadata {
  /** Shown instead of the raw model id. Empty means use the id. */
  label?: string;
  /** Data URL for the model's picture. Empty means the provider default. */
  avatar?: string;
}

/**
 * The administrator-chosen model order, most important first. Models missing
 * from the list keep their provider order after the ones listed here.
 */
export async function getModelOrder(): Promise<string[]> {
  try {
    const raw = await getSystemSetting(MODEL_ORDER_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (key): key is string => typeof key === 'string' && key.length > 0
    );
  } catch (error) {
    logger.warn('Could not read model order; using provider order:', error);
    return [];
  }
}

export function normalizeModelOrder(keys: unknown): string[] {
  if (!Array.isArray(keys)) {
    throw new Error('order must be an array of model keys.');
  }
  if (keys.length > MODEL_VISIBILITY_MAX_KEYS) {
    throw new Error(
      `At most ${MODEL_VISIBILITY_MAX_KEYS} models can be ordered.`
    );
  }
  const deduped = new Set<string>();
  for (const key of keys) {
    if (typeof key !== 'string' || !key.trim()) {
      throw new Error('Every ordered model key must be a non-empty string.');
    }
    if (key.trim().length > MODEL_KEY_MAX_CHARS) {
      throw new Error(
        `Model keys are limited to ${MODEL_KEY_MAX_CHARS} characters.`
      );
    }
    deduped.add(key.trim());
  }
  return [...deduped];
}

export async function setModelOrder(keys: string[]): Promise<string[]> {
  const normalized = normalizeModelOrder(keys);
  await setSystemSetting(MODEL_ORDER_KEY, JSON.stringify(normalized));
  return normalized;
}

/** Labels and pictures administrators set, keyed the same way as visibility. */
export async function getModelMetadata(): Promise<
  Record<string, ModelMetadata>
> {
  try {
    const raw = await getSystemSetting(MODEL_METADATA_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    return parsed as Record<string, ModelMetadata>;
  } catch (error) {
    logger.warn('Could not read model metadata; using provider names:', error);
    return {};
  }
}

export function normalizeModelMetadata(
  value: unknown
): Record<string, ModelMetadata> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('metadata must be an object keyed by model.');
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MODEL_METADATA_MAX_ENTRIES) {
    throw new Error(
      `At most ${MODEL_METADATA_MAX_ENTRIES} models can carry metadata.`
    );
  }
  const normalized: Record<string, ModelMetadata> = {};
  for (const [key, raw] of entries) {
    if (!key.trim() || key.length > MODEL_KEY_MAX_CHARS) {
      throw new Error('Model metadata keys must be short, non-empty strings.');
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`Metadata for ${key} must be an object.`);
    }
    const { label, avatar } = raw as { label?: unknown; avatar?: unknown };
    const entry: ModelMetadata = {};
    if (label !== undefined) {
      if (typeof label !== 'string') {
        throw new Error(`Label for ${key} must be a string.`);
      }
      const trimmed = label.trim();
      if (trimmed.length > MODEL_LABEL_MAX_CHARS) {
        throw new Error(
          `Labels are limited to ${MODEL_LABEL_MAX_CHARS} characters.`
        );
      }
      if (trimmed) entry.label = trimmed;
    }
    if (avatar !== undefined) {
      if (typeof avatar !== 'string') {
        throw new Error(`Picture for ${key} must be a string.`);
      }
      const trimmed = avatar.trim();
      if (trimmed) {
        if (trimmed.length > MODEL_AVATAR_MAX_CHARS) {
          throw new Error(
            `Model pictures are limited to ${Math.floor(MODEL_AVATAR_MAX_CHARS / 1000)} KB.`
          );
        }
        if (
          !/^data:image\/(png|jpeg|jpg|gif|webp|svg\+xml);base64,/i.test(
            trimmed
          )
        ) {
          throw new Error(`Picture for ${key} must be an image data URL.`);
        }
        entry.avatar = trimmed;
      }
    }
    // An entry stripped back to nothing is a reset, not a stored blank.
    if (entry.label || entry.avatar) normalized[key.trim()] = entry;
  }
  return normalized;
}

export async function setModelMetadata(
  value: Record<string, ModelMetadata>
): Promise<Record<string, ModelMetadata>> {
  const normalized = normalizeModelMetadata(value);
  await setSystemSetting(MODEL_METADATA_KEY, JSON.stringify(normalized));
  return normalized;
}

export default {
  getHiddenModels,
  setHiddenModels,
  normalizeHiddenModels,
  getModelOrder,
  setModelOrder,
  normalizeModelOrder,
  getModelMetadata,
  setModelMetadata,
  normalizeModelMetadata,
};
