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
 * Decision models across providers: which ones a user can reach, and one
 * call to any of them. Ollama marks its decision models with the `decision`
 * capability; a provider plugin declares a `decision` capability with its
 * wire format, and lists its models statically, through its model listing,
 * or both.
 */

import type {
  ChatMessage,
  ChatProviderSelection,
  DecisionConfig,
  Plugin,
} from '../types/index.js';
import {
  buildDecisionRequestBody,
  DecisionProviderError,
  DecisionValidationError,
  parseDecisionResponse,
  readDecisionProviderError,
  renderDecisionMarkdown,
  resolveDecisionChatTurn,
  type DecisionApi,
  type DecisionImageInput,
  type DecisionInput,
  type DecisionQuestions,
  type DecisionResult,
} from '../utils/decisionProtocol.js';
import {
  assertSafePluginEndpoint,
  buildPluginAuthHeaders,
  buildPluginModelDiscoveryHeaders,
  pluginRequiresApiKey,
  resolvePluginApiConfig,
  validatePluginModel,
} from '../utils/pluginValidation.js';
import {
  isProviderRequestCancelled,
  ProviderHttpError,
  type ProviderRequestOptions,
  type ProviderResponse,
} from '../utils/providerFetch.js';
import type { PluginStreamChunk } from '../utils/pluginStreaming.js';
import type { PluginUsageEventInput } from './pluginUsageService.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('services:decision');

type PluginVariables = Record<string, string | number | boolean>;
type MaybePromise<T> = T | Promise<T>;

type DecisionCapability = NonNullable<
  NonNullable<Plugin['capabilities']>['decision']
>;

const DISCOVERY_TTL_MS = 10 * 60 * 1000;
const DISCOVERY_FAILURE_TTL_MS = 60 * 1000;
const DECISION_TIMEOUT_MS = 120_000;
const LISTING_TIMEOUT_MS = 15_000;
const OLLAMA_PROBE_CONCURRENCY = 6;

/** One decision model a user can call. */
export interface DecisionModelEntry {
  /** The id to send as `model`. */
  id: string;
  providerType: 'ollama' | 'plugin';
  /** The plugin id; absent for Ollama. */
  providerId?: string;
  providerName: string;
  /** Whether the model reads images, when that is known. */
  images?: boolean;
}

/** Where a decision request goes. */
export type DecisionTarget =
  | { providerType: 'ollama'; model: string }
  | {
      providerType: 'plugin';
      model: string;
      plugin: Plugin;
      capability: DecisionCapability;
    };

export interface DecisionOutcome extends DecisionResult {
  provider: { type: 'ollama' | 'plugin'; id?: string; name: string };
  durationMs: number;
}

export interface DecisionServiceDependencies {
  getActivePlugins(userId?: string): MaybePromise<Plugin[]>;
  getApiKey(plugin: Plugin, userId?: string): MaybePromise<string | null>;
  getPluginVariables(
    plugin: Plugin,
    userId?: string
  ): MaybePromise<PluginVariables>;
  ollama: {
    isEnabled(): boolean;
    getModels(): Promise<Array<{ name: string }>>;
    getCapabilities(
      model: string,
      signal?: AbortSignal
    ): Promise<string[] | undefined>;
    systemOne(
      body: Record<string, unknown>,
      signal?: AbortSignal
    ): Promise<unknown>;
  };
  request<T = unknown>(
    options: ProviderRequestOptions
  ): Promise<ProviderResponse<T>>;
  canUse(userId: string): Promise<boolean>;
  recordUsage?(usage: PluginUsageEventInput): void | Promise<void>;
  now?(): number;
}

interface DiscoveredDecisionModel {
  id: string;
  images?: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const OPERATION_SUFFIXES = [
  '/chat/completions',
  '/completions',
  '/responses',
  '/messages',
];

/**
 * The provider's API root with a trailing slash: its chat endpoint, after
 * any Base URL the user set, without the operation. Decision paths are
 * resolved against it so a self-hosted or regional endpoint moves them too.
 */
export function decisionApiRoot(
  plugin: Plugin,
  variables: PluginVariables = {}
): string {
  const { endpoint } = resolvePluginApiConfig(plugin, variables);
  const url = new URL(endpoint);
  url.search = '';
  url.hash = '';
  let path = url.pathname.replace(/\/+$/, '');
  for (const suffix of OPERATION_SUFFIXES) {
    if (path.endsWith(suffix)) {
      path = path.slice(0, -suffix.length);
      break;
    }
  }
  url.pathname = `${path}/`;
  return url.toString();
}

export function resolveDecisionEndpoint(
  plugin: Plugin,
  capability: DecisionCapability,
  variables: PluginVariables = {}
): string {
  const endpoint = capability.config?.path
    ? new URL(
        capability.config.path,
        decisionApiRoot(plugin, variables)
      ).toString()
    : capability.endpoint;
  assertSafePluginEndpoint(endpoint, 'decision endpoint');
  return endpoint;
}

function resolveDecisionModelsEndpoint(
  plugin: Plugin,
  config: DecisionConfig,
  variables: PluginVariables
): string {
  const endpoint = new URL(
    config.models_path || 'models',
    decisionApiRoot(plugin, variables)
  ).toString();
  assertSafePluginEndpoint(endpoint, 'decision models endpoint');
  return endpoint;
}

/** The decision models in one provider listing, as its config marks them. */
export function readDecisionModelListing(
  config: DecisionConfig,
  body: unknown
): DiscoveredDecisionModel[] {
  const entries = Array.isArray(body)
    ? body
    : isRecord(body) && Array.isArray(body.data)
      ? body.data
      : isRecord(body) && Array.isArray(body.models)
        ? body.models
        : [];
  const models: DiscoveredDecisionModel[] = [];
  for (const entry of entries) {
    if (!isRecord(entry) || typeof entry.id !== 'string' || !entry.id) continue;
    const architecture = isRecord(entry.architecture)
      ? entry.architecture
      : undefined;
    const outputs = Array.isArray(architecture?.output_modalities)
      ? architecture.output_modalities
      : undefined;
    const inputs = Array.isArray(architecture?.input_modalities)
      ? architecture.input_modalities
      : undefined;
    if (config.discovery === 'id-prefix') {
      if (!config.id_prefix || !entry.id.startsWith(config.id_prefix)) continue;
    } else if (config.discovery === 'output-modality') {
      if (!outputs?.includes('decisions')) continue;
    } else {
      continue;
    }
    models.push({
      id: entry.id,
      ...(inputs ? { images: inputs.includes('image') } : {}),
    });
  }
  return models;
}

/**
 * A plugin's decision capability: its capability block, or its root when the
 * plugin is a decision provider and nothing else.
 */
export function getDecisionCapability(
  plugin: Plugin
): DecisionCapability | undefined {
  if (plugin.capabilities?.decision) return plugin.capabilities.decision;
  if (plugin.type !== 'decision') return undefined;
  return {
    endpoint: plugin.endpoint,
    model_map: plugin.model_map,
    config: { api: 'systemone' },
  };
}

const pluginImageInput = (capability: DecisionCapability): DecisionImageInput =>
  capability.config?.image_input ?? 'none';

export class DecisionService {
  private discovered = new Map<
    string,
    { models: DiscoveredDecisionModel[]; at: number; ok: boolean }
  >();

  constructor(private readonly deps: DecisionServiceDependencies) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private async pluginIsUsable(
    plugin: Plugin,
    capability: DecisionCapability,
    userId?: string
  ): Promise<boolean> {
    if (
      capability.config?.no_auth_required === true ||
      !pluginRequiresApiKey(plugin)
    ) {
      return true;
    }
    return Boolean(await this.deps.getApiKey(plugin, userId));
  }

  private async discover(
    plugin: Plugin,
    capability: DecisionCapability,
    userId?: string,
    signal?: AbortSignal
  ): Promise<DiscoveredDecisionModel[]> {
    const config = capability.config;
    if (!config?.discovery) return [];
    const key = `${userId ?? ''}\u0000${plugin.id}`;
    const cached = this.discovered.get(key);
    const ttl = cached?.ok ? DISCOVERY_TTL_MS : DISCOVERY_FAILURE_TTL_MS;
    if (cached && this.now() - cached.at < ttl) return cached.models;

    try {
      const variables = await this.deps.getPluginVariables(plugin, userId);
      const endpoint = resolveDecisionModelsEndpoint(plugin, config, variables);
      const apiKey = await this.deps.getApiKey(plugin, userId);
      const response = await this.deps.request({
        url: endpoint,
        method: 'GET',
        headers: buildPluginModelDiscoveryHeaders(plugin, apiKey, endpoint),
        timeoutMs: LISTING_TIMEOUT_MS,
        signal,
      });
      const models = readDecisionModelListing(config, response.data);
      this.discovered.set(key, { models, at: this.now(), ok: true });
      return models;
    } catch (error) {
      if (signal?.aborted || isProviderRequestCancelled(error)) throw error;
      logger.debug(
        `Decision model listing for ${plugin.id} failed: ${error instanceof Error ? error.message : String(error)}`
      );
      this.discovered.set(key, {
        models: cached?.models ?? [],
        at: this.now(),
        ok: false,
      });
      return cached?.models ?? [];
    }
  }

  /** The models one plugin offers, listed ones first, then its own list. */
  private async pluginModels(
    plugin: Plugin,
    capability: DecisionCapability,
    userId?: string,
    signal?: AbortSignal
  ): Promise<DiscoveredDecisionModel[]> {
    const listed = await this.discover(plugin, capability, userId, signal);
    const seen = new Set(listed.map(model => model.id));
    // OpenAI's and Gemini's Decisions APIs carry images in their own shape.
    const imageDefault =
      (capability.config?.api ?? 'systemone') !== 'systemone' ||
      pluginImageInput(capability) !== 'none';
    const declared = capability.model_map
      .filter(id => !seen.has(id))
      .map(id => ({ id, images: imageDefault }));
    return [
      ...listed.map(model => ({
        ...model,
        images:
          imageDefault && (model.images === undefined || model.images === true),
      })),
      ...declared,
    ];
  }

  private async ollamaDecisionModels(
    signal?: AbortSignal
  ): Promise<DecisionModelEntry[]> {
    if (!this.deps.ollama.isEnabled()) return [];
    let names: string[];
    try {
      names = (await this.deps.ollama.getModels()).map(model => model.name);
    } catch {
      return [];
    }
    const entries: DecisionModelEntry[] = [];
    for (let i = 0; i < names.length; i += OLLAMA_PROBE_CONCURRENCY) {
      const batch = names.slice(i, i + OLLAMA_PROBE_CONCURRENCY);
      const results = await Promise.all(
        batch.map(async name => {
          try {
            return {
              name,
              capabilities: await this.deps.ollama.getCapabilities(
                name,
                signal
              ),
            };
          } catch (error) {
            if (signal?.aborted || isProviderRequestCancelled(error)) {
              throw error;
            }
            return { name, capabilities: undefined };
          }
        })
      );
      for (const { name, capabilities } of results) {
        if (!capabilities?.includes('decision')) continue;
        entries.push({
          id: name,
          providerType: 'ollama',
          providerName: 'Ollama',
          images: capabilities.includes('vision'),
        });
      }
    }
    return entries;
  }

  /** Every decision model this user can reach, Ollama first. */
  async listModels(
    userId?: string,
    signal?: AbortSignal
  ): Promise<DecisionModelEntry[]> {
    const entries = await this.ollamaDecisionModels(signal);
    for (const plugin of await this.deps.getActivePlugins(userId)) {
      const capability = getDecisionCapability(plugin);
      if (!capability) continue;
      if (!(await this.pluginIsUsable(plugin, capability, userId))) continue;
      for (const model of await this.pluginModels(
        plugin,
        capability,
        userId,
        signal
      )) {
        entries.push({
          id: model.id,
          providerType: 'plugin',
          providerId: plugin.id,
          providerName: plugin.name,
          images: model.images,
        });
      }
    }
    return entries;
  }

  /**
   * The decision target for a chat model selection, or null when the
   * selection is not a decision model. A plugin selection names its plugin;
   * an Ollama or unbound one is asked of Ollama first.
   */
  async resolveTarget(
    model: string,
    selection: ChatProviderSelection | undefined,
    userId?: string,
    signal?: AbortSignal
  ): Promise<DecisionTarget | null> {
    if (!model || selection?.providerType === 'agent') return null;
    if (model.startsWith('persona:')) return null;

    if (selection?.providerType === 'plugin') {
      if (!selection.providerId) return null;
      const plugin = (await this.deps.getActivePlugins(userId)).find(
        candidate => candidate.id === selection.providerId
      );
      const capability = plugin ? getDecisionCapability(plugin) : undefined;
      if (!plugin || !capability) return null;
      const models = await this.pluginModels(
        plugin,
        capability,
        userId,
        signal
      );
      return models.some(entry => entry.id === model)
        ? { providerType: 'plugin', model, plugin, capability }
        : null;
    }

    if (this.deps.ollama.isEnabled()) {
      try {
        const capabilities = await this.deps.ollama.getCapabilities(
          model,
          signal
        );
        if (capabilities?.includes('decision')) {
          return { providerType: 'ollama', model };
        }
      } catch (error) {
        if (signal?.aborted || isProviderRequestCancelled(error)) throw error;
      }
    }
    if (selection?.providerType === 'ollama') return null;

    // Unbound legacy selections: a plugin that lists the model statically.
    for (const plugin of await this.deps.getActivePlugins(userId)) {
      const capability = getDecisionCapability(plugin);
      if (capability?.model_map.includes(model)) {
        return { providerType: 'plugin', model, plugin, capability };
      }
    }
    return null;
  }

  async assertAccess(userId: string): Promise<void> {
    if (!(await this.deps.canUse(userId))) {
      throw new DecisionAccessError();
    }
  }

  /** One decision, after access, target, and input checks. */
  async decide(
    userId: string,
    request: {
      model: string;
      providerType?: 'ollama' | 'plugin';
      providerId?: string;
      input: DecisionInput;
    },
    signal?: AbortSignal
  ): Promise<DecisionOutcome> {
    await this.assertAccess(userId);
    validatePluginModel(request.model);
    const target = await this.resolveTarget(
      request.model,
      request.providerType
        ? ({
            providerType: request.providerType,
            ...(request.providerId ? { providerId: request.providerId } : {}),
          } as ChatProviderSelection)
        : undefined,
      userId,
      signal
    );
    if (!target) {
      throw new DecisionModelNotFoundError(request.model);
    }
    return this.execute(target, request.input, userId, signal);
  }

  async execute(
    target: DecisionTarget,
    input: DecisionInput,
    userId: string,
    signal?: AbortSignal
  ): Promise<DecisionOutcome> {
    const startedAt = this.now();

    if (target.providerType === 'ollama') {
      const body = buildDecisionRequestBody(
        'systemone',
        'images',
        target.model,
        input
      );
      let data: unknown;
      try {
        data = await this.deps.ollama.systemOne(body, signal);
      } catch (error) {
        throw toProviderError(error, signal);
      }
      const result = parseDecisionResponse(
        'systemone',
        data,
        input.questions,
        target.model
      );
      return {
        ...result,
        provider: { type: 'ollama', name: 'Ollama' },
        durationMs: this.now() - startedAt,
      };
    }

    const { plugin, capability } = target;
    const api: DecisionApi = capability.config?.api ?? 'systemone';
    const variables = await this.deps.getPluginVariables(plugin, userId);
    const endpoint = resolveDecisionEndpoint(plugin, capability, variables);
    const apiKey = await this.deps.getApiKey(plugin, userId);
    if (
      !apiKey &&
      capability.config?.no_auth_required !== true &&
      pluginRequiresApiKey(plugin)
    ) {
      throw new DecisionValidationError(
        `Save an API key for ${plugin.name} in Settings to use its decision models.`
      );
    }
    const body = buildDecisionRequestBody(
      api,
      pluginImageInput(capability),
      capability.config?.model_aliases?.[target.model] ?? target.model,
      input
    );
    const record = (
      status: PluginUsageEventInput['status'],
      result?: DecisionResult
    ) => {
      const usage = result?.usage;
      void this.deps.recordUsage?.({
        userId,
        pluginId: plugin.id,
        pluginName: plugin.name,
        // Decision calls are model calls; they are metered with chat so
        // provider budgets and the usage page count them.
        capability: 'chat',
        model: target.model,
        status,
        durationMs: this.now() - startedAt,
        inputUnits: Object.keys(input.questions).length,
        unitKind: 'inputs',
        ...(usage?.inputTokens !== undefined ||
        usage?.outputTokens !== undefined
          ? {
              tokens: {
                promptTokens: usage.inputTokens ?? 0,
                completionTokens: usage.outputTokens ?? 0,
                totalTokens:
                  (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
              },
            }
          : {}),
      });
    };

    let data: unknown;
    try {
      const response = await this.deps.request({
        url: endpoint,
        method: 'POST',
        headers: buildPluginAuthHeaders(plugin, apiKey, endpoint),
        json: body,
        timeoutMs: DECISION_TIMEOUT_MS,
        signal,
      });
      data = response.data;
    } catch (error) {
      const cancelled = signal?.aborted || isProviderRequestCancelled(error);
      record(cancelled ? 'cancelled' : 'error');
      throw toProviderError(error, signal);
    }
    let result: DecisionResult;
    try {
      result = parseDecisionResponse(api, data, input.questions, target.model);
    } catch (error) {
      record('error');
      throw error;
    }
    record('success', result);
    return {
      ...result,
      provider: { type: 'plugin', id: plugin.id, name: plugin.name },
      durationMs: this.now() - startedAt,
    };
  }

  /**
   * One chat turn with a decision model, in the stream shape every chat
   * path already consumes: the answers as text, the token counts, and the
   * structured result on the reply's provider metadata for the chat to draw.
   */
  async *streamChatTurn(
    target: DecisionTarget,
    messages: readonly ChatMessage[],
    userId: string,
    options: { questions?: DecisionQuestions; signal?: AbortSignal } = {}
  ): AsyncGenerator<PluginStreamChunk, void, unknown> {
    await this.assertAccess(userId);
    const turn = resolveDecisionChatTurn(messages, options.questions);

    if (turn.kind !== 'decide') {
      const content =
        turn.kind === 'state'
          ? 'Saved as the state. Ask yes/no questions about it, one per line, or set questions for this chat.'
          : 'Cleared. Your next message is the new state.';
      yield { type: 'content', content };
      yield {
        type: 'done',
        providerMetadata: { decision: { kind: turn.kind } },
      };
      return;
    }

    const outcome = await this.execute(
      target,
      turn.input,
      userId,
      options.signal
    );
    yield {
      type: 'content',
      content: renderDecisionMarkdown(turn.input.questions, outcome),
    };
    yield {
      type: 'usage',
      usage: {
        ...(outcome.usage.inputTokens !== undefined
          ? { promptTokens: outcome.usage.inputTokens }
          : {}),
        ...(outcome.usage.outputTokens !== undefined
          ? { completionTokens: outcome.usage.outputTokens }
          : {}),
      },
      timings: { promptMs: outcome.durationMs, predictedMs: 0 },
    };
    yield {
      type: 'done',
      providerMetadata: {
        decision: {
          kind: 'answers',
          mode: turn.mode,
          model: outcome.model,
          provider: outcome.provider.name,
          questions: turn.input.questions,
          answers: outcome.answers,
          usage: outcome.usage,
        },
      },
    };
  }
}

export class DecisionAccessError extends Error {
  constructor() {
    super('Decision models are not enabled for your account.');
    this.name = 'DecisionAccessError';
  }
}

export class DecisionModelNotFoundError extends Error {
  constructor(model: string) {
    super(`${model} is not a decision model you can use.`);
    this.name = 'DecisionModelNotFoundError';
  }
}

function toProviderError(error: unknown, signal?: AbortSignal): unknown {
  if (signal?.aborted || isProviderRequestCancelled(error)) return error;
  if (error instanceof ProviderHttpError) {
    const status = error.response.status;
    const message =
      readDecisionProviderError(error.response.data) ??
      `The decision provider answered with status ${status}.`;
    return new DecisionProviderError(message, status);
  }
  if (error instanceof Error) {
    return new DecisionProviderError(error.message);
  }
  return new DecisionProviderError(
    'The decision provider could not be reached.'
  );
}

let defaultService: DecisionService | null = null;

/** The application's decision service, wired to its providers. */
export async function getDecisionService(): Promise<DecisionService> {
  if (defaultService) return defaultService;
  const [
    { default: pluginService },
    { default: ollamaService },
    { providerRequest },
    { default: pluginUsageService },
    { userIdCanUseDecisionModels },
  ] = await Promise.all([
    import('./pluginService.js'),
    import('./ollamaService.js'),
    import('../utils/providerFetch.js'),
    import('./pluginUsageService.js'),
    import('./decisionAccessService.js'),
  ]);
  defaultService = new DecisionService({
    getActivePlugins: userId => pluginService.getActivePlugins(userId),
    getApiKey: (plugin, userId) => pluginService.getApiKey(plugin, userId),
    getPluginVariables: (plugin, userId) =>
      pluginService.getPluginVariables(plugin, userId),
    ollama: {
      isEnabled: () => ollamaService.isEnabled(),
      getModels: () => ollamaService.getModels(),
      getCapabilities: async (model, signal) =>
        (await ollamaService.getModelDefaults(model, signal)).capabilities,
      systemOne: (body, signal) => ollamaService.systemOne(body, signal),
    },
    request: options => providerRequest(options),
    canUse: userId => userIdCanUseDecisionModels(userId),
    recordUsage: usage => pluginUsageService.record(usage),
  });
  return defaultService;
}

/** Whether a chat's model selection is a decision model, for chat routing. */
export async function isDecisionChatModel(
  model: string,
  selection: ChatProviderSelection | undefined,
  userId: string,
  signal?: AbortSignal
): Promise<boolean> {
  const service = await getDecisionService();
  return Boolean(await service.resolveTarget(model, selection, userId, signal));
}
