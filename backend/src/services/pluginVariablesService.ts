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
  /**
   * Get all variable values for a plugin, merged with schema defaults.
   * If forDisplay is true, sensitive values are masked.
   */
  getVariables(
    pluginId: string,
    schema: PluginVariableDefinition[],
    userId?: string,
    forDisplay = false
  ): Record<string, PluginVariableValue> {
    const effectiveUserId = userId || 'default';
    const db = getDatabaseSafe();
    const result: Record<string, PluginVariableValue> = {};

    // Initialize with defaults from schema
    for (const def of schema) {
      result[def.name] = {
        name: def.name,
        value: def.default ?? '',
        is_sensitive: def.sensitive ?? false,
        has_value: false,
      };
    }

    if (!db) return result;

    try {
      const rows = db
        .prepare(
          'SELECT variable_name, variable_value, is_encrypted, updated_at FROM plugin_variables WHERE plugin_id = ? AND user_id = ?'
        )
        .all(pluginId, effectiveUserId) as VariableRow[];

      for (const row of rows) {
        const def = schema.find(d => d.name === row.variable_name);
        if (!def) continue;

        let value: string | number | boolean = row.variable_value;

        // Decrypt if encrypted
        if (row.is_encrypted) {
          const decrypted = encryptionService.decrypt(row.variable_value);
          if (!decrypted) continue;
          value = decrypted;
        }

        // Cast to correct type
        if (def.type === 'number') {
          value = Number(value);
        } else if (def.type === 'boolean') {
          value = String(value) === 'true';
        }

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

  /**
   * Get resolved variable values for runtime use (decrypted, typed).
   */
  getResolvedVariables(
    pluginId: string,
    schema: PluginVariableDefinition[],
    userId?: string
  ): Record<string, string | number | boolean> {
    const vars = this.getVariables(pluginId, schema, userId, false);
    const result: Record<string, string | number | boolean> = {};
    for (const [key, val] of Object.entries(vars)) {
      result[key] = val.value;
    }
    return result;
  }

  /**
   * Set multiple variable values for a plugin.
   */
  setVariables(
    pluginId: string,
    variables: Record<string, string | number | boolean>,
    schema: PluginVariableDefinition[],
    userId?: string
  ): boolean {
    const effectiveUserId = userId || 'default';
    const db = getDatabaseSafe();

    if (!db) {
      console.error('Database not available for storing plugin variables');
      return false;
    }

    try {
      const now = Date.now();

      const transaction = db.transaction(() => {
        for (const [name, value] of Object.entries(variables)) {
          const def = schema.find(d => d.name === name);
          if (!def) continue;

          const stringValue = String(value);
          const isSensitive = def.sensitive ?? false;
          const storedValue = isSensitive
            ? encryptionService.encrypt(stringValue)
            : stringValue;

          const existing = db
            .prepare(
              'SELECT id FROM plugin_variables WHERE plugin_id = ? AND user_id = ? AND variable_name = ?'
            )
            .get(pluginId, effectiveUserId, name) as { id: string } | undefined;

          if (existing) {
            db.prepare(
              'UPDATE plugin_variables SET variable_value = ?, is_encrypted = ?, updated_at = ? WHERE id = ?'
            ).run(storedValue, isSensitive ? 1 : 0, now, existing.id);
          } else {
            const id = uuidv4();
            db.prepare(
              'INSERT INTO plugin_variables (id, user_id, plugin_id, variable_name, variable_value, is_encrypted, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
            ).run(
              id,
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

      transaction();
      return true;
    } catch (error) {
      console.error('Failed to set variables for plugin %s:', pluginId, error);
      return false;
    }
  }

  /**
   * Delete all variables for a plugin (reset to defaults).
   */
  deletePluginVariables(pluginId: string, userId?: string): boolean {
    const db = getDatabaseSafe();
    if (!db) return false;

    try {
      if (userId) {
        db.prepare(
          'DELETE FROM plugin_variables WHERE plugin_id = ? AND user_id = ?'
        ).run(pluginId, userId);
      } else {
        db.prepare('DELETE FROM plugin_variables WHERE plugin_id = ?').run(
          pluginId
        );
      }
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

  /**
   * Delete all variables for a user (used on account deletion).
   */
  deleteUserVariables(userId: string): boolean {
    const db = getDatabaseSafe();
    if (!db) return false;

    try {
      db.prepare('DELETE FROM plugin_variables WHERE user_id = ?').run(userId);
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
