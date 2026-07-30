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
import { createLogger } from '../utils/logger.js';
import {
  assertSafePluginEndpoint,
  applyModelEndpointTemplate,
  resolvePluginOperationEndpoint,
  validatePluginModel,
} from '../utils/pluginValidation.js';

const logger = createLogger('plugin-tts');

type PluginVariables = Record<string, string | number | boolean>;

export interface PluginTTSServiceDependencies {
  getAllPlugins(userId?: string): Plugin[];
  getPlugin(id: string, userId?: string): Plugin | null;
  getApiKey(plugin: Plugin, userId?: string): string | null;
  getPluginVariables(plugin: Plugin, userId?: string): PluginVariables;
  validateEndpointUrl(endpoint: string): string;
}

export class PluginTTSService {
  constructor(private readonly deps: PluginTTSServiceDependencies) {}

  getPluginForTTS(
    model: string,
    pluginId?: string,
    userId?: string
  ): Plugin | null {
    const allPlugins = this.deps.getAllPlugins(userId);

    for (const plugin of allPlugins) {
      if (pluginId && plugin.id !== pluginId) {
        continue;
      }

      if (plugin.capabilities?.tts) {
        const ttsCapability = plugin.capabilities.tts;
        if (ttsCapability.model_map.includes(model)) {
          const noAuthRequired =
            (ttsCapability.config as Record<string, unknown> | undefined)
              ?.no_auth_required === true;

          const apiKey = this.deps.getApiKey(plugin, userId);
          if (!apiKey && !noAuthRequired) {
            continue;
          }

          return plugin;
        }
      }

      if (plugin.type === 'tts' && plugin.model_map.includes(model)) {
        const noAuthRequired =
          (
            plugin.capabilities?.tts?.config as
              Record<string, unknown> | undefined
          )?.no_auth_required === true;

        const apiKey = this.deps.getApiKey(plugin, userId);
        if (!apiKey && !noAuthRequired) {
          continue;
        }

        return plugin;
      }
    }

    return null;
  }

  getAvailableTTSModels(userId?: string): {
    model: string;
    plugin: string;
    config?: TTSConfig;
  }[] {
    const models: { model: string; plugin: string; config?: TTSConfig }[] = [];
    const allPlugins = this.deps.getAllPlugins(userId);

    for (const plugin of allPlugins) {
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
      const apiKey = this.deps.getApiKey(plugin, userId);
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
    } = {}
  ): Promise<Buffer> {
    validatePluginModel(model);

    const plugin = this.getPluginForTTS(
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

    const ttsVars = this.deps.getPluginVariables(plugin, options.userId);
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

    const apiKey = this.deps.getApiKey(plugin, options.userId);
    if (!apiKey && !noAuthRequired) {
      throw new Error(
        `API key not found for plugin ${plugin.id} (set via Settings or ${plugin.auth.key_env} env var)`
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
      const chunks = splitTextForTTS(input, maxChars);
      logger.debug(
        `[TTS] Input too long (${input.length} chars), splitting into ${chunks.length} chunks`
      );

      const audioBuffers: Buffer[] = [];
      for (let i = 0; i < chunks.length; i++) {
        logger.debug(
          `[TTS] Processing chunk ${i + 1}/${chunks.length} (${chunks[i].length} chars)`
        );
        const chunkAudio = await this.executeTTSRequest(
          model,
          chunks[i],
          options
        );
        audioBuffers.push(chunkAudio);
      }

      return Buffer.concat(audioBuffers);
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

    assertSafePluginEndpoint(processedEndpoint, 'TTS endpoint URL constructed');

    try {
      const response = await axios.post(processedEndpoint, payload, {
        headers,
        timeout: 120000,
        responseType: 'arraybuffer',
      });

      return Buffer.from(response.data);
    } catch (error: unknown) {
      logger.error(`TTS plugin request failed for ${plugin.id}:`, error);

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

        throw new Error(
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
    }
  }

  getTTSConfig(pluginId: string): TTSConfig | null {
    const plugin = this.deps.getPlugin(pluginId);
    if (!plugin) return null;

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
