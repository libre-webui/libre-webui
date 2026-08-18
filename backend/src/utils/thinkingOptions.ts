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
 * How hard a model should think before it answers.
 *
 * Every provider spells this differently: Ollama takes a top-level `think`,
 * OpenAI takes a reasoning effort, Anthropic and Gemini take a token budget.
 * The application keeps one value on the generation options and translates it
 * at each provider boundary, so a conversation carries its own setting no
 * matter which model answers it.
 *
 * Unset means the provider decides, which is what every request did before
 * this option existed. Nothing is added to a payload for an unset value.
 */

export const THINKING_LEVELS = ['low', 'medium', 'high'] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/** `false` disables reasoning, `true` enables it at the provider's default. */
export type ThinkingPreference = boolean | ThinkingLevel;

/**
 * Token budgets for the providers that price thinking in tokens rather than
 * naming levels. Anthropic requires at least 1024, and both providers reject a
 * budget that leaves no room for the answer itself, which `maxTokensForBudget`
 * takes care of.
 */
const THINKING_BUDGETS: Record<ThinkingLevel, number> = {
  low: 2048,
  medium: 8192,
  high: 16384,
};

/** Headroom kept for the visible answer when a budget is applied. */
const ANSWER_HEADROOM_TOKENS = 1024;

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return (
    typeof value === 'string' &&
    (THINKING_LEVELS as readonly string[]).includes(value)
  );
}

/**
 * Reads whatever arrived from a client or a stored preference. Anything that
 * is not a level or a boolean is dropped rather than guessed at, so a stale
 * value cannot reach a provider as an unknown request field.
 */
export function normalizeThinkingPreference(
  value: unknown
): ThinkingPreference | undefined {
  if (typeof value === 'boolean') return value;
  if (isThinkingLevel(value)) return value;
  if (value === 'off' || value === 'false') return false;
  if (value === 'on' || value === 'true') return true;
  return undefined;
}

/**
 * `think` travels with the generation options because that is how a chat
 * carries its own settings, but it is never a sampling parameter: Ollama takes
 * it beside `options`, and the other providers take their own field entirely.
 * This lifts it back out at the request boundary.
 */
export function splitThinkingOption<
  T extends Record<string, unknown> | undefined,
>(
  options: T
): {
  think: ThinkingPreference | undefined;
  options: T;
} {
  if (!options || !('think' in options)) {
    return { think: undefined, options };
  }

  const { think, ...rest } = options;
  return {
    think: normalizeThinkingPreference(think),
    options: rest as T,
  };
}

/**
 * OpenAI-style reasoning effort. `true` means "think, but I have no opinion
 * about how much", which is the middle setting. Anything unset, disabled, or
 * unrecognized asks for nothing, so no reasoning field reaches the provider.
 */
export function thinkingEffort(think: unknown): ThinkingLevel | undefined {
  const preference = normalizeThinkingPreference(think);
  if (preference === undefined || preference === false) return undefined;
  return preference === true ? 'medium' : preference;
}

/** Reasoning token budget for the providers that take one. */
export function thinkingBudgetTokens(think: unknown): number | undefined {
  const effort = thinkingEffort(think);
  return effort ? THINKING_BUDGETS[effort] : undefined;
}

/**
 * A reply has to fit beside the reasoning it took: Anthropic rejects a budget
 * that is not smaller than `max_tokens`, and a budget that eats the whole
 * allowance leaves the answer truncated.
 */
export function maxTokensForBudget(
  maxTokens: number | undefined,
  budgetTokens: number
): number {
  const minimum = budgetTokens + ANSWER_HEADROOM_TOKENS;
  return maxTokens === undefined ? minimum : Math.max(maxTokens, minimum);
}
