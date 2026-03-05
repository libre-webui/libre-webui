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

import { v4 as uuidv4 } from 'uuid';
import { getDatabaseSafe } from '../db.js';
import { encryptionService } from './encryptionService.js';
import { PluginVariableDefinition } from '../types/index.js';

interface VariableRow {
  id: string;
  variable_name: string;
  variable_value: string;
  is_encrypted: number;
  updated_at: number;
}

export interface PluginVariableValue {
  name: string;
  value: string | number | boolean;
  is_sensitive: boolean;
  has_value: boolean;
}

class PluginVariablesService {
  private resolvedCache = new Map<
    string,
    { data: Record<string, string | number | boolean>; expires: number }
  >();

  private getCacheKey(pluginId: string, userId: string): string {
    return `${pluginId}:${userId}`;
  }

  private invalidateCache(pluginId: string, userId?: string): void {
    if (userId) {
      this.resolvedCache.delete(this.getCacheKey(pluginId, userId));
    } else {
      for (const key of this.resolvedCache.keys()) {
        if (key.startsWith(`${pluginId}:`)) this.resolvedCache.delete(key);
      }
    }
  }

  async getVariables(
    pluginId: string,
    schema: PluginVariableDefinition[],
    userId?: string,
    forDisplay = false
  ): Promise<Record<string, PluginVariableValue>> {
    const effectiveUserId = userId || 'default';
    const db = getDatabaseSafe();
    const result: Record<string, PluginVariableValue> = {};

    for (const def of schema) {
      const isSensitive = def.sensitive ?? false;
      result[def.name] = {
        name: def.name,
        value: forDisplay && isSensitive ? '' : (def.default ?? ''),
        is_sensitive: isSensitive,
        has_value: false,
      };
    }

    if (!db) return result;

    try {
      const rows = await db.all<VariableRow>(
        'SELECT variable_name, variable_value, is_encrypted, updated_at FROM plugin_variables WHERE plugin_id = ? AND user_id = ?',
        pluginId,
        effectiveUserId
      );

      for (const row of rows) {
        const def = schema.find(d => d.name === row.variable_name);
        if (!def) continue;

        let value: string | number | boolean = row.variable_value;

        if (row.is_encrypted) {
          const decrypted = encryptionService.decrypt(row.variable_value);
          if (!decrypted) continue;
          value = decrypted;
        }

        if (def.type === 'number') value = Number(value);
        else if (def.type === 'boolean') value = String(value) === 'true';

        if (forDisplay && def.sensitive) {
          result[def.name] = {
            name: def.name,
            value: '••••••••',
            is_sensitive: true,
            has_value: true,
          };
        } else {
          result[def.name] = {
            name: def.name,
            value,
            is_sensitive: def.sensitive ?? false,
            has_value: true,
          };
        }
      }
    } catch (error) {
      console.error('Failed to get variables for plugin %s:', pluginId, error);
    }

    return result;
  }

  async getResolvedVariables(
    pluginId: string,
    schema: PluginVariableDefinition[],
    userId?: string
  ): Promise<Record<string, string | number | boolean>> {
    const effectiveUserId = userId || 'default';
    const cacheKey = this.getCacheKey(pluginId, effectiveUserId);
    const cached = this.resolvedCache.get(cacheKey);
    if (cached && cached.expires > Date.now()) return cached.data;

    const vars = await this.getVariables(pluginId, schema, userId, false);
    const result: Record<string, string | number | boolean> = {};
    for (const [key, val] of Object.entries(vars)) result[key] = val.value;

    this.resolvedCache.set(cacheKey, {
      data: result,
      expires: Date.now() + 5000,
    });
    return result;
  }

  async setVariables(
    pluginId: string,
    variables: Record<string, string | number | boolean>,
    schema: PluginVariableDefinition[],
    userId?: string
  ): Promise<boolean> {
    const effectiveUserId = userId || 'default';
    const db = getDatabaseSafe();
    if (!db) {
      console.error('Database not available for storing plugin variables');
      return false;
    }

    try {
      const now = Date.now();

      await db.transaction(async tx => {
        for (const [name, value] of Object.entries(variables)) {
          const def = schema.find(d => d.name === name);
          if (!def) continue;

          const stringValue = String(value);
          const isSensitive = def.sensitive ?? false;
          const storedValue = isSensitive
            ? encryptionService.encrypt(stringValue)
            : stringValue;

          const existing = await tx.get<{ id: string }>(
            'SELECT id FROM plugin_variables WHERE plugin_id = ? AND user_id = ? AND variable_name = ?',
            pluginId,
            effectiveUserId,
            name
          );

          if (existing) {
            await tx.run(
              'UPDATE plugin_variables SET variable_value = ?, is_encrypted = ?, updated_at = ? WHERE id = ?',
              storedValue,
              isSensitive ? 1 : 0,
              now,
              existing.id
            );
          } else {
            await tx.run(
              'INSERT INTO plugin_variables (id, user_id, plugin_id, variable_name, variable_value, is_encrypted, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
              uuidv4(),
              effectiveUserId,
              pluginId,
              name,
              storedValue,
              isSensitive ? 1 : 0,
              now,
              now
            );
          }
        }
      });

      this.invalidateCache(pluginId, effectiveUserId);
      return true;
    } catch (error) {
      console.error('Failed to set variables for plugin %s:', pluginId, error);
      return false;
    }
  }

  async deletePluginVariables(
    pluginId: string,
    userId?: string
  ): Promise<boolean> {
    const db = getDatabaseSafe();
    if (!db) return false;
    try {
      if (userId) {
        await db.run(
          'DELETE FROM plugin_variables WHERE plugin_id = ? AND user_id = ?',
          pluginId,
          userId
        );
      } else {
        await db.run(
          'DELETE FROM plugin_variables WHERE plugin_id = ?',
          pluginId
        );
      }
      this.invalidateCache(pluginId, userId);
      return true;
    } catch (error) {
      console.error(
        'Failed to delete variables for plugin %s:',
        pluginId,
        error
      );
      return false;
    }
  }

  async deleteUserVariables(userId: string): Promise<boolean> {
    const db = getDatabaseSafe();
    if (!db) return false;
    try {
      await db.run('DELETE FROM plugin_variables WHERE user_id = ?', userId);
      for (const key of this.resolvedCache.keys()) {
        if (key.endsWith(`:${userId}`)) this.resolvedCache.delete(key);
      }
      return true;
    } catch (error) {
      console.error(
        `Failed to delete all variables for user ${userId}:`,
        error
      );
      return false;
    }
  }
}

const pluginVariablesService = new PluginVariablesService();
export default pluginVariablesService;
