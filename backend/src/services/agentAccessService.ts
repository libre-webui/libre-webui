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
 * Administrator opt-in for host agent CLI models. Installations that saved the
 * older shared agents decision keep it until an admin changes this setting.
 */

import {
  getSystemSettings,
  setSystemSetting,
} from './systemSettingsService.js';

/** Legacy shared decision, read only as the CLI fallback. */
const LEGACY_AGENTS_ENABLED_KEY = 'agents_enabled';
export const AGENT_CLI_MODELS_ENABLED_KEY = 'agent_cli_models_enabled';

function environmentDecision(name: string): boolean | undefined {
  const value = process.env[name];
  return value === 'true' ? true : value === 'false' ? false : undefined;
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
      LEGACY_AGENTS_ENABLED_KEY,
    ]);
    if (
      Object.prototype.hasOwnProperty.call(saved, AGENT_CLI_MODELS_ENABLED_KEY)
    ) {
      return saved[AGENT_CLI_MODELS_ENABLED_KEY] === 'true';
    }
    return saved[LEGACY_AGENTS_ENABLED_KEY] === 'true';
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
