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
