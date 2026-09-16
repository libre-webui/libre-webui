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
 * One provider round for the native tool loop, in the plugin chunk
 * vocabulary. Both transports that run tools — the durable chat turn and a
 * channel @model mention — need the same plugin-or-Ollama branch, so it
 * lives here once: a prepared target plus the turn's base messages becomes
 * the `startRound` the loop calls each round.
 */

import type {
  ChatMessage,
  OllamaChatMessage,
  OllamaChatResponse,
  ProviderToolSpec,
} from '../types/index.js';
import { toOpenAICompatibleTools } from '../utils/pluginChatAdapter.js';
import type { PluginStreamChunk } from '../utils/pluginStreamAdapter.js';
import type { GenerationTarget } from './chatGenerationService.js';
import {
  ollamaStreamAsPluginChunks,
  toOllamaExtensionMessages,
} from './chatToolRuntimeService.js';
import ollamaService from './ollamaService.js';
import pluginService from './pluginService.js';

export interface ToolRoundStarterOptions {
  target: GenerationTarget;
  /** The turn's base context, in each transport's native message shape. */
  ollamaMessages: OllamaChatMessage[];
  pluginMessages: ChatMessage[];
  userId: string;
  /** Receives the Ollama bridge's terminal chunk, when that path runs. */
  ollamaState: { finalChunk?: OllamaChatResponse };
  signal?: AbortSignal;
}

export type ToolRoundStarter = (
  extension: readonly ChatMessage[],
  tools: readonly ProviderToolSpec[]
) => AsyncIterable<PluginStreamChunk>;

/** Build the `startRound` a `runPluginToolLoop` call needs for this target. */
export const createToolRoundStarter = (
  options: ToolRoundStarterOptions
): ToolRoundStarter => {
  const activePluginId = options.target.activePlugin?.id;
  if (activePluginId) {
    return (extension, tools) =>
      pluginService.executePluginStreamRequest(
        options.target.actualModelName,
        [...options.pluginMessages, ...extension],
        { ...options.target.mergedOptions, tools: [...tools] },
        options.userId,
        activePluginId,
        options.signal
      );
  }
  return (extension, tools) =>
    ollamaStreamAsPluginChunks(
      {
        model: options.target.actualModelName,
        messages: [
          ...options.ollamaMessages,
          ...toOllamaExtensionMessages(extension),
        ],
        stream: true,
        options: options.target.mergedOptions as Record<string, unknown>,
        ...(tools.length > 0
          ? { tools: toOpenAICompatibleTools([...tools]) }
          : {}),
      },
      ollamaService,
      options.ollamaState,
      options.signal,
      { userId: options.userId }
    );
};
