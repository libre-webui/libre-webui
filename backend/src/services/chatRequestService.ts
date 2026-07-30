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
  toOllamaMessages,
  withSystemPrompt,
  type ChatContextMessage,
} from '../utils/chatContext.js';
import {
  preparePluginChatContext,
  type PluginVariables,
} from '../utils/pluginChatContext.js';
import type { GenerationTarget } from './chatGenerationService.js';
import type {
  ChatMessage,
  ChatProviderSelection,
  ChatSession,
  GenerationOptions,
  OllamaChatMessage,
  Persona,
} from '../types/index.js';
import { createLogger } from '../utils/logger.js';
import { normalizeChatProviderSelection } from '../utils/chatProviderSelection.js';

const logger = createLogger('services:chat-request-service');

export interface ChatGenerationTargetService {
  prepareGenerationTarget(
    sessionModel: string,
    userId: string,
    options?: GenerationOptions,
    providerSelection?: ChatProviderSelection
  ): Promise<GenerationTarget>;
}

export interface ChatPersonaLookupService {
  getPersonaById(id: string, userId?: string): Promise<Persona | null>;
}

export interface ChatRequestServiceDependencies {
  chatGenerationService: ChatGenerationTargetService;
  personaService?: ChatPersonaLookupService;
}

export interface PrepareGenerationMessagesOptions {
  isPrivate?: boolean;
  persistedMessages: readonly ChatMessage[];
  messageHistory?: readonly ChatContextMessage[];
  regenerate?: boolean;
  content: string;
  images?: string[];
  hasRelevantContext?: boolean;
  enhancedContent?: string;
  personaSystemPrompt?: string;
  pluginVariables?: PluginVariables;
  now?: () => number;
}

export interface PreparedGenerationMessages {
  enhancedContent: string;
  hasRelevantContext: boolean;
  contextMessages: ChatContextMessage[];
  ollamaMessages: OllamaChatMessage[];
  pluginMessages: ChatMessage[];
  shouldStreamPlugin: boolean;
}

export interface PrepareChatGenerationRequestOptions extends Omit<
  PrepareGenerationMessagesOptions,
  'pluginVariables' | 'personaSystemPrompt'
> {
  session: Pick<
    ChatSession,
    'model' | 'personaId' | 'providerType' | 'providerId'
  >;
  userId: string;
  options?: GenerationOptions;
  providerType?: ChatProviderSelection['providerType'];
  providerId?: ChatProviderSelection['providerId'];
  personaSystemPrompt?: string;
  includePersonaPrompt?: boolean;
}

export interface PreparedChatGenerationRequest
  extends PreparedGenerationMessages, GenerationTarget {
  target: GenerationTarget;
}

export function buildDocumentEnhancedContent(
  content: string,
  relevantContext: readonly string[]
): string {
  if (relevantContext.length === 0) {
    return content;
  }

  const contextString = relevantContext.join('\n\n---\n\n');
  return `Context from uploaded documents:\n\n${contextString}\n\n---\n\nUser question: ${content}`;
}

export function prepareGenerationMessages({
  isPrivate = false,
  persistedMessages,
  messageHistory = [],
  regenerate = false,
  content,
  images,
  hasRelevantContext,
  enhancedContent,
  personaSystemPrompt,
  pluginVariables = {},
  now = Date.now,
}: PrepareGenerationMessagesOptions): PreparedGenerationMessages {
  const contextMessages: ChatContextMessage[] = isPrivate
    ? regenerate
      ? [...messageHistory]
      : [
          ...messageHistory,
          {
            role: 'user',
            content,
            images,
          },
        ]
    : [...persistedMessages];

  const finalEnhancedContent = enhancedContent ?? content;
  const usesRelevantContext =
    hasRelevantContext ?? finalEnhancedContent !== content;

  const ollamaMessages = withSystemPrompt(
    toOllamaMessages(contextMessages, {
      latestUserContent: usesRelevantContext ? finalEnhancedContent : undefined,
    }),
    personaSystemPrompt
  );

  const { messages: pluginMessages, shouldStream } = preparePluginChatContext({
    isPrivate,
    persistedMessages,
    messageHistory,
    regenerate,
    content,
    images,
    hasRelevantContext: usesRelevantContext,
    enhancedContent: finalEnhancedContent,
    pluginVariables,
    now,
  });

  return {
    enhancedContent: finalEnhancedContent,
    hasRelevantContext: usesRelevantContext,
    contextMessages,
    ollamaMessages,
    pluginMessages,
    shouldStreamPlugin: shouldStream,
  };
}

export class ChatRequestService {
  private readonly chatGenerationService: ChatGenerationTargetService;
  private readonly personaService?: ChatPersonaLookupService;

  constructor({
    chatGenerationService,
    personaService,
  }: ChatRequestServiceDependencies) {
    this.chatGenerationService = chatGenerationService;
    this.personaService = personaService;
  }

  async resolvePersonaSystemPrompt(
    session: Pick<ChatSession, 'personaId'>,
    userId: string
  ): Promise<string | undefined> {
    if (!session.personaId || !this.personaService) {
      return undefined;
    }

    try {
      const persona = await this.personaService.getPersonaById(
        session.personaId,
        userId
      );
      return persona?.parameters?.system_prompt?.trim() || undefined;
    } catch (error) {
      logger.error('Error loading persona system prompt:', error);
      return undefined;
    }
  }

  async prepareGenerationRequest({
    session,
    userId,
    options = {},
    providerType,
    providerId,
    personaSystemPrompt,
    includePersonaPrompt = true,
    ...messageOptions
  }: PrepareChatGenerationRequestOptions): Promise<PreparedChatGenerationRequest> {
    const sessionProviderSelection = normalizeChatProviderSelection(session);
    const requestProviderSelection = messageOptions.isPrivate
      ? normalizeChatProviderSelection({ providerType, providerId })
      : undefined;
    const providerSelection = messageOptions.isPrivate
      ? (sessionProviderSelection ?? requestProviderSelection)
      : sessionProviderSelection;
    const target = await this.chatGenerationService.prepareGenerationTarget(
      session.model,
      userId,
      options,
      providerSelection
    );

    const resolvedPersonaSystemPrompt =
      personaSystemPrompt ??
      (includePersonaPrompt
        ? await this.resolvePersonaSystemPrompt(session, userId)
        : undefined);

    const preparedMessages = prepareGenerationMessages({
      ...messageOptions,
      personaSystemPrompt: resolvedPersonaSystemPrompt,
      pluginVariables: target.pluginVariables,
    });

    return {
      target,
      ...target,
      ...preparedMessages,
    };
  }
}
