/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import type { PluginResponse } from '../types/index.js';

type JsonObject = Record<string, unknown>;

export const OPENAI_RESPONSES_OUTPUT_ITEMS_METADATA_KEY =
  'openAIResponsesOutputItems';
export const OPENAI_RESPONSES_INCOMPLETE_REASON_METADATA_KEY =
  'openAIResponsesIncompleteReason';

export interface OpenAICompatibleChatMessage {
  role: string;
  content?: unknown;
  name?: string;
  tool_call_id?: string;
  call_id?: string;
  tool_calls?: unknown;
}

export interface OpenAIResponsesPayloadOptions {
  tools?: readonly JsonObject[];
  tool_choice?: unknown;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stream?: boolean;
}

export interface OpenAIResponsesPayload extends JsonObject {
  model: string;
  input: JsonObject[];
  store: false;
}

export interface NormalizedOpenAIResponsesToolCall {
  id: string;
  call_id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
  providerMetadata?: Record<string, unknown>;
}

export type NormalizedOpenAIResponsesResponse = Omit<
  PluginResponse,
  'choices'
> & {
  choices: Array<{
    index: number;
    message: {
      role: 'assistant';
      content: string;
      reasoning_content?: string;
      tool_calls?: NormalizedOpenAIResponsesToolCall[];
    };
    finish_reason: string;
  }>;
};

function asObject(value: unknown): JsonObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function stringifyJsonValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  if (value === undefined || value === null) {
    return '';
  }

  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function hasMessageContent(content: unknown): boolean {
  if (typeof content === 'string') {
    return content.length > 0;
  }

  return Array.isArray(content) && content.length > 0;
}

function toResponsesMessageContent(content: unknown): string | JsonObject[] {
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return stringifyJsonValue(content);
  }

  return content.flatMap<JsonObject>(rawBlock => {
    const block = asObject(rawBlock);
    if (!block) {
      return [];
    }

    if (
      (block.type === 'text' ||
        block.type === 'input_text' ||
        block.type === 'output_text') &&
      typeof block.text === 'string'
    ) {
      return [{ type: 'input_text', text: block.text }];
    }

    if (block.type !== 'image_url' && block.type !== 'input_image') {
      return [];
    }

    const imageUrlObject = asObject(block.image_url);
    const imageUrl =
      nonEmptyString(block.image_url) || nonEmptyString(imageUrlObject?.url);
    if (!imageUrl) {
      return [];
    }

    const detail =
      nonEmptyString(block.detail) || nonEmptyString(imageUrlObject?.detail);
    return [
      {
        type: 'input_image',
        image_url: imageUrl,
        ...(detail ? { detail } : {}),
      },
    ];
  });
}

function toResponsesFunctionCalls(
  value: unknown,
  messageIndex: number
): JsonObject[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((rawCall, callIndex) => {
    const call = asObject(rawCall);
    const fn = asObject(call?.function);
    const name = nonEmptyString(fn?.name) || nonEmptyString(call?.name);
    if (!call || !name) {
      return [];
    }

    const callId =
      nonEmptyString(call.call_id) ||
      nonEmptyString(call.id) ||
      `call-${messageIndex}-${callIndex}`;
    const args =
      fn && 'arguments' in fn ? fn.arguments : (call.arguments ?? undefined);

    return [
      {
        type: 'function_call',
        call_id: callId,
        name,
        arguments: stringifyJsonValue(args),
      },
    ];
  });
}

/**
 * Converts Chat Completions-style history into stateless Responses API input.
 * Assistant tool calls and tool results become sibling typed input items so
 * their call IDs remain correlated without relying on stored response state.
 */
export function toOpenAIResponsesInput(
  messages: readonly OpenAICompatibleChatMessage[]
): JsonObject[] {
  return messages.flatMap((message, messageIndex) => {
    if (message.role === 'tool') {
      return [
        {
          type: 'function_call_output',
          call_id:
            nonEmptyString(message.call_id) ||
            nonEmptyString(message.tool_call_id) ||
            `call-${messageIndex}`,
          output: stringifyJsonValue(message.content),
        },
      ];
    }

    const functionCalls = toResponsesFunctionCalls(
      message.tool_calls,
      messageIndex
    );
    const items: JsonObject[] = [];

    if (hasMessageContent(message.content) || functionCalls.length === 0) {
      items.push({
        role: message.role,
        content: toResponsesMessageContent(message.content),
      });
    }

    items.push(...functionCalls);
    return items;
  });
}

/**
 * Flattens Chat Completions function tools into the shape accepted by the
 * Responses API. Non-function tools are preserved for compatible providers.
 */
export function toOpenAIResponsesTools(
  tools: readonly JsonObject[] = []
): JsonObject[] {
  return tools.flatMap(tool => {
    if (tool.type !== 'function') {
      return [{ ...tool }];
    }

    const fn = asObject(tool.function);
    const name = nonEmptyString(fn?.name) || nonEmptyString(tool.name);
    if (!name) {
      return [];
    }

    const description = fn?.description ?? tool.description;
    const parameters = fn?.parameters ?? tool.parameters;
    const strict = fn?.strict ?? tool.strict;

    return [
      {
        type: 'function',
        name,
        ...(typeof description === 'string' ? { description } : {}),
        ...(asObject(parameters) ? { parameters } : {}),
        ...(typeof strict === 'boolean' ? { strict } : {}),
      },
    ];
  });
}

/**
 * Builds a stateless Responses API request from the fields already used by
 * OpenAI-compatible Chat Completions providers.
 */
export function buildOpenAIResponsesPayload(
  model: string,
  messages: readonly OpenAICompatibleChatMessage[],
  options: OpenAIResponsesPayloadOptions = {}
): OpenAIResponsesPayload {
  const tools = toOpenAIResponsesTools(options.tools);

  return {
    model,
    input: toOpenAIResponsesInput(messages),
    store: false,
    ...(tools.length > 0 ? { tools } : {}),
    ...(options.tool_choice !== undefined
      ? { tool_choice: options.tool_choice }
      : {}),
    ...(typeof options.max_tokens === 'number'
      ? { max_output_tokens: options.max_tokens }
      : {}),
    ...(typeof options.temperature === 'number'
      ? { temperature: options.temperature }
      : {}),
    ...(typeof options.top_p === 'number' ? { top_p: options.top_p } : {}),
    ...(typeof options.stream === 'boolean' ? { stream: options.stream } : {}),
  };
}

function outputTextFromItem(item: JsonObject): string[] {
  if (item.type !== 'message' || !Array.isArray(item.content)) {
    return [];
  }

  return item.content.flatMap(rawBlock => {
    const block = asObject(rawBlock);
    if (
      block &&
      (block.type === 'output_text' || block.type === 'text') &&
      typeof block.text === 'string'
    ) {
      return [block.text];
    }

    if (
      block &&
      block.type === 'refusal' &&
      typeof block.refusal === 'string'
    ) {
      return [block.refusal];
    }

    return [];
  });
}

function reasoningSummaryFromItem(item: JsonObject): string[] {
  if (item.type !== 'reasoning') {
    return [];
  }

  const blocks = [
    ...(Array.isArray(item.summary) ? item.summary : []),
    ...(Array.isArray(item.content) ? item.content : []),
  ];

  return blocks.flatMap(rawBlock => {
    const block = asObject(rawBlock);
    return block && typeof block.text === 'string' ? [block.text] : [];
  });
}

function functionCallFromItem(
  item: JsonObject,
  index: number
): NormalizedOpenAIResponsesToolCall | undefined {
  if (item.type !== 'function_call') {
    return undefined;
  }

  const name = nonEmptyString(item.name);
  if (!name) {
    return undefined;
  }

  const callId =
    nonEmptyString(item.call_id) ||
    nonEmptyString(item.id) ||
    `response-call-${index}`;

  return {
    id: callId,
    call_id: callId,
    type: 'function',
    function: {
      name,
      arguments: stringifyJsonValue(item.arguments),
    },
  };
}

function normalizeResponsesFinishReason(
  response: JsonObject,
  hasToolCalls: boolean
): string {
  if (response.status === 'incomplete') {
    const details = asObject(response.incomplete_details);
    if (details?.reason === 'max_output_tokens') {
      return 'length';
    }
    if (details?.reason === 'content_filter') {
      return 'content_filter';
    }
  }

  return hasToolCalls ? 'tool_calls' : 'stop';
}

function responsesIncompleteReason(response: JsonObject): string | undefined {
  if (response.status !== 'incomplete') return undefined;
  const details = asObject(response.incomplete_details);
  return typeof details?.reason === 'string' ? details.reason : 'unknown';
}

function normalizeResponsesUsage(
  value: unknown
): PluginResponse['usage'] | undefined {
  const usage = asObject(value);
  if (!usage) {
    return undefined;
  }

  const inputTokens =
    typeof usage.input_tokens === 'number' ? usage.input_tokens : undefined;
  const outputTokens =
    typeof usage.output_tokens === 'number' ? usage.output_tokens : undefined;
  const totalTokens =
    typeof usage.total_tokens === 'number' ? usage.total_tokens : undefined;

  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    totalTokens === undefined
  ) {
    return undefined;
  }

  return {
    prompt_tokens: inputTokens ?? 0,
    completion_tokens: outputTokens ?? 0,
    total_tokens: totalTokens ?? (inputTokens ?? 0) + (outputTokens ?? 0),
  };
}

/**
 * Converts a completed Responses API object into Libre WebUI's existing
 * Chat Completions-shaped normalized response.
 */
export function normalizeOpenAIResponsesResponse(
  value: unknown,
  fallbackModel: string
): NormalizedOpenAIResponsesResponse {
  const response = asObject(value) || {};
  if (response.status === 'failed') {
    const error = asObject(response.error);
    const message =
      nonEmptyString(error?.message) ||
      nonEmptyString(response.message) ||
      'Responses request failed';
    throw new Error(`Responses API error: ${message.slice(0, 500)}`);
  }

  const output = Array.isArray(response.output) ? response.output : [];
  const text: string[] = [];
  const reasoning: string[] = [];
  const reasoningItems: JsonObject[] = [];
  const toolCalls: NormalizedOpenAIResponsesToolCall[] = [];

  for (const [index, rawItem] of output.entries()) {
    const item = asObject(rawItem);
    if (!item) {
      continue;
    }

    text.push(...outputTextFromItem(item));
    reasoning.push(...reasoningSummaryFromItem(item));
    if (item.type === 'reasoning') {
      reasoningItems.push({ ...item });
    }
    const functionCall = functionCallFromItem(item, index);
    if (functionCall) {
      toolCalls.push(functionCall);
    }
  }

  if (reasoningItems.length > 0 && toolCalls[0]) {
    toolCalls[0].providerMetadata = {
      openAIResponsesReasoningItems: reasoningItems,
    };
  }

  if (text.length === 0 && typeof response.output_text === 'string') {
    text.push(response.output_text);
  }

  const reasoningContent = reasoning.join('\n');
  const model =
    typeof response.model === 'string' ? response.model : fallbackModel;
  const usage = normalizeResponsesUsage(response.usage);
  const incompleteReason = responsesIncompleteReason(response);

  return {
    id:
      typeof response.id === 'string' && response.id ? response.id : 'response',
    object: 'chat.completion',
    created:
      typeof response.created_at === 'number'
        ? Math.floor(response.created_at)
        : 0,
    model,
    ...(incompleteReason
      ? {
          providerMetadata: {
            [OPENAI_RESPONSES_INCOMPLETE_REASON_METADATA_KEY]: incompleteReason,
          },
        }
      : {}),
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: text.join(''),
          ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: normalizeResponsesFinishReason(
          response,
          toolCalls.length > 0
        ),
      },
    ],
    ...(usage ? { usage } : {}),
  };
}
