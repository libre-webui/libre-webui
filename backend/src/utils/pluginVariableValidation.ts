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
import { isSafePluginEndpoint } from './pluginValidation.js';

export type ValidatedPluginVariables = Record<
  string,
  string | number | boolean
>;

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

    if (key === 'endpoint') {
      const endpoint = str.trim();
      if (endpoint.length === 0) {
        validated[key] = '';
        continue;
      }

      try {
        if (!isSafePluginEndpoint(endpoint)) {
          return {
            success: false,
            error:
              'Variable "endpoint" must use HTTPS for remote URLs, or HTTP ' +
              'for localhost and private IPv4 addresses',
          };
        }
      } catch {
        return {
          success: false,
          error: `Variable "${key}" must be a valid URL`,
        };
      }

      validated[key] = endpoint;
      continue;
    }

    validated[key] = str;
  }

  return { success: true, variables: validated };
}
