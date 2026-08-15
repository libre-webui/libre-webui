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

import axios from 'axios';
import { Plugin, TTSConfig } from '../types/index.js';
import {
  acquireSharedCapacity,
  combineAbortSignals,
  SharedCapacityExceededError,
  type SharedCapacityReservation,
} from '../platform/coordination/sharedAdmission.js';
import { createLogger } from '../utils/logger.js';
import {
  assertSafePluginEndpoint,
  applyModelEndpointTemplate,
  buildPluginAttributionHeaders,
  resolvePluginOperationEndpoint,
  validatePluginModel,
} from '../utils/pluginValidation.js';
import {
  validateTTSVoiceCloneAudio,
  type TTSVoiceCloneAudioFile,
} from '../utils/ttsVoiceCloneUpload.js';
import type { PluginUsageEventInput } from './pluginUsageService.js';

const logger = createLogger('plugin-tts');

type PluginVariables = Record<string, string | number | boolean>;

export const TTS_MAX_PROVIDER_RESPONSE_BYTES = 50 * 1024 * 1024;
const MAX_ACTIVE_TTS_REQUESTS_PER_USER = 6;
const MAX_ACTIVE_TTS_REQUESTS_GLOBAL = 16;

export class TTSConcurrencyError extends Error {
  constructor() {
    super('Too many concurrent TTS provider requests');
    this.name = 'TTSConcurrencyError';
  }
}

async function reserveTTSProviderRequest(
  userId?: string
): Promise<SharedCapacityReservation> {
  const owner = userId?.trim() || 'authenticated-user';
  try {
    return await acquireSharedCapacity({
      limits: [
        {
          scope: 'provider-tts.global',
          capacity: MAX_ACTIVE_TTS_REQUESTS_GLOBAL,
        },
        {
          scope: 'provider-tts.user',
          subject: owner,
          capacity: MAX_ACTIVE_TTS_REQUESTS_PER_USER,
        },
      ],
    });
  } catch (error) {
    if (error instanceof SharedCapacityExceededError) {
      throw new TTSConcurrencyError();
    }
    throw error;
  }
}

function cancellationReason(signal: AbortSignal | undefined, fallback: string) {
  return signal?.reason instanceof Error && signal.reason.name !== 'AbortError'
    ? signal.reason
    : new Error(fallback);
}

const TTS_STANDARD_REQUEST_FIELDS = new Set([
  'model',
  'model_id',
  'input',
  'text',
  'voice',
  'voice_settings',
  'response_format',
  'speed',
  'reference_audio',
  'reference_text',
]);

function getForwardedTTSVariables(
  config: TTSConfig | undefined,
  variables: PluginVariables
): Record<string, string | number | boolean> {
  const forwarded: Record<string, string | number | boolean> = {};
  for (const name of config?.request_variables || []) {
    if (
      typeof name !== 'string' ||
      name.length === 0 ||
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ||
      TTS_STANDARD_REQUEST_FIELDS.has(name) ||
      name === '__proto__' ||
      name === 'constructor' ||
      name === 'prototype'
    ) {
      continue;
    }
    const value = variables[name];
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      forwarded[name] = value;
    }
  }
  return forwarded;
}

function describeTTSRequestFailure(error: unknown):
  | string
  | {
      message: string;
      code?: string;
      status?: number;
    } {
  if (!axios.isAxiosError(error)) {
    return error instanceof Error ? error.message : 'Unknown TTS error';
  }

  return {
    message: error.message,
    ...(typeof error.code === 'string' ? { code: error.code } : {}),
    ...(typeof error.response?.status === 'number'
      ? { status: error.response.status }
      : {}),
  };
}

export interface PluginTTSServiceDependencies {
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

export interface VoiceCloneRequestOptions {
  referenceText?: string;
  response_format?: 'mp3' | 'opus' | 'aac' | 'flac' | 'wav' | 'pcm';
  pluginId?: string;
  userId?: string;
  signal?: AbortSignal;
}

export class TTSProviderResponseError extends Error {
  constructor(
    readonly providerStatus: number,
    message: string
  ) {
    super(message);
    this.name = 'TTSProviderResponseError';
  }
}

export class PluginTTSService {
  constructor(private readonly deps: PluginTTSServiceDependencies) {}

  async getPluginForTTS(
    model: string,
    pluginId?: string,
    userId?: string
  ): Promise<Plugin | null> {
    const allPlugins = await this.deps.getAllPlugins(userId);

    for (const plugin of allPlugins) {
      if (!plugin.active) {
        continue;
      }
      if (pluginId && plugin.id !== pluginId) {
        continue;
      }

      if (plugin.capabilities?.tts) {
        const ttsCapability = plugin.capabilities.tts;
        if (ttsCapability.model_map.includes(model)) {
          const noAuthRequired =
            (ttsCapability.config as Record<string, unknown> | undefined)
              ?.no_auth_required === true;

          const apiKey = await this.deps.getApiKey(plugin, userId);
          if (!apiKey && !noAuthRequired) {
            continue;
          }

          return plugin;
        }
      } else if (plugin.type === 'tts' && plugin.model_map.includes(model)) {
        const noAuthRequired =
          (
            plugin.capabilities?.tts?.config as
              Record<string, unknown> | undefined
          )?.no_auth_required === true;

        const apiKey = await this.deps.getApiKey(plugin, userId);
        if (!apiKey && !noAuthRequired) {
          continue;
        }

        return plugin;
      }
    }

    return null;
  }

  async getAvailableTTSModels(userId?: string): Promise<
    {
      model: string;
      plugin: string;
      config?: TTSConfig;
    }[]
  > {
    const models: { model: string; plugin: string; config?: TTSConfig }[] = [];
    const allPlugins = await this.deps.getAllPlugins(userId);

    for (const plugin of allPlugins) {
      if (!plugin.active) {
        continue;
      }
      const ttsCapability = plugin.capabilities?.tts;
      const supportedModels =
        ttsCapability?.model_map ||
        (plugin.type === 'tts' ? plugin.model_map : []);
      if (supportedModels.length === 0) {
        continue;
      }

      const noAuthRequired =
        (ttsCapability?.config as Record<string, unknown> | undefined)
          ?.no_auth_required === true;
      const apiKey = await this.deps.getApiKey(plugin, userId);
      if (apiKey || noAuthRequired) {
        for (const model of supportedModels) {
          models.push({
            model,
            plugin: plugin.id,
            config: ttsCapability?.config,
          });
        }
      }
    }

    return models;
  }

  async executeTTSRequest(
    model: string,
    input: string,
    options: {
      voice?: string;
      response_format?: 'mp3' | 'opus' | 'aac' | 'flac' | 'wav' | 'pcm';
      speed?: number;
      pluginId?: string;
      userId?: string;
      signal?: AbortSignal;
    } = {}
  ): Promise<Buffer> {
    validatePluginModel(model);

    const plugin = await this.getPluginForTTS(
      model,
      options.pluginId,
      options.userId
    );
    if (!plugin) {
      throw new Error(`No TTS plugin found for model: ${model}`);
    }

    let endpoint: string;
    let ttsConfig: TTSConfig | undefined;

    if (plugin.capabilities?.tts) {
      endpoint = plugin.capabilities.tts.endpoint;
      ttsConfig = plugin.capabilities.tts.config;
    } else {
      endpoint = plugin.endpoint;
    }

    const ttsVars = await this.deps.getPluginVariables(plugin, options.userId);
    const endpointVariable =
      ttsConfig?.endpoint_variable ||
      (plugin.type === 'tts' ? 'endpoint' : 'tts_endpoint');
    const endpointOverride = ttsVars[endpointVariable];
    if (endpointVariable === 'endpoint') {
      endpoint = resolvePluginOperationEndpoint(endpoint, ttsVars);
    } else if (
      typeof endpointOverride === 'string' &&
      endpointOverride.trim().length > 0
    ) {
      endpoint = this.deps.validateEndpointUrl(endpointOverride.trim());
    }

    const noAuthRequired =
      (ttsConfig as Record<string, unknown> | undefined)?.no_auth_required ===
      true;

    const apiKey = await this.deps.getApiKey(plugin, options.userId);
    if (!apiKey && !noAuthRequired) {
      throw new Error(
        `API key not found for plugin ${plugin.id} (save a provider credential in Settings)`
      );
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (apiKey && plugin.auth.header) {
      const authValue = plugin.auth.prefix
        ? `${plugin.auth.prefix}${apiKey}`
        : apiKey;
      headers[plugin.auth.header] = authValue;
    }

    const voice = options.voice || ttsConfig?.default_voice || 'alloy';
    const responseFormat =
      options.response_format || ttsConfig?.default_format || 'mp3';
    const speed = options.speed || (ttsVars.speed as number | undefined) || 1.0;

    const maxChars = ttsConfig?.max_characters || 4096;
    if (input.length > maxChars) {
      throw new Error(
        `TTS input exceeds maximum length of ${maxChars} characters; split it into batches`
      );
    }

    let payload: Record<string, unknown>;
    let processedEndpoint: string;

    if (plugin.id === 'elevenlabs') {
      const elevenLabsVoiceIds: Record<string, string> = {
        rachel: '21m00Tcm4TlvDq8ikWAM',
        domi: 'AZnzlk1XvdvUeBnXmlld',
        bella: 'EXAVITQu4vr4xnSDxMaL',
        antoni: 'ErXwobaYiN019PkySvjV',
        elli: 'MF3mGyEYCl7XYWbV9V6O',
        josh: 'TxGEqnHWrfWFTfGW9XjX',
        arnold: 'VR6AewLTigWG4xSOukaG',
        adam: 'pNInz6obpgDQGcFmaJgB',
        sam: 'yoZ06aMxZJJ28mfd3POQ',
        nicole: 'piTKgcLEGmPE4e6mEKli',
        glinda: 'z9fAnlkpzviPz146aGWa',
        clyde: '2EiwWnXFnvU5JabPnv8n',
        james: 'ZQe5CZNOzWyzPSCn5a3c',
        charlotte: 'XB0fDUnXU5powFXDhCwa',
        lily: 'pFZP5JQG7iQjIQuC4Bku',
        serena: 'pMsXgVXv3BLzUgSXRplE',
      };

      const voiceId =
        elevenLabsVoiceIds[voice.toLowerCase()] ||
        elevenLabsVoiceIds['rachel'] ||
        '21m00Tcm4TlvDq8ikWAM';

      processedEndpoint = `${endpoint}/${voiceId}`;

      const formatMap: Record<string, string> = {
        mp3: 'mp3_44100_128',
        pcm: 'pcm_16000',
        ulaw: 'ulaw_8000',
      };
      const outputFormat = formatMap[responseFormat] || 'mp3_44100_128';
      processedEndpoint += `?output_format=${outputFormat}`;

      payload = {
        text: input,
        model_id: model,
        voice_settings: {
          stability: (ttsVars.stability as number | undefined) ?? 0.5,
          similarity_boost:
            (ttsVars.similarity_boost as number | undefined) ?? 0.75,
        },
      };
    } else if (plugin.id === 'huggingface') {
      payload = { inputs: input };
      processedEndpoint = applyModelEndpointTemplate(endpoint, model);
    } else {
      payload = {
        model,
        input,
        voice,
        response_format: responseFormat,
        speed,
      };

      const sanitizedModel = encodeURIComponent(model);
      processedEndpoint = endpoint.replace('{model}', sanitizedModel);
    }

    payload = {
      ...getForwardedTTSVariables(ttsConfig, ttsVars),
      ...payload,
    };

    assertSafePluginEndpoint(processedEndpoint, 'TTS endpoint URL constructed');
    Object.assign(
      headers,
      buildPluginAttributionHeaders(plugin, processedEndpoint)
    );

    const providerSlot = await reserveTTSProviderRequest(options.userId);
    const providerSignal = combineAbortSignals(
      options.signal,
      providerSlot.signal
    );
    const startedAt = Date.now();
    try {
      const response = await axios.post(processedEndpoint, payload, {
        headers,
        timeout: 120000,
        responseType: 'arraybuffer',
        maxRedirects: 0,
        maxContentLength: TTS_MAX_PROVIDER_RESPONSE_BYTES,
        signal: providerSignal,
      });

      const audio = Buffer.from(response.data);
      this.deps.recordUsage?.({
        userId: options.userId,
        pluginId: plugin.id,
        pluginName: plugin.name,
        capability: 'tts',
        model,
        status: 'success',
        durationMs: Date.now() - startedAt,
        inputUnits: input.length,
        unitKind: 'characters',
      });
      return audio;
    } catch (error: unknown) {
      const cancelled = axios.isCancel(error) || providerSignal.aborted;
      this.deps.recordUsage?.({
        userId: options.userId,
        pluginId: plugin.id,
        pluginName: plugin.name,
        capability: 'tts',
        model,
        status: cancelled ? 'cancelled' : 'error',
        durationMs: Date.now() - startedAt,
        inputUnits: input.length,
        unitKind: 'characters',
      });
      if (!cancelled) {
        logger.error(
          `TTS plugin request failed for ${plugin.id}:`,
          describeTTSRequestFailure(error)
        );
      }

      if (cancelled) {
        throw cancellationReason(
          providerSignal,
          'TTS provider request was cancelled'
        );
      }

      if (error && typeof error === 'object' && 'response' in error) {
        const axiosError = error as {
          response: {
            status: number;
            data?: ArrayBuffer;
            statusText: string;
          };
        };

        let errorMessage = axiosError.response.statusText;
        if (axiosError.response.data) {
          try {
            const errorText = Buffer.from(axiosError.response.data).toString(
              'utf8'
            );
            const errorJson = JSON.parse(errorText);
            errorMessage =
              errorJson.error?.message ||
              errorJson.detail ||
              errorJson.message ||
              errorMessage;
          } catch {
            const rawText = Buffer.from(axiosError.response.data).toString(
              'utf8'
            );
            if (rawText) {
              errorMessage = rawText.substring(0, 200);
            }
          }
        }

        throw new TTSProviderResponseError(
          axiosError.response.status,
          `TTS API error: ${axiosError.response.status} - ${errorMessage}`
        );
      } else if (error && typeof error === 'object' && 'request' in error) {
        throw new Error(
          `TTS connection error: Unable to reach ${processedEndpoint}`
        );
      } else {
        const errorMessage =
          error instanceof Error ? error.message : 'Unknown error';
        throw new Error(`TTS error: ${errorMessage}`);
      }
    } finally {
      await providerSlot.release();
    }
  }

  async executeVoiceCloneRequest(
    model: string,
    input: string,
    referenceAudio: TTSVoiceCloneAudioFile,
    options: VoiceCloneRequestOptions = {}
  ): Promise<Buffer> {
    validatePluginModel(model);

    const plugin = await this.getPluginForTTS(
      model,
      options.pluginId,
      options.userId
    );
    if (!plugin) {
      throw new Error(`No TTS plugin found for model: ${model}`);
    }

    const ttsConfig = plugin.capabilities?.tts?.config;
    if (!ttsConfig?.supports_voice_cloning) {
      throw new Error(`TTS plugin ${plugin.id} does not support voice cloning`);
    }
    if (!ttsConfig.voice_clone_endpoint) {
      throw new Error(
        `TTS plugin ${plugin.id} has no voice clone endpoint configured`
      );
    }
    if (!input || input.trim().length === 0) {
      throw new Error('TTS input text is required for voice cloning');
    }

    const maxChars = ttsConfig.max_characters || 4096;
    if (input.length > maxChars) {
      throw new Error(
        `TTS input exceeds maximum length of ${maxChars} characters; split it into batches`
      );
    }

    const referenceText = options.referenceText?.trim();
    if (ttsConfig.clone_requires_transcript && !referenceText) {
      throw new Error(
        `TTS plugin ${plugin.id} requires a reference audio transcript for voice cloning`
      );
    }

    const validatedAudio = validateTTSVoiceCloneAudio(
      referenceAudio,
      ttsConfig
    );
    const ttsVars = await this.deps.getPluginVariables(plugin, options.userId);
    let endpoint = ttsConfig.voice_clone_endpoint;
    const endpointVariable = ttsConfig.voice_clone_endpoint_variable;
    if (endpointVariable) {
      const endpointOverride = ttsVars[endpointVariable];
      if (
        typeof endpointOverride === 'string' &&
        endpointOverride.trim().length > 0
      ) {
        endpoint = this.deps.validateEndpointUrl(endpointOverride.trim());
      } else if (endpointOverride !== undefined && endpointOverride !== '') {
        throw new Error(
          `Voice clone endpoint override ${endpointVariable} must be a URL string`
        );
      }
    }

    const processedEndpoint = applyModelEndpointTemplate(endpoint, model);
    assertSafePluginEndpoint(
      processedEndpoint,
      'TTS voice clone endpoint URL constructed'
    );

    const apiKey = await this.deps.getApiKey(plugin, options.userId);
    if (!apiKey && !ttsConfig.no_auth_required) {
      throw new Error(
        `API key not found for plugin ${plugin.id} (save a provider credential in Settings)`
      );
    }

    const headers: Record<string, string> = buildPluginAttributionHeaders(
      plugin,
      processedEndpoint
    );
    if (apiKey && plugin.auth.header) {
      headers[plugin.auth.header] = plugin.auth.prefix
        ? `${plugin.auth.prefix}${apiKey}`
        : apiKey;
    }

    const responseFormat =
      options.response_format || ttsConfig.default_format || 'wav';
    const form = new FormData();
    for (const [name, value] of Object.entries(
      getForwardedTTSVariables(ttsConfig, ttsVars)
    )) {
      form.append(name, String(value));
    }
    form.append('model', model);
    form.append('input', input);
    const audioBytes = Uint8Array.from(validatedAudio.buffer);
    const audioBlob = new Blob([audioBytes], {
      type: validatedAudio.mimetype,
    });
    const originalBaseName =
      validatedAudio.originalname.split(/[\\/]/).pop() ||
      `reference.${validatedAudio.format}`;
    const safeFilename =
      originalBaseName.replace(/[\r\n"]/g, '_').slice(0, 255) ||
      `reference.${validatedAudio.format}`;
    form.append('reference_audio', audioBlob, safeFilename);
    if (referenceText) {
      form.append('reference_text', referenceText);
    }
    form.append('response_format', responseFormat);

    const providerSlot = await reserveTTSProviderRequest(options.userId);
    const providerSignal = combineAbortSignals(
      options.signal,
      providerSlot.signal
    );
    const startedAt = Date.now();
    try {
      const response = await axios.post(processedEndpoint, form, {
        headers,
        timeout: 120000,
        responseType: 'arraybuffer',
        maxRedirects: 0,
        maxContentLength: TTS_MAX_PROVIDER_RESPONSE_BYTES,
        signal: providerSignal,
      });
      const audio = Buffer.from(response.data);
      this.deps.recordUsage?.({
        userId: options.userId,
        pluginId: plugin.id,
        pluginName: plugin.name,
        capability: 'tts',
        model,
        status: 'success',
        durationMs: Date.now() - startedAt,
        inputUnits: input.length,
        unitKind: 'characters',
      });
      return audio;
    } catch (error: unknown) {
      const cancelled = axios.isCancel(error) || providerSignal.aborted;
      this.deps.recordUsage?.({
        userId: options.userId,
        pluginId: plugin.id,
        pluginName: plugin.name,
        capability: 'tts',
        model,
        status: cancelled ? 'cancelled' : 'error',
        durationMs: Date.now() - startedAt,
        inputUnits: input.length,
        unitKind: 'characters',
      });
      if (!cancelled) {
        logger.error(
          `TTS voice clone request failed for ${plugin.id}:`,
          describeTTSRequestFailure(error)
        );
      }

      if (cancelled) {
        throw cancellationReason(
          providerSignal,
          'TTS voice clone request was cancelled'
        );
      }

      if (axios.isAxiosError(error) && error.response) {
        let errorMessage = error.response.statusText;
        if (error.response.data) {
          try {
            const errorText = Buffer.from(error.response.data).toString('utf8');
            const errorJson = JSON.parse(errorText);
            errorMessage =
              errorJson.error?.message ||
              errorJson.detail ||
              errorJson.message ||
              errorMessage;
          } catch {
            const rawText = Buffer.from(error.response.data).toString('utf8');
            if (rawText) errorMessage = rawText.substring(0, 200);
          }
        }
        throw new TTSProviderResponseError(
          error.response.status,
          `TTS voice clone API error: ${error.response.status} - ${errorMessage}`
        );
      }
      if (axios.isAxiosError(error) && error.request) {
        throw new Error(
          `TTS voice clone connection error: Unable to reach ${processedEndpoint}`
        );
      }
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`TTS voice clone error: ${errorMessage}`);
    } finally {
      await providerSlot.release();
    }
  }

  async getTTSConfig(
    pluginId: string,
    userId?: string
  ): Promise<TTSConfig | null> {
    const plugin = await this.deps.getPlugin(pluginId, userId);
    if (!plugin?.active) return null;

    if (plugin.capabilities?.tts?.config) {
      return plugin.capabilities.tts.config;
    }

    return null;
  }
}

export function splitTextForTTS(text: string, maxChars: number): string[] {
  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxChars) {
      chunks.push(remaining);
      break;
    }

    let breakPoint = maxChars;
    const searchStart = Math.max(0, maxChars - 500);
    const sentenceEnders = ['. ', '! ', '? ', '.\n', '!\n', '?\n'];
    let bestBreak = -1;

    for (const ender of sentenceEnders) {
      const lastIndex = remaining.lastIndexOf(ender, maxChars);
      if (lastIndex > searchStart && lastIndex > bestBreak) {
        bestBreak = lastIndex + ender.length;
      }
    }

    if (bestBreak > searchStart) {
      breakPoint = bestBreak;
    } else {
      const lastSpace = remaining.lastIndexOf(' ', maxChars);
      if (lastSpace > searchStart) {
        breakPoint = lastSpace + 1;
      }
    }

    chunks.push(remaining.slice(0, breakPoint).trim());
    remaining = remaining.slice(breakPoint).trim();
  }

  return chunks.filter(chunk => chunk.length > 0);
}
