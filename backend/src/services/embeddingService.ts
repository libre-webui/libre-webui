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

import {
  EmbeddingModel,
  OllamaEmbeddingsRequest,
  OllamaEmbeddingsResponse,
} from '../types/index.js';
import ollamaService from './ollamaService.js';
import pluginService from './pluginService.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('services:embedding-service');

const EMBEDDING_PATTERNS = [
  'embed',
  'embedding',
  'nomic',
  'mxbai',
  'e5',
  'bge',
  'gte',
  'voyage',
  'snowflake',
  'arctic',
  'cohere',
  'minilm',
  'multilingual',
  'sentence',
  'universal',
  'instructor',
  'jina',
  'paraphrase',
  'mpnet',
  'contriever',
];

const isLikelyEmbeddingModel = (modelName: string): boolean =>
  EMBEDDING_PATTERNS.some(pattern =>
    modelName.toLowerCase().includes(pattern.toLowerCase())
  );

const PLUGIN_MODEL_PREFIX = 'plugin:';

const encodePluginModelId = (pluginId: string, model: string): string =>
  `${PLUGIN_MODEL_PREFIX}${pluginId}:${model}`;

const parseModelTarget = (
  modelId: string
): { model: string; pluginId?: string } => {
  if (!modelId.startsWith(PLUGIN_MODEL_PREFIX)) {
    return { model: modelId };
  }

  const target = modelId.slice(PLUGIN_MODEL_PREFIX.length);
  const separatorIndex = target.indexOf(':');
  if (separatorIndex === -1) {
    return { model: modelId };
  }

  return {
    pluginId: target.slice(0, separatorIndex),
    model: target.slice(separatorIndex + 1),
  };
};

class EmbeddingService {
  private dedupeModels(models: EmbeddingModel[]): EmbeddingModel[] {
    return models.reduce((unique: EmbeddingModel[], model) => {
      if (!unique.find(existing => existing.id === model.id)) {
        unique.push(model);
      }
      return unique;
    }, []);
  }

  async getAvailableModels(userId?: string): Promise<EmbeddingModel[]> {
    const models: EmbeddingModel[] = [];

    try {
      const ollamaModels = await ollamaService.getModels();
      for (const model of ollamaModels) {
        if (!isLikelyEmbeddingModel(model.name)) {
          continue;
        }

        models.push({
          id: model.name,
          name: model.name,
          description: `Ollama - ${model.details?.parameter_size || 'Unknown size'} - ${model.details?.family || 'Model'}`,
          provider: 'ollama',
          dimensions: 0,
          isDetectedEmbedding: isLikelyEmbeddingModel(model.name),
        });
      }
    } catch (error) {
      logger.warn('Failed to load Ollama embedding models:', error);
    }

    const plugins = pluginService
      .getActivePlugins(userId)
      .filter(
        plugin =>
          (plugin.capabilities?.embedding ||
            plugin.type === 'embedding' ||
            plugin.type === 'completion' ||
            plugin.type === 'chat') &&
          Boolean(pluginService.getApiKey(plugin, userId))
      );
    await Promise.all(
      plugins.map(plugin =>
        pluginService
          .discoverModels(plugin.id, userId)
          .catch(() => plugin.model_map)
      )
    );

    for (const model of pluginService.getAvailableEmbeddingModels(userId)) {
      const isEmbeddingCandidate =
        model.fromEmbeddingCapability || isLikelyEmbeddingModel(model.model);

      if (!isEmbeddingCandidate) {
        continue;
      }

      models.push({
        id: encodePluginModelId(model.plugin, model.model),
        name: model.model,
        description: `${model.pluginName} - ${model.description || 'OpenAI-compatible provider'}`,
        provider: model.provider,
        dimensions: 0,
        rawModel: model.model,
        pluginId: model.plugin,
        pluginName: model.pluginName,
        isDetectedEmbedding:
          model.fromEmbeddingCapability || isLikelyEmbeddingModel(model.model),
      });
    }

    const deduped = this.dedupeModels(models);
    if (deduped.length > 0) {
      return deduped.sort((a, b) => {
        const detectionDelta =
          Number(Boolean(b.isDetectedEmbedding)) -
          Number(Boolean(a.isDetectedEmbedding));
        if (detectionDelta !== 0) {
          return detectionDelta;
        }

        return a.name.localeCompare(b.name);
      });
    }

    return [
      {
        id: 'nomic-embed-text',
        name: 'nomic-embed-text',
        description: 'Ollama - Default embedding model',
        provider: 'ollama',
        dimensions: 0,
        isDetectedEmbedding: true,
      },
    ];
  }

  async generateEmbeddings(
    payload: OllamaEmbeddingsRequest,
    userId?: string,
    signal?: AbortSignal
  ): Promise<OllamaEmbeddingsResponse> {
    const target = parseModelTarget(payload.model);
    if (target.pluginId) {
      return pluginService.executeEmbeddingRequest(
        target.model,
        payload.input,
        target.pluginId,
        userId,
        signal
      );
    }

    const plugin = pluginService.getPluginForEmbedding(
      target.model,
      undefined,
      userId
    );
    if (plugin && isLikelyEmbeddingModel(target.model)) {
      return pluginService.executeEmbeddingRequest(
        target.model,
        payload.input,
        undefined,
        userId,
        signal
      );
    }

    return ollamaService.generateEmbeddings(
      {
        ...payload,
        model: target.model,
      },
      signal
    );
  }
}

export default new EmbeddingService();
