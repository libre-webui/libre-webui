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

import type { Plugin, PluginCapabilityType, PluginType } from '@/types';

export type PluginModelCapability =
  'Chat' | 'Embedding' | 'Image' | 'Speech' | 'Transcription';

export interface PluginProviderCatalogEntry {
  id: string;
  capabilities: PluginModelCapability[];
}

const CAPABILITY_ORDER: PluginModelCapability[] = [
  'Chat',
  'Image',
  'Speech',
  'Transcription',
  'Embedding',
];

const PRIMARY_CAPABILITY: Record<PluginType, PluginModelCapability> = {
  chat: 'Chat',
  completion: 'Chat',
  embedding: 'Embedding',
  image: 'Image',
  stt: 'Transcription',
  tts: 'Speech',
};

const PLUGIN_CAPABILITY: Record<PluginCapabilityType, PluginModelCapability> = {
  completion: 'Chat',
  embedding: 'Embedding',
  image: 'Image',
  stt: 'Transcription',
  tts: 'Speech',
};

export function buildPluginProviderCatalog(
  plugin: Plugin
): PluginProviderCatalogEntry[] {
  const catalog = new Map<string, Set<PluginModelCapability>>();

  const addModels = (
    modelIds: string[] | undefined,
    capability: PluginModelCapability
  ) => {
    for (const modelId of modelIds || []) {
      if (typeof modelId !== 'string' || !modelId.trim()) continue;
      const normalizedModelId = modelId.trim();
      const capabilities = catalog.get(normalizedModelId) ?? new Set();
      capabilities.add(capability);
      catalog.set(normalizedModelId, capabilities);
    }
  };

  addModels(plugin.model_map, PRIMARY_CAPABILITY[plugin.type]);

  for (const capabilityType of Object.keys(
    plugin.capabilities || {}
  ) as PluginCapabilityType[]) {
    addModels(
      plugin.capabilities?.[capabilityType]?.model_map,
      PLUGIN_CAPABILITY[capabilityType]
    );
  }

  return Array.from(catalog, ([id, capabilities]) => ({
    id,
    capabilities: CAPABILITY_ORDER.filter(capability =>
      capabilities.has(capability)
    ),
  }));
}

export function pluginSupportsModelRefresh(plugin: Plugin): boolean {
  return plugin.type === 'chat' || plugin.type === 'completion';
}

// A provider's model listing covers every modality it sells, so an
// auto-discovered catalog also carries speech, image and embedding models.
// They stay in the plugin's catalog for the pickers that want them; only the
// chat model list filters them out.
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

export function isChatCapableModelId(modelId: string): boolean {
  const normalized = modelId.toLocaleLowerCase();
  return !NON_CHAT_MODEL_PATTERNS.some(pattern => normalized.includes(pattern));
}

/**
 * Models a plugin can answer chat requests with: its catalog minus anything it
 * declares under another capability, minus well-known non-chat model families.
 */
export function getPluginChatModels(plugin: {
  model_map?: string[];
  capabilities?: Plugin['capabilities'];
}): string[] {
  const capabilityModels = new Set<string>();
  for (const [capabilityType, capability] of Object.entries(
    plugin.capabilities || {}
  ) as [PluginCapabilityType, { model_map?: string[] } | undefined][]) {
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
}

export function pluginMatchesProviderSearch(
  plugin: Plugin,
  query: string
): boolean {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return true;

  return [
    plugin.name,
    plugin.id,
    plugin.type,
    ...buildPluginProviderCatalog(plugin).map(model => model.id),
  ].some(value => value?.toLocaleLowerCase().includes(normalizedQuery));
}
