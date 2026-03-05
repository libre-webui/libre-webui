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
  api_key: string;
  created_at: number;
  updated_at: number;
}

class PluginCredentialsService {
  async getApiKey(
    pluginId: string,
    keyEnv: string,
    userId?: string
  ): Promise<string | null> {
    const effectiveUserId = userId || 'default';
    const db = getDatabaseSafe();

    if (db) {
      try {
        const row = await db.get<{ api_key: string }>(
          'SELECT api_key FROM plugin_credentials WHERE plugin_id = ? AND user_id = ?',
          pluginId,
          effectiveUserId
        );
        if (row?.api_key) {
          const decryptedKey = encryptionService.decrypt(row.api_key);
          if (decryptedKey) return decryptedKey;
        }
      } catch (error) {
        console.error('Failed to get API key for plugin %s:', pluginId, error);
      }
    }

    return process.env[keyEnv] || null;
  }

  async getCredentials(
    userId?: string
  ): Promise<
    Array<{ plugin_id: string; has_api_key: boolean; updated_at: number }>
  > {
    const effectiveUserId = userId || 'default';
    const db = getDatabaseSafe();
    if (!db) return [];

    try {
      const rows = await db.all<{
        plugin_id: string;
        api_key: string;
        updated_at: number;
      }>(
        'SELECT plugin_id, api_key, updated_at FROM plugin_credentials WHERE user_id = ?',
        effectiveUserId
      );
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

  async setApiKey(
    pluginId: string,
    apiKey: string,
    userId?: string
  ): Promise<boolean> {
    const effectiveUserId = userId || 'default';
    const db = getDatabaseSafe();
    if (!db) {
      console.error('Database not available for storing plugin credentials');
      return false;
    }

    try {
      const now = Date.now();
      const encryptedKey = encryptionService.encrypt(apiKey);

      const existing = await db.get<{ id: string }>(
        'SELECT id FROM plugin_credentials WHERE plugin_id = ? AND user_id = ?',
        pluginId,
        effectiveUserId
      );

      if (existing) {
        await db.run(
          'UPDATE plugin_credentials SET api_key = ?, updated_at = ? WHERE id = ?',
          encryptedKey,
          now,
          existing.id
        );
      } else {
        await db.run(
          'INSERT INTO plugin_credentials (id, user_id, plugin_id, api_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
          uuidv4(),
          effectiveUserId,
          pluginId,
          encryptedKey,
          now,
          now
        );
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

  async deleteApiKey(pluginId: string, userId?: string): Promise<boolean> {
    const effectiveUserId = userId || 'default';
    const db = getDatabaseSafe();
    if (!db) return false;

    try {
      const result = await db.run(
        'DELETE FROM plugin_credentials WHERE plugin_id = ? AND user_id = ?',
        pluginId,
        effectiveUserId
      );
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

  async hasApiKey(
    pluginId: string,
    keyEnv: string,
    userId?: string
  ): Promise<boolean> {
    return (await this.getApiKey(pluginId, keyEnv, userId)) !== null;
  }

  async deleteAllUserCredentials(userId: string): Promise<boolean> {
    const db = getDatabaseSafe();
    if (!db) return false;
    try {
      await db.run('DELETE FROM plugin_credentials WHERE user_id = ?', userId);
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

  async deleteAllPluginCredentials(pluginId: string): Promise<boolean> {
    const db = getDatabaseSafe();
    if (!db) return false;
    try {
      await db.run(
        'DELETE FROM plugin_credentials WHERE plugin_id = ?',
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
