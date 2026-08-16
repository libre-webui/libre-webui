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
 * One authoritative, server-side list of chat-capable models across every
 * provider the user can reach: local Ollama plus their active provider
 * connections. Serves the OpenAI-compatible `/v1/models` listing and model
 * management. Each source is allowed to fail independently — a stopped
 * Ollama must not empty a plugin-only deployment's catalog.
 */

import ollamaService from './ollamaService.js';
import pluginService from './pluginService.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('services:model-catalog');

export interface CatalogModel {
  id: string;
  providerType: 'ollama' | 'plugin';
  providerId?: string;
  ownedBy: string;
}

// A provider's model listing covers every modality it sells; the chat list
// filters out well-known non-chat model families.
const NON_CHAT_MODEL_PATTERNS = [
  'dall-e',
  'embed',
  'gpt-image',
  'moderation',
  'rerank',
  'sora',
  'stable-diffusion',
  'text-to-speech',
  'tts',
  'whisper',
];

export const isChatCapableModelId = (modelId: string): boolean => {
  const normalized = modelId.toLocaleLowerCase();
  return !NON_CHAT_MODEL_PATTERNS.some(pattern => normalized.includes(pattern));
};

/**
 * Models a plugin can answer chat requests with: its catalog minus anything
 * it declares under another capability, minus non-chat model families.
 */
const pluginChatModels = (plugin: {
  model_map?: string[];
  capabilities?: object;
}): string[] => {
  const capabilityModels = new Set<string>();
  for (const [capabilityType, capability] of Object.entries(
    (plugin.capabilities || {}) as Record<
      string,
      { model_map?: string[] } | undefined
    >
  )) {
    if (capabilityType === 'completion') continue;
    for (const modelId of capability?.model_map || []) {
      capabilityModels.add(modelId.trim());
    }
  }
  return (plugin.model_map || []).filter(
    modelId =>
      typeof modelId === 'string' &&
      modelId.trim().length > 0 &&
      !capabilityModels.has(modelId.trim()) &&
      isChatCapableModelId(modelId)
  );
};

export const listChatModels = async (
  userId: string
): Promise<CatalogModel[]> => {
  const models: CatalogModel[] = [];
  const seen = new Set<string>();

  try {
    const ollamaModels = await ollamaService.getModels();
    for (const model of ollamaModels) {
      if (seen.has(model.name)) continue;
      seen.add(model.name);
      models.push({
        id: model.name,
        providerType: 'ollama',
        ownedBy: 'ollama',
      });
    }
  } catch (error) {
    logger.debug('Ollama models unavailable for the catalog:', error);
  }

  try {
    const plugins = await pluginService.getActivePlugins(userId);
    for (const plugin of plugins) {
      if (plugin.type === 'tts' || plugin.type === 'image') continue;
      for (const modelId of pluginChatModels(plugin)) {
        if (seen.has(modelId)) continue;
        seen.add(modelId);
        models.push({
          id: modelId,
          providerType: 'plugin',
          providerId: plugin.id,
          ownedBy: plugin.id,
        });
      }
    }
  } catch (error) {
    logger.debug('Plugin models unavailable for the catalog:', error);
  }

  return models;
};
