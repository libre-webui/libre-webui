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
 * Voice governance (AUDIO-03): separate administrator-controlled access
 * modes for speech-to-text, text-to-speech, hands-free voice mode, and
 * voice cloning. Each mode is a persisted system setting read on every
 * check, mirroring the tool access mode. Defaults stay open ('all-users')
 * so upgrades do not silently take audio features away; restricting them
 * is an administrator decision. An environment variable per feature pins
 * the value and locks the runtime toggle.
 */

import { getSystemSetting, setSystemSetting } from './systemSettingsService.js';

export type VoiceAccessMode = 'admins' | 'all-users';

export type VoiceFeatureKey = 'stt' | 'tts' | 'voice-mode' | 'voice-cloning';

export const VOICE_FEATURE_KEYS: readonly VoiceFeatureKey[] = [
  'stt',
  'tts',
  'voice-mode',
  'voice-cloning',
];

const SETTING_KEYS: Record<VoiceFeatureKey, string> = {
  stt: 'stt_access_mode',
  tts: 'tts_access_mode',
  'voice-mode': 'voice_mode_access_mode',
  'voice-cloning': 'voice_cloning_access_mode',
};

const ENV_KEYS: Record<VoiceFeatureKey, string> = {
  stt: 'STT_ACCESS_MODE',
  tts: 'TTS_ACCESS_MODE',
  'voice-mode': 'VOICE_MODE_ACCESS_MODE',
  'voice-cloning': 'VOICE_CLONING_ACCESS_MODE',
};

export function isVoiceAccessMode(value: unknown): value is VoiceAccessMode {
  return value === 'admins' || value === 'all-users';
}

export function isVoiceFeatureKey(value: unknown): value is VoiceFeatureKey {
  return (
    typeof value === 'string' &&
    (VOICE_FEATURE_KEYS as readonly string[]).includes(value)
  );
}

/** Whether the environment pins the setting, locking the admin toggle. */
export function voiceAccessModeLockedByEnv(feature: VoiceFeatureKey): boolean {
  return isVoiceAccessMode(process.env[ENV_KEYS[feature]]);
}

export async function getVoiceAccessMode(
  feature: VoiceFeatureKey
): Promise<VoiceAccessMode> {
  const env = process.env[ENV_KEYS[feature]];
  if (isVoiceAccessMode(env)) return env;
  try {
    const value = await getSystemSetting(SETTING_KEYS[feature]);
    return isVoiceAccessMode(value) ? value : 'all-users';
  } catch {
    return 'all-users';
  }
}

export async function setVoiceAccessMode(
  feature: VoiceFeatureKey,
  mode: VoiceAccessMode
): Promise<void> {
  if (!isVoiceAccessMode(mode)) {
    throw new Error(`Invalid voice access mode "${String(mode)}".`);
  }
  await setSystemSetting(SETTING_KEYS[feature], mode);
}
