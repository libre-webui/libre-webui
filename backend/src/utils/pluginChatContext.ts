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
  replaceLatestUserMessageContent,
  sanitizeChatMessageProviderState,
  toChatMessages,
  type ChatContextMessage,
} from './chatContext.js';
import type { ChatMessage } from '../types/index.js';

export type PluginVariables = Record<string, string | number | boolean>;

export interface PluginChatContextOptions {
  isPrivate: boolean;
  persistedMessages: readonly ChatMessage[];
  messageHistory?: readonly ChatContextMessage[];
  regenerate?: boolean;
  content: string;
  images?: string[];
  hasRelevantContext?: boolean;
  enhancedContent?: string;
  pluginVariables?: PluginVariables;
  now?: () => number;
}

export interface PluginChatContextResult {
  messages: ChatMessage[];
  shouldStream: boolean;
}

export function resolvePluginStreamFlag(value: unknown): boolean {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    return value.trim().toLowerCase() === 'true';
  }

  return false;
}

export function buildPluginIdentityContent(
  pluginVariables: PluginVariables = {}
): string {
  const systemPromptPrefix =
    typeof pluginVariables.system_prompt_prefix === 'string'
      ? pluginVariables.system_prompt_prefix
      : '';
  const userName =
    typeof pluginVariables.user_name === 'string'
      ? pluginVariables.user_name
      : '';

  if (!systemPromptPrefix && !userName) {
    return '';
  }

  if (!userName) {
    return systemPromptPrefix;
  }

  return systemPromptPrefix
    ? `${systemPromptPrefix}\n\nThe user's name is: ${userName}`
    : `The user's name is: ${userName}`;
}

export function preparePluginChatContext({
  isPrivate,
  persistedMessages,
  messageHistory = [],
  regenerate = false,
  content,
  images,
  hasRelevantContext = false,
  enhancedContent,
  pluginVariables = {},
  now = Date.now,
}: PluginChatContextOptions): PluginChatContextResult {
  let messages = isPrivate
    ? toChatMessages(
        regenerate
          ? messageHistory
          : [
              ...messageHistory,
              {
                role: 'user' as const,
                content,
                images,
              },
            ],
        'private-context'
      )
    : [...persistedMessages];

  // Legacy sessions and private client histories may contain Responses API
  // function calls without matching tool results. Never replay that raw state
  // from Chat; the visible assistant content remains in the conversation.
  messages = messages.map(sanitizeChatMessageProviderState);

  if (hasRelevantContext && enhancedContent) {
    messages = replaceLatestUserMessageContent(messages, enhancedContent);
  }

  const identityContent = buildPluginIdentityContent(pluginVariables);
  if (identityContent) {
    messages = [
      {
        id: 'system-identity',
        role: 'system',
        content: identityContent,
        timestamp: now(),
      },
      ...messages,
    ];
  }

  return {
    messages,
    shouldStream: resolvePluginStreamFlag(pluginVariables.stream),
  };
}
