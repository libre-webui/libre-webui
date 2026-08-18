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

import type { ChatMessage, OllamaChatMessage } from '../types/index.js';
import {
  boundedOpenAIResponsesOutputItems,
  OPENAI_RESPONSES_OUTPUT_ITEMS_METADATA_KEY,
  OPENAI_RESPONSES_STATE_DROPPED_METADATA_KEY,
  OPENAI_RESPONSES_STATE_SCOPE_METADATA_KEY,
} from './openAIResponsesAdapter.js';

export type ChatContextMessage = Pick<
  ChatMessage,
  'role' | 'content' | 'thinking' | 'images' | 'providerMetadata'
>;

/**
 * Marks a system message produced by context compaction. Lives here rather
 * than in the compaction service so message-shaping utilities can recognize
 * summaries without importing a service.
 */
export const COMPACTION_SUMMARY_PREFIX = '[Conversation summary] ';

export function isCompactionSummaryContent(content: string): boolean {
  return content.startsWith(COMPACTION_SUMMARY_PREFIX);
}
type ContentMessage = {
  role: string;
  content: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Chat does not persist tool results, so replaying a Responses API
 * `function_call` item on the next turn would create an orphaned call. Keep the
 * visible assistant content, but discard the raw replay state and its scope.
 */
export function sanitizeChatProviderMetadata(
  providerMetadata: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  const outputItems =
    providerMetadata?.[OPENAI_RESPONSES_OUTPUT_ITEMS_METADATA_KEY];
  const containsFunctionCall =
    Array.isArray(outputItems) &&
    outputItems.some(item => isRecord(item) && item.type === 'function_call');
  const boundedOutput = boundedOpenAIResponsesOutputItems(outputItems);
  const dropsReplayState = containsFunctionCall || boundedOutput.dropped;

  if (!providerMetadata || !dropsReplayState) {
    return providerMetadata;
  }

  const sanitized = { ...providerMetadata };
  delete sanitized[OPENAI_RESPONSES_OUTPUT_ITEMS_METADATA_KEY];
  delete sanitized[OPENAI_RESPONSES_STATE_SCOPE_METADATA_KEY];
  if (boundedOutput.dropped) {
    sanitized[OPENAI_RESPONSES_STATE_DROPPED_METADATA_KEY] = true;
  }

  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

export function sanitizeChatMessageProviderState<T extends ChatContextMessage>(
  message: T
): T {
  const providerMetadata = sanitizeChatProviderMetadata(
    message.providerMetadata
  );

  if (providerMetadata === message.providerMetadata) {
    return message;
  }

  const sanitized = { ...message };
  delete sanitized.providerMetadata;
  return {
    ...sanitized,
    ...(providerMetadata ? { providerMetadata } : {}),
  };
}

/**
 * Retain complete user-led turns. A plain `slice(-N)` can begin with an
 * assistant message whose provider state depends on an omitted user turn.
 */
export function selectChatMessagesForContext<
  T extends Pick<ChatMessage, 'role' | 'isActive'>,
>(messages: readonly T[], maxMessages = 10): T[] {
  const systemMessages = messages.filter(
    message => message.role === 'system' && message.isActive !== false
  );
  const conversationMessages = messages.filter(
    message => message.role !== 'system' && message.isActive !== false
  );
  const limit = Math.max(0, Math.floor(maxMessages));
  const recentConversation =
    limit > 0 ? conversationMessages.slice(-limit) : [];
  const firstUserIndex = recentConversation.findIndex(
    message => message.role === 'user'
  );
  const alignedConversation =
    firstUserIndex >= 0 ? recentConversation.slice(firstUserIndex) : [];

  return [...systemMessages, ...alignedConversation];
}

export function getLatestUserMessageIndex(
  messages: readonly Pick<ContentMessage, 'role'>[]
): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'user') {
      return i;
    }
  }

  return -1;
}

export function replaceLatestUserMessageContent<T extends ContentMessage>(
  messages: readonly T[],
  content: string
): T[] {
  const latestUserMessageIndex = getLatestUserMessageIndex(messages);

  if (latestUserMessageIndex === -1) {
    return [...messages];
  }

  return messages.map((message, index) =>
    index === latestUserMessageIndex ? { ...message, content } : message
  );
}

export function stripDataUrlPrefix(image: string): string {
  if (!image.includes(',')) {
    return image;
  }

  const base64Index = image.indexOf(',');
  return base64Index === -1 ? image : image.substring(base64Index + 1);
}

export function toOllamaMessages(
  messages: readonly ChatContextMessage[],
  options: { latestUserContent?: string; stripImageDataUrls?: boolean } = {}
): OllamaChatMessage[] {
  const latestUserMessageIndex = options.latestUserContent
    ? getLatestUserMessageIndex(messages)
    : -1;

  return messages.map((message, index) => {
    const ollamaMessage: OllamaChatMessage = {
      role: message.role,
      content:
        index === latestUserMessageIndex && options.latestUserContent
          ? options.latestUserContent
          : message.content,
    };

    if (message.images?.length) {
      ollamaMessage.images =
        options.stripImageDataUrls === false
          ? [...message.images]
          : message.images.map(stripDataUrlPrefix);
    }

    if (message.thinking) {
      ollamaMessage.thinking = message.thinking;
    }

    return ollamaMessage;
  });
}

export function withSystemPrompt(
  messages: readonly OllamaChatMessage[],
  systemPrompt?: string
): OllamaChatMessage[] {
  const prompt = systemPrompt?.trim();

  if (!prompt) {
    return [...messages];
  }

  // The persona prompt replaces stored system messages, except a compaction
  // summary — dropping that would silently lose the compacted history.
  return [
    {
      role: 'system',
      content: prompt,
    },
    ...messages.filter(
      message =>
        message.role !== 'system' || isCompactionSummaryContent(message.content)
    ),
  ];
}

export function toChatMessages(
  messages: readonly ChatContextMessage[],
  idPrefix: string
): ChatMessage[] {
  const timestamp = Date.now();

  return messages.map((message, index) => ({
    id: `${idPrefix}-${index}`,
    role: message.role,
    content: message.content,
    thinking: message.thinking,
    images: message.images,
    providerMetadata: message.providerMetadata,
    timestamp,
  }));
}
