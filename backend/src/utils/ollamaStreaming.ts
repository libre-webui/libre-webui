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

import type {
  GenerationStatistics,
  OllamaChatRequest,
  OllamaChatResponse,
} from '../types/index.js';
import { extractStatistics } from './generationUtils.js';
import {
  sendAssistantChunk,
  sendError,
  type WebSocketLike,
} from './websocketMessages.js';

export interface OllamaChatStreamGenerator {
  generateChatStreamResponse(
    request: OllamaChatRequest,
    onChunk: (chunk: OllamaChatResponse) => void,
    onError: (error: Error) => void,
    onComplete: () => void,
    signal?: AbortSignal,
    usage?: { userId?: string }
  ): Promise<void>;
}

export interface StreamOllamaChatResponseOptions {
  ws: WebSocketLike;
  request: OllamaChatRequest;
  streamSource: OllamaChatStreamGenerator;
  messageId?: string;
  /** Attributes the metered usage of this call to a user. */
  userId?: string;
}

export interface StreamOllamaChatResponseResult {
  content: string;
  statistics?: GenerationStatistics;
  completed: boolean;
  error?: Error;
}

export async function streamOllamaChatResponse({
  ws,
  request,
  streamSource,
  messageId,
  userId,
}: StreamOllamaChatResponseOptions): Promise<StreamOllamaChatResponseResult> {
  return new Promise(resolve => {
    let content = '';
    let statistics: GenerationStatistics | undefined;
    let resolved = false;

    const finish = (
      result: Omit<StreamOllamaChatResponseResult, 'content'>
    ) => {
      if (resolved) {
        return;
      }

      resolved = true;
      resolve({
        content,
        statistics,
        ...result,
      });
    };

    const handleChunk = (chunk: OllamaChatResponse) => {
      if (resolved) {
        return;
      }

      if (chunk.message?.content) {
        content += chunk.message.content;
        sendAssistantChunk(ws, {
          content: chunk.message.content,
          total: content,
          done: chunk.done,
          messageId,
        });
      }

      if (chunk.done) {
        statistics = extractStatistics(chunk);
        finish({ completed: true });
      }
    };

    const handleError = (error: Error) => {
      if (resolved) {
        return;
      }

      sendError(ws, { error: error.message });
      finish({ completed: false, error });
    };

    streamSource
      .generateChatStreamResponse(
        request,
        handleChunk,
        handleError,
        () => finish({ completed: true }),
        undefined,
        { userId }
      )
      .catch(error => {
        handleError(error instanceof Error ? error : new Error(String(error)));
      });
  });
}
