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

export type ChatContextMessage = Pick<
  ChatMessage,
  'role' | 'content' | 'images'
>;
type ContentMessage = {
  role: string;
  content: string;
};

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

  return [
    {
      role: 'system',
      content: prompt,
    },
    ...messages.filter(message => message.role !== 'system'),
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
    images: message.images,
    timestamp,
  }));
}
