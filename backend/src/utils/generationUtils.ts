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
  GenerationOptions,
  GenerationStatistics,
  OllamaChatResponse,
} from '../types/index.js';

/**
 * Merges user preferences with request options, giving precedence to request options
 */
export const mergeGenerationOptions = (
  userOptions: Partial<GenerationOptions>,
  requestOptions?: Partial<GenerationOptions>
): GenerationOptions => {
  return {
    ...userOptions,
    ...requestOptions,
  };
};

/**
 * Extracts generation statistics from Ollama response
 */
export const extractStatistics = (
  response: OllamaChatResponse
): GenerationStatistics => {
  const stats: GenerationStatistics = {
    total_duration: response.total_duration,
    load_duration: response.load_duration,
    prompt_eval_count: response.prompt_eval_count,
    prompt_eval_duration: response.prompt_eval_duration,
    eval_count: response.eval_count,
    eval_duration: response.eval_duration,
    created_at: response.created_at,
    model: response.model,
  };

  // Calculate tokens per second if we have the necessary data
  if (response.eval_count && response.eval_duration) {
    // Convert nanoseconds to seconds and calculate tokens/second
    stats.tokens_per_second =
      Math.round((response.eval_count / (response.eval_duration / 1e9)) * 100) /
      100;
  }

  return stats;
};
