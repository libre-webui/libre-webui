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

/**
 * Libre WebUI's answer to the engine's provider questions.
 *
 * The engine's adapter asks this handler which models exist and how to stream a
 * call; the handler resolves both through the services the Chat surface already
 * uses. That is what makes a model pulled in the UI immediately available to
 * the engine, with the credentials and endpoints already configured, instead of
 * a second provider configuration maintained by hand in YAML.
 *
 * This module is the one place that knows both sides. It imports Libre WebUI's
 * services and the engine adapter's types, and it is installed by
 * {@link installLibreWebUiProvider} at startup.
 *
 * @module cordis/dsh/provider-handler
 */

import { randomUUID } from 'node:crypto';
import type {
  ChatMessage,
  GenerationOptions,
  Plugin,
} from '../../types/index.js';
import pluginService from '../../services/pluginService.js';
import ollamaService from '../../services/ollamaService.js';
import { getOllamaRuntimeSettings } from '../../services/ollamaSettingsService.js';
import preferencesService, {
  instanceDefaultModel,
} from '../../services/preferencesService.js';
import { userModel } from '../../models/userModel.js';
import {
  isProviderModelIdentity,
  nativeDshModelId,
  parseNativeDshModelId,
} from './model-identity.js';
import { nativeDshProviderService } from './native-provider-client.js';
import { createLogger } from '../../utils/logger.js';
import { toOpenAICompatibleTools } from '../../utils/pluginChatAdapter.js';
import {
  type BridgeCall,
  type BridgeEvent,
  type BridgeModel,
  type BridgeToolCall,
  type LibreWebUiProviderHandler,
} from './librewebui-llm-adapter.js';

const logger = createLogger('cordis-provider');

/**
 * Account whose provider credentials serve engine calls.
 *
 * A trusted composition without an interactive caller may explicitly name a
 * service account. Interactive requests always use their authenticated actor.
 */
function configuredUserId(): string | undefined {
  const configured = process.env.LIBRE_CORDIS_USER;
  return configured && configured.trim() !== '' ? configured.trim() : undefined;
}

type ProviderRoute =
  | { type: 'ollama'; model: string }
  | { type: 'plugin'; model: string; pluginId: string };

function modelRouteId(route: ProviderRoute): string {
  return route.type === 'ollama'
    ? `lwui:ollama:${encodeURIComponent(route.model)}`
    : `lwui:plugin:${encodeURIComponent(route.pluginId)}:${encodeURIComponent(route.model)}`;
}

/** Qualified IDs retain the selected destination across restarts and outages. */
function parseModelRoute(id: string): ProviderRoute | undefined {
  if (!id.startsWith('lwui:')) return undefined;
  const parts = id.split(':');
  try {
    if (parts[1] === 'ollama' && parts.length === 3 && parts[2]) {
      return { type: 'ollama', model: decodeURIComponent(parts[2]) };
    }
    if (parts[1] === 'plugin' && parts.length === 4 && parts[2] && parts[3]) {
      return {
        type: 'plugin',
        pluginId: decodeURIComponent(parts[2]),
        model: decodeURIComponent(parts[3]),
      };
    }
  } catch {
    // A malformed qualified route must never become a legacy model lookup.
  }
  throw new Error('The Cordis model route is invalid.');
}

async function requirePluginRoute(
  route: Extract<ProviderRoute, { type: 'plugin' }>,
  userId?: string
): Promise<Plugin> {
  if (!userId)
    throw new Error(
      'A Cordis plugin route requires an authenticated provider account.'
    );
  const plugin = await pluginService.getActivePluginForModel(
    route.model,
    userId,
    route.pluginId
  );
  if (!plugin) throw new Error('The selected Cordis provider is unavailable.');
  return plugin;
}

async function requireOllamaEnabled(): Promise<void> {
  if (!(await getOllamaRuntimeSettings()).enabled)
    throw new Error(
      'Ollama is disabled. Choose an available qualified provider model.'
    );
}

/**
 * Whether a model identifier names an embedding model.
 *
 * Embedding models appear in the same listing as chat models and cannot answer
 * a turn, so they are excluded from what the engine may select.
 * @param id - the model identifier.
 * @returns true when the model is for embeddings rather than chat.
 */
function isEmbeddingModel(id: string): boolean {
  const name = id.toLowerCase();
  return (
    name.includes('embed') ||
    name.includes('minilm') ||
    name.includes('bge-') ||
    name.includes('rerank')
  );
}

/** Chat execution selections are not provider model identifiers. */
function isChatModelId(id: string): boolean {
  return (
    !id.toLowerCase().startsWith('lwui:') &&
    isProviderModelIdentity(id) &&
    !isEmbeddingModel(id)
  );
}

/** An engine picker catalog, independently of Chat persona selection/prompts. */
export async function getCordisModelCatalog(userId: string): Promise<{
  models: readonly BridgeModel[];
  defaultModel?: string;
}> {
  const models = await libreWebUiProviderHandler.listModels(userId);
  let defaultModel: string | undefined;
  try {
    defaultModel = await libreWebUiProviderHandler.defaultModel(userId);
  } catch (error) {
    // The catalog stays usable to replace an unavailable preference. Actual
    // execution still resolves explicit routes without provider fallback.
    logger.debug('Cordis default model is unavailable', { error });
  }
  return { models, ...(defaultModel ? { defaultModel } : {}) };
}

/**
 * The model the engine should request when its own configuration names none.
 *
 * Read live from preferences so changing the default in the UI changes what the
 * engine uses, rather than pinning a copy in the engine's settings document.
 * @returns the model identifier, or undefined when the deployment has none.
 */
export async function resolveEngineDefaultModel(
  userId?: string
): Promise<string | undefined> {
  return libreWebUiProviderHandler.defaultModel(userId);
}

async function providerUserId(requested?: string): Promise<string | undefined> {
  const userId = requested ?? configuredUserId();
  if (!userId) return undefined;
  const user = await userModel.getUserById(userId);
  if (user?.role !== 'admin' || user.status !== 'active') {
    throw new Error('Cordis provider calls require an active administrator.');
  }
  return userId;
}

async function resolveProviderCallModel(
  requestedModel: string,
  requestedUserId?: string
): Promise<{ userId?: string; model: string; plugin?: Plugin | null }> {
  const userId = await providerUserId(requestedUserId);
  const preferences = userId
    ? await preferencesService.getPreferences(userId)
    : undefined;
  const qualified = parseModelRoute(requestedModel);
  const model = qualified?.model ?? requestedModel;
  if (!isChatModelId(model)) {
    throw new Error(
      'Select a provider chat model for Cordis; personas and agent selectors cannot be used as models.'
    );
  }
  const preferred = preferences?.defaultModel === model;
  let plugin: Plugin | null | undefined;
  if (qualified?.type === 'plugin') {
    plugin = await requirePluginRoute(qualified, userId);
  } else if (qualified?.type === 'ollama') {
    await requireOllamaEnabled();
  } else if (!qualified) {
    if (preferred && preferences?.defaultProviderType === 'plugin') {
      if (!preferences.defaultProviderId)
        throw new Error(
          'The selected Cordis provider has no provider identity.'
        );
      plugin = await requirePluginRoute(
        { type: 'plugin', model, pluginId: preferences.defaultProviderId },
        userId
      );
    } else {
      await requireOllamaEnabled();
      if (!(preferred && preferences?.defaultProviderType === 'ollama')) {
        // Raw operator-configured IDs retain legacy lookup only while the
        // local catalog is available. Qualified routes never need this probe.
        const local = await ollamaService.getModels();
        if (userId && !local.some(candidate => candidate.name === model)) {
          plugin = await pluginService.getActivePluginForModel(model, userId);
        }
      }
    }
  }
  return { userId, model, plugin };
}

/** Resolve a text-only task through the same provider as an engine request. */
export async function resolveCordisProviderTarget(
  requestedModel: string,
  requestedUserId: string
): Promise<{
  model: string;
  providerType: 'ollama' | 'plugin' | 'dsh';
  providerId: string | null;
}> {
  const native = parseNativeDshModelId(requestedModel);
  if (native) {
    await nativeDshProviderService.assertModel(
      native.providerId,
      native.model,
      requestedUserId
    );
    return { ...native, providerType: 'dsh' };
  }
  const { model, plugin } = await resolveProviderCallModel(
    requestedModel,
    requestedUserId
  );
  return {
    model,
    providerType: plugin ? 'plugin' : 'ollama',
    providerId: plugin?.id ?? null,
  };
}

/**
 * Build the provider-layer messages LWUI's services expect.
 * @param call - the engine's request.
 * @returns chat messages with the fields the providers read.
 */
function toChatMessages(call: BridgeCall): ChatMessage[] {
  const now = Date.now();
  return call.messages.map((message, index) => ({
    id: `cordis-${now}-${index}`,
    role: message.role,
    content: message.content,
    ...(message.thinking ? { thinking: message.thinking } : {}),
    ...(message.providerMetadata
      ? { providerMetadata: message.providerMetadata }
      : {}),
    timestamp: now,
    ...(message.toolCalls && message.toolCalls.length > 0
      ? {
          tool_calls: message.toolCalls.map(toolCall => ({
            id: toolCall.id,
            type: 'function' as const,
            function: {
              name: toolCall.name,
              arguments: toolCall.arguments,
            },
          })),
        }
      : {}),
    ...(message.toolCallId === undefined
      ? {}
      : { tool_call_id: message.toolCallId }),
  }));
}

/**
 * The options object the providers read for sampling controls.
 *
 * Exported for its regression test: the tool shape it produces is only
 * observable at this boundary, because the engine normalises tool declarations
 * before they reach the adapter that calls it.
 * @param call - the engine's request.
 * @returns options for Libre WebUI's provider layer.
 */
export function toGenerationOptions(call: BridgeCall): GenerationOptions {
  return {
    ...(call.temperature === undefined
      ? {}
      : { temperature: call.temperature }),
    ...(call.maxTokens === undefined ? {} : { num_predict: call.maxTokens }),
    ...(call.stop === undefined ? {} : { stop: [...call.stop] }),
    ...(call.tools === undefined || call.tools.length === 0
      ? {}
      : {
          // Libre WebUI's provider layer takes tool declarations flat and
          // wraps them per protocol itself. Pre-wrapping them the way an
          // OpenAI request looks made every name read as undefined, and the
          // provider rejected the request outright.
          tools: call.tools.map(tool => ({
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          })),
        }),
  };
}

/** Map one plugin stream chunk onto the engine's event vocabulary. */
function fromPluginChunk(chunk: {
  type: string;
  content?: string;
  toolCall?: BridgeToolCall;
  usage?: { promptTokens?: number; completionTokens?: number };
  doneReason?: string;
}): BridgeEvent | undefined {
  if (chunk.type === 'content' && chunk.content) {
    return { type: 'text', text: chunk.content };
  }
  if (chunk.type === 'reasoning' && chunk.content) {
    return { type: 'reasoning', text: chunk.content };
  }
  if (chunk.type === 'tool_call' && chunk.toolCall) {
    return { type: 'tool-call', toolCall: chunk.toolCall };
  }
  if (chunk.type === 'usage' && chunk.usage) {
    return {
      type: 'usage',
      inputTokens: chunk.usage.promptTokens ?? 0,
      outputTokens: chunk.usage.completionTokens ?? 0,
    };
  }
  return undefined;
}

/** Keep native completion reasons; truncation must never execute partial tools. */
function completionReason(
  reason: string | undefined,
  hasTools: boolean
): 'stop' | 'tool-calls' | 'max-tokens' | 'error' {
  if (
    reason === 'length' ||
    reason === 'max_tokens' ||
    reason === 'max-tokens' ||
    reason === 'incomplete:max_output_tokens'
  )
    return 'max-tokens';
  if (reason === 'error' || reason?.startsWith('incomplete:')) return 'error';
  return hasTools ? 'tool-calls' : 'stop';
}

/** The handler the engine's adapter delegates to. */
export const libreWebUiProviderHandler: LibreWebUiProviderHandler = {
  async defaultModel(requestedUserId): Promise<string | undefined> {
    const userId = await providerUserId(requestedUserId);
    const preferences = userId
      ? await preferencesService.getPreferences(userId)
      : undefined;
    const preferred = preferences?.defaultModel || instanceDefaultModel();
    const qualified = preferred ? parseModelRoute(preferred) : undefined;
    if (
      preferred &&
      preferences?.defaultProviderType !== 'agent' &&
      isChatModelId(qualified?.model ?? preferred)
    ) {
      if (qualified) {
        if (qualified.type === 'plugin')
          await requirePluginRoute(qualified, userId);
        else await requireOllamaEnabled();
        return modelRouteId(qualified);
      }
      if (preferences?.defaultProviderType === 'plugin') {
        if (!preferences.defaultProviderId)
          throw new Error(
            'The selected Cordis provider has no provider identity.'
          );
        const route = {
          type: 'plugin' as const,
          model: preferred,
          pluginId: preferences.defaultProviderId,
        };
        await requirePluginRoute(route, userId);
        return modelRouteId(route);
      }
      if (preferences?.defaultProviderType === 'ollama') {
        await requireOllamaEnabled();
        return modelRouteId({ type: 'ollama', model: preferred });
      }
      // Legacy unqualified defaults are only resolved when the local catalog
      // answers. An outage cannot turn an ambiguous local name into a remote call.
      await requireOllamaEnabled();
      const local = await ollamaService.getModels();
      if (local.some(model => model.name === preferred)) {
        return modelRouteId({ type: 'ollama', model: preferred });
      }
      if (userId) {
        const plugin = await pluginService.getActivePluginForModel(
          preferred,
          userId
        );
        if (plugin)
          return modelRouteId({
            type: 'plugin',
            model: preferred,
            pluginId: plugin.id,
          });
      }
    }
    // Personas and agents are Chat execution surfaces. Do not resolve their
    // backing configuration or inherit their prompts into the coding engine.
    return (await this.listModels(userId))[0]?.id;
  },

  async listModels(requestedUserId): Promise<readonly BridgeModel[]> {
    const userId = await providerUserId(requestedUserId);
    const models = new Map<string, BridgeModel>();
    try {
      const local = (await getOllamaRuntimeSettings()).enabled
        ? await ollamaService.getModels()
        : [];
      for (const model of local) {
        if (isChatModelId(model.name)) {
          const id = modelRouteId({ type: 'ollama', model: model.name });
          models.set(id, {
            id,
            name: model.name,
            providerType: 'ollama',
            providerName: 'Ollama',
          });
        }
      }
    } catch (error) {
      logger.debug('Ollama models unavailable to the engine', { error });
    }
    // No account means no implicit access to somebody else's remote keys.
    if (userId) {
      const statuses = await pluginService.getPluginStatus(userId);
      for (const plugin of await pluginService.getActivePlugins(userId)) {
        if (
          (plugin.type !== 'completion' && plugin.type !== 'chat') ||
          !statuses.some(status => status.id === plugin.id && status.available)
        )
          continue;
        for (const model of plugin.model_map) {
          if (isChatModelId(model)) {
            const id = modelRouteId({
              type: 'plugin',
              model,
              pluginId: plugin.id,
            });
            models.set(id, {
              id,
              name: model,
              providerType: 'plugin',
              providerId: plugin.id,
              providerName: plugin.name,
            });
          }
        }
      }
    }
    if (userId) {
      const native = await nativeDshProviderService.catalog(userId);
      for (const model of native.models) {
        const id = nativeDshModelId(model.providerId, model.model);
        models.set(id, {
          id,
          name: model.name,
          providerType: 'dsh',
          providerId: model.providerId,
          providerName: model.providerName,
          ...(model.contextWindow
            ? { contextWindow: model.contextWindow }
            : {}),
          ...(model.defaultMaxTokens
            ? { maxTokens: model.defaultMaxTokens }
            : {}),
        });
      }
    }
    return [...models.values()];
  },

  async resolveModel(model, userId): Promise<BridgeModel | undefined> {
    return (await this.listModels(userId)).find(
      candidate => candidate.id === model
    );
  },

  async *stream(call: BridgeCall): AsyncIterable<BridgeEvent> {
    call.signal?.throwIfAborted();
    const native = parseNativeDshModelId(call.model);
    if (native) {
      const userId = await providerUserId(call.userId);
      yield* nativeDshProviderService.stream(
        { ...call, model: native.model, userId },
        native.providerId
      );
      return;
    }
    const { userId, model, plugin } = await resolveProviderCallModel(
      call.model,
      call.userId
    );
    const messages = toChatMessages(call);
    const options = toGenerationOptions(call);
    const controller = new AbortController();
    const signal = call.signal
      ? AbortSignal.any([call.signal, controller.signal])
      : controller.signal;

    try {
      if (plugin) {
        let hasTools = false;
        for await (const chunk of pluginService.executePluginStreamRequest(
          model,
          messages,
          options,
          userId,
          plugin.id,
          signal
        )) {
          signal.throwIfAborted();
          const event = fromPluginChunk(chunk);
          if (event) yield event;
          if (chunk.type === 'tool_call') hasTools = true;
          if (chunk.type === 'done') {
            yield {
              type: 'done',
              reason: completionReason(chunk.doneReason, hasTools),
              ...(chunk.providerMetadata
                ? { providerMetadata: chunk.providerMetadata }
                : {}),
            };
          }
        }
        return;
      }

      const { tools, ...samplingOptions } = options;
      const queue: BridgeEvent[] = [];
      let bufferedBytes = 0;
      let settled = false;
      let failure: Error | undefined;
      let wake: (() => void) | undefined;
      let hasTools = false;
      let doneReason: string | undefined;
      const notify = () => {
        wake?.();
        wake = undefined;
      };
      const fail = (error: Error) => {
        failure ??= error;
        settled = true;
        notify();
      };
      const push = (event: BridgeEvent) => {
        if (settled || signal.aborted) return;
        const bytes = Buffer.byteLength(JSON.stringify(event));
        if (queue.length >= 2048 || bufferedBytes + bytes > 2_000_000) {
          const error = new Error(
            'Cordis provider output exceeded its stream buffer limit.'
          );
          fail(error);
          controller.abort(error);
          return;
        }
        queue.push(event);
        bufferedBytes += bytes;
        notify();
      };
      const abort = () => {
        fail(
          signal.reason instanceof Error
            ? signal.reason
            : new Error('Request aborted')
        );
      };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      const finished = ollamaService
        .generateChatStreamResponse(
          {
            model,
            messages,
            stream: true,
            options: samplingOptions,
            ...(tools?.length ? { tools: toOpenAICompatibleTools(tools) } : {}),
          },
          chunk => {
            const text = chunk.message?.content;
            if (text) push({ type: 'text', text });
            if (chunk.message?.thinking)
              push({ type: 'reasoning', text: chunk.message.thinking });
            for (const rawCall of chunk.message?.tool_calls ?? []) {
              const fn = rawCall.function as
                { name?: unknown; arguments?: unknown } | undefined;
              hasTools = true;
              push({
                type: 'tool-call',
                toolCall: {
                  id:
                    typeof rawCall.id === 'string' && rawCall.id
                      ? rawCall.id
                      : `call_${randomUUID()}`,
                  name: typeof fn?.name === 'string' ? fn.name : '',
                  arguments:
                    typeof fn?.arguments === 'string'
                      ? fn.arguments
                      : JSON.stringify(fn?.arguments ?? {}),
                },
              });
            }
            if (
              typeof chunk.prompt_eval_count === 'number' &&
              typeof chunk.eval_count === 'number'
            ) {
              push({
                type: 'usage',
                inputTokens: chunk.prompt_eval_count,
                outputTokens: chunk.eval_count,
              });
            }
            if (chunk.done_reason) doneReason = chunk.done_reason;
          },
          fail,
          () =>
            push({
              type: 'done',
              reason: completionReason(doneReason, hasTools),
            }),
          signal,
          { userId }
        )
        .catch(error =>
          fail(error instanceof Error ? error : new Error(String(error)))
        )
        .finally(() => {
          settled = true;
          notify();
        });

      try {
        while (!settled || queue.length) {
          signal.throwIfAborted();
          if (failure) throw failure;
          const event = queue.shift();
          if (event) {
            bufferedBytes -= Buffer.byteLength(JSON.stringify(event));
            yield event;
          } else {
            await new Promise<void>(resolve => {
              wake = resolve;
            });
          }
        }
        if (failure) throw failure;
      } finally {
        signal.removeEventListener('abort', abort);
        controller.abort();
        queue.length = 0;
        await finished;
      }
    } finally {
      // Async iterator return (including disconnect) owns the provider request.
      controller.abort();
    }
  },
};

/** Install a capability without borrowing an administrator's credentials. */
export async function installLibreWebUiProvider(): Promise<LibreWebUiProviderHandler> {
  if (configuredUserId()) await providerUserId();
  return libreWebUiProviderHandler;
}
