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

/** Reasoning support by model id, for the models where it is knowable. */
export type PluginModelReasoningMap = Record<string, boolean>;

/**
 * Whether one listing entry says its model can reason. OpenRouter publishes
 * `supported_parameters` for every model, so on entries that carry the array
 * its silence is a real "no"; other providers say nothing, and nothing is
 * recorded rather than guessed here — the name heuristic below is the
 * fallback, kept separate because a listing's own answer must win.
 */
export function readModelReasoningSupport(
  entry: Record<string, unknown> | undefined
): boolean | undefined {
  if (!entry) return undefined;

  const supportedParameters = entry.supported_parameters;
  if (Array.isArray(supportedParameters)) {
    return supportedParameters.some(
      parameter =>
        parameter === 'reasoning' ||
        parameter === 'include_reasoning' ||
        parameter === 'reasoning_effort'
    );
  }

  const capabilities = entry.capabilities;
  if (
    Array.isArray(capabilities) &&
    capabilities.some(
      capability => capability === 'reasoning' || capability === 'thinking'
    )
  ) {
    return true;
  }

  if (entry.reasoning === true) return true;

  return undefined;
}

/**
 * What a model's name says about reasoning, for the providers whose listings
 * say nothing. This is a maintained table of the major families: a wrong
 * "true" costs a provider error the user can act on, a wrong "false" hides a
 * working control, and an unknown name stays undefined — offered, like an
 * Ollama model that reports no capabilities.
 */
export function inferReasoningFromModelId(id: string): boolean | undefined {
  const name = id.toLowerCase();
  const tail = name.split('/').pop() ?? name;

  // OpenAI: the o-series, gpt-5 family, and gpt-oss reason; the gpt-4/4o and
  // earlier chat families do not.
  if (/^o[134](-|$)/.test(tail) || tail.startsWith('gpt-5')) return true;
  if (tail.includes('gpt-oss')) return true;
  if (/^(chatgpt-|gpt-4|gpt-3)/.test(tail)) return false;

  // Anthropic: extended thinking exists from Claude 3.7 on. Everything older
  // — Claude 3.x, Claude 2, Instant — predates it.
  if (tail.includes('claude')) {
    return !/claude-(3-[05]|3-(haiku|sonnet|opus)|2|instant)/.test(tail);
  }

  // Gemini: thinking arrived with 2.5; 2.0 only in the models that carry
  // "thinking" in the name.
  if (tail.includes('gemini')) {
    if (tail.includes('thinking')) return true;
    const generation = /gemini-(\d+(?:\.\d+)?)/.exec(tail);
    return generation ? Number(generation[1]) >= 2.5 : undefined;
  }

  // Open reasoning families served through providers.
  if (/(^|[^a-z])r1([^a-z]|$)/.test(tail) || tail.includes('qwq')) return true;

  return undefined;
}

export function readModelReasoningMap(
  entries: readonly unknown[]
): PluginModelReasoningMap {
  const reasoning: PluginModelReasoningMap = {};

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const id = record.id;
    if (typeof id !== 'string' || id.length === 0) continue;
    const support =
      readModelReasoningSupport(record) ?? inferReasoningFromModelId(id);
    if (support !== undefined) reasoning[id] = support;
  }

  return reasoning;
}

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
  modelReasoning?: PluginModelReasoningMap;
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
    reasoning: catalog.modelReasoning ?? {},
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

  // An object catalog missing the reasoning key was written before reasoning
  // support was captured; like the plain-array form it earns one refresh.

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

  const modelContext: PluginModelContextMap = {};
  if (context) {
    for (const [model, length] of Object.entries(context)) {
      const contextLength = asContextLength(length);
      if (contextLength !== undefined) modelContext[model] = contextLength;
    }
  }

  const reasoning =
    record.reasoning && typeof record.reasoning === 'object'
      ? (record.reasoning as Record<string, unknown>)
      : undefined;
  const modelReasoning: PluginModelReasoningMap = {};
  if (reasoning) {
    for (const [model, support] of Object.entries(reasoning)) {
      if (typeof support === 'boolean') modelReasoning[model] = support;
    }
  }

  return {
    models,
    ...(Object.keys(modelContext).length > 0 ? { modelContext } : {}),
    ...(Object.keys(modelReasoning).length > 0 ? { modelReasoning } : {}),
    ...('reasoning' in record ? {} : { legacy: true }),
  };
}
