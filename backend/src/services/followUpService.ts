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
import { normalizeChatProviderSelection } from '../utils/chatProviderSelection.js';

const FOLLOW_UP_GENERATION_OPTIONS: GenerationOptions = {
  temperature: 0.7,
  num_predict: 200,
};

const MAX_SUGGESTIONS = 4;
const MAX_SUGGESTION_LENGTH = 120;
const CONTEXT_CHARS = 1500;

export function buildFollowUpPrompt(
  userMessage: string,
  assistantMessage: string
): string {
  return `Given this exchange from a conversation, suggest ${MAX_SUGGESTIONS} short follow-up messages the user might naturally send next. Write them from the user's perspective. Each suggestion must be a single sentence under 15 words. Respond with one suggestion per line, no numbering, no bullets, no quotes, nothing else.

User: "${userMessage.slice(0, CONTEXT_CHARS)}"

Assistant: "${assistantMessage.slice(0, CONTEXT_CHARS)}"

Suggestions:`;
}

export function parseFollowUpSuggestions(raw: string): string[] {
  const seen = new Set<string>();
  const suggestions: string[] = [];

  for (const line of raw.split('\n')) {
    const cleaned = line
      .trim()
      .replace(/^```(?:\w+)?\s*|\s*```$/g, '')
      .replace(/^[-*••]+\s*/, '')
      .replace(/^\d+[.)]\s*/, '')
      .replace(/^["'`]+|["'`]+$/g, '')
      .trim();

    if (!cleaned || cleaned.length > MAX_SUGGESTION_LENGTH) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    suggestions.push(cleaned);
    if (suggestions.length >= MAX_SUGGESTIONS) break;
  }

  return suggestions;
}

interface ChatServiceDependency {
  getSession(
    sessionId: string,
    userId?: string
  ): Promise<ChatSession | undefined>;
}

interface ChatGenerationServiceDependency {
  prepareGenerationTarget(
    sessionModel: string,
    userId: string,
    options?: GenerationOptions,
    providerSelection?: ReturnType<typeof normalizeChatProviderSelection>
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

export interface FollowUpServiceDependencies {
  chatService: ChatServiceDependency;
  chatGenerationService: ChatGenerationServiceDependency;
  pluginService: PluginServiceDependency;
  ollamaService: OllamaServiceDependency;
  now?: () => number;
  logger?: Pick<Console, 'error'>;
}

export class FollowUpService {
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
  }: FollowUpServiceDependencies) {
    this.chatService = chatService;
    this.chatGenerationService = chatGenerationService;
    this.pluginService = pluginService;
    this.ollamaService = ollamaService;
    this.now = now;
    this.logger = logger;
  }

  /**
   * Suggest follow-up messages for the latest exchange in a session.
   * Returns null when the session does not exist, an empty list when the
   * conversation has no completed exchange or generation fails.
   */
  async generateFollowUpsForSession(
    sessionId: string,
    userId = 'default'
  ): Promise<string[] | null> {
    const session = await this.chatService.getSession(sessionId, userId);
    if (!session) {
      return null;
    }

    const activeMessages = session.messages.filter(
      message => message.isActive !== false
    );
    const lastAssistant = [...activeMessages]
      .reverse()
      .find(message => message.role === 'assistant' && message.content.trim());
    const lastUser = [...activeMessages]
      .reverse()
      .find(message => message.role === 'user' && message.content.trim());

    if (!lastAssistant || !lastUser) {
      return [];
    }

    try {
      const raw = await this.generateWithModel(
        sessionId,
        session,
        lastUser.content,
        lastAssistant.content,
        userId
      );
      return parseFollowUpSuggestions(raw);
    } catch (error) {
      this.logger.error('Error generating follow-up suggestions:', error);
      return [];
    }
  }

  private async generateWithModel(
    sessionId: string,
    session: ChatSession,
    userMessage: string,
    assistantMessage: string,
    userId: string
  ): Promise<string> {
    const target = await this.chatGenerationService.prepareGenerationTarget(
      session.model,
      userId,
      FOLLOW_UP_GENERATION_OPTIONS,
      normalizeChatProviderSelection(session)
    );
    const prompt = buildFollowUpPrompt(userMessage, assistantMessage);

    if (target.activePlugin) {
      const pluginResponse = await this.pluginService.executePluginRequest(
        target.actualModelName,
        [
          {
            id: `followups-${sessionId}`,
            role: 'user',
            content: prompt,
            timestamp: this.now(),
          },
        ],
        target.mergedOptions,
        userId,
        target.activePlugin.id
      );

      return this.chatGenerationService.extractPluginAssistantContent(
        pluginResponse
      );
    }

    const response = await this.ollamaService.generateResponse({
      model: target.actualModelName,
      prompt,
      stream: false,
      think: false,
      options: {
        ...target.mergedOptions,
        temperature: FOLLOW_UP_GENERATION_OPTIONS.temperature,
        num_predict: FOLLOW_UP_GENERATION_OPTIONS.num_predict,
      },
    });

    return response.response;
  }
}
