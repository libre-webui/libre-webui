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

export type SteeringAccessMode = 'admins' | 'all-users';

/** One vector a model's server offers, as its GET /steering lists it. */
export interface SteeringVector {
  name: string;
  label?: string;
  description?: string;
  group?: string;
  source?: string;
  /** The strength the server suggests. */
  default?: number;
}

export interface SteeringVectors {
  /** Whether this user may steer at all. */
  allowed: boolean;
  /** Whether the model's server offers any vectors. */
  supported: boolean;
  vectors: SteeringVector[];
}

export const steeringApi = {
  getVectors: async (
    model: string,
    providerId?: string
  ): Promise<ApiResponse<SteeringVectors>> => {
    if (isDemoMode()) {
      return createDemoResponse<SteeringVectors>({
        allowed: false,
        supported: false,
        vectors: [],
      });
    }
    const response = await api.get('/steering/vectors', {
      params: { model, ...(providerId ? { providerId } : {}) },
    });
    return response.data;
  },

  getAccess: async (): Promise<
    ApiResponse<{ mode: SteeringAccessMode; lockedByEnv: boolean }>
  > => {
    if (isDemoMode()) {
      return createDemoResponse({ mode: 'admins', lockedByEnv: false });
    }
    const response = await api.get('/steering/access');
    return response.data;
  },

  setAccess: async (
    mode: SteeringAccessMode
  ): Promise<ApiResponse<{ mode: SteeringAccessMode }>> => {
    if (isDemoMode()) return createDemoResponse({ mode });
    const response = await api.put('/steering/access', { mode });
    return response.data;
  },
};

export default steeringApi;
