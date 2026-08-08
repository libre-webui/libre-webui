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
 * Whether the Agents section (Libre Claw and agent CLI models) is offered.
 * Agent CLIs run on the host as the server user — outside the Work sandbox —
 * so the feature ships disabled and an administrator must opt in. The
 * decision is a persisted system setting read on every check, mirroring the
 * Work access mode. The AGENT_CLI_MODELS_ENABLED environment variable, when
 * set, pins the value either way and locks the runtime toggle.
 */

import { getDatabase } from '../db.js';

export const AGENTS_ENABLED_KEY = 'agents_enabled';

/** Whether the environment pins the setting, locking the admin toggle. */
export function agentsEnabledLockedByEnv(): boolean {
  const env = process.env.AGENT_CLI_MODELS_ENABLED;
  return env === 'true' || env === 'false';
}

export function getAgentsEnabled(): boolean {
  const env = process.env.AGENT_CLI_MODELS_ENABLED;
  if (env === 'false') return false;
  if (env === 'true') return true;
  try {
    const row = getDatabase()
      .prepare('SELECT value FROM system_settings WHERE key = ?')
      .get(AGENTS_ENABLED_KEY) as { value?: string } | undefined;
    return row?.value === 'true';
  } catch {
    // No database means no persisted opt-in; stay disabled.
    return false;
  }
}

export function setAgentsEnabled(enabled: boolean): void {
  getDatabase()
    .prepare(
      `INSERT INTO system_settings (key, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         updated_at = excluded.updated_at`
    )
    .run(AGENTS_ENABLED_KEY, enabled ? 'true' : 'false', Date.now());
}
