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
 * The provider models the Strands engine may drive, and how a selection maps
 * back onto the Libre WebUI provider that serves it. The engine never talks to
 * a provider directly: every call goes through the same Ollama and plugin
 * services Chat uses, so credentials, usage metering, and the Ollama switch
 * apply unchanged.
 */

import type { Plugin } from '../types/index.js';
import pluginService from '../services/pluginService.js';
import ollamaService from '../services/ollamaService.js';
import { getOllamaRuntimeSettings } from '../services/ollamaSettingsService.js';
import preferencesService, {
  instanceDefaultModel,
} from '../services/preferencesService.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('strands-catalog');

/** Chat selector for the engine's default model. */
export const STRANDS_AGENT_ID = 'strands';
const STRANDS_SELECTOR_PREFIX = `${STRANDS_AGENT_ID}:`;

export type StrandsProviderRoute =
  | { type: 'ollama'; model: string }
  | { type: 'plugin'; model: string; pluginId: string };

export interface StrandsCatalogModel {
  /** Route id, `ollama:<model>` or `plugin:<pluginId>:<model>`, URI encoded. */
  readonly id: string;
  readonly name: string;
  readonly providerType: 'ollama' | 'plugin';
  readonly providerId: string | null;
  readonly providerName: string;
}

export interface ResolvedStrandsRoute {
  readonly id: string;
  readonly route: StrandsProviderRoute;
  readonly plugin?: Plugin;
}

export class StrandsModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StrandsModelError';
  }
}

export function strandsModelRouteId(route: StrandsProviderRoute): string {
  return route.type === 'ollama'
    ? `ollama:${encodeURIComponent(route.model)}`
    : `plugin:${encodeURIComponent(route.pluginId)}:${encodeURIComponent(route.model)}`;
}

/** Parse a route id. Returns undefined for a bare model name. */
export function parseStrandsModelRoute(
  id: string
): StrandsProviderRoute | undefined {
  const parts = id.split(':');
  try {
    if (parts[0] === 'ollama' && parts.length === 2 && parts[1]) {
      return { type: 'ollama', model: decodeURIComponent(parts[1]) };
    }
    if (parts[0] === 'plugin' && parts.length === 3 && parts[1] && parts[2]) {
      return {
        type: 'plugin',
        pluginId: decodeURIComponent(parts[1]),
        model: decodeURIComponent(parts[2]),
      };
    }
  } catch {
    throw new StrandsModelError('The Strands model route is invalid.');
  }
  if (parts[0] === 'ollama' || parts[0] === 'plugin') {
    throw new StrandsModelError('The Strands model route is invalid.');
  }
  return undefined;
}

/**
 * Strip the chat selector prefix. `strands` alone means the engine default;
 * `strands:<route>` pins a model. Anything else is returned as given.
 */
export function strandsSelectorModel(selector: string): string | undefined {
  const value = selector.trim();
  if (value === STRANDS_AGENT_ID) return undefined;
  if (value.startsWith(STRANDS_SELECTOR_PREFIX)) {
    const model = value.slice(STRANDS_SELECTOR_PREFIX.length).trim();
    return model || undefined;
  }
  return value || undefined;
}

function isEmbeddingModel(id: string): boolean {
  const name = id.toLowerCase();
  return (
    name.includes('embed') ||
    name.includes('minilm') ||
    name.includes('bge-') ||
    name.includes('rerank')
  );
}

function isChatModelId(id: string): boolean {
  return (
    typeof id === 'string' &&
    id.trim().length > 0 &&
    id.length <= 512 &&
    // eslint-disable-next-line no-control-regex
    !/[\u0000-\u001f\u007f]/.test(id) &&
    !id.startsWith('persona:') &&
    !id.startsWith(STRANDS_SELECTOR_PREFIX) &&
    !isEmbeddingModel(id)
  );
}

async function requirePluginRoute(
  route: Extract<StrandsProviderRoute, { type: 'plugin' }>,
  userId: string
): Promise<Plugin> {
  let plugin: Plugin | null;
  try {
    plugin = await pluginService.getActivePluginForModel(
      route.model,
      userId,
      route.pluginId
    );
  } catch {
    plugin = null;
  }
  if (!plugin || (plugin.type !== 'chat' && plugin.type !== 'completion')) {
    throw new StrandsModelError(
      'The selected Strands provider is unavailable.'
    );
  }
  return plugin;
}

async function requireOllamaEnabled(): Promise<void> {
  if (!(await getOllamaRuntimeSettings()).enabled) {
    throw new StrandsModelError(
      'Ollama is disabled. Choose a plugin model for the Strands engine.'
    );
  }
}

/** Every chat model the engine may drive for this account. */
export async function listStrandsModels(
  userId: string
): Promise<StrandsCatalogModel[]> {
  const models = new Map<string, StrandsCatalogModel>();
  try {
    const local = (await getOllamaRuntimeSettings()).enabled
      ? await ollamaService.getModels()
      : [];
    for (const model of local) {
      if (!isChatModelId(model.name)) continue;
      const id = strandsModelRouteId({ type: 'ollama', model: model.name });
      models.set(id, {
        id,
        name: model.name,
        providerType: 'ollama',
        providerId: null,
        providerName: 'Ollama',
      });
    }
  } catch (error) {
    logger.debug('Ollama models are unavailable to the Strands engine', {
      error,
    });
  }
  try {
    const statuses = await pluginService.getPluginStatus(userId);
    for (const plugin of await pluginService.getActivePlugins(userId)) {
      if (
        (plugin.type !== 'completion' && plugin.type !== 'chat') ||
        !statuses.some(status => status.id === plugin.id && status.available)
      ) {
        continue;
      }
      for (const model of plugin.model_map) {
        if (!isChatModelId(model)) continue;
        const id = strandsModelRouteId({
          type: 'plugin',
          model,
          pluginId: plugin.id,
        });
        models.set(id, {
          id,
          name: model,
          providerType: 'plugin',
          providerId: plugin.id,
          providerName: plugin.name,
        });
      }
    }
  } catch (error) {
    logger.debug('Plugin models are unavailable to the Strands engine', {
      error,
    });
  }
  return [...models.values()];
}

/**
 * Resolve a model selection to a concrete provider route. Accepts a route id,
 * a chat selector (`strands`, `strands:<route>`), a bare model name, or
 * nothing, in which case the account's default chat model is used.
 */
export async function resolveStrandsRoute(
  requested: string | undefined,
  userId: string
): Promise<ResolvedStrandsRoute> {
  const selected = requested ? strandsSelectorModel(requested) : undefined;
  const preferences = await preferencesService
    .getPreferences(userId)
    .catch(() => undefined);
  const model =
    selected ??
    (preferences?.defaultProviderType === 'agent'
      ? undefined
      : preferences?.defaultModel || instanceDefaultModel() || undefined);

  if (model) {
    const qualified = parseStrandsModelRoute(model);
    if (qualified) {
      if (!isChatModelId(qualified.model)) {
        throw new StrandsModelError('Choose a chat model for Strands.');
      }
      if (qualified.type === 'plugin') {
        const plugin = await requirePluginRoute(qualified, userId);
        return { id: strandsModelRouteId(qualified), route: qualified, plugin };
      }
      await requireOllamaEnabled();
      return { id: strandsModelRouteId(qualified), route: qualified };
    }
    if (!isChatModelId(model)) {
      throw new StrandsModelError(
        'Choose a provider chat model for Strands; personas and agent selectors cannot be used.'
      );
    }
    const preferred = preferences?.defaultModel === model;
    if (
      preferred &&
      preferences?.defaultProviderType === 'plugin' &&
      preferences.defaultProviderId
    ) {
      const route = {
        type: 'plugin' as const,
        model,
        pluginId: preferences.defaultProviderId,
      };
      const plugin = await requirePluginRoute(route, userId);
      return { id: strandsModelRouteId(route), route, plugin };
    }
    const ollamaEnabled = (await getOllamaRuntimeSettings()).enabled;
    if (ollamaEnabled) {
      const local = await ollamaService.getModels().catch(() => []);
      if (
        (preferred && preferences?.defaultProviderType === 'ollama') ||
        local.some(candidate => candidate.name === model)
      ) {
        const route = { type: 'ollama' as const, model };
        return { id: strandsModelRouteId(route), route };
      }
    }
    const plugin = await pluginService
      .getActivePluginForModel(model, userId)
      .catch(() => null);
    if (plugin && (plugin.type === 'chat' || plugin.type === 'completion')) {
      const route = { type: 'plugin' as const, model, pluginId: plugin.id };
      return { id: strandsModelRouteId(route), route, plugin };
    }
    if (selected) {
      throw new StrandsModelError(
        `The model "${model}" is not available to the Strands engine.`
      );
    }
  }

  const first = (await listStrandsModels(userId))[0];
  if (!first) {
    throw new StrandsModelError(
      'No chat model is available to the Strands engine. Enable Ollama or a chat plugin first.'
    );
  }
  return resolveStrandsRoute(first.id, userId);
}

/** Plain text target for titles and summaries, with no agent loop. */
export async function resolveStrandsProviderTarget(
  requested: string,
  userId: string
): Promise<{
  model: string;
  providerType: 'ollama' | 'plugin';
  providerId: string | null;
}> {
  const { route } = await resolveStrandsRoute(requested, userId);
  return route.type === 'plugin'
    ? { model: route.model, providerType: 'plugin', providerId: route.pluginId }
    : { model: route.model, providerType: 'ollama', providerId: null };
}
