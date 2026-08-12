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

import { Plugin } from '../types/index.js';

export const PLUGIN_CONNECTION_VARIABLE_NAMES: ReadonlySet<string> = new Set([
  'endpoint',
  'base_url',
  'api_path',
  'models_endpoint',
  'api_url',
  'image_endpoint',
  'embedding_endpoint',
  'tts_endpoint',
  'voice_clone_endpoint',
  'api_mode',
  'model',
  'model_id',
]);

export function isPluginConnectionVariable(name: string): boolean {
  return PLUGIN_CONNECTION_VARIABLE_NAMES.has(name);
}

export function getPluginConnectionVariableNames(
  plugin: Pick<Plugin, 'capabilities'>
): ReadonlySet<string> {
  const names = new Set(PLUGIN_CONNECTION_VARIABLE_NAMES);
  for (const capability of Object.values(
    (plugin.capabilities || {}) as Record<string, unknown>
  )) {
    if (!capability || typeof capability !== 'object') continue;
    const capabilityRecord = capability as Record<string, unknown>;
    const config =
      capabilityRecord.config && typeof capabilityRecord.config === 'object'
        ? (capabilityRecord.config as Record<string, unknown>)
        : {};
    const selectors = [
      config.endpoint_variable ?? capabilityRecord.endpoint_variable,
      config.models_endpoint_variable,
      config.voice_clone_endpoint_variable,
    ];
    for (const selector of selectors) {
      if (typeof selector === 'string' && selector.trim()) {
        names.add(selector);
      }
    }
  }
  return names;
}

export function isPluginConnectionVariableForPlugin(
  plugin: Pick<Plugin, 'capabilities'>,
  name: string
): boolean {
  return getPluginConnectionVariableNames(plugin).has(name);
}
