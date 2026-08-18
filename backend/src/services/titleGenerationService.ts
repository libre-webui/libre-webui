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

import type { GenerationTarget } from './chatGenerationService.js';
import type {
  ChatMessage,
  ChatProviderSelection,
  ChatSession,
  GenerationOptions,
  OllamaGenerateRequest,
  OllamaGenerateResponse,
  PluginResponse,
} from '../types/index.js';
import {
  normalizeChatProviderSelection,
  type QualifiedChatProviderSelection,
} from '../utils/chatProviderSelection.js';

export const AUTO_TITLE_CURRENT_MODEL = '__current_running_model__';

const TITLE_GENERATION_OPTIONS: GenerationOptions = {
  temperature: 0.3,
  num_predict: 20,
};

/**
 * Providers reached over the plugin path cannot be told to skip reasoning the
 * way a local Ollama call can (`think: false`). A reasoning model spends the
 * whole budget thinking and returns empty content, which used to surface as
 * "could not generate a title", so give that path room to think and still
 * answer. Only the visible content is read, and the result is trimmed to a
 * title afterwards.
 */
const PLUGIN_TITLE_GENERATION_OPTIONS: GenerationOptions = {
  temperature: 0.3,
  num_predict: 512,
  // Naming a conversation is not worth a reasoning pass, whatever the chat
  // itself is set to.
  think: false,
};

const TITLE_STOP_SEQUENCES = ['\n', '.', '!', '?'];

export interface GenerateTitleForSessionOptions {
  sessionId: string;
  requestedModel: string;
  message: string;
  userId?: string;
  providerType?: ChatProviderSelection['providerType'];
  providerId?: ChatProviderSelection['providerId'];
}

export interface GenerateTitleForSessionResult {
  title: string;
  session: ChatSession;
  model: string;
  source: 'plugin' | 'ollama' | 'fallback';
}

export interface SanitizedGeneratedTitle {
  title: string;
  usedFallback: boolean;
}

interface ChatServiceDependency {
  getSession(
    sessionId: string,
    userId?: string
  ): Promise<ChatSession | undefined>;
  updateSession(
    sessionId: string,
    updates: Partial<ChatSession>,
    userId?: string
  ): Promise<ChatSession | null | undefined> | ChatSession | null | undefined;
}

interface ChatGenerationServiceDependency {
  resolveActualModelName(
    sessionModel: string,
    userId?: string
  ): Promise<string>;
  prepareGenerationTarget(
    sessionModel: string,
    userId: string,
    options?: GenerationOptions,
    providerSelection?: ChatProviderSelection
  ): Promise<GenerationTarget>;
  extractPluginAssistantContent(response: PluginResponse): string;
}

interface PluginServiceDependency {
  executePluginRequest(
    model: string,
    messages: ChatMessage[],
    options?: GenerationOptions,
    userId?: string,
    pluginId?: string
  ): Promise<PluginResponse>;
}

interface OllamaServiceDependency {
  generateResponse(
    request: OllamaGenerateRequest
  ): Promise<OllamaGenerateResponse>;
}

export interface TitleGenerationServiceDependencies {
  chatService: ChatServiceDependency;
  chatGenerationService: ChatGenerationServiceDependency;
  pluginService: PluginServiceDependency;
  ollamaService: OllamaServiceDependency;
  now?: () => number;
  logger?: Pick<Console, 'error'>;
}

export function buildTitlePrompt(message: string): string {
  return `Generate a very short, concise title (3-6 words max) for a chat that starts with this message. Only respond with the title, nothing else. No quotes, no punctuation at the end. Do not use any markdown formatting. Do not think out loud, do not explain your reasoning, and do not describe what the user wants; output only the title text.

Message: "${message.substring(0, 500)}"

Title:`;
}

export function buildFallbackTitle(message: string): string {
  return message.substring(0, 30) + (message.length > 30 ? '...' : '');
}

function truncateGeneratedTitle(title: string, maxLength = 50): string {
  if (title.length <= maxLength) {
    return title;
  }

  const availableLength = maxLength - 3;
  const hardCut = title.slice(0, availableLength).trimEnd();
  const lastSpace = hardCut.lastIndexOf(' ');
  const wordBoundary =
    lastSpace >= Math.floor(availableLength * 0.6)
      ? hardCut.slice(0, lastSpace)
      : hardCut;

  return `${wordBoundary.replace(/[,:;.!?]+$/, '').trimEnd()}...`;
}

// Reasoning models sometimes leak their thinking into the title response:
// as <think>/<thinking> blocks (often truncated before the closing tag by the
// token budget), or as untagged deliberation ("The user wants a very short,
// concise title…"). Either way it is not a title.
const REASONING_PREAMBLE =
  /^(the user (wants|is asking|asked|needs|says)|i (need|should|will) |let me |okay, |we need to |hmm\b)/i;

function stripThinking(rawTitle: string): string {
  return rawTitle
    .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, ' ')
    .replace(/^[\s\S]*?<\/think(?:ing)?>/i, ' ')
    .replace(/<think(?:ing)?>[\s\S]*$/i, ' ');
}

export function sanitizeGeneratedTitleResult(
  rawTitle: string,
  sourceMessage: string
): SanitizedGeneratedTitle {
  const title = stripThinking(rawTitle)
    .trim()
    .replace(/^```(?:\w+)?\s*|\s*```$/g, '')
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/^title\s*:\s*/i, '')
    .replace(/\s+/g, ' ')
    .replace(/[.!?]+$/, '')
    .trim();

  if (!title || REASONING_PREAMBLE.test(title)) {
    return {
      title: buildFallbackTitle(sourceMessage),
      usedFallback: true,
    };
  }

  return {
    title: truncateGeneratedTitle(title),
    usedFallback: false,
  };
}

export function sanitizeGeneratedTitle(
  rawTitle: string,
  sourceMessage: string
): string {
  return sanitizeGeneratedTitleResult(rawTitle, sourceMessage).title;
}

export class TitleGenerationService {
  private chatService: ChatServiceDependency;
  private chatGenerationService: ChatGenerationServiceDependency;
  private pluginService: PluginServiceDependency;
  private ollamaService: OllamaServiceDependency;
  private now: () => number;
  private logger: Pick<Console, 'error'>;

  constructor({
    chatService,
    chatGenerationService,
    pluginService,
    ollamaService,
    now = Date.now,
    logger = console,
  }: TitleGenerationServiceDependencies) {
    this.chatService = chatService;
    this.chatGenerationService = chatGenerationService;
    this.pluginService = pluginService;
    this.ollamaService = ollamaService;
    this.now = now;
    this.logger = logger;
  }

  async resolveTitleGenerationModel(
    requestedModel: string,
    session: ChatSession,
    userId: string
  ): Promise<string> {
    if (requestedModel === AUTO_TITLE_CURRENT_MODEL) {
      return this.chatGenerationService.resolveActualModelName(
        session.model,
        userId
      );
    }

    return requestedModel;
  }

  async generateTitleForSession({
    sessionId,
    requestedModel,
    message,
    userId = 'default',
    providerType,
    providerId,
  }: GenerateTitleForSessionOptions): Promise<GenerateTitleForSessionResult | null> {
    const session = await this.chatService.getSession(sessionId, userId);
    if (!session) {
      return null;
    }

    const model = await this.resolveTitleGenerationModel(
      requestedModel,
      session,
      userId
    );
    const providerSelection =
      requestedModel === AUTO_TITLE_CURRENT_MODEL
        ? normalizeChatProviderSelection(session)
        : normalizeChatProviderSelection({ providerType, providerId });

    let title = buildFallbackTitle(message);
    let source: GenerateTitleForSessionResult['source'] = 'fallback';

    try {
      const generation = await this.generateTitleWithModel(
        sessionId,
        model,
        message,
        userId,
        providerSelection
      );
      const sanitizedTitle = sanitizeGeneratedTitleResult(
        generation.title,
        message
      );
      title = sanitizedTitle.title;
      source = sanitizedTitle.usedFallback ? 'fallback' : generation.source;
    } catch (error) {
      this.logger.error('Error generating title:', error);
    }

    const updatedSession = await this.chatService.updateSession(
      sessionId,
      { title },
      userId
    );

    if (!updatedSession) {
      throw new Error('Failed to update session title');
    }

    return {
      title,
      session: updatedSession,
      model,
      source,
    };
  }

  private async generateTitleWithModel(
    sessionId: string,
    model: string,
    message: string,
    userId: string,
    providerSelection?: QualifiedChatProviderSelection
  ): Promise<{ title: string; source: 'plugin' | 'ollama' }> {
    const target = await this.chatGenerationService.prepareGenerationTarget(
      model,
      userId,
      TITLE_GENERATION_OPTIONS,
      providerSelection
    );
    const prompt = buildTitlePrompt(message);

    if (target.activePlugin) {
      const pluginResponse = await this.pluginService.executePluginRequest(
        target.actualModelName,
        [
          {
            id: `title-${sessionId}`,
            role: 'user',
            content: prompt,
            timestamp: this.now(),
          },
        ],
        { ...target.mergedOptions, ...PLUGIN_TITLE_GENERATION_OPTIONS },
        userId,
        target.activePlugin.id
      );

      return {
        title:
          this.chatGenerationService.extractPluginAssistantContent(
            pluginResponse
          ),
        source: 'plugin',
      };
    }

    // Ollama takes the thinking setting beside the options, never inside
    // them, and this call answers it for itself below.
    const { think: _think, ...ollamaOptions } = target.mergedOptions;

    const response = await this.ollamaService.generateResponse({
      model: target.actualModelName,
      prompt,
      stream: false,
      think: false,
      options: {
        ...ollamaOptions,
        temperature: TITLE_GENERATION_OPTIONS.temperature,
        num_predict: TITLE_GENERATION_OPTIONS.num_predict,
        stop: TITLE_STOP_SEQUENCES,
      },
    });

    return {
      title: response.response,
      source: 'ollama',
    };
  }
}
