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
  ChatMessage,
  GenerationOptions,
  Plugin,
  PluginResponse,
} from '../types/index.js';

export type PluginVariables = Record<string, string | number | boolean>;

export interface PluginChatParameters {
  temperature: number;
  maxTokens?: number;
  topP?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  shouldStream: boolean;
}

export interface PluginChatPayloadResult {
  payload: Record<string, unknown>;
  headers?: Record<string, string>;
}

type OpenAICompatibleSamplingParameters = Partial<{
  temperature: number;
  top_p: number;
  frequency_penalty: number;
  presence_penalty: number;
}>;

const KIMI_CODE_FIXED_SAMPLING_VARIABLES = new Set([
  'temperature',
  'top_p',
  'frequency_penalty',
  'presence_penalty',
]);

const ANTHROPIC_LEGACY_SAMPLING_MODELS = new Set([
  'claude-haiku-4-5',
  'claude-haiku-4-5-20251001',
  'claude-opus-4-1',
  'claude-opus-4-1-20250805',
  'claude-opus-4-5',
  'claude-opus-4-5-20251101',
  'claude-opus-4-6',
  'claude-sonnet-4-5',
  'claude-sonnet-4-5-20250929',
  'claude-sonnet-4-6',
]);

export function resolvePluginChatParameters(
  options: GenerationOptions = {},
  pluginVars: PluginVariables = {}
): PluginChatParameters {
  return {
    temperature:
      options.temperature ??
      (pluginVars.temperature as number | undefined) ??
      0.7,
    maxTokens:
      options.num_predict === -1
        ? undefined
        : (options.num_predict ??
          (pluginVars.max_tokens as number | undefined) ??
          undefined),
    topP:
      options.top_p ?? (pluginVars.top_p as number | undefined) ?? undefined,
    frequencyPenalty:
      (pluginVars.frequency_penalty as number | undefined) ?? undefined,
    presencePenalty:
      (pluginVars.presence_penalty as number | undefined) ?? undefined,
    shouldStream: (pluginVars.stream as boolean | undefined) ?? false,
  };
}

export function applyPluginDefinitionPolicy(plugin: Plugin): Plugin {
  if (plugin.id !== 'kimi-code' || !plugin.variables) {
    return plugin;
  }

  const variables = plugin.variables.filter(
    variable => !KIMI_CODE_FIXED_SAMPLING_VARIABLES.has(variable.name)
  );
  return variables.length === plugin.variables.length
    ? plugin
    : { ...plugin, variables };
}

export function getOpenAICompatibleSamplingParameters(
  plugin: Pick<Plugin, 'id'>,
  params: PluginChatParameters
): OpenAICompatibleSamplingParameters {
  // Kimi Code models choose fixed sampling values for their active mode and
  // reject generic application preferences. Moonshot recommends omitting
  // these fields instead of sending explicit fixed values.
  if (plugin.id === 'kimi-code') {
    return {};
  }

  return {
    temperature: params.temperature,
    top_p: params.topP,
    frequency_penalty: params.frequencyPenalty,
    presence_penalty: params.presencePenalty,
  };
}

function splitDataUrlImage(image: string): {
  mediaType: string;
  base64Data: string;
} {
  if (!image.startsWith('data:')) {
    return {
      mediaType: 'image/jpeg',
      base64Data: image,
    };
  }

  const match = image.match(/^data:([^;]+);base64,(.+)$/);
  return {
    mediaType: match?.[1] || 'image/jpeg',
    base64Data: match?.[2] || image,
  };
}

export function toOpenAICompatibleMessages(messages: ChatMessage[]): Array<{
  role: string;
  content:
    | string
    | Array<
        | { type: 'text'; text: string }
        | { type: 'image_url'; image_url: { url: string } }
      >;
}> {
  return messages.map(message => {
    if (message.images && message.images.length > 0) {
      const content: Array<
        | { type: 'text'; text: string }
        | { type: 'image_url'; image_url: { url: string } }
      > = [];

      for (const image of message.images) {
        const imageUrl = image.startsWith('data:')
          ? image
          : `data:image/jpeg;base64,${image}`;
        content.push({ type: 'image_url', image_url: { url: imageUrl } });
      }

      if (message.content) {
        content.push({ type: 'text', text: message.content });
      }

      return { role: message.role, content };
    }

    return { role: message.role, content: message.content };
  });
}

function toAnthropicMessages(messages: ChatMessage[]): Array<{
  role: string;
  content:
    | string
    | Array<
        | { type: 'text'; text: string }
        | {
            type: 'image';
            source: { type: 'base64'; media_type: string; data: string };
          }
      >;
}> {
  return messages.map(message => {
    if (message.images && message.images.length > 0) {
      const content: Array<
        | { type: 'text'; text: string }
        | {
            type: 'image';
            source: { type: 'base64'; media_type: string; data: string };
          }
      > = [];

      for (const image of message.images) {
        const { mediaType, base64Data } = splitDataUrlImage(image);
        content.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: mediaType,
            data: base64Data,
          },
        });
      }

      if (message.content) {
        content.push({
          type: 'text',
          text: message.content,
        });
      }

      return {
        role: message.role,
        content,
      };
    }

    return {
      role: message.role,
      content: message.content,
    };
  });
}

function buildAnthropicChatPayload(
  model: string,
  messages: ChatMessage[],
  options: GenerationOptions,
  params: PluginChatParameters
): PluginChatPayloadResult {
  const systemMessages = messages.filter(message => message.role === 'system');
  const nonSystemMessages = messages.filter(
    message => message.role !== 'system'
  );

  const payload: Record<string, unknown> = {
    model,
    messages: toAnthropicMessages(nonSystemMessages),
    max_tokens: params.maxTokens ?? 1024,
    stop_sequences: options.stop,
    stream: params.shouldStream,
  };

  // Anthropic rejects non-default sampling parameters on Claude Opus 4.7 and
  // newer model families. Unknown model IDs are treated as current so models
  // found through discovery remain safe as Anthropic expands the catalog.
  if (ANTHROPIC_LEGACY_SAMPLING_MODELS.has(model)) {
    if (params.topP !== undefined && params.topP < 1) {
      payload.top_p = params.topP;
    } else {
      payload.temperature = params.temperature;
    }
  }

  if (systemMessages.length > 0) {
    payload.system = systemMessages.map(message => message.content).join('\n');
  }

  return {
    payload,
    headers: {
      'anthropic-version': '2023-06-01',
    },
  };
}

function buildGeminiChatPayload(
  model: string,
  messages: ChatMessage[],
  options: GenerationOptions,
  params: PluginChatParameters
): PluginChatPayloadResult {
  const lastMessage = messages[messages.length - 1];
  const parts: Array<{
    text?: string;
    inline_data?: { mime_type: string; data: string };
  }> = [];

  if (lastMessage?.images && lastMessage.images.length > 0) {
    for (const image of lastMessage.images) {
      const { mediaType, base64Data } = splitDataUrlImage(image);
      parts.push({
        inline_data: {
          mime_type: mediaType,
          data: base64Data,
        },
      });
    }
  }

  if (lastMessage?.content) {
    parts.push({ text: lastMessage.content });
  }

  return {
    payload: {
      contents: [{ parts }],
      generationConfig: {
        temperature: params.temperature,
        maxOutputTokens: params.maxTokens ?? 1024,
        topP: params.topP,
        stopSequences: options.stop,
      },
    },
  };
}

function buildOpenAICompatibleChatPayload(
  plugin: Pick<Plugin, 'id'>,
  model: string,
  messages: ChatMessage[],
  options: GenerationOptions,
  params: PluginChatParameters
): PluginChatPayloadResult {
  return {
    payload: {
      model,
      messages: toOpenAICompatibleMessages(messages),
      ...getOpenAICompatibleSamplingParameters(plugin, params),
      max_tokens: params.maxTokens,
      stop: options.stop,
      stream: params.shouldStream,
    },
  };
}

export function buildPluginChatPayload(
  plugin: Plugin,
  model: string,
  messages: ChatMessage[],
  options: GenerationOptions = {},
  pluginVars: PluginVariables = {},
  streamOverride?: boolean
): PluginChatPayloadResult {
  const params = resolvePluginChatParameters(options, pluginVars);
  if (streamOverride !== undefined) {
    params.shouldStream = streamOverride;
  }

  if (plugin.id === 'anthropic') {
    return buildAnthropicChatPayload(model, messages, options, params);
  }

  if (plugin.id === 'gemini') {
    return buildGeminiChatPayload(model, messages, options, params);
  }

  return buildOpenAICompatibleChatPayload(
    plugin,
    model,
    messages,
    options,
    params
  );
}

export function convertAnthropicResponse(
  anthropicResponse: Record<string, unknown>,
  model: string
): PluginResponse {
  const id =
    typeof anthropicResponse.id === 'string'
      ? anthropicResponse.id
      : `chatcmpl-${Date.now()}`;

  const stopReasonMap: Record<string, string> = {
    end_turn: 'stop',
    max_tokens: 'length',
    stop_sequence: 'stop',
    tool_use: 'tool_calls',
  };

  const stopReason =
    typeof anthropicResponse.stop_reason === 'string'
      ? stopReasonMap[anthropicResponse.stop_reason] || 'stop'
      : 'stop';

  let content = '';
  if (Array.isArray(anthropicResponse.content)) {
    for (const block of anthropicResponse.content) {
      if (
        block &&
        typeof block === 'object' &&
        'type' in block &&
        block.type === 'text' &&
        'text' in block &&
        typeof block.text === 'string'
      ) {
        content += block.text;
      }
    }
  }

  let usage;
  if (
    anthropicResponse.usage &&
    typeof anthropicResponse.usage === 'object' &&
    anthropicResponse.usage !== null
  ) {
    const usageObj = anthropicResponse.usage as Record<string, unknown>;
    const inputTokens =
      typeof usageObj.input_tokens === 'number' ? usageObj.input_tokens : 0;
    const outputTokens =
      typeof usageObj.output_tokens === 'number' ? usageObj.output_tokens : 0;

    usage = {
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
    };
  }

  return {
    id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content,
        },
        finish_reason: stopReason,
      },
    ],
    usage,
  };
}

export function convertGeminiResponse(
  geminiResponse: Record<string, unknown>,
  model: string
): PluginResponse {
  const id = `chatcmpl-${Date.now()}`;

  let content = '';
  let finishReason = 'stop';

  if (Array.isArray(geminiResponse.candidates)) {
    const candidate = geminiResponse.candidates[0];
    if (candidate && typeof candidate === 'object') {
      const candidateObj = candidate as Record<string, unknown>;

      if (candidateObj.content && typeof candidateObj.content === 'object') {
        const contentObj = candidateObj.content as Record<string, unknown>;
        if (Array.isArray(contentObj.parts)) {
          for (const part of contentObj.parts) {
            if (
              part &&
              typeof part === 'object' &&
              'text' in part &&
              typeof part.text === 'string'
            ) {
              content += part.text;
            }
          }
        }
      }

      if (typeof candidateObj.finishReason === 'string') {
        const finishReasonMap: Record<string, string> = {
          STOP: 'stop',
          MAX_TOKENS: 'length',
          SAFETY: 'content_filter',
          RECITATION: 'content_filter',
          OTHER: 'stop',
        };
        finishReason = finishReasonMap[candidateObj.finishReason] || 'stop';
      }
    }
  }

  let usage;
  if (
    geminiResponse.usageMetadata &&
    typeof geminiResponse.usageMetadata === 'object'
  ) {
    const usageObj = geminiResponse.usageMetadata as Record<string, unknown>;
    const promptTokens =
      typeof usageObj.promptTokenCount === 'number'
        ? usageObj.promptTokenCount
        : 0;
    const completionTokens =
      typeof usageObj.candidatesTokenCount === 'number'
        ? usageObj.candidatesTokenCount
        : 0;

    usage = {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    };
  }

  return {
    id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content,
        },
        finish_reason: finishReason,
      },
    ],
    usage,
  };
}

export function convertProviderResponse(
  plugin: Plugin,
  response: Record<string, unknown>,
  model: string
): PluginResponse {
  if (plugin.id === 'anthropic') {
    return convertAnthropicResponse(response, model);
  }

  if (plugin.id === 'gemini') {
    return convertGeminiResponse(response, model);
  }

  return response as unknown as PluginResponse;
}
