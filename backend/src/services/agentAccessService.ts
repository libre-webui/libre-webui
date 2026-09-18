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
 * Independent administrator opt-ins for Libre Claw and host agent CLI models.
 * Existing installations retain their former shared decision until an admin
 * changes either setting. New environment pins apply only to their own feature.
 */

import {
  getSystemSetting,
  getSystemSettings,
  setSystemSetting,
  setSystemSettings,
} from './systemSettingsService.js';

export const AGENTS_ENABLED_KEY = 'agents_enabled';
export const AGENT_CLI_MODELS_ENABLED_KEY = 'agent_cli_models_enabled';

function environmentDecision(name: string): boolean | undefined {
  const value = process.env[name];
  return value === 'true' ? true : value === 'false' ? false : undefined;
}

/** Whether the environment pins the setting, locking the admin toggle. */
export function agentsEnabledLockedByEnv(): boolean {
  return environmentDecision('LIBRE_CLAW_ENABLED') !== undefined;
}

export async function getAgentsEnabled(): Promise<boolean> {
  const env = environmentDecision('LIBRE_CLAW_ENABLED');
  if (env !== undefined) return env;
  try {
    const saved = await getSystemSetting(AGENTS_ENABLED_KEY);
    if (saved !== null) return saved === 'true';
    // An untouched pre-split deployment may have enabled both features with
    // this legacy variable. A saved Claw choice takes precedence from now on.
    return environmentDecision('AGENT_CLI_MODELS_ENABLED') ?? false;
  } catch {
    // No database means no persisted opt-in; stay disabled.
    return false;
  }
}

export async function setAgentsEnabled(enabled: boolean): Promise<void> {
  const legacyCliEnabled =
    environmentDecision('AGENT_CLI_MODELS_ENABLED') ??
    (await getSystemSetting(AGENTS_ENABLED_KEY)) === 'true';
  // Snapshot the old CLI decision in the same repository transaction as the
  // Claw edit, so that changing Claw cannot silently enable or disable CLIs.
  await setSystemSettings(
    { [AGENTS_ENABLED_KEY]: enabled ? 'true' : 'false' },
    { [AGENT_CLI_MODELS_ENABLED_KEY]: legacyCliEnabled ? 'true' : 'false' }
  );
}

export function agentCliModelsEnabledLockedByEnv(): boolean {
  return environmentDecision('AGENT_CLI_MODELS_ENABLED') !== undefined;
}

export async function getAgentCliModelsEnabled(): Promise<boolean> {
  const env = environmentDecision('AGENT_CLI_MODELS_ENABLED');
  if (env !== undefined) return env;
  try {
    const saved = await getSystemSettings([
      AGENT_CLI_MODELS_ENABLED_KEY,
      AGENTS_ENABLED_KEY,
    ]);
    if (
      Object.prototype.hasOwnProperty.call(saved, AGENT_CLI_MODELS_ENABLED_KEY)
    ) {
      return saved[AGENT_CLI_MODELS_ENABLED_KEY] === 'true';
    }
    return saved[AGENTS_ENABLED_KEY] === 'true';
  } catch {
    return false;
  }
}

export async function setAgentCliModelsEnabled(
  enabled: boolean
): Promise<void> {
  await setSystemSetting(
    AGENT_CLI_MODELS_ENABLED_KEY,
    enabled ? 'true' : 'false'
  );
}
