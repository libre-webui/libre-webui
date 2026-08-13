/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import axios from 'axios';
import type { Plugin, STTConfig } from '../types/index.js';
import {
  applyModelEndpointTemplate,
  assertSafePluginEndpoint,
  buildPluginAuthHeaders,
  resolvePluginOperationEndpoint,
  validatePluginModel,
} from '../utils/pluginValidation.js';
import type { PluginUsageEventInput } from './pluginUsageService.js';

type PluginVariables = Record<string, string | number | boolean>;
const MAX_STT_PROVIDER_RESPONSE_BYTES = 1024 * 1024;
const MAX_TRANSCRIPT_CHARACTERS = 200_000;

export interface STTAudioFile {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
  size: number;
}

export interface STTTranscriptionResult {
  text: string;
  language?: string;
  duration?: number;
}

export interface PluginSTTServiceDependencies {
  getAllPlugins(userId?: string): Plugin[];
  getPlugin(id: string, userId?: string): Plugin | null;
  getApiKey(plugin: Plugin, userId?: string): string | null;
  getPluginVariables(plugin: Plugin, userId?: string): PluginVariables;
  validateEndpointUrl(endpoint: string): string;
  recordUsage?(usage: PluginUsageEventInput): void;
}

export class STTProviderResponseError extends Error {
  constructor(
    readonly providerStatus: number,
    message: string
  ) {
    super(message);
    this.name = 'STTProviderResponseError';
  }
}

export class PluginSTTService {
  constructor(private readonly deps: PluginSTTServiceDependencies) {}

  getAvailableModels(userId?: string): Array<{
    model: string;
    plugin: string;
    config?: STTConfig;
  }> {
    return this.deps.getAllPlugins(userId).flatMap(plugin => {
      const capability = sttCapability(plugin);
      if (!plugin.active || !capability) return [];
      const apiKey = this.deps.getApiKey(plugin, userId);
      if (!apiKey && !capability.config?.no_auth_required) return [];
      return capability.model_map.map(model => ({
        model,
        plugin: plugin.id,
        config: capability.config,
      }));
    });
  }

  async transcribe(
    model: string,
    audio: STTAudioFile,
    options: {
      pluginId: string;
      userId: string;
      language?: string;
      prompt?: string;
      signal?: AbortSignal;
    }
  ): Promise<STTTranscriptionResult> {
    validatePluginModel(model);
    const { plugin, endpoint, config, headers } = this.resolve(
      model,
      options.pluginId,
      options.userId
    );
    const startedAt = Date.now();

    try {
      const response =
        config?.request_mode === 'raw'
          ? await axios.post(endpoint, audio.buffer, {
              headers: { ...headers, 'Content-Type': audio.mimetype },
              timeout: 120_000,
              maxRedirects: 0,
              maxContentLength: MAX_STT_PROVIDER_RESPONSE_BYTES,
              signal: options.signal,
            })
          : await this.transcribeMultipart(
              endpoint,
              headers,
              model,
              audio,
              options
            );
      const result = normalizeTranscriptionResponse(response.data);
      this.deps.recordUsage?.({
        userId: options.userId,
        pluginId: plugin.id,
        pluginName: plugin.name,
        capability: 'stt',
        model,
        status: 'success',
        durationMs: Date.now() - startedAt,
        inputUnits: audio.size,
        unitKind: 'bytes',
      });
      return result;
    } catch (error) {
      const cancelled = axios.isCancel(error) || options.signal?.aborted;
      this.deps.recordUsage?.({
        userId: options.userId,
        pluginId: plugin.id,
        pluginName: plugin.name,
        capability: 'stt',
        model,
        status: cancelled ? 'cancelled' : 'error',
        durationMs: Date.now() - startedAt,
        inputUnits: audio.size,
        unitKind: 'bytes',
      });
      if (cancelled) throw new Error('Speech transcription was cancelled');
      if (axios.isAxiosError(error) && error.response) {
        throw new STTProviderResponseError(
          error.response.status,
          providerErrorMessage(error.response.data) ||
            `Speech provider returned HTTP ${error.response.status}`
        );
      }
      throw error instanceof Error
        ? error
        : new Error('Speech transcription failed');
    }
  }

  private resolve(model: string, pluginId: string, userId: string) {
    const plugin = this.deps.getPlugin(pluginId, userId);
    const capability = plugin ? sttCapability(plugin) : undefined;
    if (
      !plugin?.active ||
      !capability ||
      !capability.model_map.includes(model)
    ) {
      throw new Error(`No speech-to-text plugin found for model: ${model}`);
    }

    const apiKey = this.deps.getApiKey(plugin, userId);
    if (!apiKey && !capability.config?.no_auth_required) {
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
      } else if (override !== undefined && override !== '') {
        throw new Error(
          `Speech-to-text endpoint override ${endpointVariable} must be a URL string`
        );
      }
    } else if (plugin.type === 'stt') {
      endpoint = resolvePluginOperationEndpoint(endpoint, variables);
    }
    endpoint = applyModelEndpointTemplate(endpoint, model);
    assertSafePluginEndpoint(endpoint, 'speech-to-text endpoint');

    const headers = buildPluginAuthHeaders(plugin, apiKey, endpoint);
    delete headers['Content-Type'];
    return { plugin, endpoint, config: capability.config, headers };
  }

  private transcribeMultipart(
    endpoint: string,
    headers: Record<string, string>,
    model: string,
    audio: STTAudioFile,
    options: {
      language?: string;
      prompt?: string;
      signal?: AbortSignal;
    }
  ) {
    const form = new FormData();
    const bytes = Uint8Array.from(audio.buffer);
    const blob = new Blob([bytes], { type: audio.mimetype });
    const filename = safeAudioFilename(audio.originalname);
    form.append('file', blob, filename);
    form.append('model', model);
    form.append('response_format', 'json');
    if (options.language) form.append('language', options.language);
    if (options.prompt) form.append('prompt', options.prompt);
    return axios.post(endpoint, form, {
      headers,
      timeout: 120_000,
      maxRedirects: 0,
      maxContentLength: MAX_STT_PROVIDER_RESPONSE_BYTES,
      signal: options.signal,
    });
  }
}

function sttCapability(plugin: Plugin):
  | {
      endpoint: string;
      model_map: string[];
      config?: STTConfig;
    }
  | undefined {
  if (plugin.capabilities?.stt) return plugin.capabilities.stt;
  if (plugin.type === 'stt') {
    return {
      endpoint: plugin.endpoint,
      model_map: plugin.model_map,
    };
  }
  return undefined;
}

function normalizeTranscriptionResponse(data: unknown): STTTranscriptionResult {
  if (typeof data === 'string' && data.trim()) {
    const text = data.trim();
    if (text.length > MAX_TRANSCRIPT_CHARACTERS) {
      throw new Error('Speech provider returned an oversized transcript');
    }
    return { text };
  }
  if (!data || typeof data !== 'object') {
    throw new Error('Speech provider returned an unexpected response');
  }
  const response = data as Record<string, unknown>;
  const text = typeof response.text === 'string' ? response.text.trim() : '';
  if (!text) throw new Error('Speech provider returned an empty transcript');
  if (text.length > MAX_TRANSCRIPT_CHARACTERS) {
    throw new Error('Speech provider returned an oversized transcript');
  }
  return {
    text,
    ...(typeof response.language === 'string'
      ? { language: response.language }
      : {}),
    ...(typeof response.duration === 'number' &&
    Number.isFinite(response.duration)
      ? { duration: response.duration }
      : {}),
  };
}

function providerErrorMessage(data: unknown): string | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const record = data as Record<string, unknown>;
  const nested =
    record.error && typeof record.error === 'object'
      ? (record.error as Record<string, unknown>).message
      : undefined;
  const message = typeof nested === 'string' ? nested : record.message;
  return typeof message === 'string' ? message.slice(0, 500) : undefined;
}

function safeAudioFilename(originalname: string): string {
  const basename = originalname.split(/[\\/]/).pop() || 'recording.webm';
  return basename.replace(/[\r\n"]/g, '_').slice(0, 255) || 'recording.webm';
}
