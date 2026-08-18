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

import { createHash } from 'node:crypto';
import type { PluginResponse } from '../types/index.js';

type JsonObject = Record<string, unknown>;

export const OPENAI_RESPONSES_OUTPUT_ITEMS_METADATA_KEY =
  'openAIResponsesOutputItems';
export const OPENAI_RESPONSES_INCOMPLETE_REASON_METADATA_KEY =
  'openAIResponsesIncompleteReason';
export const OPENAI_RESPONSES_STATE_SCOPE_METADATA_KEY =
  'openAIResponsesStateScope';
export const OPENAI_RESPONSES_STATE_DROPPED_METADATA_KEY =
  'openAIResponsesStateDropped';
export const OPENAI_RESPONSES_REPLAY_MAX_ITEMS = 64;
export const OPENAI_RESPONSES_REPLAY_MAX_BYTES = 90_000;

export interface OpenAICompatibleChatMessage {
  role: string;
  content?: unknown;
  name?: string;
  tool_call_id?: string;
  call_id?: string;
  tool_calls?: unknown;
  providerMetadata?: Record<string, unknown>;
}

export interface OpenAIResponsesPayloadOptions {
  tools?: readonly JsonObject[];
  tool_choice?: unknown;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stream?: boolean;
  stateScope?: string;
  /** How hard the model should reason, when the caller has an opinion. */
  reasoningEffort?: 'low' | 'medium' | 'high';
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

function outputContentBlocksAreValid(
  value: unknown,
  allowedTypes: ReadonlySet<string>
): boolean {
  return (
    Array.isArray(value) &&
    value.every(rawBlock => {
      const block = asObject(rawBlock);
      const type = nonEmptyString(block?.type);
      if (!block || !type || !allowedTypes.has(type)) return false;
      if (type === 'refusal') return typeof block.refusal === 'string';
      return typeof block.text === 'string';
    })
  );
}

export function openAIResponsesOutputItemsValidationError(
  value: unknown
): string | undefined {
  if (!Array.isArray(value)) {
    return 'output must be an array';
  }

  const itemIds = new Set<string>();
  for (const [index, rawItem] of value.entries()) {
    const item = asObject(rawItem);
    if (!item) return `output item ${index} must be an object`;

    const itemId = nonEmptyString(item.id);
    if (!itemId) {
      return `output item ${index} is missing a non-empty id`;
    }
    if (itemIds.has(itemId)) {
      return `duplicate output item id "${itemId}"`;
    }
    itemIds.add(itemId);

    const type = nonEmptyString(item.type);
    if (!type) {
      return `output item ${index} is missing a non-empty type`;
    }
    if (type === 'function_call') {
      if (
        !nonEmptyString(item.call_id) ||
        !nonEmptyString(item.name) ||
        typeof item.arguments !== 'string'
      ) {
        return `function call ${index} is missing an exact call_id or name, or string arguments`;
      }
      continue;
    }
    if (type === 'message') {
      if (
        item.role !== 'assistant' ||
        !outputContentBlocksAreValid(
          item.content,
          new Set(['output_text', 'text', 'refusal'])
        )
      ) {
        return `message output item ${index} has invalid role or content`;
      }
      continue;
    }
    if (type === 'reasoning') {
      if (
        (item.summary !== undefined &&
          !outputContentBlocksAreValid(
            item.summary,
            new Set(['summary_text'])
          )) ||
        (item.content !== undefined &&
          !outputContentBlocksAreValid(
            item.content,
            new Set(['reasoning_text', 'text'])
          ))
      ) {
        return `reasoning output item ${index} has invalid summary or content`;
      }
    }
  }
  return undefined;
}

export function boundedOpenAIResponsesOutputItems(value: unknown): {
  items?: JsonObject[];
  dropped: boolean;
} {
  if (!Array.isArray(value) || value.length === 0) {
    return { dropped: false };
  }
  if (value.length > OPENAI_RESPONSES_REPLAY_MAX_ITEMS) {
    return { dropped: true };
  }
  if (openAIResponsesOutputItemsValidationError(value)) {
    return { dropped: true };
  }

  const items: JsonObject[] = [];
  for (const rawItem of value) {
    const item = asObject(rawItem);
    if (!item) {
      return { dropped: true };
    }
    items.push({ ...item });
  }

  try {
    if (
      Buffer.byteLength(JSON.stringify(items), 'utf8') >
      OPENAI_RESPONSES_REPLAY_MAX_BYTES
    ) {
      return { dropped: true };
    }
  } catch {
    return { dropped: true };
  }
  return { items, dropped: false };
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

    const callId = nonEmptyString(call.call_id) || nonEmptyString(call.id);
    if (!callId) {
      throw new Error(
        `Responses history function call ${messageIndex}:${callIndex} is missing an exact call_id`
      );
    }
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
  messages: readonly OpenAICompatibleChatMessage[],
  expectedStateScope?: string
): JsonObject[] {
  return messages.flatMap((message, messageIndex) => {
    if (message.role === 'assistant') {
      const storedStateScope =
        message.providerMetadata?.[OPENAI_RESPONSES_STATE_SCOPE_METADATA_KEY];
      const responseOutputItems = boundedOpenAIResponsesOutputItems(
        message.providerMetadata?.[OPENAI_RESPONSES_OUTPUT_ITEMS_METADATA_KEY]
      ).items;
      const replayableOutputItems =
        responseOutputItems &&
        (expectedStateScope === undefined ||
          storedStateScope === expectedStateScope)
          ? responseOutputItems
          : [];
      if (replayableOutputItems.length > 0) {
        return replayableOutputItems;
      }
    }

    if (message.role === 'tool') {
      const callId =
        nonEmptyString(message.call_id) || nonEmptyString(message.tool_call_id);
      if (!callId) {
        throw new Error(
          `Responses history tool result ${messageIndex} is missing an exact call_id`
        );
      }
      return [
        {
          type: 'function_call_output',
          call_id: callId,
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
    input: toOpenAIResponsesInput(messages, options.stateScope),
    store: false,
    include: ['reasoning.encrypted_content'],
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
    ...(options.reasoningEffort
      ? { reasoning: { effort: options.reasoningEffort } }
      : {}),
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
  item: JsonObject
): NormalizedOpenAIResponsesToolCall | undefined {
  if (item.type !== 'function_call') {
    return undefined;
  }

  const name = nonEmptyString(item.name);
  if (!name || typeof item.arguments !== 'string') {
    return undefined;
  }

  const callId = nonEmptyString(item.call_id);
  if (!callId) {
    return undefined;
  }

  return {
    id: callId,
    call_id: callId,
    type: 'function',
    function: {
      name,
      arguments: item.arguments,
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
  fallbackModel: string,
  stateScope?: string
): NormalizedOpenAIResponsesResponse {
  const response = asObject(value);
  if (!response) {
    throw new Error('Responses API error: response must be an object');
  }
  if (response.status === 'failed') {
    const error = asObject(response.error);
    const message =
      nonEmptyString(error?.message) ||
      nonEmptyString(response.message) ||
      'Responses request failed';
    throw new Error(`Responses API error: ${message.slice(0, 500)}`);
  }
  if (
    typeof response.status === 'string' &&
    response.status !== 'completed' &&
    response.status !== 'incomplete'
  ) {
    throw new Error(
      `Responses API error: unexpected response status "${response.status.slice(0, 100)}"`
    );
  }

  const outputValidationError = openAIResponsesOutputItemsValidationError(
    response.output
  );
  if (outputValidationError) {
    throw new Error(`Responses API error: ${outputValidationError}`);
  }
  const output = response.output as unknown[];
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
    const functionCall = functionCallFromItem(item);
    if (item.type === 'function_call' && !functionCall) {
      throw new Error(
        `Responses API error: function call ${index} is missing an exact call_id or name, or string arguments`
      );
    }
    if (functionCall) {
      if (toolCalls.some(call => call.id === functionCall.id)) {
        throw new Error(
          `Responses API error: duplicate function call_id "${functionCall.id}"`
        );
      }
      toolCalls.push(functionCall);
    }
  }

  if (toolCalls.length > 16) {
    throw new Error(
      'Responses API error: more than 16 function calls returned'
    );
  }

  const boundedOutput = boundedOpenAIResponsesOutputItems(output);
  if (!boundedOutput.dropped && reasoningItems.length > 0 && toolCalls[0]) {
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
  const providerMetadata = {
    ...(boundedOutput.items
      ? {
          [OPENAI_RESPONSES_OUTPUT_ITEMS_METADATA_KEY]: boundedOutput.items,
        }
      : {}),
    ...(boundedOutput.dropped
      ? { [OPENAI_RESPONSES_STATE_DROPPED_METADATA_KEY]: true }
      : {}),
    ...(incompleteReason
      ? {
          [OPENAI_RESPONSES_INCOMPLETE_REASON_METADATA_KEY]: incompleteReason,
        }
      : {}),
    ...(stateScope
      ? { [OPENAI_RESPONSES_STATE_SCOPE_METADATA_KEY]: stateScope }
      : {}),
  };

  return {
    id:
      typeof response.id === 'string' && response.id ? response.id : 'response',
    object: 'chat.completion',
    created:
      typeof response.created_at === 'number'
        ? Math.floor(response.created_at)
        : 0,
    model,
    ...(Object.keys(providerMetadata).length > 0 ? { providerMetadata } : {}),
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

export function createOpenAIResponsesStateScope(
  providerId: string,
  model: string,
  endpoint: string,
  credentialFingerprint: string
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        version: 2,
        apiMode: 'responses',
        providerId,
        model,
        endpoint,
        credentialFingerprint,
      })
    )
    .digest('hex');
}

/**
 * Produce a one-way, domain-separated identity for the credential selected by
 * a provider request. Only this digest is included in replay/routing scopes;
 * the credential itself is never persisted or returned to clients.
 */
export function createPluginCredentialFingerprint(
  apiKey: string | null
): string {
  return createHash('sha256')
    .update('libre-webui:plugin-credential:v1\0')
    .update(apiKey || '')
    .digest('hex');
}
