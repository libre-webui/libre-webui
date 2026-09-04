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
import { encryptionService } from './encryptionService.js';
import { createLogger } from '../utils/logger.js';
import { randomUUID } from 'node:crypto';

const logger = createLogger('services:plugin-credentials-service');

export interface PluginCredential {
  id: string;
  user_id: string;
  plugin_id: string;
  api_key: string; // Decrypted API key (not stored in DB)
  created_at: number;
  updated_at: number;
}

class PluginCredentialsService {
  /**
   * Get only the API key stored for a specific plugin and user.
   */
  async getStoredApiKey(
    pluginId: string,
    userId: string | undefined,
    options: {
      expectedRoutingAuthFingerprint: string;
      allowLegacyUnboundCredential: boolean;
    }
  ): Promise<string | null> {
    const effectiveUserId = userId || 'default';
    try {
      const row = await this.repository().find(pluginId, effectiveUserId);
      if (row?.api_key) {
        const bindingMatches =
          row.routing_auth_fingerprint ===
          options.expectedRoutingAuthFingerprint;
        const trustedLegacyCredential =
          row.routing_auth_fingerprint === null &&
          options.allowLegacyUnboundCredential;
        if (!bindingMatches && !trustedLegacyCredential) {
          return null;
        }
        if (trustedLegacyCredential) {
          if (
            !(await this.repository().bindLegacy(
              row.id,
              options.expectedRoutingAuthFingerprint
            ))
          ) {
            return null;
          }
        }

        // Decrypt the API key
        const decryptedKey = encryptionService.decrypt(row.api_key);
        if (decryptedKey) {
          return decryptedKey;
        }
      }
    } catch (error) {
      logger.error('Failed to get API key for plugin %s:', pluginId, error);
    }

    return null;
  }

  /**
   * Get an API key for a specific plugin and user.
   * Environment fallback must be disabled when the effective route comes from
   * a user-stored connection override.
   */
  async getApiKey(
    pluginId: string,
    keyEnv: string,
    userId: string | undefined,
    options: {
      allowEnvironmentFallback: boolean;
      expectedRoutingAuthFingerprint: string;
      allowLegacyUnboundCredential: boolean;
    }
  ): Promise<string | null> {
    const storedApiKey = await this.getStoredApiKey(pluginId, userId, options);
    if (storedApiKey) return storedApiKey;
    if (!options.allowEnvironmentFallback) return null;
    return process.env[keyEnv] || null;
  }

  /**
   * Get all credentials for a user (API keys are masked for security)
   */
  async getCredentials(userId?: string): Promise<
    Array<{
      plugin_id: string;
      has_api_key: boolean;
      updated_at: number;
    }>
  > {
    const effectiveUserId = userId || 'default';

    try {
      const rows = await this.repository().listByUser(effectiveUserId);

      return rows.map(row => ({
        plugin_id: row.plugin_id,
        has_api_key: Boolean(row.api_key),
        updated_at: row.updated_at,
      }));
    } catch (error) {
      logger.error('Failed to get plugin credentials:', error);
      return [];
    }
  }

  /**
   * Set or update API key for a plugin
   */
  async setApiKey(
    pluginId: string,
    apiKey: string,
    userId: string | undefined,
    routingAuthFingerprint: string
  ): Promise<boolean> {
    const effectiveUserId = userId || 'default';
    if (!routingAuthFingerprint) {
      logger.error('Routing/auth binding is required for plugin credentials');
      return false;
    }

    try {
      const now = Date.now();
      const encryptedKey = encryptionService.encrypt(apiKey);

      const existing = await this.repository().find(pluginId, effectiveUserId);
      await this.repository().upsert({
        id: existing?.id ?? randomUUID(),
        user_id: effectiveUserId,
        plugin_id: pluginId,
        api_key: encryptedKey,
        routing_auth_fingerprint: routingAuthFingerprint,
        created_at: existing?.created_at ?? now,
        updated_at: now,
      });

      logger.debug(
        `API key ${existing ? 'updated' : 'set'} for plugin ${pluginId} (user: ${effectiveUserId})`
      );
      return true;
    } catch (error) {
      logger.error('Failed to set API key for plugin %s:', pluginId, error);
      return false;
    }
  }

  /**
   * Delete API key for a plugin
   */
  async deleteApiKey(pluginId: string, userId?: string): Promise<boolean> {
    const effectiveUserId = userId || 'default';

    try {
      const deleted = await this.repository().delete(pluginId, effectiveUserId);
      if (deleted) {
        logger.debug(
          `API key deleted for plugin ${pluginId} (user: ${effectiveUserId})`
        );
        return true;
      }
      return false;
    } catch (error) {
      logger.error('Failed to delete API key for plugin %s:', pluginId, error);
      return false;
    }
  }

  /**
   * Delete all credentials for a user (used when user account is deleted)
   */
  async deleteAllUserCredentials(userId: string): Promise<boolean> {
    try {
      await this.repository().deleteByUser(userId);
      logger.debug(`All plugin credentials deleted for user ${userId}`);
      return true;
    } catch (error) {
      logger.error(
        `Failed to delete all credentials for user ${userId}:`,
        error
      );
      return false;
    }
  }

  /**
   * Delete all credentials for a plugin (used when plugin is deleted)
   */
  async deleteAllPluginCredentials(pluginId: string): Promise<boolean> {
    try {
      await this.repository().deleteByPlugin(pluginId);
      logger.debug(`All credentials deleted for plugin ${pluginId}`);
      return true;
    } catch (error) {
      logger.error(
        `Failed to delete all credentials for plugin ${pluginId}:`,
        error
      );
      return false;
    }
  }

  private repository() {
    return getPersistence(encryptionService).repositories.extensions
      .pluginCredentials;
  }
}

const pluginCredentialsService = new PluginCredentialsService();
export default pluginCredentialsService;
