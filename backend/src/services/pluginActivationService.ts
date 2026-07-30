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

import fs from 'fs';
import path from 'path';
import { getDatabaseSafe } from '../db.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('services:plugin-activation-service');
const LEGACY_MIGRATION_KEY = 'plugin_activations_legacy_migrated_v1';

type LegacyStatus = {
  activePlugin?: unknown;
  activePlugins?: unknown;
  activePluginsByUser?: unknown;
};

export class PluginActivationService {
  migrateLegacyStatus(
    statusDirectories: string[],
    canMigratePlugin: (pluginId: string) => boolean = () => true
  ): void {
    const db = getDatabaseSafe();
    if (!db) return;

    try {
      const migrated = db
        .prepare('SELECT value FROM system_settings WHERE key = ?')
        .get(LEGACY_MIGRATION_KEY) as { value?: string } | undefined;
      if (migrated?.value === 'true') return;

      const status = this.readLegacyStatus(statusDirectories);
      const now = Date.now();
      const migrate = db.transaction(() => {
        const insertActivation = db.prepare(
          `INSERT OR IGNORE INTO plugin_activations
             (user_id, plugin_id, activated_at)
           VALUES (?, ?, ?)`
        );
        const users = db.prepare('SELECT id FROM users').all() as Array<{
          id: string;
        }>;
        const validUserIds = new Set(users.map(user => user.id));

        if (
          status?.activePluginsByUser &&
          typeof status.activePluginsByUser === 'object' &&
          !Array.isArray(status.activePluginsByUser)
        ) {
          for (const [userId, pluginIds] of Object.entries(
            status.activePluginsByUser
          )) {
            if (!validUserIds.has(userId) || !Array.isArray(pluginIds)) {
              continue;
            }
            for (const pluginId of validPluginIds(pluginIds).filter(
              canMigratePlugin
            )) {
              insertActivation.run(userId, pluginId, now);
            }
          }
        } else {
          const legacyPluginIds = Array.isArray(status?.activePlugins)
            ? validPluginIds(status.activePlugins).filter(canMigratePlugin)
            : typeof status?.activePlugin === 'string'
              ? [status.activePlugin].filter(canMigratePlugin)
              : [];
          for (const { id: userId } of users) {
            for (const pluginId of legacyPluginIds) {
              insertActivation.run(userId, pluginId, now);
            }
          }
        }

        db.prepare(
          `INSERT INTO system_settings (key, value, updated_at)
           VALUES (?, 'true', ?)
           ON CONFLICT(key) DO UPDATE SET
             value = excluded.value,
             updated_at = excluded.updated_at`
        ).run(LEGACY_MIGRATION_KEY, now);
      });

      migrate();
    } catch (error) {
      logger.error('Failed to migrate legacy plugin activation status:', error);
    }
  }

  getActivePluginIds(userId?: string): Set<string> {
    const db = getDatabaseSafe();
    if (!db) return new Set();

    try {
      const rows = db
        .prepare('SELECT plugin_id FROM plugin_activations WHERE user_id = ?')
        .all(userId || 'default') as Array<{ plugin_id: string }>;
      return new Set(rows.map(row => row.plugin_id));
    } catch (error) {
      logger.error('Failed to read plugin activations:', error);
      return new Set();
    }
  }

  activate(pluginId: string, userId?: string): boolean {
    const db = getDatabaseSafe();
    if (!db) return false;

    try {
      db.prepare(
        `INSERT INTO plugin_activations (user_id, plugin_id, activated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(user_id, plugin_id) DO UPDATE SET
           activated_at = excluded.activated_at`
      ).run(userId || 'default', pluginId, Date.now());
      return true;
    } catch (error) {
      logger.error('Failed to activate plugin %s:', pluginId, error);
      return false;
    }
  }

  deactivate(pluginId: string | undefined, userId?: string): boolean {
    const db = getDatabaseSafe();
    if (!db) return false;

    try {
      if (pluginId) {
        db.prepare(
          'DELETE FROM plugin_activations WHERE user_id = ? AND plugin_id = ?'
        ).run(userId || 'default', pluginId);
      } else {
        db.prepare('DELETE FROM plugin_activations WHERE user_id = ?').run(
          userId || 'default'
        );
      }
      return true;
    } catch (error) {
      logger.error('Failed to deactivate plugin:', error);
      return false;
    }
  }

  deletePlugin(pluginId: string): boolean {
    const db = getDatabaseSafe();
    if (!db) return false;

    try {
      db.prepare('DELETE FROM plugin_activations WHERE plugin_id = ?').run(
        pluginId
      );
      return true;
    } catch (error) {
      logger.error(
        'Failed to delete activation state for plugin %s:',
        pluginId,
        error
      );
      return false;
    }
  }

  private readLegacyStatus(
    statusDirectories: string[]
  ): LegacyStatus | undefined {
    for (const statusDirectory of Array.from(new Set(statusDirectories))) {
      const statusFile = path.join(statusDirectory, '.status.json');
      if (!fs.existsSync(statusFile)) continue;

      try {
        const status = JSON.parse(
          fs.readFileSync(statusFile, 'utf8')
        ) as unknown;
        if (status && typeof status === 'object' && !Array.isArray(status)) {
          return status as LegacyStatus;
        }
      } catch (error) {
        logger.error('Failed to load plugin status:', error);
      }
    }
    return undefined;
  }
}

function validPluginIds(values: unknown[]): string[] {
  return Array.from(
    new Set(
      values.filter(
        (pluginId): pluginId is string =>
          typeof pluginId === 'string' && pluginId.length > 0
      )
    )
  );
}

const pluginActivationService = new PluginActivationService();
export default pluginActivationService;
