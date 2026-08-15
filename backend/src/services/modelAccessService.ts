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
 * Who may download models (Ollama pulls, including the Hugging Face
 * browser, which pulls through Ollama). A persisted system setting read on
 * every check, mirroring the Work access mode: administrators always may;
 * other active users only when an administrator opens downloads to all
 * users. The default is admins-only — model pulls consume disk and
 * bandwidth on the server, which is an administrator's call to share.
 */

import { getSystemSetting, setSystemSetting } from './systemSettingsService.js';

export type ModelDownloadMode = 'admins' | 'all-users';

export const MODEL_DOWNLOAD_MODES: readonly ModelDownloadMode[] = [
  'admins',
  'all-users',
];

export const MODEL_DOWNLOAD_MODE_KEY = 'model_download_mode';

export function isModelDownloadMode(
  value: unknown
): value is ModelDownloadMode {
  return (
    typeof value === 'string' &&
    (MODEL_DOWNLOAD_MODES as readonly string[]).includes(value)
  );
}

export async function getModelDownloadMode(): Promise<ModelDownloadMode> {
  try {
    const value = await getSystemSetting(MODEL_DOWNLOAD_MODE_KEY);
    return isModelDownloadMode(value) ? value : 'admins';
  } catch {
    return 'admins';
  }
}

export async function setModelDownloadMode(
  mode: ModelDownloadMode
): Promise<void> {
  if (!isModelDownloadMode(mode)) {
    throw new Error(`Invalid model download mode "${String(mode)}".`);
  }
  await setSystemSetting(MODEL_DOWNLOAD_MODE_KEY, mode);
}

/** Whether a user may pull models right now. */
export async function userCanDownloadModels(user: {
  role?: string;
  status?: string;
}): Promise<boolean> {
  if (user.status !== undefined && user.status !== 'active') return false;
  if (user.role === 'admin') return true;
  return (await getModelDownloadMode()) === 'all-users';
}
