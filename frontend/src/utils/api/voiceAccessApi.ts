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

import type { ApiResponse } from '@/types';
import { isDemoMode } from '@/utils/demoMode';
import { api, createDemoResponse } from './client';

export type VoiceAccessMode = 'admins' | 'all-users';

export type VoiceFeatureKey = 'stt' | 'tts' | 'voice-mode' | 'voice-cloning';

export type VoiceAccessModes = Record<
  VoiceFeatureKey,
  { mode: VoiceAccessMode; lockedByEnv: boolean }
>;

const DEMO_MODES: VoiceAccessModes = {
  stt: { mode: 'all-users', lockedByEnv: false },
  tts: { mode: 'all-users', lockedByEnv: false },
  'voice-mode': { mode: 'all-users', lockedByEnv: false },
  'voice-cloning': { mode: 'all-users', lockedByEnv: false },
};

export const voiceAccessApi = {
  getModes: async (): Promise<ApiResponse<VoiceAccessModes>> => {
    if (isDemoMode()) return createDemoResponse<VoiceAccessModes>(DEMO_MODES);
    const response = await api.get('/voice-access');
    return response.data;
  },

  setMode: async (
    feature: VoiceFeatureKey,
    mode: VoiceAccessMode
  ): Promise<
    ApiResponse<{ feature: VoiceFeatureKey; mode: VoiceAccessMode }>
  > => {
    if (isDemoMode()) {
      return createDemoResponse({ feature, mode });
    }
    const response = await api.put(
      `/voice-access/${encodeURIComponent(feature)}`,
      { mode }
    );
    return response.data;
  },
};

export default voiceAccessApi;
