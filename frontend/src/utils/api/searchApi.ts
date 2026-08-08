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

export interface WebSearchConfigResponse {
  enabled: boolean;
  available: boolean;
  /** Only present for administrators. */
  url?: string;
}

export const searchApi = {
  getConfig: (): Promise<ApiResponse<WebSearchConfigResponse>> => {
    if (isDemoMode()) {
      return createDemoResponse({ enabled: false, available: false });
    }
    return api.get('/search/config').then(res => res.data);
  },

  setConfig: (
    enabled: boolean,
    url: string
  ): Promise<ApiResponse<WebSearchConfigResponse>> => {
    if (isDemoMode()) {
      return createDemoResponse({ enabled, available: enabled, url });
    }
    return api.put('/search/config', { enabled, url }).then(res => res.data);
  },

  test: (): Promise<ApiResponse<{ ok: boolean; results: number }>> => {
    if (isDemoMode()) {
      return createDemoResponse({ ok: false, results: 0 }, false);
    }
    return api.post('/search/test').then(res => res.data);
  },
};
