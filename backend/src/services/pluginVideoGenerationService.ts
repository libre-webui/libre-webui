/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import type { Plugin, VideoGenConfig } from '../types/index.js';
import {
  assertSafePluginEndpoint,
  buildPluginAuthHeaders,
  resolvePluginOperationEndpoint,
  validatePluginModel,
} from '../utils/pluginValidation.js';
import {
  isProviderHttpError,
  isProviderRequestCancelled,
  ProviderHttpError,
  ProviderNetworkError,
  ProviderResponseTooLargeError,
  ProviderTimeoutError,
  providerRequest,
} from '../utils/providerFetch.js';
import type { PluginUsageEventInput } from './pluginUsageService.js';

type PluginVariables = Record<string, string | number | boolean>;

export interface VideoGenerationJobStatus {
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  error?: string;
  usage?: Record<string, unknown>;
}

export interface PluginVideoGenerationServiceDependencies {
  getAllPlugins(userId?: string): Plugin[] | Promise<Plugin[]>;
  getPlugin(
    id: string,
    userId?: string
  ): Plugin | null | Promise<Plugin | null>;
  getApiKey(
    plugin: Plugin,
    userId?: string
  ): string | null | Promise<string | null>;
  getPluginVariables(
    plugin: Plugin,
    userId?: string
  ): PluginVariables | Promise<PluginVariables>;
  validateEndpointUrl(endpoint: string): string;
  recordUsage?(usage: PluginUsageEventInput): void;
}

export class PluginVideoGenerationService {
  constructor(
    private readonly deps: PluginVideoGenerationServiceDependencies
  ) {}

  async getAvailableModels(userId?: string): Promise<
    Array<{
      model: string;
      plugin: string;
      config?: VideoGenConfig;
    }>
  > {
    const models: Array<{
      model: string;
      plugin: string;
      config?: VideoGenConfig;
    }> = [];
    for (const plugin of await this.deps.getAllPlugins(userId)) {
      const capability = plugin.capabilities?.video;
      if (
        !plugin.active ||
        !capability ||
        !(await this.deps.getApiKey(plugin, userId))
      ) {
        continue;
      }
      models.push(
        ...capability.model_map.map(model => ({
          model,
          plugin: plugin.id,
          config: capability.config,
        }))
      );
    }
    return models;
  }

  async submit(
    model: string,
    prompt: string,
    options: {
      pluginId: string;
      userId: string;
      duration?: number;
      resolution?: string;
      aspectRatio?: string;
      generateAudio?: boolean;
      /** Stable caller key used to reconcile an accepted provider job. */
      idempotencyKey?: string;
      /** Shared-worker mode must not call a provider without this guarantee. */
      requireIdempotency?: boolean;
      /** Cancels only this HTTP submission transport, not a provider job that was already accepted. */
      signal?: AbortSignal;
    }
  ): Promise<{ providerJobId: string; status: string }> {
    validatePluginModel(model);
    const { plugin, endpoint, config, headers } = await this.resolve(
      model,
      options.pluginId,
      options.userId
    );
    if (config?.max_prompt_length && prompt.length > config.max_prompt_length) {
      throw new Error(
        `Prompt exceeds maximum length of ${config.max_prompt_length} characters`
      );
    }
    if (options.requireIdempotency && config?.supports_idempotency !== true) {
      throw new Error(
        'The selected video provider does not declare idempotent submission support'
      );
    }

    const payload: Record<string, unknown> = { model, prompt };
    const duration = options.duration ?? config?.default_duration;
    const resolution = options.resolution ?? config?.default_resolution;
    const aspectRatio = options.aspectRatio ?? config?.default_aspect_ratio;
    const generateAudio =
      options.generateAudio ?? config?.default_generate_audio;
    if (duration !== undefined) payload.duration = duration;
    if (resolution) payload.resolution = resolution;
    if (aspectRatio) payload.aspect_ratio = aspectRatio;
    if (generateAudio !== undefined) payload.generate_audio = generateAudio;

    const startedAt = Date.now();
    try {
      const response = await providerRequest<{
        id?: unknown;
        status?: VideoGenerationJobStatus['status'];
      }>({
        url: endpoint,
        method: 'POST',
        json: payload,
        headers: options.idempotencyKey
          ? { ...headers, 'Idempotency-Key': options.idempotencyKey }
          : headers,
        timeoutMs: 30000,
        signal: options.signal,
      });
      const providerJobId = response.data?.id;
      if (typeof providerJobId !== 'string' || providerJobId.length === 0) {
        throw new Error('Video provider returned no job ID');
      }
      this.deps.recordUsage?.({
        userId: options.userId,
        pluginId: plugin.id,
        pluginName: plugin.name,
        capability: 'video',
        model,
        status: 'success',
        durationMs: Date.now() - startedAt,
        outputUnits: 0,
        unitKind: 'jobs',
      });
      return { providerJobId, status: response.data?.status || 'pending' };
    } catch (error) {
      const cancelled =
        isProviderRequestCancelled(error) || options.signal?.aborted;
      this.recordError(
        plugin,
        model,
        options.userId,
        startedAt,
        cancelled ? 'cancelled' : 'error'
      );
      if (cancelled)
        throw cancellationReason(options.signal, 'Video submission');
      throw toVideoError(error);
    }
  }

  async poll(
    model: string,
    providerJobId: string,
    pluginId: string,
    userId: string,
    signal?: AbortSignal
  ): Promise<VideoGenerationJobStatus> {
    const { endpoint, headers } = await this.resolve(model, pluginId, userId);
    const statusEndpoint = `${endpoint.replace(/\/+$/, '')}/${encodeURIComponent(
      providerJobId
    )}`;
    assertSafePluginEndpoint(statusEndpoint, 'video status endpoint');
    try {
      const response = await providerRequest<{
        status?: VideoGenerationJobStatus['status'];
        error?: unknown;
        usage?: unknown;
      }>({
        url: statusEndpoint,
        headers,
        timeoutMs: 15000,
        signal,
      });
      const status = response.data?.status;
      if (
        !status ||
        !['pending', 'in_progress', 'completed', 'failed'].includes(status)
      ) {
        throw new Error('Video provider returned an invalid job status');
      }
      return {
        status,
        ...(typeof response.data?.error === 'string'
          ? { error: response.data.error }
          : {}),
        ...(response.data?.usage && typeof response.data.usage === 'object'
          ? { usage: response.data.usage as Record<string, unknown> }
          : {}),
      };
    } catch (error) {
      if (isProviderRequestCancelled(error) || signal?.aborted) {
        throw cancellationReason(signal, 'Video status request');
      }
      throw toVideoError(error);
    }
  }

  async download(
    model: string,
    providerJobId: string,
    pluginId: string,
    userId: string,
    signal?: AbortSignal
  ): Promise<{ video: Buffer; mimeType: string }> {
    const { endpoint, headers } = await this.resolve(model, pluginId, userId);
    const contentEndpoint = `${endpoint.replace(
      /\/+$/,
      ''
    )}/${encodeURIComponent(providerJobId)}/content?index=0`;
    assertSafePluginEndpoint(contentEndpoint, 'video content endpoint');
    try {
      const response = await providerRequest<Buffer>({
        url: contentEndpoint,
        headers,
        timeoutMs: 120000,
        responseType: 'bytes',
        maxResponseBytes: 200 * 1024 * 1024,
        signal,
      });
      const mimeType = String(response.headers['content-type'] || 'video/mp4')
        .split(';')[0]
        .trim();
      if (!mimeType.startsWith('video/')) {
        throw new Error('Video provider returned non-video content');
      }
      return { video: Buffer.from(response.data), mimeType };
    } catch (error) {
      if (isProviderRequestCancelled(error) || signal?.aborted) {
        throw cancellationReason(signal, 'Video download');
      }
      throw toVideoError(error);
    }
  }

  async supportsCancellation(
    model: string,
    pluginId: string,
    userId: string
  ): Promise<boolean> {
    try {
      const { endpoint, config } = await this.resolve(model, pluginId, userId);
      const configuredEndpoint = config?.cancel_endpoint;
      const method = config?.cancel_method || 'POST';
      if (
        typeof configuredEndpoint !== 'string' ||
        !configuredEndpoint.includes('{job_id}') ||
        (method !== 'POST' && method !== 'DELETE')
      ) {
        return false;
      }
      const candidate = resolveRelativeOperationEndpoint(
        endpoint,
        configuredEndpoint.replace('{job_id}', 'job-id')
      );
      assertSafePluginEndpoint(candidate, 'video cancellation endpoint');
      return true;
    } catch {
      return false;
    }
  }

  async cancel(
    model: string,
    providerJobId: string,
    pluginId: string,
    userId: string,
    signal?: AbortSignal
  ): Promise<void> {
    const { endpoint, headers, config } = await this.resolve(
      model,
      pluginId,
      userId
    );
    const configuredEndpoint = config?.cancel_endpoint;
    if (typeof configuredEndpoint !== 'string' || !configuredEndpoint) {
      throw new VideoCancellationUnsupportedError();
    }
    const expandedEndpoint = configuredEndpoint.replace(
      /\{job_id\}/g,
      encodeURIComponent(providerJobId)
    );
    if (!configuredEndpoint.includes('{job_id}')) {
      throw new Error('Video cancel endpoint must contain {job_id}');
    }
    const cancelEndpoint = resolveRelativeOperationEndpoint(
      endpoint,
      expandedEndpoint
    );
    assertSafePluginEndpoint(cancelEndpoint, 'video cancellation endpoint');
    const method = config.cancel_method || 'POST';
    if (method !== 'POST' && method !== 'DELETE') {
      throw new Error('Video cancel method must be POST or DELETE');
    }
    try {
      await providerRequest({
        url: cancelEndpoint,
        method,
        headers,
        timeoutMs: 15000,
        signal,
      });
    } catch (error) {
      if (isProviderRequestCancelled(error) || signal?.aborted) {
        throw cancellationReason(signal, 'Video cancellation request');
      }
      throw toVideoError(error);
    }
  }

  private async resolve(model: string, pluginId: string, userId: string) {
    const plugin = await this.deps.getPlugin(pluginId, userId);
    const capability = plugin?.capabilities?.video;
    if (
      !plugin?.active ||
      !capability ||
      !capability.model_map.includes(model)
    ) {
      throw new Error(`No video generation plugin found for model: ${model}`);
    }
    const apiKey = await this.deps.getApiKey(plugin, userId);
    if (!apiKey) {
      throw new Error(
        `API key not found for plugin ${plugin.id} (save a provider credential in Settings)`
      );
    }
    const variables = await this.deps.getPluginVariables(plugin, userId);
    let endpoint = capability.endpoint;
    const endpointVariable = capability.config?.endpoint_variable;
    if (endpointVariable) {
      const override = variables[endpointVariable];
      if (typeof override === 'string' && override.trim()) {
        endpoint = this.deps.validateEndpointUrl(override.trim());
      }
    } else if (plugin.type === 'video') {
      endpoint = resolvePluginOperationEndpoint(endpoint, variables);
    }
    assertSafePluginEndpoint(endpoint, 'video generation endpoint');
    return {
      plugin,
      endpoint,
      config: capability.config,
      headers: buildPluginAuthHeaders(plugin, apiKey, endpoint),
    };
  }

  private recordError(
    plugin: Plugin,
    model: string,
    userId: string,
    startedAt: number,
    status: 'error' | 'cancelled'
  ) {
    this.deps.recordUsage?.({
      userId,
      pluginId: plugin.id,
      pluginName: plugin.name,
      capability: 'video',
      model,
      status,
      durationMs: Date.now() - startedAt,
      outputUnits: 0,
      unitKind: 'jobs',
    });
  }
}

export class VideoCancellationUnsupportedError extends Error {
  constructor() {
    super('The selected video provider does not declare job cancellation');
    this.name = 'VideoCancellationUnsupportedError';
  }
}

function resolveRelativeOperationEndpoint(
  generationEndpoint: string,
  configuredEndpoint: string
): string {
  try {
    return new URL(configuredEndpoint).toString();
  } catch {
    const generationUrl = new URL(generationEndpoint);
    if (configuredEndpoint.startsWith('/')) {
      return new URL(configuredEndpoint, generationUrl.origin).toString();
    }
    const base = generationEndpoint.endsWith('/')
      ? generationEndpoint
      : `${generationEndpoint}/`;
    return new URL(configuredEndpoint, base).toString();
  }
}

function cancellationReason(
  signal: AbortSignal | undefined,
  operation: string
) {
  return signal?.reason instanceof Error
    ? signal.reason
    : new Error(`${operation} was cancelled`);
}

function toVideoError(error: unknown): Error {
  if (
    error instanceof ProviderHttpError ||
    error instanceof ProviderTimeoutError ||
    error instanceof ProviderNetworkError ||
    error instanceof ProviderResponseTooLargeError
  ) {
    const data = isProviderHttpError(error) ? error.response.data : undefined;
    let message: unknown = error.message;
    if (Buffer.isBuffer(data) || data instanceof ArrayBuffer) {
      const bytes = Buffer.isBuffer(data)
        ? data
        : Buffer.from(new Uint8Array(data));
      try {
        const parsed = JSON.parse(bytes.toString('utf8'));
        message =
          parsed.error?.message || parsed.error || parsed.message || message;
      } catch {
        message = bytes.toString('utf8').slice(0, 200) || message;
      }
    } else if (data && typeof data === 'object') {
      const record = data as {
        error?: { message?: unknown } | string;
        message?: unknown;
      };
      const nested =
        record.error && typeof record.error === 'object'
          ? record.error.message
          : undefined;
      message = nested || record.error || record.message || message;
    }
    return new Error(`Video generation failed: ${String(message)}`);
  }
  return error instanceof Error ? error : new Error('Video generation failed');
}
