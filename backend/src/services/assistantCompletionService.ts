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
  buildAssistantBranchingFields,
  type AssistantBranchingFields,
} from '../utils/assistantBranching.js';
import chatService from './chatService.js';
import type {
  ChatMessage,
  ChatSession,
  GenerationStatistics,
} from '../types/index.js';
import { throwIfChatGenerationCancelled } from '../utils/chatCancellation.js';

export interface AssistantCompletionInput {
  sessionId: string;
  session: ChatSession;
  content: string;
  thinking?: string;
  model: string;
  messageId: string;
  userId: string;
  isPrivate: boolean;
  regenerate?: boolean;
  originalMessageId?: string;
  statistics?: GenerationStatistics;
  providerMetadata?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface AssistantCompletionResult {
  assistantMessage?: ChatMessage;
  privateMessage?: ChatMessage;
  branchingFields: AssistantBranchingFields;
}

class AssistantCompletionService {
  buildBranchingFields(
    session: ChatSession,
    regenerate?: boolean,
    originalMessageId?: string
  ): AssistantBranchingFields {
    return buildAssistantBranchingFields(
      session,
      regenerate,
      originalMessageId
    );
  }

  async completeAssistantMessage({
    sessionId,
    session,
    content,
    thinking,
    model,
    messageId,
    userId,
    isPrivate,
    regenerate,
    originalMessageId,
    statistics,
    providerMetadata,
    signal,
  }: AssistantCompletionInput): Promise<AssistantCompletionResult> {
    throwIfChatGenerationCancelled(signal);
    const branchingFields = this.buildBranchingFields(
      session,
      regenerate,
      originalMessageId
    );

    if (isPrivate) {
      return {
        privateMessage: {
          id: messageId,
          role: 'assistant',
          content,
          thinking,
          model,
          timestamp: Date.now(),
          statistics,
          providerMetadata,
        },
        branchingFields,
      };
    }

    const assistantMessage = await chatService.addMessage(
      sessionId,
      {
        role: 'assistant',
        content,
        thinking,
        model,
        id: messageId,
        statistics,
        providerMetadata,
        ...branchingFields,
      },
      userId,
      {
        assertPersistenceAllowed: () => throwIfChatGenerationCancelled(signal),
      }
    );

    return {
      assistantMessage,
      branchingFields,
    };
  }
}

export default new AssistantCompletionService();
