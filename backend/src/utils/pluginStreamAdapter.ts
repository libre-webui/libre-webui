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

export interface PluginToolCall {
  id: string;
  name: string;
  arguments: string;
}

export type PluginStreamChunk =
  | { type: 'content'; content: string }
  | { type: 'tool_call'; toolCall: PluginToolCall }
  | { type: 'done' };

interface ToolCallDelta {
  index: number;
  id?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
}

function getChoiceDelta(payload: unknown): Record<string, unknown> | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const choices = (payload as Record<string, unknown>).choices;
  if (!Array.isArray(choices)) {
    return null;
  }

  const firstChoice = choices[0];
  if (!firstChoice || typeof firstChoice !== 'object') {
    return null;
  }

  const delta = (firstChoice as Record<string, unknown>).delta;
  if (!delta || typeof delta !== 'object') {
    return null;
  }

  return delta as Record<string, unknown>;
}

function parseToolCallDelta(toolCall: unknown): ToolCallDelta | null {
  if (!toolCall || typeof toolCall !== 'object') {
    return null;
  }

  const toolCallRecord = toolCall as Record<string, unknown>;
  const functionRecord =
    toolCallRecord.function && typeof toolCallRecord.function === 'object'
      ? (toolCallRecord.function as Record<string, unknown>)
      : undefined;

  return {
    index: typeof toolCallRecord.index === 'number' ? toolCallRecord.index : 0,
    id: typeof toolCallRecord.id === 'string' ? toolCallRecord.id : undefined,
    function: functionRecord
      ? {
          name:
            typeof functionRecord.name === 'string'
              ? functionRecord.name
              : undefined,
          arguments:
            typeof functionRecord.arguments === 'string'
              ? functionRecord.arguments
              : undefined,
        }
      : undefined,
  };
}

function applyToolCallDelta(
  toolCallsInProgress: Map<number, PluginToolCall>,
  delta: ToolCallDelta
): void {
  if (!toolCallsInProgress.has(delta.index)) {
    toolCallsInProgress.set(delta.index, {
      id: '',
      name: '',
      arguments: '',
    });
  }

  const existing = toolCallsInProgress.get(delta.index);
  if (!existing) {
    return;
  }

  if (delta.id) {
    existing.id = delta.id;
  }
  if (delta.function?.name) {
    existing.name = delta.function.name;
  }
  if (delta.function?.arguments) {
    existing.arguments += delta.function.arguments;
  }
}

export async function* streamOpenAICompatibleResponse(
  response: Awaited<ReturnType<typeof fetch>>
): AsyncGenerator<PluginStreamChunk, void, unknown> {
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Plugin API error: ${response.status} - ${errorText.slice(0, 200)}`
    );
  }

  if (!response.body) {
    throw new Error('No response body for streaming');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const toolCallsInProgress = new Map<number, PluginToolCall>();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === 'data: [DONE]') {
          if (trimmed === 'data: [DONE]') {
            for (const toolCall of toolCallsInProgress.values()) {
              yield { type: 'tool_call', toolCall };
            }
            yield { type: 'done' };
          }
          continue;
        }

        if (!trimmed.startsWith('data: ')) {
          continue;
        }

        try {
          const delta = getChoiceDelta(JSON.parse(trimmed.slice(6)));
          if (!delta) {
            continue;
          }

          if (typeof delta.content === 'string' && delta.content) {
            yield { type: 'content', content: delta.content };
          }

          if (Array.isArray(delta.tool_calls)) {
            for (const toolCall of delta.tool_calls) {
              const parsedDelta = parseToolCallDelta(toolCall);
              if (parsedDelta) {
                applyToolCallDelta(toolCallsInProgress, parsedDelta);
              }
            }
          }
        } catch {
          // Ignore malformed SSE payloads and keep the stream alive.
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function getAnthropicEventType(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const type = (payload as Record<string, unknown>).type;
  return typeof type === 'string' ? type : null;
}

export async function* streamAnthropicResponse(
  response: Awaited<ReturnType<typeof fetch>>
): AsyncGenerator<PluginStreamChunk, void, unknown> {
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Plugin API error: ${response.status} - ${errorText.slice(0, 200)}`
    );
  }

  if (!response.body) {
    throw new Error('No response body for streaming');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const toolCallsInProgress = new Map<number, PluginToolCall>();
  let buffer = '';
  let completed = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) {
          continue;
        }

        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse(trimmed.slice(5).trim()) as Record<
            string,
            unknown
          >;
        } catch {
          // Anthropic may add event types over time. Ignore malformed data
          // without ending an otherwise healthy stream.
          continue;
        }

        const eventType = getAnthropicEventType(payload);
        if (eventType === 'content_block_start') {
          const index =
            typeof payload.index === 'number' ? payload.index : undefined;
          const contentBlock =
            payload.content_block && typeof payload.content_block === 'object'
              ? (payload.content_block as Record<string, unknown>)
              : undefined;

          if (
            index !== undefined &&
            contentBlock?.type === 'tool_use' &&
            typeof contentBlock.id === 'string' &&
            typeof contentBlock.name === 'string'
          ) {
            toolCallsInProgress.set(index, {
              id: contentBlock.id,
              name: contentBlock.name,
              arguments: '',
            });
          }
          continue;
        }

        if (eventType === 'content_block_delta') {
          const index =
            typeof payload.index === 'number' ? payload.index : undefined;
          const delta =
            payload.delta && typeof payload.delta === 'object'
              ? (payload.delta as Record<string, unknown>)
              : undefined;

          if (
            delta?.type === 'text_delta' &&
            typeof delta.text === 'string' &&
            delta.text
          ) {
            yield { type: 'content', content: delta.text };
          } else if (
            index !== undefined &&
            delta?.type === 'input_json_delta' &&
            typeof delta.partial_json === 'string'
          ) {
            const toolCall = toolCallsInProgress.get(index);
            if (toolCall) {
              toolCall.arguments += delta.partial_json;
            }
          }
          continue;
        }

        if (eventType === 'content_block_stop') {
          const index =
            typeof payload.index === 'number' ? payload.index : undefined;
          const toolCall =
            index === undefined ? undefined : toolCallsInProgress.get(index);
          if (index !== undefined && toolCall) {
            toolCallsInProgress.delete(index);
            yield { type: 'tool_call', toolCall };
          }
          continue;
        }

        if (eventType === 'error') {
          const error =
            payload.error && typeof payload.error === 'object'
              ? (payload.error as Record<string, unknown>)
              : undefined;
          const message =
            typeof error?.message === 'string'
              ? error.message
              : 'Anthropic streaming error';
          throw new Error(`Plugin API error: ${message}`);
        }

        if (eventType === 'message_stop') {
          for (const toolCall of toolCallsInProgress.values()) {
            yield { type: 'tool_call', toolCall };
          }
          toolCallsInProgress.clear();
          completed = true;
          yield { type: 'done' };
        }
      }
    }

    if (!completed) {
      for (const toolCall of toolCallsInProgress.values()) {
        yield { type: 'tool_call', toolCall };
      }
      yield { type: 'done' };
    }
  } finally {
    reader.releaseLock();
  }
}
