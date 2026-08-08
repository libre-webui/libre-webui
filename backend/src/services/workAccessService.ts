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

/**
 * Who may use Work. The mode is a persisted system setting so an
 * administrator's decision survives restarts and takes effect immediately —
 * every access check reads the current value, mirroring how role demotions
 * are honored mid-session. The default is admins-only: opening Work to all
 * users hands every account a command-executing sandbox, which is safe by
 * construction but is still a decision the administrator must make.
 *
 * Host-folder workspaces are NOT governed by this mode: they bind-mount
 * server paths and therefore stay admin-only regardless of the setting.
 */

import { getDatabase } from '../db.js';

export type WorkAccessMode = 'admins' | 'all-users';

export const WORK_ACCESS_MODES: readonly WorkAccessMode[] = [
  'admins',
  'all-users',
];

export const WORK_ACCESS_MODE_KEY = 'work_access_mode';

export function isWorkAccessMode(value: unknown): value is WorkAccessMode {
  return (
    typeof value === 'string' &&
    (WORK_ACCESS_MODES as readonly string[]).includes(value)
  );
}

export function getWorkAccessMode(): WorkAccessMode {
  const row = getDatabase()
    .prepare('SELECT value FROM system_settings WHERE key = ?')
    .get(WORK_ACCESS_MODE_KEY) as { value?: string } | undefined;
  return isWorkAccessMode(row?.value) ? row.value : 'admins';
}

export function setWorkAccessMode(mode: WorkAccessMode): void {
  if (!isWorkAccessMode(mode)) {
    throw new Error(`Invalid Work access mode "${String(mode)}".`);
  }
  getDatabase()
    .prepare(
      `INSERT INTO system_settings (key, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         updated_at = excluded.updated_at`
    )
    .run(WORK_ACCESS_MODE_KEY, mode, Date.now());
}

/**
 * Whether a user may use Work right now. Administrators always may; other
 * active accounts may when the mode is opened to all users.
 */
export function userHasWorkAccess(user: {
  role?: string;
  status?: string;
}): boolean {
  if (user.status !== undefined && user.status !== 'active') return false;
  if (user.role === 'admin') return true;
  return getWorkAccessMode() === 'all-users';
}
