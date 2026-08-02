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
import {
  EmbeddingConfig,
  EmbeddingModel,
  OllamaEmbeddingsResponse,
  Plugin,
} from '../types/index.js';
import {
  assertSafePluginEndpoint,
  applyModelEndpointTemplate,
  resolvePluginOperationEndpoint,
  validatePluginModel,
} from '../utils/pluginValidation.js';
import type { PluginUsageEventInput } from './pluginUsageService.js';

type PluginVariables = Record<string, string | number | boolean>;

export interface PluginEmbeddingServiceDependencies {
  getAllPlugins(userId?: string): Plugin[];
  getApiKey(plugin: Plugin, userId?: string): string | null;
  getPluginVariables(plugin: Plugin, userId?: string): PluginVariables;
  validateEndpointUrl(endpoint: string): string;
  recordUsage?(usage: PluginUsageEventInput): void;
}

export class PluginEmbeddingService {
  constructor(private readonly deps: PluginEmbeddingServiceDependencies) {}

  getPluginForEmbedding(
    model: string,
    pluginId?: string,
    userId?: string
  ): Plugin | null {
    const allPlugins = this.deps.getAllPlugins(userId);

    for (const plugin of allPlugins) {
      if (pluginId && plugin.id !== pluginId) {
        continue;
      }

      const embeddingCapability = this.getEmbeddingCapability(plugin);
      const supportsEmbedding =
        embeddingCapability?.model_map.includes(model) ||
        ((plugin.type === 'embedding' ||
          plugin.type === 'completion' ||
          plugin.type === 'chat') &&
          plugin.model_map.includes(model));

      if (!supportsEmbedding) {
        continue;
      }

      const noAuthRequired =
        (embeddingCapability?.config as Record<string, unknown> | undefined)
          ?.no_auth_required === true;
      const apiKey = this.deps.getApiKey(plugin, userId);
      if (apiKey || noAuthRequired) {
        return plugin;
      }
    }

    return null;
  }

  getAvailableEmbeddingModels(userId?: string): Array<{
    model: string;
    plugin: string;
    pluginName: string;
    provider: EmbeddingModel['provider'];
    description?: string;
    fromEmbeddingCapability?: boolean;
  }> {
    const models: Array<{
      model: string;
      plugin: string;
      pluginName: string;
      provider: EmbeddingModel['provider'];
      description?: string;
      fromEmbeddingCapability?: boolean;
    }> = [];
    const allPlugins = this.deps.getAllPlugins(userId);

    for (const plugin of allPlugins) {
      const embeddingCapability = this.getEmbeddingCapability(plugin);
      const noAuthRequired =
        (embeddingCapability?.config as Record<string, unknown> | undefined)
          ?.no_auth_required === true;
      const apiKey = this.deps.getApiKey(plugin, userId);
      if (!apiKey && !noAuthRequired) {
        continue;
      }

      const provider: EmbeddingModel['provider'] =
        plugin.id === 'huggingface' ? 'huggingface' : 'openai';
      const modelMap =
        embeddingCapability?.model_map ||
        ((plugin.type === 'embedding' ||
          plugin.type === 'completion' ||
          plugin.type === 'chat') &&
        Array.isArray(plugin.model_map)
          ? plugin.model_map
          : []);

      for (const model of modelMap) {
        models.push({
          model,
          plugin: plugin.id,
          pluginName: plugin.name,
          provider,
          description: embeddingCapability
            ? 'Embedding provider'
            : 'OpenAI-compatible provider',
          fromEmbeddingCapability: Boolean(embeddingCapability),
        });
      }
    }

    return models;
  }

  async executeEmbeddingRequest(
    model: string,
    input: string | string[],
    pluginId?: string,
    userId?: string
  ): Promise<OllamaEmbeddingsResponse> {
    validatePluginModel(model);

    const plugin = this.getPluginForEmbedding(model, pluginId, userId);
    if (!plugin) {
      throw new Error(`No embedding plugin found for model: ${model}`);
    }

    const embeddingCapability = this.getEmbeddingCapability(plugin);
    const noAuthRequired =
      (embeddingCapability?.config as Record<string, unknown> | undefined)
        ?.no_auth_required === true;
    const pluginVars = this.deps.getPluginVariables(plugin, userId);
    const endpointVariable =
      embeddingCapability?.config?.endpoint_variable ||
      (embeddingCapability && plugin.type !== 'embedding'
        ? 'embedding_endpoint'
        : 'endpoint');
    const endpointOverride = pluginVars[endpointVariable];
    let effectiveEndpoint = embeddingCapability?.endpoint || plugin.endpoint;
    if (endpointVariable === 'endpoint') {
      effectiveEndpoint = resolvePluginOperationEndpoint(
        effectiveEndpoint,
        pluginVars
      );
    } else if (
      typeof endpointOverride === 'string' &&
      endpointOverride.trim().length > 0
    ) {
      effectiveEndpoint = this.deps.validateEndpointUrl(
        endpointOverride.trim()
      );
    }

    const processedEndpoint =
      plugin.id === 'huggingface'
        ? applyModelEndpointTemplate(effectiveEndpoint, model)
        : getEmbeddingEndpoint(effectiveEndpoint);
    assertSafePluginEndpoint(processedEndpoint, 'embedding endpoint');

    const apiKey = this.deps.getApiKey(plugin, userId);
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

    const startedAt = Date.now();
    try {
      const response = await axios.post(
        processedEndpoint,
        plugin.id === 'huggingface' ? { inputs: input } : { model, input },
        {
          headers,
          timeout: 60000,
          maxRedirects: 0,
        }
      );

      let result: OllamaEmbeddingsResponse;
      if (
        Array.isArray(response.data) &&
        response.data.every(value => typeof value === 'number')
      ) {
        result = { embeddings: [response.data as number[]] };
      } else if (
        Array.isArray(response.data) &&
        response.data.every(
          value =>
            Array.isArray(value) &&
            value.every(component => typeof component === 'number')
        )
      ) {
        result = { embeddings: response.data as number[][] };
      } else if (Array.isArray(response.data?.embeddings)) {
        result = { embeddings: response.data.embeddings };
      } else if (Array.isArray(response.data?.data)) {
        result = {
          embeddings: response.data.data
            .map((entry: { embedding?: number[] }) => entry.embedding)
            .filter((embedding: unknown): embedding is number[] =>
              Array.isArray(embedding)
            ),
        };
      } else {
        throw new Error('Embedding provider returned an unexpected response');
      }

      const usage = response.data?.usage as
        | {
            prompt_tokens?: number;
            total_tokens?: number;
          }
        | undefined;
      this.deps.recordUsage?.({
        userId,
        pluginId: plugin.id,
        pluginName: plugin.name,
        capability: 'embedding',
        model,
        status: 'success',
        durationMs: Date.now() - startedAt,
        inputUnits: Array.isArray(input) ? input.length : 1,
        unitKind: 'inputs',
        tokens:
          typeof usage?.total_tokens === 'number' ||
          typeof usage?.prompt_tokens === 'number'
            ? {
                promptTokens: usage.prompt_tokens ?? usage.total_tokens ?? 0,
                completionTokens: 0,
                totalTokens: usage.total_tokens ?? usage.prompt_tokens ?? 0,
              }
            : undefined,
      });
      return result;
    } catch (error) {
      this.deps.recordUsage?.({
        userId,
        pluginId: plugin.id,
        pluginName: plugin.name,
        capability: 'embedding',
        model,
        status: 'error',
        durationMs: Date.now() - startedAt,
        inputUnits: Array.isArray(input) ? input.length : 1,
        unitKind: 'inputs',
      });
      throw error;
    }
  }

  private getEmbeddingCapability(plugin: Plugin):
    | {
        endpoint: string;
        model_map: string[];
        config?: EmbeddingConfig;
      }
    | undefined {
    return plugin.capabilities?.embedding;
  }
}

export function getEmbeddingEndpoint(endpoint: string): string {
  const url = new URL(endpoint);
  url.search = '';

  if (url.pathname.endsWith('/embeddings')) {
    return url.toString();
  }

  if (url.pathname.endsWith('/chat/completions')) {
    url.pathname = `${url.pathname.slice(0, -'/chat/completions'.length)}/embeddings`;
    return url.toString();
  }

  if (url.pathname.endsWith('/completions')) {
    url.pathname = `${url.pathname.slice(0, -'/completions'.length)}/embeddings`;
    return url.toString();
  }

  if (url.pathname.endsWith('/models')) {
    url.pathname = `${url.pathname.slice(0, -'/models'.length)}/embeddings`;
    return url.toString();
  }

  const basePath =
    url.pathname === '/'
      ? ''
      : url.pathname.endsWith('/')
        ? url.pathname.slice(0, -1)
        : url.pathname;
  url.pathname = `${basePath}/embeddings`;
  return url.toString();
}
