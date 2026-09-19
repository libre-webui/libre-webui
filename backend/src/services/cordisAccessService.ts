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
 * Whether the embedded Cordis/DSH engine is offered.
 *
 * The engine runs tools with real filesystem access that Libre WebUI's
 * tool-approval flow does not mediate, so it ships disabled and an
 * administrator opts in — the same posture as the Agents feature. The decision
 * is a persisted system setting read on every check, so enabling it takes
 * effect without editing files or restarting the backend.
 *
 * Two sources can pin the value, and both lock the administrator toggle rather
 * than being silently overridden by it:
 *
 * 1. `LIBRE_CORDIS_ENABLED`, the deployment-level switch. A container that sets
 *    it means it, so the UI must not offer to disagree.
 * 2. `features.enabled` in `cordis.config.yml`. A YAML file cannot be changed
 *    at runtime, so an explicit `true` there restates the default; an explicit
 *    `false` is an operator decision the UI must not quietly undo.
 *
 * @module services/cordisAccessService
 */

import type { CordisHostConfig } from '../cordis/host/config.js';
import { resolveCordisHostConfig } from '../cordis/host/config.js';
import { getSystemSetting, setSystemSetting } from './systemSettingsService.js';

/** System-settings key holding the administrator's opt-in. */
export const CORDIS_ENABLED_KEY = 'cordis_enabled';

/** How the effective value was decided. */
export interface CordisAccessState {
  /** Whether the engine is offered. */
  readonly enabled: boolean;
  /** Whether a deployment-level source pins the value. */
  readonly lockedByEnv: boolean;
  /** Which source pinned it, when locked. */
  readonly lockedBy?: 'env' | 'config-file';
}

/**
 * Read the environment's opinion, if it has one.
 * @returns true/false when `LIBRE_CORDIS_ENABLED` is set, undefined otherwise.
 */
function envDecision(): boolean | undefined {
  const raw = process.env.LIBRE_CORDIS_ENABLED;
  if (raw === undefined || raw.trim() === '') return undefined;
  const normalized = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  // A malformed deployment pin must not enable host filesystem tools through
  // a previously saved setting. Keep it locked off until the operator fixes it.
  return false;
}

/**
 * Resolve the effective access state.
 *
 * @param resolved - the host configuration to consult, when the caller already
 *   has one. Passing it matters for two reasons: the file is not read twice, and
 *   a caller that overrode the configuration (a test, or an embedding host)
 *   gets the decision it configured rather than one re-read from disk.
 * @returns the decision and whether a deployment-level source pinned it.
 */
export async function getCordisAccess(
  resolved?: CordisHostConfig
): Promise<CordisAccessState> {
  const fromEnv = envDecision();
  if (fromEnv !== undefined) {
    return { enabled: fromEnv, lockedByEnv: true, lockedBy: 'env' };
  }
  let config = resolved;
  if (!config) {
    try {
      config = resolveCordisHostConfig();
    } catch {
      // An unreadable settings document is already reported by the host when it
      // tries to start; access resolution falls back to the persisted setting.
      config = undefined;
    }
  }
  if (config?.featuresEnabledDeclared) {
    return {
      enabled: config.features.enabled,
      lockedByEnv: true,
      lockedBy: 'config-file',
    };
  }
  try {
    return {
      enabled: (await getSystemSetting(CORDIS_ENABLED_KEY)) === 'true',
      lockedByEnv: false,
    };
  } catch {
    // No database means no persisted opt-in; stay disabled.
    return { enabled: false, lockedByEnv: false };
  }
}

/**
 * Whether the engine is offered at all.
 *
 * Every read path goes through here, so flipping the setting is the only thing
 * needed to expose or withdraw the feature.
 * @returns the effective boolean.
 */
export async function getCordisEnabled(
  resolved?: CordisHostConfig
): Promise<boolean> {
  return (await getCordisAccess(resolved)).enabled;
}

/**
 * Persist the administrator's opt-in.
 * @param enabled - whether the engine should be offered.
 */
export async function setCordisEnabled(enabled: boolean): Promise<void> {
  await setSystemSetting(CORDIS_ENABLED_KEY, enabled ? 'true' : 'false');
}
