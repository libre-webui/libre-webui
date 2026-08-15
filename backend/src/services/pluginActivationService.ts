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
import { getPersistence } from '../persistence/index.js';
import { createLogger } from '../utils/logger.js';
import { encryptionService } from './encryptionService.js';

const logger = createLogger('services:plugin-activation-service');
const LEGACY_MIGRATION_KEY = 'plugin_activations_legacy_migrated_v1';

type LegacyStatus = {
  activePlugin?: unknown;
  activePlugins?: unknown;
  activePluginsByUser?: unknown;
};

export class PluginActivationService {
  async migrateLegacyStatus(
    statusDirectories: string[],
    canMigratePlugin: (pluginId: string) => boolean = () => true
  ): Promise<void> {
    try {
      const status = this.readLegacyStatus(statusDirectories);
      const now = Date.now();
      const users = await this.repository().listUserIds();
      const validUserIds = new Set(users);
      const activations = new Map<string, readonly string[]>();

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
          activations.set(
            userId,
            validPluginIds(pluginIds).filter(canMigratePlugin)
          );
        }
      } else {
        const legacyPluginIds = Array.isArray(status?.activePlugins)
          ? validPluginIds(status.activePlugins).filter(canMigratePlugin)
          : typeof status?.activePlugin === 'string'
            ? [status.activePlugin].filter(canMigratePlugin)
            : [];
        for (const userId of users) activations.set(userId, legacyPluginIds);
      }
      await this.repository().migrateLegacy(
        activations,
        now,
        LEGACY_MIGRATION_KEY
      );
    } catch (error) {
      logger.error('Failed to migrate legacy plugin activation status:', error);
    }
  }

  async getActivePluginIds(userId?: string): Promise<Set<string>> {
    try {
      return new Set(await this.repository().list(userId || 'default'));
    } catch (error) {
      logger.error('Failed to read plugin activations:', error);
      return new Set();
    }
  }

  async activate(pluginId: string, userId?: string): Promise<boolean> {
    try {
      await this.repository().activate(
        pluginId,
        userId || 'default',
        Date.now()
      );
      return true;
    } catch (error) {
      logger.error('Failed to activate plugin %s:', pluginId, error);
      return false;
    }
  }

  async deactivate(
    pluginId: string | undefined,
    userId?: string
  ): Promise<boolean> {
    try {
      await this.repository().deactivate(pluginId, userId || 'default');
      return true;
    } catch (error) {
      logger.error('Failed to deactivate plugin:', error);
      return false;
    }
  }

  async deletePlugin(pluginId: string): Promise<boolean> {
    try {
      await this.repository().deleteByPlugin(pluginId);
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

  private repository() {
    return getPersistence(encryptionService).repositories.extensions
      .pluginActivations;
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
