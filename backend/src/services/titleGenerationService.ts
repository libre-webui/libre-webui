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
  ChatSession,
  GenerationOptions,
  OllamaGenerateRequest,
  OllamaGenerateResponse,
  PluginResponse,
} from '../types/index.js';

export const AUTO_TITLE_CURRENT_MODEL = '__current_running_model__';

const TITLE_GENERATION_OPTIONS: GenerationOptions = {
  temperature: 0.3,
  num_predict: 20,
};

const TITLE_STOP_SEQUENCES = ['\n', '.', '!', '?'];

export interface GenerateTitleForSessionOptions {
  sessionId: string;
  requestedModel: string;
  message: string;
  userId?: string;
}

export interface GenerateTitleForSessionResult {
  title: string;
  session: ChatSession;
  model: string;
  source: 'plugin' | 'ollama' | 'fallback';
}

interface ChatServiceDependency {
  getSession(sessionId: string, userId?: string): ChatSession | undefined;
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
    options?: GenerationOptions
  ): Promise<GenerationTarget>;
  extractPluginAssistantContent(response: PluginResponse): string;
}

interface PluginServiceDependency {
  executePluginRequest(
    model: string,
    messages: ChatMessage[],
    options?: GenerationOptions,
    userId?: string
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
  return `Generate a very short, concise title (3-6 words max) for a chat that starts with this message. Only respond with the title, nothing else. No quotes, no punctuation at the end. Do not use any markdown formatting.

Message: "${message.substring(0, 500)}"

Title:`;
}

export function buildFallbackTitle(message: string): string {
  return message.substring(0, 30) + (message.length > 30 ? '...' : '');
}

export function sanitizeGeneratedTitle(
  rawTitle: string,
  sourceMessage: string
): string {
  const title = rawTitle
    .trim()
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[.!?]+$/, '')
    .trim();

  if (!title || title.length > 50) {
    return buildFallbackTitle(sourceMessage);
  }

  return title;
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
  }: GenerateTitleForSessionOptions): Promise<GenerateTitleForSessionResult | null> {
    const session = this.chatService.getSession(sessionId, userId);
    if (!session) {
      return null;
    }

    const model = await this.resolveTitleGenerationModel(
      requestedModel,
      session,
      userId
    );

    let title = buildFallbackTitle(message);
    let source: GenerateTitleForSessionResult['source'] = 'fallback';

    try {
      const generation = await this.generateTitleWithModel(
        sessionId,
        model,
        message,
        userId
      );
      title = sanitizeGeneratedTitle(generation.title, message);
      source = generation.source;
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
    userId: string
  ): Promise<{ title: string; source: 'plugin' | 'ollama' }> {
    const target = await this.chatGenerationService.prepareGenerationTarget(
      model,
      userId,
      TITLE_GENERATION_OPTIONS
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
        target.mergedOptions,
        userId
      );

      return {
        title:
          this.chatGenerationService.extractPluginAssistantContent(
            pluginResponse
          ),
        source: 'plugin',
      };
    }

    const response = await this.ollamaService.generateResponse({
      model: target.actualModelName,
      prompt,
      stream: false,
      options: {
        ...target.mergedOptions,
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
