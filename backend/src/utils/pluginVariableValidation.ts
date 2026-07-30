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

import type { PluginVariableDefinition } from '../types/index.js';

export type ValidatedPluginVariables = Record<
  string,
  string | number | boolean
>;

export function validatePluginVariablesToUnset(
  definitions: PluginVariableDefinition[],
  value: unknown
): { success: true; variables: string[] } | { success: false; error: string } {
  if (value === undefined) {
    return { success: true, variables: [] };
  }

  if (!Array.isArray(value)) {
    return {
      success: false,
      error: 'Variable names to unset must be an array',
    };
  }

  const schemaNames = new Set(definitions.map(definition => definition.name));
  const variables: string[] = [];
  const seen = new Set<string>();

  for (const name of value) {
    if (typeof name !== 'string' || !schemaNames.has(name)) {
      return {
        success: false,
        error: `Cannot unset unknown plugin variable "${String(name)}"`,
      };
    }

    if (!seen.has(name)) {
      seen.add(name);
      variables.push(name);
    }
  }

  return { success: true, variables };
}

export function validatePluginVariables(
  definitions: PluginVariableDefinition[],
  values: Record<string, unknown>
):
  | { success: true; variables: ValidatedPluginVariables }
  | { success: false; error: string } {
  const schemaMap = new Map(
    definitions.map(definition => [definition.name, definition])
  );
  const validated: ValidatedPluginVariables = {};

  for (const [key, value] of Object.entries(values)) {
    const definition = schemaMap.get(key);
    if (!definition) continue;

    if (definition.type === 'number') {
      const num = Number(value);
      if (isNaN(num)) {
        return { success: false, error: `Variable "${key}" must be a number` };
      }
      if (definition.min !== undefined && num < definition.min) {
        return {
          success: false,
          error: `Variable "${key}" must be >= ${definition.min}`,
        };
      }
      if (definition.max !== undefined && num > definition.max) {
        return {
          success: false,
          error: `Variable "${key}" must be <= ${definition.max}`,
        };
      }
      validated[key] = num;
      continue;
    }

    if (definition.type === 'boolean') {
      validated[key] = value === true || value === 'true';
      continue;
    }

    if (definition.type === 'select') {
      if (definition.options && !definition.options.includes(String(value))) {
        return {
          success: false,
          error: `Variable "${key}" must be one of: ${definition.options.join(', ')}`,
        };
      }
      validated[key] = String(value);
      continue;
    }

    const str = String(value);
    if (str.length > 2048) {
      return {
        success: false,
        error: `Variable "${key}" exceeds maximum length of 2048 characters`,
      };
    }

    if (key === 'endpoint' && str.length > 0) {
      try {
        new URL(str);
      } catch {
        return {
          success: false,
          error: `Variable "${key}" must be a valid URL`,
        };
      }
    }

    validated[key] = str;
  }

  return { success: true, variables: validated };
}
