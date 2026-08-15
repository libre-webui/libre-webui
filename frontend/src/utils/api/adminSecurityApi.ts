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

export interface UserGroupMember {
  group_id: string;
  user_id: string;
  added_by: string;
  added_at: string;
}

export interface UserGroup {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
  members: UserGroupMember[];
}

export interface EffectiveAccessGrant {
  id: string;
  resourceType: string;
  resourceId: string;
  permission: string;
  via: string;
  principalId: string;
}

export interface EffectiveAccess {
  userId: string;
  username: string;
  role: string;
  status: string;
  groups: { id: string; name: string }[];
  features: Record<string, boolean>;
  grants: EffectiveAccessGrant[];
}

export interface AuditEvent {
  id: string;
  occurredAt: string;
  actorUserId: string | null;
  actorKind: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  result: 'success' | 'denied' | 'failure' | string;
  details: Record<string, unknown> | null;
}

export interface AuditQuery {
  action?: string;
  actor?: string;
  result?: string;
  limit?: number;
}

// Administrator-only surfaces: user groups, effective access, and the
// security audit log. The backend enforces the admin requirement.
export const adminSecurityApi = {
  getGroups: (): Promise<ApiResponse<UserGroup[]>> => {
    if (isDemoMode()) {
      return createDemoResponse<UserGroup[]>([]);
    }

    return api.get('/groups').then(res => res.data);
  },

  createGroup: (payload: {
    name: string;
    description?: string;
  }): Promise<ApiResponse<UserGroup>> => {
    if (isDemoMode()) {
      return createDemoResponse<UserGroup>({
        id: 'demo-group-' + Date.now(),
        name: payload.name,
        description: payload.description ?? null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        members: [],
      });
    }

    return api.post('/groups', payload).then(res => res.data);
  },

  updateGroup: (
    id: string,
    payload: { name?: string; description?: string }
  ): Promise<ApiResponse<UserGroup>> => {
    if (isDemoMode()) {
      return createDemoResponse<UserGroup>({
        id,
        name: payload.name ?? 'demo-group',
        description: payload.description ?? null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        members: [],
      });
    }

    return api.patch(`/groups/${id}`, payload).then(res => res.data);
  },

  deleteGroup: (id: string): Promise<ApiResponse<void>> => {
    if (isDemoMode()) {
      return createDemoResponse(undefined);
    }

    return api.delete(`/groups/${id}`).then(res => res.data);
  },

  addGroupMember: (
    groupId: string,
    userId: string
  ): Promise<ApiResponse<UserGroup>> => {
    if (isDemoMode()) {
      return createDemoResponse<UserGroup>({
        id: groupId,
        name: 'demo-group',
        description: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        members: [],
      });
    }

    return api
      .post(`/groups/${groupId}/members`, { userId })
      .then(res => res.data);
  },

  removeGroupMember: (
    groupId: string,
    userId: string
  ): Promise<ApiResponse<void>> => {
    if (isDemoMode()) {
      return createDemoResponse(undefined);
    }

    return api
      .delete(`/groups/${groupId}/members/${userId}`)
      .then(res => res.data);
  },

  getEffectiveAccess: (
    userId: string
  ): Promise<ApiResponse<EffectiveAccess>> => {
    if (isDemoMode()) {
      return createDemoResponse<EffectiveAccess>({
        userId,
        username: 'demo',
        role: 'admin',
        status: 'active',
        groups: [],
        features: {
          work: true,
          'model-download': true,
          'web-search': true,
          agents: true,
        },
        grants: [],
      });
    }

    return api.get(`/groups/effective/${userId}`).then(res => res.data);
  },

  getAuditEvents: (
    query: AuditQuery = {}
  ): Promise<ApiResponse<AuditEvent[]>> => {
    if (isDemoMode()) {
      return createDemoResponse<AuditEvent[]>([]);
    }

    const params = new URLSearchParams();
    if (query.action) params.set('action', query.action);
    if (query.actor) params.set('actor', query.actor);
    if (query.result) params.set('result', query.result);
    if (query.limit) params.set('limit', String(query.limit));
    const suffix = params.toString() ? `?${params.toString()}` : '';
    return api.get(`/audit${suffix}`).then(res => res.data);
  },
};
