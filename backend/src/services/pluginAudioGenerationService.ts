/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import type { Readable } from 'node:stream';
import type { AudioGenConfig, Plugin } from '../types/index.js';
import {
  acquireSharedCapacity,
  combineAbortSignals,
  SharedCapacityExceededError,
  type SharedCapacityReservation,
} from '../platform/coordination/sharedAdmission.js';
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
import {
  normalizeProviderTokenUsage,
  type PluginUsageEventInput,
} from './pluginUsageService.js';

const MAX_SSE_LINE_BYTES = 2 * 1024 * 1024;
const MAX_ENCODED_AUDIO_BYTES = 80 * 1024 * 1024;
const MAX_AUDIO_STREAM_BYTES = 120 * 1024 * 1024;
const MAX_ACTIVE_AUDIO_REQUESTS_PER_USER = 2;
const MAX_ACTIVE_AUDIO_REQUESTS_GLOBAL = 6;

type PluginVariables = Record<string, string | number | boolean>;
type MaybePromise<T> = T | Promise<T>;

export interface PluginAudioGenerationServiceDependencies {
  getAllPlugins(userId?: string): MaybePromise<Plugin[]>;
  getPlugin(id: string, userId?: string): MaybePromise<Plugin | null>;
  getApiKey(plugin: Plugin, userId?: string): MaybePromise<string | null>;
  getPluginVariables(
    plugin: Plugin,
    userId?: string
  ): MaybePromise<PluginVariables>;
  validateEndpointUrl(endpoint: string): string;
  recordUsage?(usage: PluginUsageEventInput): void;
}

export interface AudioGenerationResult {
  audio: Buffer;
  mimeType: string;
  transcript?: string;
}

export class AudioGenerationConcurrencyError extends Error {
  constructor() {
    super('Too many concurrent audio provider requests');
    this.name = 'AudioGenerationConcurrencyError';
  }
}

async function reserveAudioProviderRequest(
  userId: string
): Promise<SharedCapacityReservation> {
  try {
    return await acquireSharedCapacity({
      limits: [
        {
          scope: 'provider-audio.global',
          capacity: MAX_ACTIVE_AUDIO_REQUESTS_GLOBAL,
        },
        {
          scope: 'provider-audio.user',
          subject: userId,
          capacity: MAX_ACTIVE_AUDIO_REQUESTS_PER_USER,
        },
      ],
    });
  } catch (error) {
    if (error instanceof SharedCapacityExceededError) {
      throw new AudioGenerationConcurrencyError();
    }
    throw error;
  }
}

export class PluginAudioGenerationService {
  constructor(
    private readonly deps: PluginAudioGenerationServiceDependencies
  ) {}

  async getAvailableModels(userId?: string): Promise<
    Array<{
      model: string;
      plugin: string;
      config?: AudioGenConfig;
    }>
  > {
    const models: Array<{
      model: string;
      plugin: string;
      config?: AudioGenConfig;
    }> = [];
    for (const plugin of await this.deps.getAllPlugins(userId)) {
      const capability = plugin.capabilities?.audio;
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

  async generate(
    model: string,
    prompt: string,
    options: {
      pluginId: string;
      userId: string;
      voice?: string;
      format?: string;
      signal?: AbortSignal;
    }
  ): Promise<AudioGenerationResult> {
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

    const voice = options.voice || config?.default_voice || 'alloy';
    const format = options.format || config?.default_format || 'wav';
    if (config?.formats?.length && !config.formats.includes(format)) {
      throw new Error(`Audio format ${format} is not supported by ${model}`);
    }
    const payload = {
      model,
      messages: [{ role: 'user', content: prompt }],
      modalities: ['text', 'audio'],
      audio: { voice, format },
      stream: true,
    };

    const providerSlot = await reserveAudioProviderRequest(options.userId);
    const providerSignal = combineAbortSignals(
      options.signal,
      providerSlot.signal
    );
    const startedAt = Date.now();
    try {
      const response = await providerRequest<Readable>({
        url: endpoint,
        method: 'POST',
        json: payload,
        headers,
        timeoutMs: 300000,
        responseType: 'stream',
        signal: providerSignal,
      });
      const result = await collectAudioStream(response.data, providerSignal);
      this.deps.recordUsage?.({
        userId: options.userId,
        pluginId: plugin.id,
        pluginName: plugin.name,
        capability: 'audio',
        model,
        status: 'success',
        durationMs: Date.now() - startedAt,
        tokens: result.usage,
        outputUnits: result.audio.length,
        unitKind: 'bytes',
      });
      return {
        audio: result.audio,
        mimeType: audioMimeType(format),
        ...(result.transcript ? { transcript: result.transcript } : {}),
      };
    } catch (error) {
      const cancelled =
        isProviderRequestCancelled(error) || providerSignal.aborted;
      this.deps.recordUsage?.({
        userId: options.userId,
        pluginId: plugin.id,
        pluginName: plugin.name,
        capability: 'audio',
        model,
        status: cancelled ? 'cancelled' : 'error',
        durationMs: Date.now() - startedAt,
      });
      if (cancelled) {
        throw providerSignal.reason instanceof Error
          ? providerSignal.reason
          : new Error('Audio provider request was cancelled');
      }
      throw audioGenerationError(error);
    } finally {
      await providerSlot.release();
    }
  }

  private async resolve(model: string, pluginId: string, userId: string) {
    const plugin = await this.deps.getPlugin(pluginId, userId);
    const capability = plugin?.capabilities?.audio;
    if (
      !plugin?.active ||
      !capability ||
      !capability.model_map.includes(model)
    ) {
      throw new Error(`No audio generation plugin found for model: ${model}`);
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
    } else if (plugin.type === 'audio') {
      endpoint = resolvePluginOperationEndpoint(endpoint, variables);
    }
    assertSafePluginEndpoint(endpoint, 'audio generation endpoint');
    return {
      plugin,
      endpoint,
      config: capability.config,
      headers: buildPluginAuthHeaders(plugin, apiKey, endpoint),
    };
  }
}

async function collectAudioStream(
  stream: AsyncIterable<Buffer | Uint8Array | string>,
  signal?: AbortSignal
): Promise<{
  audio: Buffer;
  transcript?: string;
  usage?: ReturnType<typeof normalizeProviderTokenUsage>;
}> {
  let pending = '';
  let encodedAudio = '';
  let transcript = '';
  let receivedBytes = 0;
  let usage: ReturnType<typeof normalizeProviderTokenUsage>;

  const consumeLine = (rawLine: string) => {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trimStart();
    if (!data || data === '[DONE]') return;
    let chunk: Record<string, unknown>;
    try {
      chunk = JSON.parse(data) as Record<string, unknown>;
    } catch {
      throw new Error('Audio provider returned malformed streaming data');
    }
    const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
    const first = asRecord(choices[0]);
    const delta = asRecord(first?.delta);
    const audio = asRecord(delta?.audio);
    if (typeof audio?.data === 'string' && audio.data.length > 0) {
      if (!/^[a-z0-9+/]*={0,2}$/i.test(audio.data)) {
        throw new Error('Audio provider returned invalid base64 data');
      }
      encodedAudio += audio.data;
      if (encodedAudio.length > MAX_ENCODED_AUDIO_BYTES) {
        throw new Error('Audio provider response exceeded the size limit');
      }
    }
    if (typeof audio?.transcript === 'string') transcript += audio.transcript;
    usage = normalizeProviderTokenUsage(chunk) || usage;
  };

  for await (const part of stream) {
    if (signal?.aborted) {
      throw signal.reason instanceof Error
        ? signal.reason
        : new Error('Audio provider request was cancelled');
    }
    const text = Buffer.isBuffer(part)
      ? part.toString('utf8')
      : part instanceof Uint8Array
        ? Buffer.from(part).toString('utf8')
        : String(part);
    receivedBytes += Buffer.byteLength(text);
    if (receivedBytes > MAX_AUDIO_STREAM_BYTES) {
      throw new Error('Audio provider response exceeded the size limit');
    }
    pending += text;
    if (pending.length > MAX_SSE_LINE_BYTES && !pending.includes('\n')) {
      throw new Error('Audio provider returned an oversized stream event');
    }
    let newline = pending.indexOf('\n');
    while (newline >= 0) {
      consumeLine(pending.slice(0, newline));
      pending = pending.slice(newline + 1);
      newline = pending.indexOf('\n');
    }
  }
  if (pending) consumeLine(pending);
  if (!encodedAudio) {
    throw new Error('Audio provider returned no audio data');
  }
  const audio = Buffer.from(encodedAudio, 'base64');
  if (audio.length === 0) {
    throw new Error('Audio provider returned empty audio data');
  }
  return {
    audio,
    ...(transcript ? { transcript } : {}),
    ...(usage ? { usage } : {}),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : null;
}

function audioMimeType(format: string): string {
  return (
    (
      {
        aac: 'audio/aac',
        flac: 'audio/flac',
        mp3: 'audio/mpeg',
        opus: 'audio/opus',
        pcm: 'audio/L16',
        pcm16: 'audio/L16',
        wav: 'audio/wav',
      } as Record<string, string>
    )[format] || 'audio/wav'
  );
}

function audioGenerationError(error: unknown): Error {
  if (
    error instanceof ProviderHttpError ||
    error instanceof ProviderTimeoutError ||
    error instanceof ProviderNetworkError ||
    error instanceof ProviderResponseTooLargeError
  ) {
    const data = isProviderHttpError(error) ? error.response.data : undefined;
    const record =
      data && typeof data === 'object'
        ? (data as {
            error?: { message?: unknown } | string;
            message?: unknown;
          })
        : undefined;
    const nested =
      record?.error && typeof record.error === 'object'
        ? record.error.message
        : undefined;
    const message = nested || record?.error || record?.message || error.message;
    return new Error(`Audio provider request failed: ${String(message)}`);
  }
  return error instanceof Error ? error : new Error('Audio generation failed');
}
