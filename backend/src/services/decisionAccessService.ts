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
 * Who may use decision models, in Chat and through the Decisions API. The
 * mode is a persisted system setting read on every check. The default is
 * admins-only, like every capability that can bill a provider account;
 * opening it to all users is an administrator decision. The
 * DECISION_MODELS_ACCESS_MODE environment variable, when set, pins the value
 * and locks the runtime toggle.
 */

import { getSystemSetting, setSystemSetting } from './systemSettingsService.js';

export type DecisionAccessMode = 'admins' | 'all-users';

export const DECISION_ACCESS_MODE_KEY = 'decision_models_access_mode';

export function isDecisionAccessMode(
  value: unknown
): value is DecisionAccessMode {
  return value === 'admins' || value === 'all-users';
}

/** Whether the environment pins the setting, locking the admin toggle. */
export function decisionAccessModeLockedByEnv(): boolean {
  return isDecisionAccessMode(process.env.DECISION_MODELS_ACCESS_MODE);
}

export async function getDecisionAccessMode(): Promise<DecisionAccessMode> {
  const env = process.env.DECISION_MODELS_ACCESS_MODE;
  if (isDecisionAccessMode(env)) return env;
  try {
    const value = await getSystemSetting(DECISION_ACCESS_MODE_KEY);
    return isDecisionAccessMode(value) ? value : 'admins';
  } catch {
    // No database means no persisted opt-in; stay admins-only.
    return 'admins';
  }
}

export async function setDecisionAccessMode(
  mode: DecisionAccessMode
): Promise<void> {
  if (!isDecisionAccessMode(mode)) {
    throw new Error(`Invalid decision models access mode "${String(mode)}".`);
  }
  await setSystemSetting(DECISION_ACCESS_MODE_KEY, mode);
}

/** Whether this account may use decision models right now. */
export async function userCanUseDecisionModels(
  user: { id?: string; role?: string; status?: string } | undefined | null
): Promise<boolean> {
  if (!user) return false;
  const { authorize } = await import('./authorizationService.js');
  const decision = await authorize(
    { userId: user.id ?? '', role: user.role, status: user.status },
    'use',
    { type: 'feature', id: 'decision-models' }
  );
  return decision.allowed;
}

/** Same check for code paths that only carry a user id, such as Chat. */
export async function userIdCanUseDecisionModels(
  userId: string | undefined
): Promise<boolean> {
  if (!userId) return false;
  const { userModel } = await import('../models/userModel.js');
  const user = await userModel.getUserById(userId);
  if (!user) return false;
  return userCanUseDecisionModels(user);
}
