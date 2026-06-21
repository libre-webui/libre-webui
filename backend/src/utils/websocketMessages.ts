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

export interface WebSocketLike {
  send(data: string): void;
}

export interface AssistantChunkData {
  content: string;
  total: string;
  done: boolean;
  messageId?: string;
}

export interface ToolStatusData {
  toolCallId: string;
  name: string;
  phase: string;
}

export interface SendOptions {
  ignoreClosedSocket?: boolean;
}

type WebSocketMessageType =
  | 'connected'
  | 'user_message'
  | 'assistant_chunk'
  | 'assistant_complete'
  | 'tool_status'
  | 'error';

function sendWebSocketMessage(
  ws: WebSocketLike,
  type: WebSocketMessageType,
  data: unknown,
  options: SendOptions = {}
): boolean {
  try {
    ws.send(JSON.stringify({ type, data }));
    return true;
  } catch (error) {
    if (options.ignoreClosedSocket) {
      return false;
    }

    throw error;
  }
}

export function sendConnected(ws: WebSocketLike): boolean {
  return sendWebSocketMessage(ws, 'connected', {
    message: 'Connected to Libre WebUI',
  });
}

export function sendUserMessage(ws: WebSocketLike, data: unknown): boolean {
  return sendWebSocketMessage(ws, 'user_message', data);
}

export function sendAssistantChunk(
  ws: WebSocketLike,
  data: AssistantChunkData,
  options?: SendOptions
): boolean {
  return sendWebSocketMessage(ws, 'assistant_chunk', data, options);
}

export function sendAssistantComplete(
  ws: WebSocketLike,
  data: unknown
): boolean {
  return sendWebSocketMessage(ws, 'assistant_complete', data);
}

export function sendToolStatus(
  ws: WebSocketLike,
  data: ToolStatusData,
  options?: SendOptions
): boolean {
  return sendWebSocketMessage(ws, 'tool_status', data, options);
}

export function sendError(ws: WebSocketLike, data: unknown): boolean {
  return sendWebSocketMessage(ws, 'error', data);
}

export function buildAssistantFakeStreamChunks(
  content: string,
  messageId?: string,
  batchSize: number = 3
): AssistantChunkData[] {
  const words = content.split(' ');
  const chunks: AssistantChunkData[] = [];

  for (let i = 0; i < words.length; i += batchSize) {
    const batch = words.slice(i, i + batchSize);
    const total = words.slice(0, i + batch.length).join(' ');
    const isLast = i + batchSize >= words.length;

    chunks.push({
      content: batch.join(' ') + (isLast ? '' : ' '),
      total,
      done: isLast,
      messageId,
    });
  }

  return chunks;
}

export async function streamAssistantFakeChunks(
  ws: WebSocketLike,
  content: string,
  messageId?: string,
  delayMs: number = 100
): Promise<void> {
  const chunks = buildAssistantFakeStreamChunks(content, messageId);

  for (const [index, chunk] of chunks.entries()) {
    sendAssistantChunk(ws, chunk);

    if (index < chunks.length - 1) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
}
