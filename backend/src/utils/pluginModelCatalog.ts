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
 * What a provider's model listing says about its models.
 *
 * Discovery used to keep only the identifiers. A context window is worth
 * keeping too: without it the application can count the tokens a conversation
 * spends but has nothing to measure them against, which is the difference
 * between a number and a gauge.
 *
 * Providers name the field differently and some do not report it at all, so
 * every known spelling is read and a missing one is simply absent.
 */

/** Context-window fields, in the order providers are most likely to mean. */
const CONTEXT_LENGTH_KEYS = [
  'context_length',
  'context_window',
  'max_context_length',
  'max_context_tokens',
  'max_input_tokens',
  'inputTokenLimit',
] as const;

/**
 * Reported windows are token counts. A value that is not a positive whole
 * number is a provider quirk rather than a window, and is dropped instead of
 * being shown as a budget the user cannot trust.
 */
const asContextLength = (value: unknown): number | undefined => {
  const length = typeof value === 'string' ? Number(value) : value;
  return typeof length === 'number' &&
    Number.isFinite(length) &&
    Number.isInteger(length) &&
    length > 0
    ? length
    : undefined;
};

/**
 * The context window from one entry of a model listing. OpenRouter repeats it
 * under `top_provider`, where it reflects the provider actually serving the
 * model, so that copy wins when the two disagree.
 */
export function readModelContextLength(
  entry: Record<string, unknown> | undefined
): number | undefined {
  if (!entry) return undefined;

  const topProvider = entry.top_provider;
  if (topProvider && typeof topProvider === 'object') {
    const nested = asContextLength(
      (topProvider as Record<string, unknown>).context_length
    );
    if (nested !== undefined) return nested;
  }

  for (const key of CONTEXT_LENGTH_KEYS) {
    const length = asContextLength(entry[key]);
    if (length !== undefined) return length;
  }

  return undefined;
}

/** Context windows by model id, for the models that report one. */
export type PluginModelContextMap = Record<string, number>;

export function readModelContextMap(
  entries: readonly unknown[]
): PluginModelContextMap {
  const contexts: PluginModelContextMap = {};

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const id = record.id;
    if (typeof id !== 'string' || id.length === 0) continue;
    const contextLength = readModelContextLength(record);
    if (contextLength !== undefined) contexts[id] = contextLength;
  }

  return contexts;
}

export interface DiscoveredPluginCatalog {
  models: string[];
  modelContext?: PluginModelContextMap;
  /**
   * Whether the catalog was written before context windows were captured. Such
   * a catalog cannot be told apart from a provider that simply publishes none,
   * so it is refreshed once rather than left without windows until its next
   * scheduled refresh.
   */
  legacy?: boolean;
}

/**
 * Discovery used to be stored as a plain array of identifiers. It is now an
 * object that still carries that array, so an older build reads it as "nothing
 * discovered" and re-discovers rather than misreading a catalog, and a newer
 * one can tell a catalog with no windows from one written before windows were
 * kept at all.
 */
export function serializeDiscoveredCatalog(
  catalog: DiscoveredPluginCatalog
): string {
  return JSON.stringify({
    version: 1,
    models: catalog.models,
    context: catalog.modelContext ?? {},
  });
}

export function parseDiscoveredCatalog(
  serialized: string
): DiscoveredPluginCatalog {
  const parsed = JSON.parse(serialized) as unknown;

  const uniqueModels = (values: unknown[]): string[] =>
    Array.from(
      new Set(
        values.filter(
          (model): model is string =>
            typeof model === 'string' && model.length > 0
        )
      )
    );

  if (Array.isArray(parsed)) {
    return { models: uniqueModels(parsed), legacy: true };
  }

  if (!parsed || typeof parsed !== 'object') {
    return { models: [] };
  }

  const record = parsed as Record<string, unknown>;
  const models = Array.isArray(record.models)
    ? uniqueModels(record.models)
    : [];
  const context =
    record.context && typeof record.context === 'object'
      ? (record.context as Record<string, unknown>)
      : undefined;

  if (!context) return { models };

  const modelContext: PluginModelContextMap = {};
  for (const [model, length] of Object.entries(context)) {
    const contextLength = asContextLength(length);
    if (contextLength !== undefined) modelContext[model] = contextLength;
  }

  return Object.keys(modelContext).length > 0
    ? { models, modelContext }
    : { models };
}
