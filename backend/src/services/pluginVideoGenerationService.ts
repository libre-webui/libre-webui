/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import axios from 'axios';
import type { Plugin, VideoGenConfig } from '../types/index.js';
import {
  assertSafePluginEndpoint,
  buildPluginAuthHeaders,
  resolvePluginOperationEndpoint,
  validatePluginModel,
} from '../utils/pluginValidation.js';
import type { PluginUsageEventInput } from './pluginUsageService.js';

type PluginVariables = Record<string, string | number | boolean>;

export interface VideoGenerationJobStatus {
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  error?: string;
  usage?: Record<string, unknown>;
}

export interface PluginVideoGenerationServiceDependencies {
  getAllPlugins(userId?: string): Plugin[];
  getPlugin(id: string, userId?: string): Plugin | null;
  getApiKey(plugin: Plugin, userId?: string): string | null;
  getPluginVariables(plugin: Plugin, userId?: string): PluginVariables;
  validateEndpointUrl(endpoint: string): string;
  recordUsage?(usage: PluginUsageEventInput): void;
}

export class PluginVideoGenerationService {
  constructor(
    private readonly deps: PluginVideoGenerationServiceDependencies
  ) {}

  getAvailableModels(userId?: string): Array<{
    model: string;
    plugin: string;
    config?: VideoGenConfig;
  }> {
    return this.deps.getAllPlugins(userId).flatMap(plugin => {
      const capability = plugin.capabilities?.video;
      if (
        !plugin.active ||
        !capability ||
        !this.deps.getApiKey(plugin, userId)
      ) {
        return [];
      }
      return capability.model_map.map(model => ({
        model,
        plugin: plugin.id,
        config: capability.config,
      }));
    });
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
    }
  ): Promise<{ providerJobId: string; status: string }> {
    validatePluginModel(model);
    const { plugin, endpoint, config, headers } = this.resolve(
      model,
      options.pluginId,
      options.userId
    );
    if (config?.max_prompt_length && prompt.length > config.max_prompt_length) {
      throw new Error(
        `Prompt exceeds maximum length of ${config.max_prompt_length} characters`
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
      const response = await axios.post(endpoint, payload, {
        headers,
        timeout: 30000,
        maxRedirects: 0,
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
      this.recordError(plugin, model, options.userId, startedAt);
      throw toVideoError(error);
    }
  }

  async poll(
    model: string,
    providerJobId: string,
    pluginId: string,
    userId: string
  ): Promise<VideoGenerationJobStatus> {
    const { endpoint, headers } = this.resolve(model, pluginId, userId);
    const statusEndpoint = `${endpoint.replace(/\/+$/, '')}/${encodeURIComponent(
      providerJobId
    )}`;
    assertSafePluginEndpoint(statusEndpoint, 'video status endpoint');
    try {
      const response = await axios.get(statusEndpoint, {
        headers,
        timeout: 15000,
        maxRedirects: 0,
      });
      const status = response.data?.status;
      if (!['pending', 'in_progress', 'completed', 'failed'].includes(status)) {
        throw new Error('Video provider returned an invalid job status');
      }
      return {
        status,
        ...(typeof response.data?.error === 'string'
          ? { error: response.data.error }
          : {}),
        ...(response.data?.usage && typeof response.data.usage === 'object'
          ? { usage: response.data.usage }
          : {}),
      };
    } catch (error) {
      throw toVideoError(error);
    }
  }

  async download(
    model: string,
    providerJobId: string,
    pluginId: string,
    userId: string
  ): Promise<{ video: Buffer; mimeType: string }> {
    const { endpoint, headers } = this.resolve(model, pluginId, userId);
    const contentEndpoint = `${endpoint.replace(
      /\/+$/,
      ''
    )}/${encodeURIComponent(providerJobId)}/content?index=0`;
    assertSafePluginEndpoint(contentEndpoint, 'video content endpoint');
    try {
      const response = await axios.get(contentEndpoint, {
        headers,
        timeout: 120000,
        responseType: 'arraybuffer',
        maxRedirects: 0,
        maxContentLength: 200 * 1024 * 1024,
      });
      const mimeType = String(response.headers['content-type'] || 'video/mp4')
        .split(';')[0]
        .trim();
      if (!mimeType.startsWith('video/')) {
        throw new Error('Video provider returned non-video content');
      }
      return { video: Buffer.from(response.data), mimeType };
    } catch (error) {
      throw toVideoError(error);
    }
  }

  private resolve(model: string, pluginId: string, userId: string) {
    const plugin = this.deps.getPlugin(pluginId, userId);
    const capability = plugin?.capabilities?.video;
    if (
      !plugin?.active ||
      !capability ||
      !capability.model_map.includes(model)
    ) {
      throw new Error(`No video generation plugin found for model: ${model}`);
    }
    const apiKey = this.deps.getApiKey(plugin, userId);
    if (!apiKey) {
      throw new Error(
        `API key not found for plugin ${plugin.id} (save a provider credential in Settings)`
      );
    }
    const variables = this.deps.getPluginVariables(plugin, userId);
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
    startedAt: number
  ) {
    this.deps.recordUsage?.({
      userId,
      pluginId: plugin.id,
      pluginName: plugin.name,
      capability: 'video',
      model,
      status: 'error',
      durationMs: Date.now() - startedAt,
      outputUnits: 0,
      unitKind: 'jobs',
    });
  }
}

function toVideoError(error: unknown): Error {
  if (axios.isAxiosError(error)) {
    const data = error.response?.data;
    let message = error.message;
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
      message = data.error?.message || data.error || data.message || message;
    }
    return new Error(`Video generation failed: ${message}`);
  }
  return error instanceof Error ? error : new Error('Video generation failed');
}
