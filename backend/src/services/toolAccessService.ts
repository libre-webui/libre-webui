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
 * Who may use chat tools (native tool calls, built-in tools, and registered
 * OpenAPI/MCP tool servers). The mode is a persisted system setting read on
 * every check, mirroring the Work access mode. The default is admins-only
 * because tool calls reach external destinations with user-bound
 * credentials; opening them to all users is an administrator decision.
 * Individual servers additionally scope availability through their own
 * access mode and resource grants. The TOOLS_ACCESS_MODE environment
 * variable, when set, pins the value and locks the runtime toggle.
 */

import { getSystemSetting, setSystemSetting } from './systemSettingsService.js';

export type ToolAccessMode = 'admins' | 'all-users';

export const TOOL_ACCESS_MODES: readonly ToolAccessMode[] = [
  'admins',
  'all-users',
];

export const TOOL_ACCESS_MODE_KEY = 'tool_access_mode';

export function isToolAccessMode(value: unknown): value is ToolAccessMode {
  return (
    typeof value === 'string' &&
    (TOOL_ACCESS_MODES as readonly string[]).includes(value)
  );
}

/** Whether the environment pins the setting, locking the admin toggle. */
export function toolAccessModeLockedByEnv(): boolean {
  return isToolAccessMode(process.env.TOOLS_ACCESS_MODE);
}

export async function getToolAccessMode(): Promise<ToolAccessMode> {
  const env = process.env.TOOLS_ACCESS_MODE;
  if (isToolAccessMode(env)) return env;
  try {
    const value = await getSystemSetting(TOOL_ACCESS_MODE_KEY);
    return isToolAccessMode(value) ? value : 'admins';
  } catch {
    // No database means no persisted opt-in; stay admins-only.
    return 'admins';
  }
}

export async function setToolAccessMode(mode: ToolAccessMode): Promise<void> {
  if (!isToolAccessMode(mode)) {
    throw new Error(`Invalid tool access mode "${String(mode)}".`);
  }
  await setSystemSetting(TOOL_ACCESS_MODE_KEY, mode);
}
