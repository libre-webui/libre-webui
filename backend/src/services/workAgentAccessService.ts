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
 * Who may run agent CLIs (Claude Code, Codex, Kiro, OpenCode, Pi) in Work.
 *
 * Inside Work these agents are confined to the task sandbox, unlike the
 * host-side Agent CLI chat models, but each run still spends a credential
 * an administrator configured. So the feature starts disabled, can be
 * opened to administrators or to every Work user, and can be switched off
 * for everyone. LIBRE_WORK_AGENTS_ACCESS pins the mode for a deployment.
 */

import { getSystemSetting, setSystemSetting } from './systemSettingsService.js';

export type WorkAgentAccessMode = 'disabled' | 'admins' | 'all-users';

export const WORK_AGENT_ACCESS_MODES: readonly WorkAgentAccessMode[] = [
  'disabled',
  'admins',
  'all-users',
];

export const WORK_AGENT_ACCESS_MODE_KEY = 'work_agents_access_mode';

export interface WorkAgentAccessState {
  readonly mode: WorkAgentAccessMode;
  /** Whether LIBRE_WORK_AGENTS_ACCESS pins the mode. */
  readonly lockedByEnv: boolean;
}

export function isWorkAgentAccessMode(
  value: unknown
): value is WorkAgentAccessMode {
  return (
    typeof value === 'string' &&
    (WORK_AGENT_ACCESS_MODES as readonly string[]).includes(value)
  );
}

function environmentMode(): WorkAgentAccessMode | undefined {
  const raw = process.env.LIBRE_WORK_AGENTS_ACCESS;
  if (raw === undefined || raw.trim() === '') return undefined;
  const normalized = raw.trim().toLowerCase();
  // An unrecognized pin fails closed rather than falling back to storage.
  return isWorkAgentAccessMode(normalized) ? normalized : 'disabled';
}

export function workAgentAccessLockedByEnv(): boolean {
  return environmentMode() !== undefined;
}

export async function getWorkAgentAccess(): Promise<WorkAgentAccessState> {
  const pinned = environmentMode();
  if (pinned) return { mode: pinned, lockedByEnv: true };
  try {
    const value = await getSystemSetting(WORK_AGENT_ACCESS_MODE_KEY);
    return {
      mode: isWorkAgentAccessMode(value) ? value : 'disabled',
      lockedByEnv: false,
    };
  } catch {
    return { mode: 'disabled', lockedByEnv: false };
  }
}

export async function getWorkAgentAccessMode(): Promise<WorkAgentAccessMode> {
  return (await getWorkAgentAccess()).mode;
}

export async function setWorkAgentAccessMode(
  mode: WorkAgentAccessMode
): Promise<void> {
  if (!isWorkAgentAccessMode(mode)) {
    throw new Error(`Invalid Work agent access mode "${String(mode)}".`);
  }
  if (workAgentAccessLockedByEnv()) {
    throw new Error(
      'Agent CLI access in Work is pinned by LIBRE_WORK_AGENTS_ACCESS.'
    );
  }
  await setSystemSetting(WORK_AGENT_ACCESS_MODE_KEY, mode);
}

/** Work access and agent access both, decided by the shared authorizer. */
export async function userHasWorkAgentAccess(user: {
  id?: string;
  role?: string;
  status?: string;
}): Promise<boolean> {
  const { authorize } = await import('./authorizationService.js');
  const actor = { userId: user.id ?? '', role: user.role, status: user.status };
  const [work, agents] = await Promise.all([
    authorize(actor, 'use', { type: 'feature', id: 'work' }),
    authorize(actor, 'use', { type: 'feature', id: 'work-agents' }),
  ]);
  return work.allowed && agents.allowed;
}

export async function userIdHasWorkAgentAccess(
  userId: string
): Promise<boolean> {
  if (!userId) return false;
  const { userModel } = await import('../models/userModel.js');
  const user = await userModel.getUserById(userId);
  if (!user) return false;
  return userHasWorkAgentAccess(user);
}
