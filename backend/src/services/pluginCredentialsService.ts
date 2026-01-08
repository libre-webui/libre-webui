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

export interface PluginCredential {
  id: string;
  user_id: string;
  plugin_id: string;
  api_key: string; // Decrypted API key (not stored in DB)
  created_at: number;
  updated_at: number;
}

interface _PluginCredentialRow {
  id: string;
  user_id: string;
  plugin_id: string;
  api_key: string; // Encrypted API key from DB
  created_at: number;
  updated_at: number;
}

class PluginCredentialsService {
  /**
   * Get API key for a specific plugin and user
   * Returns null if not found, with optional fallback to environment variable
   */
  getApiKey(pluginId: string, keyEnv: string, userId?: string): string | null {
    const effectiveUserId = userId || 'default';
    const db = getDatabaseSafe();

    if (db) {
      try {
        const row = db
          .prepare(
            'SELECT api_key FROM plugin_credentials WHERE plugin_id = ? AND user_id = ?'
          )
          .get(pluginId, effectiveUserId) as { api_key: string } | undefined;

        if (row?.api_key) {
          // Decrypt the API key
          const decryptedKey = encryptionService.decrypt(row.api_key);
          if (decryptedKey) {
            return decryptedKey;
          }
        }
      } catch (error) {
        console.error('Failed to get API key for plugin %s:', pluginId, error);
      }
    }

    // Fallback to environment variable
    return process.env[keyEnv] || null;
  }

  /**
   * Get all credentials for a user (API keys are masked for security)
   */
  getCredentials(userId?: string): Array<{
    plugin_id: string;
    has_api_key: boolean;
    updated_at: number;
  }> {
    const effectiveUserId = userId || 'default';
    const db = getDatabaseSafe();

    if (!db) {
      return [];
    }

    try {
      const rows = db
        .prepare(
          'SELECT plugin_id, api_key, updated_at FROM plugin_credentials WHERE user_id = ?'
        )
        .all(effectiveUserId) as Array<{
        plugin_id: string;
        api_key: string;
        updated_at: number;
      }>;

      return rows.map(row => ({
        plugin_id: row.plugin_id,
        has_api_key: Boolean(row.api_key),
        updated_at: row.updated_at,
      }));
    } catch (error) {
      console.error('Failed to get plugin credentials:', error);
      return [];
    }
  }

  /**
   * Set or update API key for a plugin
   */
  setApiKey(pluginId: string, apiKey: string, userId?: string): boolean {
    const effectiveUserId = userId || 'default';
    const db = getDatabaseSafe();

    if (!db) {
      console.error('Database not available for storing plugin credentials');
      return false;
    }

    try {
      const now = Date.now();
      const encryptedKey = encryptionService.encrypt(apiKey);

      // Check if credential already exists
      const existing = db
        .prepare(
          'SELECT id FROM plugin_credentials WHERE plugin_id = ? AND user_id = ?'
        )
        .get(pluginId, effectiveUserId) as { id: string } | undefined;

      if (existing) {
        // Update existing credential
        db.prepare(
          'UPDATE plugin_credentials SET api_key = ?, updated_at = ? WHERE id = ?'
        ).run(encryptedKey, now, existing.id);
      } else {
        // Insert new credential
        const id = uuidv4();
        db.prepare(
          'INSERT INTO plugin_credentials (id, user_id, plugin_id, api_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
        ).run(id, effectiveUserId, pluginId, encryptedKey, now, now);
      }

      console.log(
        `API key ${existing ? 'updated' : 'set'} for plugin ${pluginId} (user: ${effectiveUserId})`
      );
      return true;
    } catch (error) {
      console.error('Failed to set API key for plugin %s:', pluginId, error);
      return false;
    }
  }

  /**
   * Delete API key for a plugin
   */
  deleteApiKey(pluginId: string, userId?: string): boolean {
    const effectiveUserId = userId || 'default';
    const db = getDatabaseSafe();

    if (!db) {
      return false;
    }

    try {
      const result = db
        .prepare(
          'DELETE FROM plugin_credentials WHERE plugin_id = ? AND user_id = ?'
        )
        .run(pluginId, effectiveUserId);

      if (result.changes > 0) {
        console.log(
          `API key deleted for plugin ${pluginId} (user: ${effectiveUserId})`
        );
        return true;
      }
      return false;
    } catch (error) {
      console.error('Failed to delete API key for plugin %s:', pluginId, error);
      return false;
    }
  }

  /**
   * Check if a user has an API key set for a plugin
   */
  hasApiKey(pluginId: string, keyEnv: string, userId?: string): boolean {
    return this.getApiKey(pluginId, keyEnv, userId) !== null;
  }

  /**
   * Delete all credentials for a user (used when user account is deleted)
   */
  deleteAllUserCredentials(userId: string): boolean {
    const db = getDatabaseSafe();

    if (!db) {
      return false;
    }

    try {
      db.prepare('DELETE FROM plugin_credentials WHERE user_id = ?').run(
        userId
      );
      console.log(`All plugin credentials deleted for user ${userId}`);
      return true;
    } catch (error) {
      console.error(
        `Failed to delete all credentials for user ${userId}:`,
        error
      );
      return false;
    }
  }

  /**
   * Delete all credentials for a plugin (used when plugin is deleted)
   */
  deleteAllPluginCredentials(pluginId: string): boolean {
    const db = getDatabaseSafe();

    if (!db) {
      return false;
    }

    try {
      db.prepare('DELETE FROM plugin_credentials WHERE plugin_id = ?').run(
        pluginId
      );
      console.log(`All credentials deleted for plugin ${pluginId}`);
      return true;
    } catch (error) {
      console.error(
        `Failed to delete all credentials for plugin ${pluginId}:`,
        error
      );
      return false;
    }
  }
}

const pluginCredentialsService = new PluginCredentialsService();
export default pluginCredentialsService;
