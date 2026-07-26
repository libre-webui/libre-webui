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

import axios from 'axios';
import type {
  GenerationOptions,
  OllamaChatMessage,
  OllamaChatRequest,
  OllamaChatResponse,
  Plugin,
} from '../types/index.js';
import {
  resolvePluginChatParameters,
  type PluginVariables,
} from '../utils/pluginChatAdapter.js';
import {
  applyModelEndpointTemplate,
  assertSafePluginEndpoint,
  buildPluginAuthHeaders,
  resolvePluginEndpoint,
  validatePluginModel,
} from '../utils/pluginValidation.js';
import ollamaService from './ollamaService.js';
import pluginService from './pluginService.js';
import type { WorkProviderSelection } from '../types/work.js';

type JsonObject = Record<string, unknown>;

export interface WorkProviderAvailability {
  ollamaAvailable: boolean;
  pluginAvailable: boolean;
}

interface WorkModelProviderDependencies {
  ollama: Pick<
    typeof ollamaService,
    'isHealthy' | 'showModel' | 'generateChatResponse'
  >;
  plugins: Pick<
    typeof pluginService,
    'getActivePlugins' | 'getPlugin' | 'getApiKey' | 'getPluginVariables'
  >;
  post: typeof axios.post;
}

export class WorkModelProviderError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = 'WorkModelProviderError';
    this.status = status;
    this.code = code;
  }
}

export class WorkModelProviderService {
  constructor(
    private readonly dependencies: WorkModelProviderDependencies = {
      ollama: ollamaService,
      plugins: pluginService,
      post: axios.post.bind(axios),
    }
  ) {}

  async availability(userId: string): Promise<WorkProviderAvailability> {
    const [ollamaAvailable, pluginAvailable] = await Promise.all([
      this.dependencies.ollama.isHealthy(),
      Promise.resolve(this.hasConfiguredPlugin(userId)),
    ]);
    return { ollamaAvailable, pluginAvailable };
  }

  async assertModelSupportsTools(
    model: string,
    provider: WorkProviderSelection,
    userId: string
  ): Promise<void> {
    const cleaned = model.trim();
    if (!cleaned) {
      throw new WorkModelProviderError(
        'A Work model is required.',
        422,
        'WORK_MODEL_TOOLS_UNSUPPORTED'
      );
    }
    if (provider.providerType === 'plugin') {
      this.requireExactPlugin(provider.providerId, cleaned, userId);
      return;
    }
    assertOllamaProvider(provider);

    let details: JsonObject;
    try {
      details = await this.dependencies.ollama.showModel(cleaned, false);
    } catch (error) {
      throw new WorkModelProviderError(
        error instanceof Error ? error.message : 'Could not inspect model.',
        503,
        'WORK_MODEL_UNAVAILABLE'
      );
    }
    const capabilities = Array.isArray(details.capabilities)
      ? details.capabilities.map(value => String(value).toLowerCase())
      : [];
    if (!capabilities.includes('tools')) {
      throw new WorkModelProviderError(
        `Model "${cleaned}" does not advertise tool support.`,
        422,
        'WORK_MODEL_TOOLS_UNSUPPORTED'
      );
    }
  }

  async generateChatResponse(
    request: OllamaChatRequest,
    provider: WorkProviderSelection,
    userId: string,
    signal?: AbortSignal
  ): Promise<OllamaChatResponse> {
    if (provider.providerType === 'ollama') {
      assertOllamaProvider(provider);
      return this.dependencies.ollama.generateChatResponse(request, signal);
    }
    const plugin = this.requireExactPlugin(
      provider.providerId,
      request.model,
      userId
    );
    return this.generatePluginResponse(plugin, request, userId, signal);
  }

  private hasConfiguredPlugin(userId: string): boolean {
    return this.dependencies.plugins
      .getActivePlugins()
      .filter(isWorkPlugin)
      .some(
        plugin =>
          plugin.model_map.length > 0 &&
          Boolean(this.dependencies.plugins.getApiKey(plugin, userId))
      );
  }

  private requireExactPlugin(
    providerId: string | undefined,
    model: string,
    userId: string
  ): Plugin {
    const cleanedProviderId = providerId?.trim();
    if (!cleanedProviderId) {
      throw new WorkModelProviderError(
        'A plugin provider ID is required.',
        400,
        'WORK_PLUGIN_ID_REQUIRED'
      );
    }
    const plugin = this.dependencies.plugins.getPlugin(cleanedProviderId);
    if (!plugin || !plugin.active) {
      throw new WorkModelProviderError(
        `Plugin "${cleanedProviderId}" is not active.`,
        422,
        'WORK_PLUGIN_UNAVAILABLE'
      );
    }
    assertWorkPluginType(plugin);
    if (!plugin.model_map.includes(model)) {
      throw new WorkModelProviderError(
        `Model "${model}" is not configured for plugin "${plugin.id}".`,
        422,
        'WORK_PLUGIN_MODEL_UNAVAILABLE'
      );
    }
    if (!this.dependencies.plugins.getApiKey(plugin, userId)) {
      throw new WorkModelProviderError(
        `API key not found for plugin ${plugin.id}.`,
        422,
        'WORK_PLUGIN_CREDENTIALS_MISSING'
      );
    }
    return plugin;
  }

  private async generatePluginResponse(
    plugin: Plugin,
    request: OllamaChatRequest,
    userId: string,
    signal?: AbortSignal
  ): Promise<OllamaChatResponse> {
    validatePluginModel(request.model);
    const apiKey = this.dependencies.plugins.getApiKey(plugin, userId);
    if (!apiKey) {
      throw new WorkModelProviderError(
        `API key not found for plugin ${plugin.id}.`,
        422,
        'WORK_PLUGIN_CREDENTIALS_MISSING'
      );
    }
    const variables = this.dependencies.plugins.getPluginVariables(
      plugin,
      userId
    );
    const endpoint = applyModelEndpointTemplate(
      resolvePluginEndpoint(
        plugin.endpoint,
        variables.endpoint as string | undefined
      ),
      request.model
    );
    assertSafePluginEndpoint(endpoint, 'Work model endpoint');
    const headers = buildPluginAuthHeaders(plugin, apiKey);
    const { payload, extraHeaders } = buildPluginWorkPayload(
      plugin,
      request,
      variables
    );
    Object.assign(headers, extraHeaders);

    try {
      const response = await this.dependencies.post<JsonObject>(
        endpoint,
        payload,
        {
          headers,
          signal,
          timeout: 300_000,
        }
      );
      return normalizePluginWorkResponse(plugin, response.data, request.model);
    } catch (error) {
      if (signal?.aborted) throw error;
      const message =
        axios.isAxiosError(error) && error.response
          ? `Plugin API error: ${error.response.status} - ${providerErrorMessage(error.response.data)}`
          : error instanceof Error
            ? error.message
            : 'Plugin request failed.';
      throw new WorkModelProviderError(
        message,
        502,
        'WORK_PLUGIN_REQUEST_FAILED'
      );
    }
  }
}

export function buildPluginWorkPayload(
  plugin: Plugin,
  request: OllamaChatRequest,
  variables: PluginVariables = {}
): { payload: JsonObject; extraHeaders: Record<string, string> } {
  const options = (request.options || {}) as GenerationOptions;
  const params = resolvePluginChatParameters(options, variables);
  if (plugin.id === 'anthropic') {
    return {
      payload: buildAnthropicWorkPayload(
        request.model,
        request.messages,
        request.tools || [],
        params.maxTokens
      ),
      extraHeaders: { 'anthropic-version': '2023-06-01' },
    };
  }
  if (plugin.id === 'gemini') {
    return {
      payload: buildGeminiWorkPayload(
        request.messages,
        request.tools || [],
        params
      ),
      extraHeaders: {},
    };
  }
  return {
    payload: {
      model: request.model,
      messages: toOpenAIWorkMessages(request.messages),
      tools: request.tools,
      tool_choice: request.tools?.length ? 'auto' : undefined,
      temperature: params.temperature,
      max_tokens: params.maxTokens,
      top_p: params.topP,
      frequency_penalty: params.frequencyPenalty,
      presence_penalty: params.presencePenalty,
      stream: false,
    },
    extraHeaders: {},
  };
}

export function normalizePluginWorkResponse(
  plugin: Plugin,
  response: JsonObject,
  model: string
): OllamaChatResponse {
  if (plugin.id === 'anthropic') {
    return normalizeAnthropicWorkResponse(response, model);
  }
  if (plugin.id === 'gemini') {
    return normalizeGeminiWorkResponse(response, model);
  }
  return normalizeOpenAIWorkResponse(response, model);
}

export function toOpenAIWorkMessages(
  messages: OllamaChatMessage[]
): JsonObject[] {
  let pendingCalls: Array<{ id: string; name: string }> = [];
  return messages.map((message, messageIndex) => {
    if (message.role === 'assistant') {
      const toolCalls = normalizeOutboundToolCalls(message.tool_calls);
      pendingCalls = toolCalls.map(call => ({
        id: String(call.id),
        name: String((call.function as JsonObject).name),
      }));
      return {
        role: 'assistant',
        content: message.content || null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      };
    }
    if (message.role === 'tool') {
      const matchingIndex = pendingCalls.findIndex(
        call => !message.tool_name || call.name === message.tool_name
      );
      const matching =
        matchingIndex >= 0
          ? pendingCalls.splice(matchingIndex, 1)[0]
          : undefined;
      return {
        role: 'tool',
        content: message.content,
        name: message.tool_name,
        tool_call_id: matching?.id || `work-tool-${messageIndex}`,
      };
    }
    return { role: message.role, content: message.content };
  });
}

function buildAnthropicWorkPayload(
  model: string,
  messages: OllamaChatMessage[],
  tools: JsonObject[],
  maxTokens?: number
): JsonObject {
  const system = messages
    .filter(message => message.role === 'system')
    .map(message => message.content)
    .join('\n');
  const providerMessages: Array<{
    role: 'user' | 'assistant';
    content: JsonObject[];
  }> = [];
  let pendingCalls: Array<{ id: string; name: string }> = [];
  let appendToolResult = false;

  for (const [messageIndex, message] of messages.entries()) {
    if (message.role === 'system') continue;
    if (message.role === 'assistant') {
      const blocks: JsonObject[] = [];
      const toolCalls = normalizeOutboundToolCalls(message.tool_calls);
      const anthropicThinkingBlocks = toolCalls.flatMap(call => {
        const metadata = asObject(call.providerMetadata);
        return Array.isArray(metadata?.anthropicThinkingBlocks)
          ? metadata.anthropicThinkingBlocks.flatMap(block =>
              asObject(block) ? [block as JsonObject] : []
            )
          : [];
      });
      blocks.push(...anthropicThinkingBlocks);
      if (message.content) blocks.push({ type: 'text', text: message.content });
      pendingCalls = toolCalls.map(call => ({
        id: String(call.id),
        name: String((call.function as JsonObject).name),
      }));
      for (const call of toolCalls) {
        const fn = call.function as JsonObject;
        blocks.push({
          type: 'tool_use',
          id: call.id,
          name: fn.name,
          input: parseToolArguments(fn.arguments),
        });
      }
      providerMessages.push({ role: 'assistant', content: blocks });
      appendToolResult = false;
      continue;
    }
    if (message.role === 'tool') {
      const matchIndex = pendingCalls.findIndex(
        call => !message.tool_name || call.name === message.tool_name
      );
      const matching =
        matchIndex >= 0 ? pendingCalls.splice(matchIndex, 1)[0] : undefined;
      const block = {
        type: 'tool_result',
        tool_use_id: matching?.id || `work-tool-${messageIndex}`,
        content: message.content,
      };
      const previous = providerMessages[providerMessages.length - 1];
      if (appendToolResult && previous?.role === 'user') {
        previous.content.push(block);
      } else {
        providerMessages.push({ role: 'user', content: [block] });
      }
      appendToolResult = true;
      continue;
    }
    providerMessages.push({
      role: 'user',
      content: [{ type: 'text', text: message.content }],
    });
    appendToolResult = false;
  }

  return {
    model,
    system: system || undefined,
    messages: providerMessages,
    tools: toAnthropicTools(tools),
    max_tokens: maxTokens ?? 4096,
    stream: false,
  };
}

function buildGeminiWorkPayload(
  messages: OllamaChatMessage[],
  tools: JsonObject[],
  params: ReturnType<typeof resolvePluginChatParameters>
): JsonObject {
  const system = messages
    .filter(message => message.role === 'system')
    .map(message => message.content)
    .join('\n');
  const contents: Array<{ role: 'user' | 'model'; parts: JsonObject[] }> = [];
  let pendingCalls: Array<{ id: string; name: string }> = [];

  const append = (role: 'user' | 'model', part: JsonObject) => {
    const previous = contents[contents.length - 1];
    if (previous?.role === role) previous.parts.push(part);
    else contents.push({ role, parts: [part] });
  };

  for (const [messageIndex, message] of messages.entries()) {
    if (message.role === 'system') continue;
    if (message.role === 'assistant') {
      if (message.content) append('model', { text: message.content });
      const calls = normalizeOutboundToolCalls(message.tool_calls);
      pendingCalls = calls.map(call => ({
        id: String(call.id),
        name: String((call.function as JsonObject).name),
      }));
      for (const call of calls) {
        const fn = call.function as JsonObject;
        append('model', {
          functionCall: {
            id: call.id,
            name: fn.name,
            args: parseToolArguments(fn.arguments),
          },
          ...(typeof call.thoughtSignature === 'string'
            ? { thoughtSignature: call.thoughtSignature }
            : {}),
        });
      }
      continue;
    }
    if (message.role === 'tool') {
      const matchIndex = pendingCalls.findIndex(
        call => !message.tool_name || call.name === message.tool_name
      );
      const matching =
        matchIndex >= 0 ? pendingCalls.splice(matchIndex, 1)[0] : undefined;
      append('user', {
        functionResponse: {
          id: matching?.id || `work-tool-${messageIndex}`,
          name: message.tool_name || matching?.name || 'work_tool',
          response: { result: message.content },
        },
      });
      continue;
    }
    append('user', { text: message.content });
  }

  return {
    systemInstruction: system ? { parts: [{ text: system }] } : undefined,
    contents,
    tools: [
      {
        functionDeclarations: tools.flatMap(tool => {
          const fn = asObject(tool.function);
          return fn
            ? [
                {
                  name: fn.name,
                  description: fn.description,
                  parameters: fn.parameters,
                },
              ]
            : [];
        }),
      },
    ],
    generationConfig: {
      temperature: params.temperature,
      maxOutputTokens: params.maxTokens ?? 4096,
      topP: params.topP,
    },
  };
}

function normalizeOpenAIWorkResponse(
  response: JsonObject,
  model: string
): OllamaChatResponse {
  const choices = Array.isArray(response.choices) ? response.choices : [];
  const choice = asObject(choices[0]);
  const message = asObject(choice?.message);
  if (!message) {
    throw new WorkModelProviderError(
      'Plugin returned an invalid chat response.',
      502,
      'WORK_PLUGIN_INVALID_RESPONSE'
    );
  }
  return workResponse(
    model,
    contentText(message.content),
    normalizeInboundToolCalls(message.tool_calls)
  );
}

function normalizeAnthropicWorkResponse(
  response: JsonObject,
  model: string
): OllamaChatResponse {
  const blocks = Array.isArray(response.content) ? response.content : [];
  const text: string[] = [];
  const calls: JsonObject[] = [];
  const thinkingBlocks: JsonObject[] = [];
  for (const [index, value] of blocks.entries()) {
    const block = asObject(value);
    if (block?.type === 'thinking' || block?.type === 'redacted_thinking') {
      thinkingBlocks.push(block);
    }
    if (block?.type === 'text' && typeof block.text === 'string') {
      text.push(block.text);
    }
    if (block?.type === 'tool_use' && typeof block.name === 'string') {
      calls.push({
        id: typeof block.id === 'string' ? block.id : `work-anthropic-${index}`,
        function: {
          name: block.name,
          arguments: asObject(block.input) || {},
        },
      });
    }
  }
  if (thinkingBlocks.length > 0 && calls[0]) {
    calls[0].providerMetadata = {
      anthropicThinkingBlocks: thinkingBlocks,
    };
  }
  return workResponse(model, text.join(''), calls);
}

function normalizeGeminiWorkResponse(
  response: JsonObject,
  model: string
): OllamaChatResponse {
  const candidates = Array.isArray(response.candidates)
    ? response.candidates
    : [];
  const candidate = asObject(candidates[0]);
  const content = asObject(candidate?.content);
  const parts = Array.isArray(content?.parts) ? content.parts : [];
  const text: string[] = [];
  const calls: JsonObject[] = [];
  for (const [index, value] of parts.entries()) {
    const part = asObject(value);
    if (typeof part?.text === 'string') text.push(part.text);
    const call = asObject(part?.functionCall);
    if (call && typeof call.name === 'string') {
      calls.push({
        id: typeof call.id === 'string' ? call.id : `work-gemini-${index}`,
        ...(typeof part?.thoughtSignature === 'string'
          ? { thoughtSignature: part.thoughtSignature }
          : {}),
        function: {
          name: call.name,
          arguments: asObject(call.args) || {},
        },
      });
    }
  }
  return workResponse(model, text.join(''), calls);
}

function workResponse(
  model: string,
  content: string,
  toolCalls: JsonObject[]
): OllamaChatResponse {
  return {
    model,
    created_at: new Date().toISOString(),
    message: {
      role: 'assistant',
      content,
      tool_calls: toolCalls,
    },
    done: true,
  };
}

function normalizeOutboundToolCalls(value: unknown): JsonObject[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw, index) => {
    const call = asObject(raw);
    const fn = asObject(call?.function);
    if (!fn || typeof fn.name !== 'string') return [];
    const providerMetadata = asObject(call?.providerMetadata);
    return [
      {
        id: typeof call?.id === 'string' ? call.id : `work-tool-call-${index}`,
        ...(typeof call?.thoughtSignature === 'string'
          ? { thoughtSignature: call.thoughtSignature }
          : {}),
        ...(providerMetadata ? { providerMetadata } : {}),
        type: 'function',
        function: {
          name: fn.name,
          arguments:
            typeof fn.arguments === 'string'
              ? fn.arguments
              : JSON.stringify(asObject(fn.arguments) || {}),
        },
      },
    ];
  });
}

function normalizeInboundToolCalls(value: unknown): JsonObject[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw, index) => {
    const call = asObject(raw);
    const fn = asObject(call?.function);
    if (!fn || typeof fn.name !== 'string') return [];
    const providerMetadata = asObject(call?.providerMetadata);
    return [
      {
        id: typeof call?.id === 'string' ? call.id : `work-plugin-${index}`,
        ...(typeof call?.thoughtSignature === 'string'
          ? { thoughtSignature: call.thoughtSignature }
          : {}),
        ...(providerMetadata ? { providerMetadata } : {}),
        function: {
          name: fn.name,
          arguments:
            typeof fn.arguments === 'string'
              ? fn.arguments
              : asObject(fn.arguments) || {},
        },
      },
    ];
  });
}

function toAnthropicTools(tools: JsonObject[]): JsonObject[] {
  return tools.flatMap(tool => {
    const fn = asObject(tool.function);
    if (!fn || typeof fn.name !== 'string') return [];
    return [
      {
        name: fn.name,
        description: fn.description,
        input_schema: fn.parameters || {
          type: 'object',
          properties: {},
        },
      },
    ];
  });
}

function parseToolArguments(value: unknown): JsonObject {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as JsonObject;
  }
  if (typeof value === 'string') {
    try {
      return asObject(JSON.parse(value)) || {};
    } catch {
      return {};
    }
  }
  return {};
}

function contentText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value
    .flatMap(item => {
      const block = asObject(item);
      return typeof block?.text === 'string' ? [block.text] : [];
    })
    .join('');
}

function providerErrorMessage(value: unknown): string {
  const payload = asObject(value);
  const error = asObject(payload?.error);
  if (typeof error?.message === 'string') return error.message;
  if (typeof payload?.message === 'string') return payload.message;
  return 'Request failed.';
}

function asObject(value: unknown): JsonObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function isWorkPlugin(plugin: Plugin): boolean {
  return plugin.type === 'completion' || plugin.type === 'chat';
}

function assertWorkPluginType(plugin: Plugin): void {
  if (!isWorkPlugin(plugin)) {
    throw new WorkModelProviderError(
      `Plugin "${plugin.name}" does not provide chat completions.`,
      422,
      'WORK_PLUGIN_TOOLS_UNSUPPORTED'
    );
  }
}

function assertOllamaProvider(provider: WorkProviderSelection): void {
  if (provider.providerType !== 'ollama' || provider.providerId) {
    throw new WorkModelProviderError(
      'Invalid Ollama provider selection.',
      400,
      'WORK_PROVIDER_INVALID'
    );
  }
}

export const workModelProviderService = new WorkModelProviderService();
export default workModelProviderService;
