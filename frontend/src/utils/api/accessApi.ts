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
import { api } from './client';

export interface ResourceGrant {
  id: string;
  resourceType: string;
  resourceId: string;
  principalType: 'user' | 'group';
  principalId: string;
  principalName?: string;
  permission: string;
  createdAt: string;
}

export interface ResolvedPrincipal {
  id: string;
  username: string;
}

/** Per-resource sharing (IAM-03 grants). */
export const accessApi = {
  listGrants: (
    resourceType: string,
    resourceId: string
  ): Promise<ApiResponse<ResourceGrant[]>> =>
    api
      .get('/access/grants', {
        params: { type: resourceType, id: resourceId },
      })
      .then(res => res.data),

  createGrant: (input: {
    resourceType: string;
    resourceId: string;
    principalType: 'user' | 'group';
    principalId: string;
    permission: string;
  }): Promise<ApiResponse<ResourceGrant>> =>
    api.post('/access/grants', input).then(res => res.data),

  deleteGrant: (grantId: string): Promise<ApiResponse> =>
    api.delete(`/access/grants/${grantId}`).then(res => res.data),

  resolvePrincipal: (
    username: string
  ): Promise<ApiResponse<ResolvedPrincipal>> =>
    api
      .get('/access/principals', { params: { username } })
      .then(res => res.data),

  resolveGroup: (
    name: string
  ): Promise<ApiResponse<{ id: string; name: string }>> =>
    api
      .get('/access/principals/groups', { params: { name } })
      .then(res => res.data),
};
