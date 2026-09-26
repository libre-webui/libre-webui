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
 * Who may use the embedded Strands agent engine. The engine runs model-driven
 * tool loops on the server, so it starts disabled and an administrator must
 * opt in from User Management. Every check reads the live setting, so a
 * change takes effect on the next request without a restart.
 *
 * LIBRE_STRANDS_ACCESS pins the mode at deployment level. A malformed pin
 * locks the engine off rather than falling back to a saved opt-in.
 */

import { getSystemSetting, setSystemSetting } from './systemSettingsService.js';

export type StrandsAccessMode = 'disabled' | 'admins' | 'all-users';

export const STRANDS_ACCESS_MODES: readonly StrandsAccessMode[] = [
  'disabled',
  'admins',
  'all-users',
];

export const STRANDS_ACCESS_MODE_KEY = 'strands_access_mode';

export interface StrandsAccessState {
  readonly mode: StrandsAccessMode;
  /** Whether LIBRE_STRANDS_ACCESS pins the mode. */
  readonly lockedByEnv: boolean;
}

export function isStrandsAccessMode(
  value: unknown
): value is StrandsAccessMode {
  return (
    typeof value === 'string' &&
    (STRANDS_ACCESS_MODES as readonly string[]).includes(value)
  );
}

function envMode(): StrandsAccessMode | undefined {
  const raw = process.env.LIBRE_STRANDS_ACCESS;
  if (raw === undefined || raw.trim() === '') return undefined;
  const normalized = raw.trim().toLowerCase();
  return isStrandsAccessMode(normalized) ? normalized : 'disabled';
}

export async function getStrandsAccess(): Promise<StrandsAccessState> {
  const pinned = envMode();
  if (pinned) return { mode: pinned, lockedByEnv: true };
  try {
    const value = await getSystemSetting(STRANDS_ACCESS_MODE_KEY);
    return {
      mode: isStrandsAccessMode(value) ? value : 'disabled',
      lockedByEnv: false,
    };
  } catch {
    // No settings store means no persisted opt-in; stay disabled.
    return { mode: 'disabled', lockedByEnv: false };
  }
}

export async function getStrandsAccessMode(): Promise<StrandsAccessMode> {
  return (await getStrandsAccess()).mode;
}

export function strandsAccessLockedByEnv(): boolean {
  return envMode() !== undefined;
}

export async function setStrandsAccessMode(
  mode: StrandsAccessMode
): Promise<void> {
  if (!isStrandsAccessMode(mode)) {
    throw new Error(`Invalid Strands access mode "${String(mode)}".`);
  }
  if (strandsAccessLockedByEnv()) {
    throw new Error('Strands access is pinned by LIBRE_STRANDS_ACCESS.');
  }
  await setSystemSetting(STRANDS_ACCESS_MODE_KEY, mode);
}

/**
 * Whether a user may use the Strands engine right now. Disabled blocks
 * everyone, including administrators; admins mode allows active
 * administrators; all-users mode allows every active account.
 */
export async function userHasStrandsAccess(user: {
  id?: string;
  role?: string;
  status?: string;
}): Promise<boolean> {
  const { authorize } = await import('./authorizationService.js');
  const decision = await authorize(
    { userId: user.id ?? '', role: user.role, status: user.status },
    'use',
    { type: 'feature', id: 'strands' }
  );
  return decision.allowed;
}

/** Same check for code paths that only carry a user id, such as Work runs. */
export async function userIdHasStrandsAccess(userId: string): Promise<boolean> {
  if (!userId) return false;
  const { userModel } = await import('../models/userModel.js');
  const user = await userModel.getUserById(userId);
  if (!user) return false;
  return userHasStrandsAccess(user);
}
