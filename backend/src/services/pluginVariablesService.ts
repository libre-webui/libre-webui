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

import { getPersistence } from '../persistence/index.js';
import type { StoredPluginVariable } from '../persistence/extensionTypes.js';
import { encryptionService } from './encryptionService.js';
import { PluginVariableDefinition } from '../types/index.js';
import { createLogger } from '../utils/logger.js';
import { PLUGIN_CONNECTION_VARIABLE_NAMES } from '../utils/pluginConnectionVariables.js';
import {
  ensurePluginCacheInvalidationSubscription,
  publishPluginCacheInvalidation,
  registerPluginCacheInvalidationListener,
  type PluginCacheInvalidation,
} from './pluginCacheInvalidation.js';
import { randomUUID } from 'node:crypto';

const logger = createLogger('services:plugin-variables-service');

export interface PluginVariableValue {
  name: string;
  value: string | number | boolean;
  is_sensitive: boolean;
  has_value: boolean;
}

export class PluginVariablesService {
  // Cache resolved variables with a 5-second TTL to avoid DB reads on every request
  private resolvedCache = new Map<
    string,
    { data: Record<string, string | number | boolean>; expires: number }
  >();
  private cacheRevisions = new Map<string, number>();
  private removeInvalidationListener: (() => void) | undefined;

  private getCacheKey(pluginId: string, userId: string): string {
    return `${pluginId}:${userId}`;
  }

  private async ensureCacheInvalidation(): Promise<void> {
    this.removeInvalidationListener ??= registerPluginCacheInvalidationListener(
      invalidation => this.handleCacheInvalidation(invalidation)
    );
    await ensurePluginCacheInvalidationSubscription();
  }

  private bumpCacheRevision(key: string): void {
    this.cacheRevisions.set(key, (this.cacheRevisions.get(key) ?? 0) + 1);
  }

  private invalidateCache(pluginId: string, userId?: string): void {
    if (userId) {
      const key = this.getCacheKey(pluginId, userId);
      this.resolvedCache.delete(key);
      this.bumpCacheRevision(key);
    } else {
      // Invalidate all entries for this plugin
      const keys = new Set([
        ...this.resolvedCache.keys(),
        ...this.cacheRevisions.keys(),
      ]);
      for (const key of keys) {
        if (key.startsWith(`${pluginId}:`)) {
          this.resolvedCache.delete(key);
          this.bumpCacheRevision(key);
        }
      }
    }
  }

  private handleCacheInvalidation(invalidation: PluginCacheInvalidation): void {
    if (invalidation.scope === 'plugin-user') {
      this.invalidateCache(invalidation.pluginId, invalidation.userId);
      return;
    }
    if (invalidation.scope === 'plugin') {
      this.invalidateCache(invalidation.pluginId);
      return;
    }
    const suffix = `:${invalidation.userId}`;
    const keys = new Set([
      ...this.resolvedCache.keys(),
      ...this.cacheRevisions.keys(),
    ]);
    for (const key of keys) {
      if (key.endsWith(suffix)) {
        this.resolvedCache.delete(key);
        this.bumpCacheRevision(key);
      }
    }
  }

  /**
   * Get all variable values for a plugin, merged with schema defaults.
   * If forDisplay is true, sensitive values are masked.
   */
  async getVariables(
    pluginId: string,
    schema: PluginVariableDefinition[],
    userId?: string,
    forDisplay = false
  ): Promise<Record<string, PluginVariableValue>> {
    const effectiveUserId = userId || 'default';
    const result: Record<string, PluginVariableValue> = {};

    // Initialize with defaults from schema
    for (const def of schema) {
      const isSensitive = def.sensitive ?? false;
      result[def.name] = {
        name: def.name,
        value: forDisplay && isSensitive ? '' : (def.default ?? ''),
        is_sensitive: isSensitive,
        has_value: false,
      };
    }

    try {
      const rows = await this.repository().list(pluginId, effectiveUserId);

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
      logger.error('Failed to get variables for plugin %s:', pluginId, error);
    }

    return result;
  }

  /**
   * Get resolved variable values for runtime use (decrypted, typed).
   */
  async getResolvedVariables(
    pluginId: string,
    schema: PluginVariableDefinition[],
    userId?: string
  ): Promise<Record<string, string | number | boolean>> {
    await this.ensureCacheInvalidation();
    const effectiveUserId = userId || 'default';
    const cacheKey = this.getCacheKey(pluginId, effectiveUserId);
    const useProcessCache =
      getPersistence(encryptionService).dialect === 'sqlite';
    const cached = useProcessCache
      ? this.resolvedCache.get(cacheKey)
      : undefined;

    if (cached && cached.expires > Date.now()) {
      return cached.data;
    }

    const revision = this.cacheRevisions.get(cacheKey) ?? 0;
    const vars = await this.getVariables(pluginId, schema, userId, false);
    const result: Record<string, string | number | boolean> = {};
    for (const [key, val] of Object.entries(vars)) {
      result[key] = val.value;
    }

    if (
      useProcessCache &&
      revision === (this.cacheRevisions.get(cacheKey) ?? 0)
    ) {
      this.resolvedCache.set(cacheKey, {
        data: result,
        expires: Date.now() + 5000, // 5 second TTL
      });
    }

    return result;
  }

  /**
   * Whether this user stored a non-empty connection-routing override.
   * Schema defaults are manifest-owned and intentionally do not count.
   */
  async hasStoredConnectionOverride(
    pluginId: string,
    userId?: string,
    schema?: PluginVariableDefinition[],
    connectionVariableNames: ReadonlySet<string> = PLUGIN_CONNECTION_VARIABLE_NAMES
  ): Promise<boolean> {
    const effectiveUserId = userId || 'default';
    const configuredConnectionNames = schema
      ? new Set(
          schema
            .map(definition => definition.name)
            .filter(name => connectionVariableNames.has(name))
        )
      : undefined;

    try {
      const rows = await this.repository().list(pluginId, effectiveUserId);

      return rows.some(row => {
        if (!connectionVariableNames.has(row.variable_name)) return false;
        if (
          configuredConnectionNames &&
          !configuredConnectionNames.has(row.variable_name)
        ) {
          return false;
        }
        const value = row.is_encrypted
          ? encryptionService.decrypt(row.variable_value)
          : row.variable_value;
        return typeof value === 'string' && value.trim().length > 0;
      });
    } catch (error) {
      logger.error(
        'Failed to inspect connection overrides for plugin %s:',
        pluginId,
        error
      );
      // Credential fallback is the sensitive operation. Fail closed if the
      // stored routing state cannot be inspected.
      return true;
    }
  }

  /**
   * Set multiple variable values for a plugin.
   */
  async setVariables(
    pluginId: string,
    variables: Record<string, string | number | boolean>,
    schema: PluginVariableDefinition[],
    userId?: string,
    variablesToUnset: string[] = []
  ): Promise<boolean> {
    const effectiveUserId = userId || 'default';

    try {
      await this.ensureCacheInvalidation();
      const now = Date.now();
      const schemaNames = new Set(schema.map(definition => definition.name));
      const variableNames = Object.keys(variables);
      const unsetNames = [...new Set(variablesToUnset)];
      const unknownName = [...variableNames, ...unsetNames].find(
        name => !schemaNames.has(name)
      );
      if (unknownName) {
        logger.error(
          'Cannot store unknown variable %s for plugin %s',
          unknownName,
          pluginId
        );
        return false;
      }
      const submittedNames = new Set(variableNames);
      const overlap = unsetNames.find(name => submittedNames.has(name));
      if (overlap) {
        logger.error(
          'Cannot both set and unset variable %s for plugin %s',
          overlap,
          pluginId
        );
        return false;
      }

      const upserts: StoredPluginVariable[] = [];
      for (const [name, value] of Object.entries(variables)) {
        const def = schema.find(d => d.name === name);
        if (!def) continue;

        const stringValue = String(value);
        const isSensitive = def.sensitive ?? false;
        const storedValue = isSensitive
          ? encryptionService.encrypt(stringValue)
          : stringValue;

        upserts.push({
          id: randomUUID(),
          user_id: effectiveUserId,
          plugin_id: pluginId,
          variable_name: name,
          variable_value: storedValue,
          is_encrypted: isSensitive ? 1 : 0,
          created_at: now,
          updated_at: now,
        });
      }
      await this.repository().apply(pluginId, effectiveUserId, {
        unsetNames,
        upserts,
      });
      await publishPluginCacheInvalidation({
        version: 1,
        scope: 'plugin-user',
        pluginId,
        userId: effectiveUserId,
      });
      return true;
    } catch (error) {
      logger.error('Failed to set variables for plugin %s:', pluginId, error);
      return false;
    }
  }

  /**
   * Delete all variables for a plugin (reset to defaults).
   */
  async deletePluginVariables(
    pluginId: string,
    userId?: string
  ): Promise<boolean> {
    try {
      await this.ensureCacheInvalidation();
      await this.repository().delete(pluginId, userId);
      await publishPluginCacheInvalidation(
        userId
          ? { version: 1, scope: 'plugin-user', pluginId, userId }
          : { version: 1, scope: 'plugin', pluginId }
      );
      return true;
    } catch (error) {
      logger.error(
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
  async deleteUserVariables(userId: string): Promise<boolean> {
    try {
      await this.ensureCacheInvalidation();
      await this.repository().deleteByUser(userId);
      await publishPluginCacheInvalidation({
        version: 1,
        scope: 'user',
        userId,
      });
      return true;
    } catch (error) {
      logger.error(`Failed to delete all variables for user ${userId}:`, error);
      return false;
    }
  }

  private repository() {
    return getPersistence(encryptionService).repositories.extensions
      .pluginVariables;
  }

  async closeCacheInvalidation(): Promise<void> {
    this.removeInvalidationListener?.();
    this.removeInvalidationListener = undefined;
    this.resolvedCache.clear();
    this.cacheRevisions.clear();
  }
}

const pluginVariablesService = new PluginVariablesService();
export default pluginVariablesService;
