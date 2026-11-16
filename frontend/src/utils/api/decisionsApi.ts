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

import type {
  ApiResponse,
  DecisionAnswer,
  DecisionModelEntry,
  DecisionQuestions,
} from '@/types';
import { isDemoMode } from '@/utils/demoMode';
import { api, createDemoResponse } from './client';

export type DecisionAccessMode = 'admins' | 'all-users';

export interface DecisionAccessState {
  mode: DecisionAccessMode;
  lockedByEnv: boolean;
  allowed: boolean;
}

export interface DecisionModelList {
  /** Whether this account may run them; the list is returned either way. */
  allowed: boolean;
  models: DecisionModelEntry[];
}

export interface DecisionRequest {
  model: string;
  providerType?: 'ollama' | 'plugin';
  providerId?: string;
  state: string | Record<string, unknown> | unknown[];
  images?: string[];
  questions: DecisionQuestions;
}

export interface DecisionOutcome {
  model: string;
  answers: Record<string, DecisionAnswer>;
  usage: {
    inputTokens?: number;
    outputTokens?: number;
    cachedTokens?: number;
    costUsd?: number;
  };
  provider: { type: 'ollama' | 'plugin'; id?: string; name: string };
  durationMs: number;
}

export const decisionsApi = {
  getModels: async (): Promise<ApiResponse<DecisionModelList>> => {
    if (isDemoMode()) {
      return createDemoResponse<DecisionModelList>({
        allowed: false,
        models: [],
      });
    }
    const response = await api.get('/decisions/models');
    return response.data;
  },

  decide: async (
    request: DecisionRequest
  ): Promise<ApiResponse<DecisionOutcome>> => {
    const response = await api.post('/decisions', request);
    return response.data;
  },

  getAccess: async (): Promise<ApiResponse<DecisionAccessState>> => {
    if (isDemoMode()) {
      return createDemoResponse<DecisionAccessState>({
        mode: 'admins',
        lockedByEnv: false,
        allowed: false,
      });
    }
    const response = await api.get('/decisions/access');
    return response.data;
  },

  setAccessMode: async (
    mode: DecisionAccessMode
  ): Promise<ApiResponse<{ mode: DecisionAccessMode }>> => {
    if (isDemoMode()) return createDemoResponse({ mode });
    const response = await api.put('/decisions/access', { mode });
    return response.data;
  },
};

export default decisionsApi;
