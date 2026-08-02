/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import type {
  ChatModelSelection,
  ChatProviderType,
  OllamaModel,
} from '@/types';

const PERSONA_PREFIX = 'persona:';
const PLUGIN_PREFIX = 'plugin:';
const OLLAMA_PREFIX = 'ollama:';
const LEGACY_PREFIX = 'legacy:';
const AGENT_PREFIX = 'agent:';

const decode = (value: string): string | null => {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
};

export function chatModelSelectionFromModel(
  model: OllamaModel
): ChatModelSelection {
  if (model.isLegacySelection) {
    return {
      model: model.name,
      providerType: null,
      providerId: null,
    };
  }

  if (model.isPersona) {
    return {
      model: model.name,
      providerType: 'ollama',
      providerId: null,
    };
  }

  if (model.isPlugin && model.pluginId) {
    return {
      model: model.name,
      providerType: 'plugin',
      providerId: model.pluginId,
    };
  }

  if (model.isAgent) {
    return {
      model: model.name,
      providerType: 'agent',
      providerId: model.agentId || model.name,
    };
  }

  return {
    model: model.name,
    providerType: 'ollama',
    providerId: null,
  };
}

export function chatModelSelectionKey(selection: ChatModelSelection): string {
  if (!selection.providerType) {
    return `${LEGACY_PREFIX}${encodeURIComponent(selection.model)}`;
  }

  if (selection.providerType === 'plugin' && selection.providerId) {
    return `${PLUGIN_PREFIX}${encodeURIComponent(
      selection.providerId
    )}:${encodeURIComponent(selection.model)}`;
  }

  if (selection.providerType === 'agent' && selection.providerId) {
    return `${AGENT_PREFIX}${encodeURIComponent(
      selection.providerId
    )}:${encodeURIComponent(selection.model)}`;
  }

  if (
    selection.providerType === 'ollama' &&
    selection.model.startsWith(PERSONA_PREFIX)
  ) {
    return `${PERSONA_PREFIX}${encodeURIComponent(
      selection.model.slice(PERSONA_PREFIX.length)
    )}`;
  }

  if (selection.providerType === 'ollama') {
    return `${OLLAMA_PREFIX}${encodeURIComponent(selection.model)}`;
  }

  return `${LEGACY_PREFIX}${encodeURIComponent(selection.model)}`;
}

export function chatModelOptionKey(model: OllamaModel): string {
  return chatModelSelectionKey(chatModelSelectionFromModel(model));
}

export function decodeChatModelSelectionKey(
  key: string
): ChatModelSelection | null {
  if (key.startsWith(PERSONA_PREFIX)) {
    const personaId = decode(key.slice(PERSONA_PREFIX.length));
    return personaId === null
      ? null
      : {
          model: `${PERSONA_PREFIX}${personaId}`,
          providerType: 'ollama',
          providerId: null,
        };
  }

  if (key.startsWith(PLUGIN_PREFIX)) {
    const encoded = key.slice(PLUGIN_PREFIX.length);
    const separatorIndex = encoded.indexOf(':');
    if (separatorIndex < 1) return null;

    const providerId = decode(encoded.slice(0, separatorIndex));
    const model = decode(encoded.slice(separatorIndex + 1));
    return providerId && model
      ? { model, providerType: 'plugin', providerId }
      : null;
  }

  if (key.startsWith(AGENT_PREFIX)) {
    const encoded = key.slice(AGENT_PREFIX.length);
    const separatorIndex = encoded.indexOf(':');
    if (separatorIndex < 1) return null;

    const providerId = decode(encoded.slice(0, separatorIndex));
    const model = decode(encoded.slice(separatorIndex + 1));
    return providerId && model
      ? { model, providerType: 'agent', providerId }
      : null;
  }

  if (key.startsWith(OLLAMA_PREFIX)) {
    const model = decode(key.slice(OLLAMA_PREFIX.length));
    return model ? { model, providerType: 'ollama', providerId: null } : null;
  }

  if (key.startsWith(LEGACY_PREFIX)) {
    const model = decode(key.slice(LEGACY_PREFIX.length));
    return model ? { model, providerType: null, providerId: null } : null;
  }

  return null;
}

export function findChatModelForSelection(
  models: OllamaModel[],
  selection: ChatModelSelection
): OllamaModel | undefined {
  if (selection.providerType === 'plugin') {
    return models.find(
      model =>
        model.isPlugin &&
        model.pluginId === selection.providerId &&
        model.name === selection.model
    );
  }

  if (selection.providerType === 'agent') {
    return models.find(
      model => model.isAgent && model.name === selection.model
    );
  }

  if (selection.providerType === 'ollama') {
    if (selection.model.startsWith(PERSONA_PREFIX)) {
      return models.find(
        model => model.isPersona && model.name === selection.model
      );
    }

    return models.find(
      model =>
        !model.isPlugin && !model.isPersona && model.name === selection.model
    );
  }

  // Legacy records did not save a provider. Preserve their historic
  // name-only behavior instead of inventing provider metadata.
  return (
    models.find(
      model => model.isLegacySelection && model.name === selection.model
    ) ?? models.find(model => model.name === selection.model)
  );
}

export function chatModelSelectionKeyForModels(
  models: OllamaModel[],
  selection: ChatModelSelection
): string {
  if (!selection.providerType) {
    return chatModelSelectionKey(selection);
  }

  const model = findChatModelForSelection(models, selection);
  return model ? chatModelOptionKey(model) : chatModelSelectionKey(selection);
}

export function chatModelSelectionFromKey(
  models: OllamaModel[],
  key: string
): ChatModelSelection | null {
  const option = models.find(model => chatModelOptionKey(model) === key);
  return option
    ? chatModelSelectionFromModel(option)
    : decodeChatModelSelectionKey(key);
}

export function isAvailableOllamaModel(model: OllamaModel): boolean {
  return (
    !model.isPlugin &&
    !model.isPersona &&
    !model.isAgent &&
    !model.isLegacySelection &&
    !model.isUnavailable
  );
}

export function isChatModelSelectionAvailable(
  models: OllamaModel[],
  selection: ChatModelSelection
): boolean {
  if (!selection.model) return false;

  const concreteModels = models.filter(
    model => !model.isLegacySelection && !model.isUnavailable
  );
  return Boolean(findChatModelForSelection(concreteModels, selection));
}

export function withUnavailableChatModel(
  models: OllamaModel[],
  selection: ChatModelSelection
): OllamaModel[] {
  if (!selection.model) {
    return models;
  }

  if (!selection.providerType) {
    if (
      models.some(
        model => model.isLegacySelection && model.name === selection.model
      )
    ) {
      return models;
    }

    const hasNamedModel = Boolean(findChatModelForSelection(models, selection));
    return [
      ...models,
      {
        name: selection.model,
        model: selection.model,
        size: 0,
        digest: '',
        modified_at: '',
        details: {},
        isLegacySelection: true,
        isUnavailable: !hasNamedModel,
      },
    ];
  }

  if (findChatModelForSelection(models, selection)) {
    return models;
  }

  const providerType: ChatProviderType = selection.providerType;
  const isPersona =
    providerType === 'ollama' && selection.model.startsWith(PERSONA_PREFIX);
  const providerId =
    providerType === 'plugin' ? selection.providerId || undefined : undefined;

  return [
    ...models,
    {
      name: selection.model,
      model: selection.model,
      size: 0,
      digest: '',
      modified_at: '',
      details: {},
      isPlugin: providerType === 'plugin',
      pluginId: providerId,
      pluginName: providerId,
      isAgent: providerType === 'agent',
      agentId:
        providerType === 'agent'
          ? selection.providerId || undefined
          : undefined,
      isPersona,
      personaName: isPersona
        ? selection.model.slice(PERSONA_PREFIX.length)
        : undefined,
      isUnavailable: true,
    },
  ];
}
