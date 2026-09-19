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

export interface AgentCliModel {
  id: string;
  name: string;
  command: string;
  binaryPath: string;
  /** CLI id — the chat providerId shared by every entry of one CLI. */
  agentId: string;
}

export interface AgentCliAccess {
  enabled: boolean;
  lockedByEnv: boolean;
}

export const agentCliApi = {
  getAccess: (): Promise<ApiResponse<AgentCliAccess>> => {
    if (isDemoMode())
      return createDemoResponse({ enabled: false, lockedByEnv: false });
    return api.get('/agent-clis/access').then(res => res.data);
  },

  setAccess: (enabled: boolean): Promise<ApiResponse<AgentCliAccess>> => {
    if (isDemoMode())
      return createDemoResponse({ enabled, lockedByEnv: false });
    return api.put('/agent-clis/access', { enabled }).then(res => res.data);
  },

  getModels: (): Promise<ApiResponse<AgentCliModel[]>> => {
    if (isDemoMode()) {
      return createDemoResponse([] as AgentCliModel[]);
    }
    return api.get('/agent-clis/models').then(res => res.data);
  },
};
