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
  ProviderRequestContext,
} from '../types/index.js';
import { createLogger } from '../utils/logger.js';
import { normalizeChatProviderSelection } from '../utils/chatProviderSelection.js';
import { throwIfChatGenerationCancelled } from '../utils/chatCancellation.js';
import type { DecisionQuestions } from '../utils/decisionProtocol.js';
import type { OllamaModelDefaults } from '../utils/ollamaModelDefaults.js';
import { getDecisionService, type DecisionTarget } from './decisionService.js';

const logger = createLogger('services:chat-generation-service');

export interface GenerationTarget {
  actualModelName: string;
  mergedOptions: GenerationOptions;
  activePlugin: Plugin | null;
  pluginVariables: Record<string, string | number | boolean>;
  providerType?: ChatProviderType;
  providerId?: string;
  /**
   * Set when the model is a decision model: it answers typed questions with
   * probabilities through its decision API, never through chat.
   */
  decision?: GenerationDecisionTarget;
}

export type GenerationDecisionTarget = DecisionTarget & {
  /** The chat's saved question set, when it has one. */
  questions?: DecisionQuestions;
};

/** Whether a target is answered by a decision model. */
export const isDecisionGenerationTarget = (
  target: Pick<GenerationTarget, 'decision'> | undefined
): target is GenerationTarget & { decision: GenerationDecisionTarget } =>
  Boolean(target?.decision);

/** A decision model was asked to write text. */
export class DecisionModelTextError extends Error {
  constructor(model: string) {
    super(
      `${model} is a decision model: it answers questions with probabilities and cannot write text. Use it in Chat or through the Decisions API.`
    );
    this.name = 'DecisionModelTextError';
  }
}

export type PluginFallbackPolicy = 'allow' | 'disabled';

export interface NonStreamingExecutionOptions {
  target: GenerationTarget;
  ollamaMessages: OllamaChatMessage[];
  pluginMessages: ChatMessage[];
  userId: string;
  pluginFallbackPolicy?: PluginFallbackPolicy;
  requestContext?: ProviderRequestContext;
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

  async mergeOptions(
    options: GenerationOptions = {}
  ): Promise<GenerationOptions> {
    return mergeGenerationOptions(
      await preferencesService.getGenerationOptions(),
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
    includeOllamaDefaults = true,
    knownOllamaDefaults?: OllamaModelDefaults
  ): Promise<GenerationOptions> {
    const [global, pinned] = await Promise.all([
      preferencesService.getGenerationOptions(userId),
      preferencesService.getModelGenerationOptions(model, userId),
    ]);

    // Only ask the model when the user has not already answered for it.
    const recommended =
      !includeOllamaDefaults ||
      (Object.keys(pinned).length > 0 && pinned.num_ctx !== undefined)
        ? {}
        : (
            knownOllamaDefaults ??
            (await ollamaService.getModelDefaults(model, signal))
          ).options;

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
    signal?: AbortSignal,
    { allowDecisionModels = false }: { allowDecisionModels?: boolean } = {}
  ): Promise<GenerationTarget> {
    // A persona session's provider binding describes the persona
    // pseudo-model, not its backing model (the UI historically stamped
    // "ollama" on every persona). The backing model's own name decides
    // the provider, so the binding must not pin routing here.
    const provider = sessionModel.startsWith('persona:')
      ? undefined
      : normalizeChatProviderSelection(providerSelection);
    const actualModelName = await this.resolveActualModelName(
      sessionModel,
      userId
    );
    // A decision model answers through its decision API; it has no chat
    // endpoint, generation options, or plugin chat route to resolve. Only a
    // chat turn knows how to ask one; titles, summaries, evaluations, and
    // the text APIs need a model that writes.
    const decisionTarget = (decision: DecisionTarget): GenerationTarget => {
      if (!allowDecisionModels) {
        throw new DecisionModelTextError(actualModelName);
      }
      return {
        actualModelName,
        mergedOptions: {},
        activePlugin: null,
        pluginVariables: {},
        ...provider,
        decision,
      };
    };
    // A provider's decision models are named by the plugin that serves them.
    if (provider?.providerType === 'plugin') {
      const decision = await (
        await getDecisionService()
      ).resolveTarget(actualModelName, provider, userId, signal);
      if (decision) return decisionTarget(decision);
    }
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
    // Ollama marks its decision models in the same /api/show answer that
    // carries a model's defaults, so one probe serves both.
    const ollamaDefaults = includeOllamaDefaults
      ? await ollamaService.getModelDefaults(actualModelName, signal)
      : undefined;
    if (ollamaDefaults?.capabilities?.includes('decision')) {
      return decisionTarget({ providerType: 'ollama', model: actualModelName });
    }
    const mergedOptions = await this.mergeOptionsForModel(
      actualModelName,
      userId,
      options,
      signal,
      includeOllamaDefaults,
      ollamaDefaults
    );
    const pluginVariables = activePlugin
      ? await pluginService.getPluginVariables(activePlugin, userId)
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
    providerMetadata?: Record<string, unknown>,
    usage?: { prompt_tokens?: number; completion_tokens?: number },
    timings?: {
      /** Whole request, request sent to last chunk. */
      totalNs?: number;
      /** Request sent to first token: the provider's think-and-prefill time. */
      firstTokenNs?: number;
      /** First token to last token: the actual generation. */
      generationNs?: number;
    }
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
      // Providers report OpenAI-style token counts; the statistics strip
      // reads Ollama's names, so carry them across rather than showing
      // "0 tokens" for every provider-backed reply.
      ...(usage?.prompt_tokens !== undefined
        ? { prompt_eval_count: usage.prompt_tokens }
        : {}),
      ...(usage?.completion_tokens !== undefined
        ? { eval_count: usage.completion_tokens }
        : {}),
      // Providers on this path report counts but no timings, so these are
      // measured here. They are wall-clock, which includes network time.
      ...(timings?.totalNs !== undefined
        ? { total_duration: timings.totalNs }
        : {}),
      ...(timings?.firstTokenNs !== undefined
        ? { prompt_eval_duration: timings.firstTokenNs }
        : {}),
      ...(timings?.generationNs !== undefined
        ? { eval_duration: timings.generationNs }
        : {}),
    } as OllamaChatResponse;
  }

  createStreamedChatResponse(
    model: string,
    content: string,
    thinking?: string,
    providerMetadata?: Record<string, unknown>,
    usage?: { promptTokens?: number; completionTokens?: number },
    timings?: { promptMs?: number; predictedMs?: number }
  ): OllamaChatResponse {
    return this.createPluginChatResponse(
      model,
      content,
      thinking,
      providerMetadata,
      {
        ...(usage?.promptTokens !== undefined
          ? { prompt_tokens: usage.promptTokens }
          : {}),
        ...(usage?.completionTokens !== undefined
          ? { completion_tokens: usage.completionTokens }
          : {}),
      },
      timings
        ? {
            ...(timings.promptMs !== undefined
              ? { firstTokenNs: timings.promptMs * 1e6 }
              : {}),
            ...(timings.predictedMs !== undefined
              ? { generationNs: timings.predictedMs * 1e6 }
              : {}),
            ...(timings.promptMs !== undefined &&
            timings.predictedMs !== undefined
              ? { totalNs: (timings.promptMs + timings.predictedMs) * 1e6 }
              : {}),
          }
        : undefined
    );
  }

  async executeNonStreaming({
    target,
    ollamaMessages,
    pluginMessages,
    userId,
    pluginFallbackPolicy = 'disabled',
    requestContext,
    signal,
  }: NonStreamingExecutionOptions): Promise<NonStreamingExecutionResult> {
    throwIfChatGenerationCancelled(signal);
    const chatRequest = {
      model: target.actualModelName,
      messages: ollamaMessages,
      stream: false,
      options: target.mergedOptions as Record<string, unknown>,
    };

    if (isDecisionGenerationTarget(target)) {
      let assistantContent = '';
      let providerMetadata: Record<string, unknown> | undefined;
      let usage:
        { promptTokens?: number; completionTokens?: number } | undefined;
      let timings: { promptMs?: number; predictedMs?: number } | undefined;
      const decisionService = await getDecisionService();
      for await (const chunk of decisionService.streamChatTurn(
        target.decision,
        pluginMessages,
        userId,
        { questions: target.decision.questions, signal }
      )) {
        if (chunk.type === 'content' && chunk.content) {
          assistantContent += chunk.content;
        } else if (chunk.type === 'usage') {
          if (chunk.usage) usage = { ...usage, ...chunk.usage };
          if (chunk.timings) timings = { ...timings, ...chunk.timings };
        } else if (chunk.type === 'done' && chunk.providerMetadata) {
          providerMetadata = chunk.providerMetadata;
        }
      }
      return {
        response: this.createStreamedChatResponse(
          target.actualModelName,
          assistantContent,
          undefined,
          providerMetadata,
          usage,
          timings
        ),
        assistantContent,
        source: target.decision.providerType === 'ollama' ? 'ollama' : 'plugin',
      };
    }

    if (target.providerType === 'agent' && target.providerId) {
      let assistantContent = '';
      let assistantThinking = '';
      let providerMetadata: Record<string, unknown> | undefined;
      let usage:
        { promptTokens?: number; completionTokens?: number } | undefined;
      let timings: { promptMs?: number; predictedMs?: number } | undefined;
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
        } else if (chunk.type === 'usage') {
          if (chunk.usage) usage = { ...usage, ...chunk.usage };
          if (chunk.timings) timings = { ...timings, ...chunk.timings };
        } else if (chunk.type === 'done' && chunk.providerMetadata) {
          providerMetadata = chunk.providerMetadata;
        }
      }
      return {
        response: this.createStreamedChatResponse(
          target.actualModelName,
          assistantContent,
          assistantThinking || undefined,
          providerMetadata,
          usage,
          timings
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
          signal,
          requestContext
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
            pluginResponse.providerMetadata,
            pluginResponse.usage
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
