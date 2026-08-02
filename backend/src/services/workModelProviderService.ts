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
import { createHash } from 'crypto';
import type {
  GenerationOptions,
  OllamaChatMessage,
  OllamaChatRequest,
  OllamaChatResponse,
  Plugin,
  PluginApiMode,
} from '../types/index.js';
import {
  getOpenAICompatibleSamplingParameters,
  resolvePluginChatParameters,
  type PluginVariables,
} from '../utils/pluginChatAdapter.js';
import {
  OPENAI_RESPONSES_OUTPUT_ITEMS_METADATA_KEY,
  OPENAI_RESPONSES_STATE_SCOPE_METADATA_KEY,
  createOpenAIResponsesStateScope,
  createPluginCredentialFingerprint,
  normalizeOpenAIResponsesResponse,
  toOpenAIResponsesInput,
  toOpenAIResponsesTools,
} from '../utils/openAIResponsesAdapter.js';
import {
  streamAnthropicResponse,
  streamOpenAICompatibleResponse,
  streamOpenAIResponsesResponse,
  type PluginStreamChunk,
  type PluginStreamUsage,
} from '../utils/pluginStreamAdapter.js';
import {
  applyModelEndpointTemplate,
  assertSafePluginEndpoint,
  buildPluginAuthHeaders,
  inferPluginApiMode,
  pluginRequiresApiKey,
  resolvePluginApiConfig,
  validatePluginModel,
} from '../utils/pluginValidation.js';
import { AGENT_CLI_DEFINITIONS } from './agentCliService.js';
import codexOAuthService, {
  CODEX_OAUTH_PLUGIN_ID,
} from './codexOAuthService.js';
import ollamaService from './ollamaService.js';
import pluginService from './pluginService.js';
import pluginUsageService, {
  normalizeProviderTokenUsage,
  type PluginUsageEventInput,
  type PluginUsageStatus,
  type ProviderTokenUsage,
} from './pluginUsageService.js';
import type { WorkProviderSelection } from '../types/work.js';

type JsonObject = Record<string, unknown>;

export const WORK_TOOL_ARGUMENTS_ERROR_METADATA_KEY = 'libreToolArgumentsError';
export const WORK_TOOL_ARGUMENTS_ERROR_MESSAGE =
  'The provider returned incomplete or invalid JSON for this tool call, likely because its output-token limit was reached. Retry with a smaller payload; split large write_file content into focused files.';

export interface WorkProviderAvailability {
  ollamaAvailable: boolean;
  pluginAvailable: boolean;
}

interface WorkModelProviderDependencies {
  ollama: Pick<
    typeof ollamaService,
    'isHealthy' | 'showModel' | 'generateChatResponse'
  > &
    Partial<Pick<typeof ollamaService, 'generateChatStreamResponse'>>;
  plugins: Pick<
    typeof pluginService,
    'getActivePlugins' | 'getPlugin' | 'getApiKey' | 'getPluginVariables'
  >;
  post: typeof axios.post;
  recordPluginUsage?: (usage: PluginUsageEventInput) => void;
}

export interface WorkModelStreamObserver {
  onContent?: (content: string) => void;
  onReasoning?: (content: string) => void;
  onUsage?: (usage: PluginStreamUsage) => void;
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
      recordPluginUsage: usage => pluginUsageService.record(usage),
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
    if (
      AGENT_CLI_DEFINITIONS.some(
        definition =>
          cleaned === definition.id || cleaned.startsWith(`${definition.id}:`)
      )
    ) {
      throw new WorkModelProviderError(
        'Agent CLI models are chat-only: they run on the host, outside the Work sandbox. Pick an Ollama or provider model for Work.',
        422,
        'WORK_MODEL_TOOLS_UNSUPPORTED'
      );
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

  getResponsesStateScope(
    model: string,
    provider: WorkProviderSelection,
    userId: string
  ): string | undefined {
    if (provider.providerType !== 'plugin') return undefined;
    const providerId = provider.providerId?.trim();
    if (!providerId) return undefined;
    const plugin = this.dependencies.plugins.getPlugin(providerId, userId);
    if (!plugin || !plugin.active || !plugin.model_map.includes(model)) {
      return undefined;
    }
    const variables = this.dependencies.plugins.getPluginVariables(
      plugin,
      userId
    );
    const apiConfig = resolvePluginApiConfig(plugin, variables);
    if (apiConfig.apiMode !== 'responses') return undefined;
    const endpoint = applyModelEndpointTemplate(apiConfig.endpoint, model);
    const apiKey = this.dependencies.plugins.getApiKey(plugin, userId);
    if (pluginRequiresApiKey(plugin) && !apiKey) return undefined;
    return createOpenAIResponsesStateScope(
      plugin.id,
      model,
      endpoint,
      createPluginCredentialFingerprint(apiKey)
    );
  }

  getRoutingFingerprint(
    model: string,
    provider: WorkProviderSelection,
    userId: string
  ): string {
    if (provider.providerType === 'ollama') {
      assertOllamaProvider(provider);
      return createHash('sha256')
        .update(
          JSON.stringify({
            version: 1,
            providerType: 'ollama',
            model,
          })
        )
        .digest('hex');
    }

    const plugin = this.requireExactPlugin(provider.providerId, model, userId);
    const variables = this.dependencies.plugins.getPluginVariables(
      plugin,
      userId
    );
    const apiConfig = resolvePluginApiConfig(plugin, variables);
    const endpoint = applyModelEndpointTemplate(apiConfig.endpoint, model);
    assertSafePluginEndpoint(endpoint, 'Work model endpoint');
    const apiKey = this.dependencies.plugins.getApiKey(plugin, userId);
    return createHash('sha256')
      .update(
        JSON.stringify({
          version: 2,
          providerType: 'plugin',
          providerId: plugin.id,
          model,
          apiMode: apiConfig.apiMode,
          endpoint,
          credentialFingerprint: createPluginCredentialFingerprint(apiKey),
        })
      )
      .digest('hex');
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

  async generateChatStreamResponse(
    request: OllamaChatRequest,
    provider: WorkProviderSelection,
    userId: string,
    observer: WorkModelStreamObserver,
    signal?: AbortSignal
  ): Promise<OllamaChatResponse> {
    const streamRequest = { ...request, stream: true };
    if (provider.providerType === 'ollama') {
      assertOllamaProvider(provider);
      return this.generateOllamaStream(streamRequest, observer, signal);
    }
    const plugin = this.requireExactPlugin(
      provider.providerId,
      request.model,
      userId
    );
    return this.generatePluginStream(
      plugin,
      streamRequest,
      userId,
      observer,
      signal
    );
  }

  private hasConfiguredPlugin(userId: string): boolean {
    return this.dependencies.plugins
      .getActivePlugins(userId)
      .filter(isWorkPlugin)
      .some(
        plugin =>
          plugin.model_map.length > 0 &&
          (!pluginRequiresApiKey(plugin) ||
            Boolean(this.dependencies.plugins.getApiKey(plugin, userId)))
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
    const plugin = this.dependencies.plugins.getPlugin(
      cleanedProviderId,
      userId
    );
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
    resolvePluginApiConfig(
      plugin,
      this.dependencies.plugins.getPluginVariables(plugin, userId)
    );
    if (
      pluginRequiresApiKey(plugin) &&
      !this.dependencies.plugins.getApiKey(plugin, userId)
    ) {
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
    if (plugin.id === CODEX_OAUTH_PLUGIN_ID) {
      await codexOAuthService.ensureFreshToken();
    }
    const variables = this.dependencies.plugins.getPluginVariables(
      plugin,
      userId
    );
    const apiConfig = resolvePluginApiConfig(plugin, variables);
    const endpoint = applyModelEndpointTemplate(
      apiConfig.endpoint,
      request.model
    );
    assertSafePluginEndpoint(endpoint, 'Work model endpoint');
    const apiKey = this.dependencies.plugins.getApiKey(plugin, userId);
    if (pluginRequiresApiKey(plugin) && !apiKey) {
      throw new WorkModelProviderError(
        `API key not found for plugin ${plugin.id}.`,
        422,
        'WORK_PLUGIN_CREDENTIALS_MISSING'
      );
    }
    const providerStateScope =
      apiConfig.apiMode === 'responses'
        ? createOpenAIResponsesStateScope(
            plugin.id,
            request.model,
            endpoint,
            createPluginCredentialFingerprint(apiKey)
          )
        : undefined;
    const headers = buildPluginAuthHeaders(plugin, apiKey, endpoint);
    const { payload, extraHeaders } = buildPluginWorkPayload(
      plugin,
      request,
      variables,
      apiConfig.apiMode,
      providerStateScope
    );
    Object.assign(headers, extraHeaders);

    const startedAt = Date.now();
    try {
      const response = await this.dependencies.post<JsonObject>(
        endpoint,
        payload,
        {
          headers,
          signal,
          timeout: 300_000,
          maxRedirects: 0,
        }
      );
      const normalized = normalizePluginWorkResponse(
        plugin,
        response.data,
        request.model,
        apiConfig.apiMode,
        providerStateScope
      );
      this.recordPluginUsage(
        plugin,
        userId,
        request.model,
        'success',
        startedAt,
        normalized,
        normalizeProviderTokenUsage(response.data)
      );
      return normalized;
    } catch (error) {
      this.recordPluginUsage(
        plugin,
        userId,
        request.model,
        signal?.aborted ? 'cancelled' : 'error',
        startedAt
      );
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

  private async generateOllamaStream(
    request: OllamaChatRequest,
    observer: WorkModelStreamObserver,
    signal?: AbortSignal
  ): Promise<OllamaChatResponse> {
    const stream = this.dependencies.ollama.generateChatStreamResponse;
    if (!stream) {
      const response = await this.dependencies.ollama.generateChatResponse(
        { ...request, stream: false },
        signal
      );
      if (response.message?.thinking) {
        observer.onReasoning?.(response.message.thinking);
      }
      if (response.message?.content) {
        observer.onContent?.(response.message.content);
      }
      observer.onUsage?.(ollamaUsage(response));
      return response;
    }

    return new Promise<OllamaChatResponse>((resolve, reject) => {
      let settled = false;
      let content = '';
      let reasoning = '';
      let latest: OllamaChatResponse | undefined;
      const toolCalls: Record<string, unknown>[] = [];

      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        if (error) {
          reject(error);
          return;
        }
        const response: OllamaChatResponse = {
          ...(latest || {
            model: request.model,
            created_at: new Date().toISOString(),
            done: true,
          }),
          message: {
            role: 'assistant',
            content,
            ...(reasoning ? { thinking: reasoning } : {}),
            ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
          },
          done: true,
        };
        observer.onUsage?.(ollamaUsage(response));
        resolve(response);
      };

      void stream
        .call(
          this.dependencies.ollama,
          request,
          chunk => {
            latest = chunk;
            const contentDelta = chunk.message?.content || '';
            const reasoningDelta = chunk.message?.thinking || '';
            if (contentDelta) {
              content += contentDelta;
              observer.onContent?.(contentDelta);
            }
            if (reasoningDelta) {
              reasoning += reasoningDelta;
              observer.onReasoning?.(reasoningDelta);
            }
            if (Array.isArray(chunk.message?.tool_calls)) {
              for (const call of chunk.message.tool_calls) {
                toolCalls.push(call);
              }
            }
            if (chunk.done) finish();
          },
          error => finish(error),
          () => finish(),
          signal
        )
        .catch(error =>
          finish(error instanceof Error ? error : new Error(String(error)))
        );
    });
  }

  private async generatePluginStream(
    plugin: Plugin,
    request: OllamaChatRequest,
    userId: string,
    observer: WorkModelStreamObserver,
    signal?: AbortSignal
  ): Promise<OllamaChatResponse> {
    validatePluginModel(request.model);
    if (plugin.id === CODEX_OAUTH_PLUGIN_ID) {
      await codexOAuthService.ensureFreshToken();
    }
    const variables = this.dependencies.plugins.getPluginVariables(
      plugin,
      userId
    );
    const apiConfig = resolvePluginApiConfig(plugin, variables);
    let endpoint = applyModelEndpointTemplate(
      apiConfig.endpoint,
      request.model
    );
    assertSafePluginEndpoint(endpoint, 'Work model endpoint');
    const apiKey = this.dependencies.plugins.getApiKey(plugin, userId);
    if (pluginRequiresApiKey(plugin) && !apiKey) {
      throw new WorkModelProviderError(
        `API key not found for plugin ${plugin.id}.`,
        422,
        'WORK_PLUGIN_CREDENTIALS_MISSING'
      );
    }
    const providerStateScope =
      apiConfig.apiMode === 'responses'
        ? createOpenAIResponsesStateScope(
            plugin.id,
            request.model,
            endpoint,
            createPluginCredentialFingerprint(apiKey)
          )
        : undefined;
    if (plugin.id === 'gemini') {
      endpoint = geminiStreamingEndpoint(endpoint);
    }
    assertSafePluginEndpoint(endpoint, 'Work model endpoint');
    const headers = buildPluginAuthHeaders(plugin, apiKey, endpoint);
    const { payload, extraHeaders } = buildPluginWorkPayload(
      plugin,
      { ...request, stream: true },
      variables,
      apiConfig.apiMode,
      providerStateScope
    );
    Object.assign(headers, extraHeaders);
    const timeoutSignal = AbortSignal.timeout(300_000);
    const requestSignal = signal
      ? AbortSignal.any([signal, timeoutSignal])
      : timeoutSignal;

    const startedAt = Date.now();
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: requestSignal,
        redirect: 'error',
      });
      const contentType = response.headers.get('content-type') || '';
      if (
        response.ok &&
        !contentType.includes('text/event-stream') &&
        !contentType.includes('application/x-ndjson')
      ) {
        const data = (await response.json()) as JsonObject;
        const normalized = normalizePluginWorkResponse(
          plugin,
          data,
          request.model,
          apiConfig.apiMode,
          providerStateScope
        );
        if (normalized.message.thinking) {
          observer.onReasoning?.(normalized.message.thinking);
        }
        if (normalized.message.content) {
          observer.onContent?.(normalized.message.content);
        }
        this.recordPluginUsage(
          plugin,
          userId,
          request.model,
          'success',
          startedAt,
          normalized
        );
        return normalized;
      }
      const chunks =
        plugin.id === 'anthropic'
          ? streamAnthropicResponse(response)
          : plugin.id === 'gemini'
            ? streamGeminiWorkResponse(response)
            : apiConfig.apiMode === 'responses'
              ? streamOpenAIResponsesResponse(response, providerStateScope)
              : streamOpenAICompatibleResponse(response);
      const normalized = await collectPluginWorkStream(
        chunks,
        request.model,
        observer
      );
      this.recordPluginUsage(
        plugin,
        userId,
        request.model,
        'success',
        startedAt,
        normalized
      );
      return normalized;
    } catch (error) {
      this.recordPluginUsage(
        plugin,
        userId,
        request.model,
        signal?.aborted ? 'cancelled' : 'error',
        startedAt
      );
      if (signal?.aborted) throw error;
      if (timeoutSignal.aborted) {
        throw new WorkModelProviderError(
          'Plugin request timed out after 300 seconds.',
          504,
          'WORK_PLUGIN_REQUEST_TIMEOUT'
        );
      }
      if (error instanceof WorkModelProviderError) throw error;
      throw new WorkModelProviderError(
        error instanceof Error ? error.message : 'Plugin request failed.',
        502,
        'WORK_PLUGIN_REQUEST_FAILED'
      );
    }
  }

  private recordPluginUsage(
    plugin: Plugin,
    userId: string,
    model: string,
    status: PluginUsageStatus,
    startedAt: number,
    response?: OllamaChatResponse,
    reportedTokens?: ProviderTokenUsage
  ): void {
    const promptTokens = response?.prompt_eval_count;
    const completionTokens = response?.eval_count;
    const hasUsage =
      typeof promptTokens === 'number' || typeof completionTokens === 'number';
    this.dependencies.recordPluginUsage?.({
      userId,
      pluginId: plugin.id,
      pluginName: plugin.name,
      capability: 'chat',
      model,
      status,
      durationMs: Date.now() - startedAt,
      tokens:
        reportedTokens ??
        (hasUsage
          ? {
              promptTokens: promptTokens ?? 0,
              completionTokens: completionTokens ?? 0,
              totalTokens: (promptTokens ?? 0) + (completionTokens ?? 0),
            }
          : undefined),
    });
  }
}

export function buildPluginWorkPayload(
  plugin: Plugin,
  request: OllamaChatRequest,
  variables: PluginVariables = {},
  apiMode: PluginApiMode = resolvePluginApiConfig(plugin, variables).apiMode,
  providerStateScope?: string
): { payload: JsonObject; extraHeaders: Record<string, string> } {
  const options = (request.options || {}) as GenerationOptions;
  const params = resolvePluginChatParameters(options, variables);
  if (plugin.id === 'anthropic') {
    return {
      payload: buildAnthropicWorkPayload(
        request.model,
        request.messages,
        request.tools || [],
        params.maxTokens,
        Boolean(request.stream)
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
  if (apiMode === 'responses') {
    const sampling = getOpenAICompatibleSamplingParameters(plugin, params);
    const tools = toOpenAIResponsesTools(request.tools || []);
    // The ChatGPT-backed codex endpoint rejects sampling parameters outright.
    const supportsSampling = plugin.id !== CODEX_OAUTH_PLUGIN_ID;
    return {
      payload: {
        model: request.model,
        input: toOpenAIResponsesWorkInput(request.messages, providerStateScope),
        ...(tools.length ? { tools, tool_choice: 'auto' } : {}),
        ...(supportsSampling
          ? {
              temperature: sampling.temperature,
              top_p: sampling.top_p,
              max_output_tokens: params.maxTokens,
            }
          : {}),
        stream: Boolean(request.stream),
        store: false,
        include: ['reasoning.encrypted_content'],
      },
      extraHeaders: {},
    };
  }
  return {
    payload: {
      model: request.model,
      messages: toOpenAIWorkMessages(request.messages),
      tools: request.tools,
      tool_choice: request.tools?.length ? 'auto' : undefined,
      ...getOpenAICompatibleSamplingParameters(plugin, params),
      max_tokens: params.maxTokens,
      stream: Boolean(request.stream),
    },
    extraHeaders: {},
  };
}

export function normalizePluginWorkResponse(
  plugin: Plugin,
  response: JsonObject,
  model: string,
  apiMode: PluginApiMode = plugin.api_mode ||
    inferPluginApiMode(plugin.endpoint),
  providerStateScope?: string
): OllamaChatResponse {
  if (plugin.id === 'anthropic') {
    return normalizeAnthropicWorkResponse(response, model);
  }
  if (plugin.id === 'gemini') {
    return normalizeGeminiWorkResponse(response, model);
  }
  if (apiMode === 'responses') {
    return normalizeOpenAIResponsesWorkResponse(
      response,
      model,
      providerStateScope
    );
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
      const reasoningContent = toolCalls
        .map(call => asObject(call.providerMetadata)?.openAIReasoningContent)
        .find(value => typeof value === 'string');
      pendingCalls = toolCalls.map(call => ({
        id: String(call.id),
        name: String((call.function as JsonObject).name),
      }));
      return {
        role: 'assistant',
        content: message.content || null,
        ...(typeof reasoningContent === 'string'
          ? { reasoning_content: reasoningContent }
          : {}),
        ...(toolCalls.length
          ? {
              tool_calls: toolCalls.map(call => ({
                id: call.id,
                type: 'function',
                function: call.function,
              })),
            }
          : {}),
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
        tool_call_id:
          message.tool_call_id || matching?.id || `work-tool-${messageIndex}`,
      };
    }
    return { role: message.role, content: message.content };
  });
}

export function toOpenAIResponsesWorkInput(
  messages: OllamaChatMessage[],
  expectedStateScope?: string
): JsonObject[] {
  const input: JsonObject[] = [];
  let pendingCalls: Array<{ id: string; name: string }> = [];

  for (const [messageIndex, message] of messages.entries()) {
    if (message.role === 'assistant') {
      const toolCalls = normalizeOutboundToolCalls(message.tool_calls);

      const responseOutputItems = Array.isArray(
        message.providerMetadata?.[OPENAI_RESPONSES_OUTPUT_ITEMS_METADATA_KEY]
      )
        ? message.providerMetadata[OPENAI_RESPONSES_OUTPUT_ITEMS_METADATA_KEY]
        : [];
      const replayableOutputItems =
        expectedStateScope === undefined ||
        message.providerMetadata?.[
          OPENAI_RESPONSES_STATE_SCOPE_METADATA_KEY
        ] === expectedStateScope
          ? responseOutputItems.flatMap(rawItem => {
              const item = asObject(rawItem);
              return item ? [{ ...item }] : [];
            })
          : [];
      if (replayableOutputItems.length > 0) {
        pendingCalls = replayableOutputItems.flatMap(item => {
          if (item.type !== 'function_call') return [];
          const id =
            typeof item.call_id === 'string'
              ? item.call_id
              : typeof item.id === 'string'
                ? item.id
                : undefined;
          return id && typeof item.name === 'string'
            ? [{ id, name: item.name }]
            : [];
        });
        input.push(...replayableOutputItems);
        continue;
      }

      pendingCalls = toolCalls.map(call => ({
        id: String(call.id),
        name: String((call.function as JsonObject).name),
      }));

      // Compatibility for Work messages created before full Responses output
      // items were retained.
      for (const call of toolCalls) {
        const metadata = asObject(call.providerMetadata);
        const reasoningItems = Array.isArray(
          metadata?.openAIResponsesReasoningItems
        )
          ? metadata.openAIResponsesReasoningItems
          : [];
        for (const rawItem of reasoningItems) {
          const item = asObject(rawItem);
          if (item?.type === 'reasoning') {
            input.push({ ...item });
          }
        }
      }

      input.push(
        ...toOpenAIResponsesInput([
          {
            role: 'assistant',
            content: message.content,
            tool_calls: toolCalls,
          },
        ])
      );
      continue;
    }

    if (message.role === 'tool') {
      const matchingIndex = pendingCalls.findIndex(
        call => !message.tool_name || call.name === message.tool_name
      );
      const matching =
        matchingIndex >= 0
          ? pendingCalls.splice(matchingIndex, 1)[0]
          : undefined;
      input.push(
        ...toOpenAIResponsesInput([
          {
            role: 'tool',
            content: message.content,
            name: message.tool_name,
            tool_call_id:
              message.tool_call_id ||
              matching?.id ||
              `work-tool-${messageIndex}`,
          },
        ])
      );
      continue;
    }

    input.push(
      ...toOpenAIResponsesInput([
        { role: message.role, content: message.content },
      ])
    );
  }

  return input;
}

function buildAnthropicWorkPayload(
  model: string,
  messages: OllamaChatMessage[],
  tools: JsonObject[],
  maxTokens?: number,
  stream = false
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
    stream,
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
    ...(tools.length
      ? {
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
        }
      : {}),
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
  const toolCalls = normalizeInboundToolCalls(message.tool_calls);
  if (typeof message.reasoning_content === 'string' && toolCalls[0]) {
    toolCalls[0].providerMetadata = {
      ...asObject(toolCalls[0].providerMetadata),
      openAIReasoningContent: message.reasoning_content,
    };
  }
  return workResponse(
    model,
    contentText(message.content),
    toolCalls,
    typeof message.reasoning_content === 'string'
      ? message.reasoning_content
      : ''
  );
}

function normalizeOpenAIResponsesWorkResponse(
  response: JsonObject,
  model: string,
  providerStateScope?: string
): OllamaChatResponse {
  const normalized = normalizeOpenAIResponsesResponse(
    response,
    model,
    providerStateScope
  );
  const choice = normalized.choices[0];
  const message = asObject(choice?.message);
  if (!message) {
    throw new WorkModelProviderError(
      'Plugin returned an invalid Responses API response.',
      502,
      'WORK_PLUGIN_INVALID_RESPONSE'
    );
  }

  const reasoning =
    typeof message.reasoning_content === 'string'
      ? message.reasoning_content
      : '';
  const toolCalls = normalizeInboundToolCalls(message.tool_calls);
  if (reasoning && toolCalls[0]) {
    toolCalls[0].providerMetadata = {
      ...asObject(toolCalls[0].providerMetadata),
      openAIReasoningContent: reasoning,
    };
  }

  const incompleteReason =
    response.status === 'incomplete'
      ? typeof asObject(response.incomplete_details)?.reason === 'string'
        ? String(asObject(response.incomplete_details)?.reason)
        : 'unknown'
      : undefined;

  return {
    ...workResponse(model, contentText(message.content), toolCalls, reasoning, {
      ...(normalized.providerMetadata
        ? { providerMetadata: normalized.providerMetadata }
        : {}),
      ...(incompleteReason
        ? { doneReason: `incomplete:${incompleteReason}` }
        : {}),
    }),
    ...(normalized.usage
      ? {
          prompt_eval_count: normalized.usage.prompt_tokens,
          eval_count: normalized.usage.completion_tokens,
        }
      : {}),
  };
}

function normalizeAnthropicWorkResponse(
  response: JsonObject,
  model: string
): OllamaChatResponse {
  const blocks = Array.isArray(response.content) ? response.content : [];
  const text: string[] = [];
  const calls: JsonObject[] = [];
  const thinkingBlocks: JsonObject[] = [];
  const reasoning: string[] = [];
  for (const [index, value] of blocks.entries()) {
    const block = asObject(value);
    if (block?.type === 'thinking' || block?.type === 'redacted_thinking') {
      thinkingBlocks.push(block);
      if (typeof block.thinking === 'string') reasoning.push(block.thinking);
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
  return workResponse(model, text.join(''), calls, reasoning.join(''));
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
  const reasoning: string[] = [];
  const calls: JsonObject[] = [];
  for (const [index, value] of parts.entries()) {
    const part = asObject(value);
    if (typeof part?.text === 'string') {
      if (part.thought === true) reasoning.push(part.text);
      else text.push(part.text);
    }
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
  return workResponse(model, text.join(''), calls, reasoning.join(''));
}

function workResponse(
  model: string,
  content: string,
  toolCalls: JsonObject[],
  reasoning = '',
  options: {
    providerMetadata?: JsonObject;
    doneReason?: string;
  } = {}
): OllamaChatResponse {
  return {
    model,
    created_at: new Date().toISOString(),
    message: {
      role: 'assistant',
      content,
      ...(reasoning ? { thinking: reasoning } : {}),
      tool_calls: toolCalls,
      ...(options.providerMetadata
        ? { providerMetadata: options.providerMetadata }
        : {}),
    },
    done: true,
    ...(options.doneReason ? { done_reason: options.doneReason } : {}),
  };
}

async function collectPluginWorkStream(
  chunks: AsyncIterable<PluginStreamChunk>,
  model: string,
  observer: WorkModelStreamObserver
): Promise<OllamaChatResponse> {
  let content = '';
  let reasoning = '';
  let usage: PluginStreamUsage = {};
  let doneReason: string | undefined;
  let providerMetadata: JsonObject | undefined;
  const toolCalls: JsonObject[] = [];

  for await (const chunk of chunks) {
    if (chunk.type === 'content') {
      content += chunk.content;
      observer.onContent?.(chunk.content);
      continue;
    }
    if (chunk.type === 'reasoning') {
      reasoning += chunk.content;
      observer.onReasoning?.(chunk.content);
      continue;
    }
    if (chunk.type === 'usage') {
      usage = { ...usage, ...chunk.usage };
      observer.onUsage?.(usage);
      continue;
    }
    if (chunk.type === 'tool_call') {
      const parsedArguments = parseToolArgumentsWithStatus(
        chunk.toolCall.arguments
      );
      const metadata: JsonObject = {
        ...chunk.toolCall.providerMetadata,
        ...(parsedArguments.error
          ? {
              [WORK_TOOL_ARGUMENTS_ERROR_METADATA_KEY]: parsedArguments.error,
            }
          : {}),
      };
      toolCalls.push({
        id: chunk.toolCall.id || `work-plugin-${toolCalls.length}`,
        ...(typeof metadata?.geminiThoughtSignature === 'string'
          ? { thoughtSignature: metadata.geminiThoughtSignature }
          : {}),
        ...(metadata &&
        Object.keys(metadata).some(key => key !== 'geminiThoughtSignature')
          ? {
              providerMetadata: Object.fromEntries(
                Object.entries(metadata).filter(
                  ([key]) => key !== 'geminiThoughtSignature'
                )
              ),
            }
          : {}),
        function: {
          name: chunk.toolCall.name,
          arguments: parsedArguments.arguments,
        },
      });
      continue;
    }
    if (chunk.type === 'done') {
      doneReason = chunk.doneReason;
      providerMetadata = chunk.providerMetadata
        ? { ...providerMetadata, ...chunk.providerMetadata }
        : providerMetadata;
    }
  }

  if (reasoning && toolCalls[0]) {
    const firstMetadata = asObject(toolCalls[0].providerMetadata) || {};
    if (
      !firstMetadata.openAIReasoningContent &&
      !firstMetadata.anthropicThinkingBlocks
    ) {
      toolCalls[0].providerMetadata = {
        ...firstMetadata,
        openAIReasoningContent: reasoning,
      };
    }
  }

  return {
    ...workResponse(model, content, toolCalls, reasoning, {
      ...(providerMetadata ? { providerMetadata } : {}),
      ...(doneReason ? { doneReason } : {}),
    }),
    prompt_eval_count: usage.promptTokens,
    eval_count: usage.completionTokens,
  };
}

function ollamaUsage(response: OllamaChatResponse): PluginStreamUsage {
  return {
    promptTokens: response.prompt_eval_count,
    completionTokens: response.eval_count,
    totalTokens:
      response.prompt_eval_count !== undefined ||
      response.eval_count !== undefined
        ? (response.prompt_eval_count || 0) + (response.eval_count || 0)
        : undefined,
  };
}

function geminiStreamingEndpoint(endpoint: string): string {
  const url = new URL(endpoint);
  url.pathname = url.pathname.replace(
    /:generateContent$/,
    ':streamGenerateContent'
  );
  url.searchParams.set('alt', 'sse');
  return url.toString();
}

async function* streamGeminiWorkResponse(
  response: Response
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
  let callIndex = 0;
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
        let payload: JsonObject;
        try {
          payload = JSON.parse(trimmed.slice(5).trim()) as JsonObject;
        } catch {
          continue;
        }
        const streamError = providerStreamErrorMessage(payload);
        if (streamError) {
          throw new Error(`Plugin API error: ${streamError}`);
        }
        const candidates = Array.isArray(payload.candidates)
          ? payload.candidates
          : [];
        const candidate = asObject(candidates[0]);
        const candidateContent = asObject(candidate?.content);
        const parts = Array.isArray(candidateContent?.parts)
          ? candidateContent.parts
          : [];
        for (const rawPart of parts) {
          const part = asObject(rawPart);
          if (typeof part?.text === 'string' && part.text) {
            yield part.thought === true
              ? { type: 'reasoning', content: part.text }
              : { type: 'content', content: part.text };
          }
          const call = asObject(part?.functionCall);
          if (call && typeof call.name === 'string') {
            yield {
              type: 'tool_call',
              toolCall: {
                id:
                  typeof call.id === 'string'
                    ? call.id
                    : `work-gemini-${callIndex++}`,
                name: call.name,
                arguments: JSON.stringify(asObject(call.args) || {}),
                ...(typeof part?.thoughtSignature === 'string'
                  ? {
                      providerMetadata: {
                        geminiThoughtSignature: part.thoughtSignature,
                      },
                    }
                  : {}),
              },
            };
          }
        }
        const usageMetadata = asObject(payload.usageMetadata);
        if (usageMetadata) {
          const promptTokens =
            typeof usageMetadata.promptTokenCount === 'number'
              ? usageMetadata.promptTokenCount
              : undefined;
          const completionTokens =
            typeof usageMetadata.candidatesTokenCount === 'number'
              ? usageMetadata.candidatesTokenCount
              : undefined;
          const totalTokens =
            typeof usageMetadata.totalTokenCount === 'number'
              ? usageMetadata.totalTokenCount
              : promptTokens !== undefined || completionTokens !== undefined
                ? (promptTokens || 0) + (completionTokens || 0)
                : undefined;
          yield {
            type: 'usage',
            usage: { promptTokens, completionTokens, totalTokens },
          };
        }
      }
    }
    yield { type: 'done' };
  } finally {
    reader.releaseLock();
  }
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
    const parsedArguments = parseToolArgumentsWithStatus(fn.arguments);
    const providerMetadata = {
      ...asObject(call?.providerMetadata),
      ...(parsedArguments.error
        ? {
            [WORK_TOOL_ARGUMENTS_ERROR_METADATA_KEY]: parsedArguments.error,
          }
        : {}),
    };
    return [
      {
        id: typeof call?.id === 'string' ? call.id : `work-plugin-${index}`,
        ...(typeof call?.thoughtSignature === 'string'
          ? { thoughtSignature: call.thoughtSignature }
          : {}),
        ...(Object.keys(providerMetadata).length > 0
          ? { providerMetadata }
          : {}),
        function: {
          name: fn.name,
          arguments:
            typeof fn.arguments === 'string' && !parsedArguments.error
              ? fn.arguments
              : parsedArguments.arguments,
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
  return parseToolArgumentsWithStatus(value).arguments;
}

function parseToolArgumentsWithStatus(value: unknown): {
  arguments: JsonObject;
  error?: string;
} {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return { arguments: value as JsonObject };
  }
  if (typeof value === 'string') {
    if (!value.trim()) return { arguments: {} };
    try {
      const parsed = asObject(JSON.parse(value));
      return parsed
        ? { arguments: parsed }
        : {
            arguments: {},
            error: WORK_TOOL_ARGUMENTS_ERROR_MESSAGE,
          };
    } catch {
      return {
        arguments: {},
        error: WORK_TOOL_ARGUMENTS_ERROR_MESSAGE,
      };
    }
  }
  return { arguments: {} };
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

function providerStreamErrorMessage(value: unknown): string | undefined {
  const payload = asObject(value);
  if (!payload) return undefined;
  const error = asObject(payload.error);
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
