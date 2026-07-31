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

import type { Plugin, PluginVariableDefinition } from '@/types';

export type PluginVariableInput = string | number | boolean;

export interface StoredPluginVariable {
  value: PluginVariableInput;
  is_sensitive: boolean;
  has_value: boolean;
}

export interface PluginVariableUpdate {
  variables: Record<string, PluginVariableInput>;
  unset: string[];
}

const CONNECTION_VARIABLE_NAMES = new Set([
  'api_mode',
  'api_path',
  'endpoint',
  'base_url',
  'api_url',
  'image_endpoint',
  'embedding_endpoint',
  'tts_endpoint',
  'model',
  'model_id',
  'models_endpoint',
]);

type PluginWithCapabilities = Plugin & {
  capabilities?: Record<
    string,
    {
      endpoint?: unknown;
      endpoint_variable?: unknown;
      config?: {
        endpoint_variable?: unknown;
      };
    }
  >;
};

export function getPluginConnectionVariableNames(
  plugin?: Plugin
): ReadonlySet<string> {
  const names = new Set(CONNECTION_VARIABLE_NAMES);
  const capabilities = (plugin as PluginWithCapabilities | undefined)
    ?.capabilities;

  for (const capability of Object.values(capabilities || {})) {
    const selector =
      capability?.config?.endpoint_variable ?? capability?.endpoint_variable;
    if (typeof selector === 'string' && selector.trim()) {
      names.add(selector);
    }
  }

  return names;
}

export function isConnectionPluginVariable(
  name: string,
  plugin?: Plugin
): boolean {
  return getPluginConnectionVariableNames(plugin).has(name);
}

export function isUrlPluginVariable(name: string): boolean {
  const normalized = name.toLowerCase();
  return (
    normalized === 'endpoint' ||
    normalized === 'base_url' ||
    normalized === 'api_url' ||
    normalized === 'models_endpoint' ||
    normalized.endsWith('_endpoint') ||
    normalized.endsWith('_base_url')
  );
}

export function getInheritedPluginVariableValue(
  definition: PluginVariableDefinition,
  plugin?: Plugin
): PluginVariableInput | undefined {
  if (definition.default !== undefined) {
    return definition.default;
  }

  if (!plugin) {
    return undefined;
  }

  if (definition.name === 'endpoint' || definition.name === 'api_url') {
    return plugin.endpoint || undefined;
  }

  if (definition.name === 'base_url') {
    return plugin.base_url;
  }

  if (definition.name === 'api_path') {
    return plugin.api_path;
  }

  if (definition.name === 'api_mode') {
    if (plugin.api_mode) {
      return plugin.api_mode;
    }

    try {
      const pathname = new URL(plugin.endpoint).pathname.replace(/\/+$/, '');
      return pathname.endsWith('/responses') ? 'responses' : 'chat_completions';
    } catch {
      return 'chat_completions';
    }
  }

  const capabilities = (plugin as PluginWithCapabilities).capabilities;
  for (const capability of Object.values(capabilities || {})) {
    const selector =
      capability?.config?.endpoint_variable ?? capability?.endpoint_variable;
    if (
      selector === definition.name &&
      typeof capability.endpoint === 'string'
    ) {
      return capability.endpoint;
    }
  }

  return undefined;
}

export function splitPluginVariableDefinitions(
  definitions: PluginVariableDefinition[],
  plugin?: Plugin
): {
  connection: PluginVariableDefinition[];
  advanced: PluginVariableDefinition[];
} {
  const connection: PluginVariableDefinition[] = [];
  const advanced: PluginVariableDefinition[] = [];

  for (const definition of definitions) {
    (isConnectionPluginVariable(definition.name, plugin)
      ? connection
      : advanced
    ).push(definition);
  }

  return { connection, advanced };
}

export function initializePluginVariableInputs(
  definitions: PluginVariableDefinition[],
  storedVariables: Record<string, StoredPluginVariable>
): Record<string, PluginVariableInput> {
  const inputs: Record<string, PluginVariableInput> = {};

  for (const definition of definitions) {
    const stored = storedVariables[definition.name];
    inputs[definition.name] =
      stored?.has_value && !stored.is_sensitive ? stored.value : '';
  }

  return inputs;
}

export function buildPluginVariableUpdate(
  definitions: PluginVariableDefinition[],
  inputs: Record<string, PluginVariableInput>,
  dirtyFields: ReadonlySet<string>,
  storedVariables: Record<string, StoredPluginVariable>,
  plugin?: Plugin
): PluginVariableUpdate {
  const schemaNames = new Set(definitions.map(definition => definition.name));
  const variables: Record<string, PluginVariableInput> = {};
  const unset: string[] = [];

  for (const name of dirtyFields) {
    if (!schemaNames.has(name)) continue;

    const definition = definitions.find(candidate => candidate.name === name);
    if (!definition) continue;

    const value = inputs[name];
    const stored = storedVariables[name];
    const isBlank = typeof value === 'string' && value.trim().length === 0;
    const inheritedValue = getInheritedPluginVariableValue(definition, plugin);
    const matchesInherited =
      inheritedValue !== undefined &&
      (typeof value === 'string' && typeof inheritedValue === 'string'
        ? value.trim() === inheritedValue.trim()
        : Object.is(value, inheritedValue));

    if (isBlank || matchesInherited) {
      if (definition.sensitive && stored?.has_value) continue;
      if (stored?.has_value) unset.push(name);
      continue;
    }

    variables[name] = value;
  }

  return { variables, unset };
}
