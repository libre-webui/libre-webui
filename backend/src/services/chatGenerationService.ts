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

import { mergeGenerationOptions } from '../utils/generationUtils.js';
import { OPENAI_RESPONSES_INCOMPLETE_REASON_METADATA_KEY } from '../utils/openAIResponsesAdapter.js';
import {
  extractPluginAssistantContent,
  extractPluginAssistantThinking,
} from '../utils/pluginResponse.js';
import agentCliService from './agentCliService.js';
import ollamaService from './ollamaService.js';
import { personaService } from './personaService.js';
import pluginService from './pluginService.js';
import preferencesService from './preferencesService.js';
import type {
  ChatMessage,
  ChatProviderSelection,
  ChatProviderType,
  GenerationOptions,
  OllamaChatMessage,
  OllamaChatResponse,
  Plugin,
  PluginResponse,
} from '../types/index.js';
import { createLogger } from '../utils/logger.js';
import { normalizeChatProviderSelection } from '../utils/chatProviderSelection.js';
import { throwIfChatGenerationCancelled } from '../utils/chatCancellation.js';

const logger = createLogger('services:chat-generation-service');

export interface GenerationTarget {
  actualModelName: string;
  mergedOptions: GenerationOptions;
  activePlugin: Plugin | null;
  pluginVariables: Record<string, string | number | boolean>;
  providerType?: ChatProviderType;
  providerId?: string;
}

export type PluginFallbackPolicy = 'allow' | 'disabled';

export interface NonStreamingExecutionOptions {
  target: GenerationTarget;
  ollamaMessages: OllamaChatMessage[];
  pluginMessages: ChatMessage[];
  userId: string;
  pluginFallbackPolicy?: PluginFallbackPolicy;
  signal?: AbortSignal;
}

export interface NonStreamingExecutionResult {
  response: OllamaChatResponse;
  assistantContent: string;
  assistantThinking?: string;
  source: 'plugin' | 'ollama';
  pluginError?: Error;
}

class ChatGenerationService {
  async resolveActualModelName(
    sessionModel: string,
    userId: string = 'default'
  ): Promise<string> {
    if (!sessionModel.startsWith('persona:')) {
      return sessionModel;
    }

    try {
      const personaId = sessionModel.replace('persona:', '');

      let persona = await personaService.getPersonaById(personaId, userId);
      if (!persona && userId !== 'default') {
        persona = await personaService.getPersonaById(personaId, 'default');
      }

      if (persona?.model) {
        return persona.model;
      }

      logger.warn(
        `Persona ${personaId} not found, falling back to session model`
      );
      return sessionModel;
    } catch (error) {
      logger.error('Error resolving persona model:', error);
      return sessionModel;
    }
  }

  mergeOptions(options: GenerationOptions = {}): GenerationOptions {
    return mergeGenerationOptions(
      preferencesService.getGenerationOptions(),
      options
    );
  }

  /**
   * The options a model actually runs with, in order of increasing authority:
   *
   *  1. the application's own settings,
   *  2. what the model's modelfile recommends — its stop sequences and the
   *     context it was trained for, rather than a fixed window that truncates
   *     anything larger,
   *  3. overrides the user pinned for this model,
   *  4. options sent with the request itself.
   */
  async mergeOptionsForModel(
    model: string,
    userId: string,
    options: GenerationOptions = {},
    signal?: AbortSignal,
    includeOllamaDefaults = true
  ): Promise<GenerationOptions> {
    const global = preferencesService.getGenerationOptions(userId);
    const pinned = preferencesService.getModelGenerationOptions(model, userId);

    // Only ask the model when the user has not already answered for it.
    const recommended =
      !includeOllamaDefaults ||
      (Object.keys(pinned).length > 0 && pinned.num_ctx !== undefined)
        ? {}
        : (await ollamaService.getModelDefaults(model, signal)).options;

    return mergeGenerationOptions(
      mergeGenerationOptions(
        mergeGenerationOptions(global, recommended as GenerationOptions),
        pinned as GenerationOptions
      ),
      options
    );
  }

  async prepareGenerationTarget(
    sessionModel: string,
    userId: string,
    options: GenerationOptions = {},
    providerSelection?: ChatProviderSelection,
    signal?: AbortSignal
  ): Promise<GenerationTarget> {
    const provider = normalizeChatProviderSelection(providerSelection);
    const actualModelName = await this.resolveActualModelName(
      sessionModel,
      userId
    );
    const activePlugin =
      provider?.providerType === 'ollama' || provider?.providerType === 'agent'
        ? null
        : await pluginService.getActivePluginForModel(
            actualModelName,
            userId,
            provider?.providerId
          );
    const includeOllamaDefaults =
      provider?.providerType === 'ollama' || (!provider && !activePlugin);
    const mergedOptions = await this.mergeOptionsForModel(
      actualModelName,
      userId,
      options,
      signal,
      includeOllamaDefaults
    );
    const pluginVariables = activePlugin
      ? pluginService.getPluginVariables(activePlugin, userId)
      : {};

    return {
      actualModelName,
      mergedOptions,
      activePlugin,
      pluginVariables,
      ...provider,
    };
  }

  extractPluginAssistantContent(response: PluginResponse): string {
    return extractPluginAssistantContent(response);
  }

  createPluginChatResponse(
    model: string,
    assistantContent: string,
    assistantThinking?: string,
    providerMetadata?: Record<string, unknown>
  ): OllamaChatResponse {
    return {
      model,
      created_at: new Date().toISOString(),
      message: {
        role: 'assistant',
        content: assistantContent,
        ...(assistantThinking ? { thinking: assistantThinking } : {}),
        ...(providerMetadata ? { providerMetadata } : {}),
      },
      done: true,
    } as OllamaChatResponse;
  }

  async executeNonStreaming({
    target,
    ollamaMessages,
    pluginMessages,
    userId,
    pluginFallbackPolicy = 'disabled',
    signal,
  }: NonStreamingExecutionOptions): Promise<NonStreamingExecutionResult> {
    throwIfChatGenerationCancelled(signal);
    const chatRequest = {
      model: target.actualModelName,
      messages: ollamaMessages,
      stream: false,
      options: target.mergedOptions as Record<string, unknown>,
    };

    if (target.providerType === 'agent' && target.providerId) {
      let assistantContent = '';
      let assistantThinking = '';
      let providerMetadata: Record<string, unknown> | undefined;
      for await (const chunk of agentCliService.executeAgentStreamRequest(
        target.providerId,
        pluginMessages,
        userId,
        { model: target.actualModelName, signal }
      )) {
        if (chunk.type === 'content' && chunk.content) {
          assistantContent += chunk.content;
        } else if (chunk.type === 'reasoning' && chunk.content) {
          assistantThinking += chunk.content;
        } else if (chunk.type === 'done' && chunk.providerMetadata) {
          providerMetadata = chunk.providerMetadata;
        }
      }
      return {
        response: this.createPluginChatResponse(
          target.actualModelName,
          assistantContent,
          assistantThinking || undefined,
          providerMetadata
        ),
        assistantContent,
        ...(assistantThinking ? { assistantThinking } : {}),
        source: 'plugin',
      };
    }

    if (target.activePlugin) {
      try {
        const pluginResponse = await pluginService.executePluginRequest(
          target.actualModelName,
          pluginMessages,
          target.mergedOptions,
          userId,
          target.activePlugin.id,
          signal
        );
        const incompleteReason =
          pluginResponse.providerMetadata?.[
            OPENAI_RESPONSES_INCOMPLETE_REASON_METADATA_KEY
          ];
        if (typeof incompleteReason === 'string') {
          throw new Error(
            `Provider returned an incomplete response (${incompleteReason})`
          );
        }
        const assistantContent =
          this.extractPluginAssistantContent(pluginResponse);
        const assistantThinking =
          extractPluginAssistantThinking(pluginResponse);

        return {
          response: this.createPluginChatResponse(
            target.actualModelName,
            assistantContent,
            assistantThinking,
            pluginResponse.providerMetadata
          ),
          assistantContent,
          ...(assistantThinking ? { assistantThinking } : {}),
          source: 'plugin',
        };
      } catch (error) {
        const pluginError =
          error instanceof Error ? error : new Error(String(error));

        if (
          pluginFallbackPolicy === 'disabled' ||
          target.providerType !== undefined
        ) {
          throw pluginError;
        }

        const response = await ollamaService.generateChatResponse(
          chatRequest,
          signal,
          { userId }
        );
        return {
          response,
          assistantContent: response.message.content,
          ...(response.message.thinking
            ? { assistantThinking: response.message.thinking }
            : {}),
          source: 'ollama',
          pluginError,
        };
      }
    }

    const response = await ollamaService.generateChatResponse(
      chatRequest,
      signal,
      { userId }
    );
    return {
      response,
      assistantContent: response.message.content,
      ...(response.message.thinking
        ? { assistantThinking: response.message.thinking }
        : {}),
      source: 'ollama',
    };
  }
}

export default new ChatGenerationService();
