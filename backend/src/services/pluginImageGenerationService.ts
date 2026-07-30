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
import { ImageGenConfig, ImageGenResponse, Plugin } from '../types/index.js';
import {
  assertSafePluginEndpoint,
  applyModelEndpointTemplate,
  resolvePluginOperationEndpoint,
  validatePluginModel,
} from '../utils/pluginValidation.js';

type PluginVariables = Record<string, string | number | boolean>;

export interface PluginImageGenerationServiceDependencies {
  getAllPlugins(userId?: string): Plugin[];
  getPlugin(id: string, userId?: string): Plugin | null;
  getApiKey(plugin: Plugin, userId?: string): string | null;
  getPluginVariables(plugin: Plugin, userId?: string): PluginVariables;
  validateEndpointUrl(endpoint: string): string;
}

export class PluginImageGenerationService {
  constructor(
    private readonly deps: PluginImageGenerationServiceDependencies
  ) {}

  getPluginForImageGen(model: string, userId?: string): Plugin | null {
    const allPlugins = this.deps.getAllPlugins(userId);

    for (const plugin of allPlugins) {
      if (plugin.capabilities?.image) {
        const imageCapability = plugin.capabilities.image;
        if (imageCapability.model_map.includes(model)) {
          return plugin;
        }
      }

      if (plugin.type === 'image' && plugin.model_map.includes(model)) {
        return plugin;
      }
    }

    return null;
  }

  getAvailableImageGenModels(userId?: string): {
    model: string;
    plugin: string;
    config?: ImageGenConfig;
  }[] {
    const models: { model: string; plugin: string; config?: ImageGenConfig }[] =
      [];
    const allPlugins = this.deps.getAllPlugins(userId);

    for (const plugin of allPlugins) {
      if (plugin.capabilities?.image) {
        const imageCapability = plugin.capabilities.image;
        const noAuthRequired =
          (imageCapability.config as Record<string, unknown> | undefined)
            ?.no_auth_required === true;
        const apiKey = this.deps.getApiKey(plugin, userId);
        if (apiKey || noAuthRequired) {
          for (const model of imageCapability.model_map) {
            models.push({
              model,
              plugin: plugin.id,
              config: imageCapability.config,
            });
          }
        }
      }

      if (plugin.type === 'image') {
        const apiKey = this.deps.getApiKey(plugin, userId);
        if (apiKey) {
          for (const model of plugin.model_map) {
            models.push({
              model,
              plugin: plugin.id,
            });
          }
        }
      }
    }

    return models;
  }

  async executeImageGenRequest(
    model: string,
    prompt: string,
    options: {
      size?: string;
      quality?: string;
      style?: string;
      n?: number;
      response_format?: 'url' | 'b64_json';
      userId?: string;
    } = {}
  ): Promise<ImageGenResponse> {
    validatePluginModel(model);

    if (!prompt || typeof prompt !== 'string') {
      throw new Error('Invalid prompt: must be a non-empty string');
    }

    const plugin = this.getPluginForImageGen(model, options.userId);
    if (!plugin) {
      throw new Error(`No image generation plugin found for model: ${model}`);
    }

    let endpoint: string;
    let imageConfig: ImageGenConfig | undefined;

    if (plugin.capabilities?.image) {
      endpoint = plugin.capabilities.image.endpoint;
      imageConfig = plugin.capabilities.image.config;
    } else {
      endpoint = plugin.endpoint;
    }

    const imageVars = this.deps.getPluginVariables(plugin, options.userId);
    const endpointVariable =
      imageConfig?.endpoint_variable ||
      (plugin.type === 'image' ? 'endpoint' : 'image_endpoint');
    const endpointOverride = imageVars[endpointVariable];
    if (endpointVariable === 'endpoint') {
      endpoint = resolvePluginOperationEndpoint(endpoint, imageVars);
    } else if (
      typeof endpointOverride === 'string' &&
      endpointOverride.trim().length > 0
    ) {
      endpoint = this.deps.validateEndpointUrl(endpointOverride.trim());
    }

    const noAuthRequired =
      (imageConfig as Record<string, unknown> | undefined)?.no_auth_required ===
      true;
    const apiKey = this.deps.getApiKey(plugin, options.userId);
    if (!apiKey && !noAuthRequired) {
      throw new Error(
        `API key not found for plugin ${plugin.id} (save a provider credential in Settings)`
      );
    }

    if (
      imageConfig?.max_prompt_length &&
      prompt.length > imageConfig.max_prompt_length
    ) {
      throw new Error(
        `Prompt exceeds maximum length of ${imageConfig.max_prompt_length} characters`
      );
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (apiKey) {
      if (plugin.auth.prefix) {
        headers[plugin.auth.header] = `${plugin.auth.prefix}${apiKey}`;
      } else {
        headers[plugin.auth.header] = apiKey;
      }
    }

    const payload: Record<string, unknown> = {
      model,
      prompt,
      size: options.size || imageConfig?.default_size || '1024x1024',
      quality: options.quality || imageConfig?.default_quality || 'standard',
      n: options.n || 1,
      response_format: options.response_format || 'url',
    };

    if (options.style || imageConfig?.default_style) {
      payload.style = options.style || imageConfig?.default_style;
    }

    endpoint =
      plugin.id === 'huggingface'
        ? applyModelEndpointTemplate(endpoint, model)
        : endpoint;
    const baseUrl = parseImageEndpoint(endpoint);

    if (plugin.id === 'comfyui' || endpoint.includes('/prompt')) {
      return executeComfyUIRequest(baseUrl, prompt, {
        ...options,
        model,
        pluginVars: imageVars,
      });
    }

    try {
      if (plugin.id === 'huggingface') {
        const [width, height] = String(payload.size)
          .split('x')
          .map(value => Number.parseInt(value, 10));
        const response = await axios.post(
          endpoint,
          {
            inputs: prompt,
            ...(Number.isInteger(width) && Number.isInteger(height)
              ? { parameters: { width, height } }
              : {}),
          },
          {
            headers,
            timeout: 120000,
            responseType: 'arraybuffer',
            maxRedirects: 0,
          }
        );
        return {
          images: [{ b64_json: Buffer.from(response.data).toString('base64') }],
          model,
        };
      }

      const response = await axios.post(endpoint, payload, {
        headers,
        timeout: 120000,
        maxRedirects: 0,
      });

      if (response.data?.data) {
        return {
          images: response.data.data.map(
            (img: {
              url?: string;
              b64_json?: string;
              revised_prompt?: string;
            }) => ({
              url: img.url,
              b64_json: img.b64_json,
              revised_prompt: img.revised_prompt,
            })
          ),
          model,
        };
      }

      return {
        images: Array.isArray(response.data) ? response.data : [response.data],
        model,
      };
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const message =
          error.response?.data?.error?.message ||
          error.response?.data?.message ||
          error.message;
        throw new Error(`Image generation failed: ${message}`);
      }
      throw error;
    }
  }

  getImageGenConfig(pluginId: string, userId?: string): ImageGenConfig | null {
    const plugin = this.deps.getPlugin(pluginId, userId);
    if (!plugin?.active) return null;

    if (plugin.capabilities?.image?.config) {
      return plugin.capabilities.image.config;
    }

    return null;
  }
}

function parseImageEndpoint(endpoint: string): URL {
  assertSafePluginEndpoint(endpoint, 'image generation endpoint');
  return new URL(endpoint);
}

interface FluxModelConfig {
  unetFile: string;
  t5File: string;
  steps: { draft: number; standard: number; high: number; ultra: number };
  guidance: number;
  useCheckpointLoader: boolean;
}

const fluxModelConfigs: Record<string, FluxModelConfig> = {
  'flux1-dev': {
    unetFile: 'flux1-dev.safetensors',
    t5File: 't5xxl_fp16.safetensors',
    steps: { draft: 12, standard: 20, high: 28, ultra: 40 },
    guidance: 3.5,
    useCheckpointLoader: false,
  },
  'flux1-dev-fp8': {
    unetFile: 'flux1-dev-fp8.safetensors',
    t5File: 't5xxl_fp8_e4m3fn_scaled.safetensors',
    steps: { draft: 12, standard: 20, high: 28, ultra: 40 },
    guidance: 3.5,
    useCheckpointLoader: false,
  },
  'flux1-schnell': {
    unetFile: 'flux1-schnell.safetensors',
    t5File: 't5xxl_fp16.safetensors',
    steps: { draft: 2, standard: 4, high: 6, ultra: 8 },
    guidance: 0,
    useCheckpointLoader: false,
  },
};

async function executeComfyUIRequest(
  baseUrl: URL,
  prompt: string,
  options: {
    size?: string;
    quality?: string;
    model?: string;
    pluginVars?: PluginVariables;
  } = {}
): Promise<ImageGenResponse> {
  const comfyBaseUrl = `${baseUrl.protocol}//${baseUrl.host}`;
  const size = options.size || '1024x1024';
  const [width, height] = size.split('x').map(Number);
  const model = options.model || 'flux1-dev';
  const config = fluxModelConfigs[model] || fluxModelConfigs['flux1-dev'];
  const quality = (options.quality || 'standard') as keyof typeof config.steps;
  const pVars = options.pluginVars || {};
  const steps =
    pVars.steps && (pVars.steps as number) > 0
      ? (pVars.steps as number)
      : config.steps[quality] || config.steps.standard;

  const workflow: Record<string, unknown> = {
    '6': {
      inputs: {
        text: prompt,
        clip: ['11', 0],
      },
      class_type: 'CLIPTextEncode',
      _meta: { title: 'CLIP Text Encode (Prompt)' },
    },
    '8': {
      inputs: {
        samples: ['13', 0],
        vae: ['10', 0],
      },
      class_type: 'VAEDecode',
      _meta: { title: 'VAE Decode' },
    },
    '9': {
      inputs: {
        filename_prefix: `LibreWebUI_${model}`,
        images: ['8', 0],
      },
      class_type: 'SaveImage',
      _meta: { title: 'Save Image' },
    },
    '10': {
      inputs: {
        vae_name: 'ae.safetensors',
      },
      class_type: 'VAELoader',
      _meta: { title: 'Load VAE' },
    },
    '11': {
      inputs: {
        clip_name1: 'clip_l.safetensors',
        clip_name2: config.t5File,
        type: 'flux',
      },
      class_type: 'DualCLIPLoader',
      _meta: { title: 'DualCLIPLoader' },
    },
    '12': {
      inputs: {
        unet_name: config.unetFile,
        weight_dtype: 'default',
      },
      class_type: 'UNETLoader',
      _meta: { title: 'Load Diffusion Model' },
    },
    '13': {
      inputs: {
        noise: ['25', 0],
        guider: ['22', 0],
        sampler: ['16', 0],
        sigmas: ['17', 0],
        latent_image: ['27', 0],
      },
      class_type: 'SamplerCustomAdvanced',
      _meta: { title: 'SamplerCustomAdvanced' },
    },
    '16': {
      inputs: {
        sampler_name: 'euler',
      },
      class_type: 'KSamplerSelect',
      _meta: { title: 'KSamplerSelect' },
    },
    '17': {
      inputs: {
        scheduler: 'simple',
        steps: steps,
        denoise: 1,
        model: ['12', 0],
      },
      class_type: 'BasicScheduler',
      _meta: { title: 'BasicScheduler' },
    },
    '22': {
      inputs: {
        model: ['12', 0],
        conditioning: config.guidance > 0 ? ['26', 0] : ['6', 0],
      },
      class_type: 'BasicGuider',
      _meta: { title: 'BasicGuider' },
    },
    '25': {
      inputs: {
        noise_seed:
          pVars.seed && (pVars.seed as number) >= 0
            ? (pVars.seed as number)
            : Math.floor(Math.random() * 1000000000000000),
      },
      class_type: 'RandomNoise',
      _meta: { title: 'RandomNoise' },
    },
    '27': {
      inputs: {
        width: width,
        height: height,
        batch_size: 1,
      },
      class_type: 'EmptySD3LatentImage',
      _meta: { title: 'EmptySD3LatentImage' },
    },
  };

  if (config.guidance > 0) {
    workflow['26'] = {
      inputs: {
        guidance:
          pVars.cfg_scale && (pVars.cfg_scale as number) > 0
            ? (pVars.cfg_scale as number)
            : config.guidance,
        conditioning: ['6', 0],
      },
      class_type: 'FluxGuidance',
      _meta: { title: 'FluxGuidance' },
    };
  }

  try {
    const clientId = `libre-webui-${Date.now()}`;
    const promptResponse = await axios.post(
      `${comfyBaseUrl}/prompt`,
      {
        prompt: workflow,
        client_id: clientId,
      },
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 10000,
        maxRedirects: 0,
      }
    );

    const promptId = promptResponse.data.prompt_id;
    if (!promptId) {
      throw new Error('Failed to get prompt ID from ComfyUI');
    }

    let completed = false;
    let attempts = 0;
    const maxAttempts = 120;

    while (!completed && attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      attempts++;

      const historyResponse = await axios.get(
        `${comfyBaseUrl}/history/${promptId}`,
        { timeout: 5000, maxRedirects: 0 }
      );

      if (historyResponse.data[promptId]) {
        const outputs = historyResponse.data[promptId].outputs;
        if (outputs && Object.keys(outputs).length > 0) {
          completed = true;

          for (const nodeId in outputs) {
            const nodeOutput = outputs[nodeId];
            if (nodeOutput.images && nodeOutput.images.length > 0) {
              const imageInfo = nodeOutput.images[0];
              const imageUrl = `${comfyBaseUrl}/view?filename=${encodeURIComponent(
                imageInfo.filename
              )}&subfolder=${encodeURIComponent(
                imageInfo.subfolder || ''
              )}&type=${encodeURIComponent(imageInfo.type || 'output')}`;

              const imageResponse = await axios.get(imageUrl, {
                responseType: 'arraybuffer',
                timeout: 30000,
                maxRedirects: 0,
              });

              const base64Image = Buffer.from(imageResponse.data).toString(
                'base64'
              );

              return {
                images: [
                  {
                    b64_json: base64Image,
                    revised_prompt: prompt,
                  },
                ],
                model,
              };
            }
          }
        }
      }
    }

    if (!completed) {
      throw new Error('ComfyUI generation timed out');
    }

    throw new Error('No image output found from ComfyUI');
  } catch (error) {
    if (axios.isAxiosError(error)) {
      const message =
        error.response?.data?.error ||
        error.response?.data?.message ||
        error.message;
      throw new Error(`ComfyUI generation failed: ${message}`);
    }
    throw error;
  }
}
