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
 * What a model says about how it wants to be run.
 *
 * Ollama's `/api/show` returns the modelfile's own `PARAMETER` lines and the
 * architecture metadata, including the context length the model was trained
 * for. Those are the author's recommendations, and they are what the
 * application should start from — a fixed 2048-token window applied to every
 * model silently truncates one trained for 128k.
 */

import { GenerationOptions } from '../types/index.js';
import { getOllamaRuntimeConfig } from '../platform/ollamaRuntimeConfig.js';
import { createLogger } from './logger.js';

const logger = createLogger('ollama:model-defaults');

/**
 * Upper bound for an adopted context window. A model's full context can be far
 * larger than the hardware can hold, and Ollama allocates the KV cache for
 * whatever is asked: adopting 128k unprompted would fail to load or swap.
 * Raise it with OLLAMA_MAX_CONTEXT where the hardware allows.
 */
const maxAdoptedContext = (): number => getOllamaRuntimeConfig().maxContext;

/** Numeric `PARAMETER` names that map straight onto a generation option. */
const NUMERIC_PARAMETERS = new Set([
  'temperature',
  'top_k',
  'top_p',
  'min_p',
  'typical_p',
  'repeat_last_n',
  'repeat_penalty',
  'presence_penalty',
  'frequency_penalty',
  'num_ctx',
  'num_predict',
  'num_keep',
  'seed',
  'num_batch',
  'num_gpu',
  'main_gpu',
  'num_thread',
]);

const BOOLEAN_PARAMETERS = new Set([
  'penalize_newline',
  'use_mmap',
  'use_mlock',
  'numa',
]);

/**
 * Strips the quoting a modelfile uses for values containing spaces or markup,
 * such as `stop "<|im_end|>"`.
 */
const unquote = (value: string): string => {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, '\n');
    }
  }
  return trimmed;
};

/**
 * The `PARAMETER` lines from a modelfile, as `/api/show` returns them: one per
 * line, name and value separated by whitespace, `stop` repeated for each
 * sequence.
 */
export function parseModelParameters(
  parameters: string | undefined
): Partial<GenerationOptions> {
  if (!parameters?.trim()) return {};

  const options: Partial<GenerationOptions> = {};
  const stops: string[] = [];

  for (const line of parameters.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const separator = trimmed.search(/\s/);
    if (separator === -1) continue;

    const name = trimmed.slice(0, separator).toLowerCase();
    const raw = unquote(trimmed.slice(separator + 1));
    if (!raw) continue;

    if (name === 'stop') {
      stops.push(raw);
      continue;
    }

    if (NUMERIC_PARAMETERS.has(name)) {
      const value = Number(raw);
      if (Number.isFinite(value)) {
        (options as Record<string, unknown>)[name] = value;
      }
      continue;
    }

    if (BOOLEAN_PARAMETERS.has(name)) {
      (options as Record<string, unknown>)[name] = raw === 'true';
    }
  }

  if (stops.length > 0) {
    options.stop = stops;
  }

  return options;
}

/**
 * The context length the model was trained for, read from the architecture
 * metadata: `general.architecture` names the family, and that family's
 * `<arch>.context_length` carries the value.
 */
export function parseModelContextLength(
  modelInfo: Record<string, unknown> | undefined
): number | undefined {
  if (!modelInfo) return undefined;

  const architecture = modelInfo['general.architecture'];
  const keys =
    typeof architecture === 'string'
      ? [`${architecture}.context_length`]
      : Object.keys(modelInfo).filter(key => key.endsWith('.context_length'));

  for (const key of keys) {
    const value = Number(modelInfo[key]);
    if (Number.isFinite(value) && value > 0) {
      return value;
    }
  }

  return undefined;
}

export interface OllamaModelDefaults {
  /** Options the model itself recommends, ready to merge. */
  options: Partial<GenerationOptions>;
  /** The model's full trained context, before any cap is applied. */
  trainedContextLength?: number;
  /** Whether the adopted context was reduced from the trained length. */
  contextCapped: boolean;
  /**
   * What the model can do, as `/api/show` reports it: `tools`, `vision`,
   * `thinking`, and so on. Absent on Ollama versions that do not report it,
   * which is not the same as a model that can do nothing.
   */
  capabilities?: string[];
  /** Whether the model reasons before answering, when that is known. */
  supportsThinking?: boolean;
}

/** The `capabilities` array from `/api/show`, when the server sends one. */
export function parseModelCapabilities(
  capabilities: unknown
): string[] | undefined {
  if (!Array.isArray(capabilities)) return undefined;
  const named = capabilities.filter(
    (capability): capability is string => typeof capability === 'string'
  );
  return named.length > 0 ? named : undefined;
}

/**
 * Turns an `/api/show` response into options to run the model with.
 *
 * A modelfile's own `num_ctx` wins over the trained length: the author chose
 * it deliberately. Otherwise the trained length is adopted, capped so that a
 * very large context cannot make the model fail to load.
 */
export function parseOllamaModelDefaults(
  show: Record<string, unknown> | undefined
): OllamaModelDefaults {
  if (!show) return { options: {}, contextCapped: false };

  const capabilities = parseModelCapabilities(show.capabilities);

  const options = parseModelParameters(
    typeof show.parameters === 'string' ? show.parameters : undefined
  );

  const trainedContextLength = parseModelContextLength(
    show.model_info as Record<string, unknown> | undefined
  );

  let contextCapped = false;

  if (options.num_ctx === undefined && trainedContextLength) {
    const cap = maxAdoptedContext();
    options.num_ctx = Math.min(trainedContextLength, cap);
    contextCapped = trainedContextLength > cap;

    if (contextCapped) {
      logger.debug(
        `Context for this model capped at ${cap} of ${trainedContextLength} trained tokens.`
      );
    }
  }

  return {
    options,
    trainedContextLength,
    contextCapped,
    ...(capabilities
      ? {
          capabilities,
          supportsThinking: capabilities.includes('thinking'),
        }
      : {}),
  };
}
