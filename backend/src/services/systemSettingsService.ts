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

import { getDatabaseSafe } from '../db.js';

const ALLOW_USER_MODEL_PULL_KEY = 'allow_user_model_pull';
const DEFAULT_ALLOW_USER_MODEL_PULL = true;

export class SystemSettingsService {
  /**
   * Whether non-admin users can install/pull models.
   */
  getAllowUserModelPull(): boolean {
    const db = getDatabaseSafe();
    if (!db) {
      return DEFAULT_ALLOW_USER_MODEL_PULL;
    }

    try {
      const row = db
        .prepare('SELECT value FROM system_settings WHERE key = ?')
        .get(ALLOW_USER_MODEL_PULL_KEY) as { value: string } | undefined;

      if (!row) {
        this.setAllowUserModelPull(DEFAULT_ALLOW_USER_MODEL_PULL);
        return DEFAULT_ALLOW_USER_MODEL_PULL;
      }

      return row.value === 'true';
    } catch (error) {
      console.error(
        'Failed to read system setting allow_user_model_pull:',
        error
      );
      return DEFAULT_ALLOW_USER_MODEL_PULL;
    }
  }

  /**
   * Update whether non-admin users can install/pull models.
   */
  setAllowUserModelPull(allow: boolean): void {
    const db = getDatabaseSafe();
    if (!db) {
      return;
    }

    try {
      const now = Date.now();
      db.prepare(
        `
          INSERT INTO system_settings (key, value, updated_at)
          VALUES (?, ?, ?)
          ON CONFLICT(key) DO UPDATE SET
            value = excluded.value,
            updated_at = excluded.updated_at
        `
      ).run(ALLOW_USER_MODEL_PULL_KEY, allow ? 'true' : 'false', now);
    } catch (error) {
      console.error(
        'Failed to update system setting allow_user_model_pull:',
        error
      );
    }
  }
}

export const systemSettingsService = new SystemSettingsService();
