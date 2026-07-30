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

import { OPENAI_RESPONSES_OUTPUT_ITEMS_METADATA_KEY } from './openAIResponsesAdapter.js';

export interface PluginToolCall {
  id: string;
  name: string;
  arguments: string;
  providerMetadata?: Record<string, unknown>;
}

export interface PluginStreamUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export type PluginStreamChunk =
  | { type: 'content'; content: string }
  | { type: 'reasoning'; content: string }
  | { type: 'tool_call'; toolCall: PluginToolCall }
  | { type: 'usage'; usage: PluginStreamUsage }
  | {
      type: 'done';
      doneReason?: string;
      providerMetadata?: Record<string, unknown>;
    };

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
  let reasoningContent = '';
  let completed = false;

  const completedToolCalls = (): PluginToolCall[] => {
    const calls = [...toolCallsInProgress.values()];
    if (reasoningContent && calls[0]) {
      calls[0].providerMetadata = {
        ...calls[0].providerMetadata,
        openAIReasoningContent: reasoningContent,
      };
    }
    return calls;
  };

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
            for (const toolCall of completedToolCalls()) {
              yield { type: 'tool_call', toolCall };
            }
            toolCallsInProgress.clear();
            completed = true;
            yield { type: 'done' };
          }
          continue;
        }

        if (!trimmed.startsWith('data: ')) {
          continue;
        }

        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse(trimmed.slice(6)) as Record<string, unknown>;
        } catch {
          // Ignore malformed SSE payloads and keep the stream alive.
          continue;
        }
        const providerError = pluginStreamError(payload);
        if (providerError) {
          throw new Error(`Plugin API error: ${providerError}`);
        }
        const usage = parseOpenAIUsage(payload.usage);
        if (usage) {
          yield { type: 'usage', usage };
        }
        const delta = getChoiceDelta(payload);
        if (!delta) {
          continue;
        }

        const reasoning =
          typeof delta.reasoning_content === 'string'
            ? delta.reasoning_content
            : typeof delta.reasoning === 'string'
              ? delta.reasoning
              : '';
        if (reasoning) {
          reasoningContent += reasoning;
          yield { type: 'reasoning', content: reasoning };
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
      }
    }

    if (!completed) {
      for (const toolCall of completedToolCalls()) {
        yield { type: 'tool_call', toolCall };
      }
      yield { type: 'done' };
    }
  } finally {
    reader.releaseLock();
  }
}

function pluginStreamError(
  payload: Record<string, unknown>
): string | undefined {
  const error =
    payload.error && typeof payload.error === 'object'
      ? (payload.error as Record<string, unknown>)
      : undefined;
  const message =
    typeof error?.message === 'string'
      ? error.message
      : typeof payload.error === 'string'
        ? payload.error
        : typeof payload.message === 'string' &&
            (payload.type === 'error' || payload.status === 'error')
          ? payload.message
          : undefined;
  return message?.slice(0, 500);
}

function parseOpenAIUsage(value: unknown): PluginStreamUsage | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const usage = value as Record<string, unknown>;
  const promptTokens =
    typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : undefined;
  const completionTokens =
    typeof usage.completion_tokens === 'number'
      ? usage.completion_tokens
      : undefined;
  const totalTokens =
    typeof usage.total_tokens === 'number' ? usage.total_tokens : undefined;
  return promptTokens !== undefined ||
    completionTokens !== undefined ||
    totalTokens !== undefined
    ? { promptTokens, completionTokens, totalTokens }
    : undefined;
}

function parseResponsesUsage(value: unknown): PluginStreamUsage | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const usage = value as Record<string, unknown>;
  const promptTokens =
    typeof usage.input_tokens === 'number' ? usage.input_tokens : undefined;
  const completionTokens =
    typeof usage.output_tokens === 'number' ? usage.output_tokens : undefined;
  const totalTokens =
    typeof usage.total_tokens === 'number'
      ? usage.total_tokens
      : promptTokens !== undefined || completionTokens !== undefined
        ? (promptTokens || 0) + (completionTokens || 0)
        : undefined;
  return promptTokens !== undefined ||
    completionTokens !== undefined ||
    totalTokens !== undefined
    ? { promptTokens, completionTokens, totalTokens }
    : undefined;
}

function responsesItemKey(
  payload: Record<string, unknown>,
  item?: Record<string, unknown>
): string {
  if (typeof payload.item_id === 'string') return payload.item_id;
  if (typeof item?.id === 'string') return item.id;
  if (typeof payload.output_index === 'number') {
    return `output-${payload.output_index}`;
  }
  return `output-${Date.now()}`;
}

export async function* streamOpenAIResponsesResponse(
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
  const toolCalls = new Map<string, PluginToolCall>();
  const reasoningItems = new Map<string, Record<string, unknown>>();
  const outputItems = new Map<
    string,
    {
      item: Record<string, unknown>;
      order: number;
      outputIndex?: number;
    }
  >();
  let buffer = '';
  let completed = false;
  let emittedAssistantContent = false;
  let outputItemOrder = 0;

  const responseOutputContent = (output: unknown): string => {
    if (!Array.isArray(output)) return '';
    return output
      .flatMap(rawItem => {
        if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) {
          return [];
        }
        const item = rawItem as Record<string, unknown>;
        if (item.type !== 'message' || !Array.isArray(item.content)) return [];
        return item.content.flatMap(rawBlock => {
          if (
            !rawBlock ||
            typeof rawBlock !== 'object' ||
            Array.isArray(rawBlock)
          ) {
            return [];
          }
          const block = rawBlock as Record<string, unknown>;
          if (
            (block.type === 'output_text' || block.type === 'text') &&
            typeof block.text === 'string'
          ) {
            return [block.text];
          }
          if (block.type === 'refusal' && typeof block.refusal === 'string') {
            return [block.refusal];
          }
          return [];
        });
      })
      .join('');
  };

  const recordOutputItem = (
    payload: Record<string, unknown>,
    rawItem: unknown
  ) => {
    if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) {
      return;
    }
    const item = rawItem as Record<string, unknown>;
    const key = responsesItemKey(payload, item);
    const existingOutputItem = outputItems.get(key);
    outputItems.set(key, {
      item: { ...item },
      order: existingOutputItem?.order ?? outputItemOrder++,
      outputIndex:
        typeof payload.output_index === 'number'
          ? payload.output_index
          : existingOutputItem?.outputIndex,
    });

    if (item.type === 'reasoning') {
      reasoningItems.set(key, { ...item });
      return;
    }
    if (item.type !== 'function_call') return;

    const existing = toolCalls.get(key);
    toolCalls.set(key, {
      id:
        typeof item.call_id === 'string'
          ? item.call_id
          : typeof item.id === 'string'
            ? item.id
            : existing?.id || key,
      name: typeof item.name === 'string' ? item.name : existing?.name || '',
      arguments:
        typeof item.arguments === 'string'
          ? item.arguments
          : existing?.arguments || '',
    });
  };

  const emitTerminalChunks = function* (
    usage?: PluginStreamUsage,
    doneReason?: string
  ): Generator<PluginStreamChunk> {
    if (usage) yield { type: 'usage', usage };
    const calls = [...toolCalls.values()];
    if (reasoningItems.size > 0 && calls[0]) {
      calls[0].providerMetadata = {
        ...calls[0].providerMetadata,
        openAIResponsesReasoningItems: [...reasoningItems.values()],
      };
    }
    for (const toolCall of calls) {
      yield { type: 'tool_call', toolCall };
    }
    const replayableOutputItems = [...outputItems.values()]
      .sort(
        (left, right) =>
          (left.outputIndex ?? Number.MAX_SAFE_INTEGER) -
            (right.outputIndex ?? Number.MAX_SAFE_INTEGER) ||
          left.order - right.order
      )
      .map(({ item }) => item);
    yield {
      type: 'done',
      ...(doneReason ? { doneReason } : {}),
      ...(replayableOutputItems.length > 0
        ? {
            providerMetadata: {
              [OPENAI_RESPONSES_OUTPUT_ITEMS_METADATA_KEY]:
                replayableOutputItems,
            },
          }
        : {}),
    };
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;

        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse(trimmed.slice(5).trim()) as Record<
            string,
            unknown
          >;
        } catch {
          continue;
        }

        const providerError = pluginStreamError(payload);
        if (providerError) {
          throw new Error(`Plugin API error: ${providerError}`);
        }

        const eventType =
          typeof payload.type === 'string' ? payload.type : undefined;
        if (
          eventType === 'response.failed' ||
          eventType === 'response.error' ||
          eventType === 'error'
        ) {
          throw new Error('Plugin API error: Responses stream failed');
        }

        if (
          (eventType === 'response.output_text.delta' ||
            eventType === 'response.refusal.delta') &&
          typeof payload.delta === 'string' &&
          payload.delta
        ) {
          emittedAssistantContent = true;
          yield { type: 'content', content: payload.delta };
          continue;
        }

        if (
          (eventType === 'response.reasoning_summary_text.delta' ||
            eventType === 'response.reasoning_summary.delta') &&
          typeof payload.delta === 'string' &&
          payload.delta
        ) {
          yield { type: 'reasoning', content: payload.delta };
          continue;
        }

        if (
          eventType === 'response.output_item.added' ||
          eventType === 'response.output_item.done'
        ) {
          recordOutputItem(payload, payload.item);
          continue;
        }

        if (
          eventType === 'response.function_call_arguments.delta' &&
          typeof payload.delta === 'string'
        ) {
          const key = responsesItemKey(payload);
          const existing = toolCalls.get(key) || {
            id: key,
            name: '',
            arguments: '',
          };
          existing.arguments += payload.delta;
          toolCalls.set(key, existing);
          continue;
        }

        if (
          eventType === 'response.function_call_arguments.done' &&
          typeof payload.arguments === 'string'
        ) {
          const key = responsesItemKey(payload);
          const existing = toolCalls.get(key) || {
            id: key,
            name: '',
            arguments: '',
          };
          existing.arguments = payload.arguments;
          if (typeof payload.name === 'string') existing.name = payload.name;
          toolCalls.set(key, existing);
          continue;
        }

        if (
          eventType === 'response.completed' ||
          eventType === 'response.incomplete'
        ) {
          const responseRecord =
            payload.response &&
            typeof payload.response === 'object' &&
            !Array.isArray(payload.response)
              ? (payload.response as Record<string, unknown>)
              : undefined;
          if (Array.isArray(responseRecord?.output)) {
            outputItems.clear();
            reasoningItems.clear();
            outputItemOrder = 0;
            for (const [outputIndex, item] of responseRecord.output.entries()) {
              recordOutputItem({ output_index: outputIndex }, item);
            }
          }
          if (!emittedAssistantContent) {
            const terminalContent = responseOutputContent(
              responseRecord?.output
            );
            if (terminalContent) {
              emittedAssistantContent = true;
              yield { type: 'content', content: terminalContent };
            }
          }
          const usage = parseResponsesUsage(responseRecord?.usage);
          const incompleteDetails =
            responseRecord?.incomplete_details &&
            typeof responseRecord.incomplete_details === 'object' &&
            !Array.isArray(responseRecord.incomplete_details)
              ? (responseRecord.incomplete_details as Record<string, unknown>)
              : undefined;
          const incompleteReason =
            eventType === 'response.incomplete' ||
            responseRecord?.status === 'incomplete'
              ? typeof incompleteDetails?.reason === 'string'
                ? incompleteDetails.reason
                : 'unknown'
              : undefined;
          for (const chunk of emitTerminalChunks(
            usage,
            incompleteReason ? `incomplete:${incompleteReason}` : undefined
          )) {
            yield chunk;
          }
          completed = true;
        }
      }
    }

    if (!completed) {
      for (const chunk of emitTerminalChunks(
        undefined,
        'incomplete:stream_ended'
      )) {
        yield chunk;
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
  const thinkingBlocks = new Map<number, Record<string, unknown>>();
  let buffer = '';
  let completed = false;
  let attachedThinking = false;
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;

  const attachThinking = (toolCall: PluginToolCall): PluginToolCall => {
    if (attachedThinking || thinkingBlocks.size === 0) return toolCall;
    attachedThinking = true;
    return {
      ...toolCall,
      providerMetadata: {
        ...toolCall.providerMetadata,
        anthropicThinkingBlocks: [...thinkingBlocks.values()],
      },
    };
  };

  const usageChunk = (): PluginStreamChunk | undefined => {
    if (inputTokens === undefined && outputTokens === undefined) {
      return undefined;
    }
    return {
      type: 'usage',
      usage: {
        promptTokens: inputTokens,
        completionTokens: outputTokens,
        totalTokens: (inputTokens || 0) + (outputTokens || 0),
      },
    };
  };

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
        if (eventType === 'message_start') {
          const message =
            payload.message && typeof payload.message === 'object'
              ? (payload.message as Record<string, unknown>)
              : undefined;
          const usage =
            message?.usage && typeof message.usage === 'object'
              ? (message.usage as Record<string, unknown>)
              : undefined;
          if (typeof usage?.input_tokens === 'number') {
            inputTokens = usage.input_tokens;
            const chunk = usageChunk();
            if (chunk) yield chunk;
          }
          continue;
        }

        if (eventType === 'message_delta') {
          const usage =
            payload.usage && typeof payload.usage === 'object'
              ? (payload.usage as Record<string, unknown>)
              : undefined;
          if (typeof usage?.output_tokens === 'number') {
            outputTokens = usage.output_tokens;
            const chunk = usageChunk();
            if (chunk) yield chunk;
          }
          continue;
        }

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
          } else if (
            index !== undefined &&
            (contentBlock?.type === 'thinking' ||
              contentBlock?.type === 'redacted_thinking')
          ) {
            thinkingBlocks.set(index, { ...contentBlock });
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
            delta?.type === 'thinking_delta' &&
            typeof delta.thinking === 'string'
          ) {
            const block = thinkingBlocks.get(index);
            if (block) {
              block.thinking = `${typeof block.thinking === 'string' ? block.thinking : ''}${delta.thinking}`;
            }
            if (delta.thinking) {
              yield { type: 'reasoning', content: delta.thinking };
            }
          } else if (
            index !== undefined &&
            delta?.type === 'signature_delta' &&
            typeof delta.signature === 'string'
          ) {
            const block = thinkingBlocks.get(index);
            if (block) {
              block.signature = `${typeof block.signature === 'string' ? block.signature : ''}${delta.signature}`;
            }
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
            yield { type: 'tool_call', toolCall: attachThinking(toolCall) };
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
            yield { type: 'tool_call', toolCall: attachThinking(toolCall) };
          }
          toolCallsInProgress.clear();
          completed = true;
          yield { type: 'done' };
        }
      }
    }

    if (!completed) {
      for (const toolCall of toolCallsInProgress.values()) {
        yield { type: 'tool_call', toolCall: attachThinking(toolCall) };
      }
      yield { type: 'done' };
    }
  } finally {
    reader.releaseLock();
  }
}
