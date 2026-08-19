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

export type ToolServerKind = 'openapi' | 'mcp';
export type ToolServerAuthMode = 'none' | 'bearer' | 'header';
export type ToolServerAccessMode = 'admins-only' | 'all-users' | 'granted';
export type ToolApprovalScope = 'once' | 'session' | 'always';

export interface ToolServerView {
  id: string;
  name: string;
  description?: string;
  kind: ToolServerKind;
  authMode: ToolServerAuthMode;
  enabled: boolean;
  specRevision: number;
  hasCredential: boolean;
  // Admin-only fields
  baseUrl?: string;
  specDigest?: string;
  authHeader?: string;
  accessMode?: ToolServerAccessMode;
  timeoutMs?: number;
  maxResponseBytes?: number;
  createdAt?: number;
  updatedAt?: number;
}

export interface ToolServerToolView {
  name: string;
  description?: string;
  sideEffect: boolean;
  enabled: boolean;
}

export interface ToolServerInput {
  name: string;
  description?: string;
  kind: ToolServerKind;
  baseUrl: string;
  specUrl?: string;
  authMode: ToolServerAuthMode;
  authHeader?: string;
  accessMode: ToolServerAccessMode;
  enabled?: boolean;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export interface ToolApprovalView {
  id: string;
  sessionId?: string;
  serverId?: string;
  toolName: string;
  callId?: string;
  scope: ToolApprovalScope;
  status: 'pending' | 'approved' | 'denied' | 'expired';
  createdAt: number;
  resolvedAt?: number;
  expiresAt?: number;
}

export interface ToolCatalogEntry {
  name: string;
  description?: string;
  sideEffect: boolean;
  source: 'builtin' | 'openapi' | 'mcp';
  serverId?: string;
  serverName?: string;
}

export interface ToolCatalogView {
  available: boolean;
  tools: ToolCatalogEntry[];
}

export const toolsApi = {
  getCatalog: (): Promise<ApiResponse<ToolCatalogView>> => {
    if (isDemoMode()) {
      return createDemoResponse({ available: false, tools: [] });
    }
    return api.get('/tools/catalog').then(res => res.data);
  },

  listServers: (): Promise<ApiResponse<ToolServerView[]>> => {
    if (isDemoMode()) return createDemoResponse([]);
    return api.get('/tools/servers').then(res => res.data);
  },

  getServer: (
    serverId: string
  ): Promise<
    ApiResponse<{ server: ToolServerView; tools: ToolServerToolView[] }>
  > => api.get(`/tools/servers/${serverId}`).then(res => res.data),

  registerServer: (
    input: ToolServerInput
  ): Promise<ApiResponse<ToolServerView>> =>
    api.post('/tools/servers', input).then(res => res.data),

  updateServer: (
    serverId: string,
    updates: Partial<ToolServerInput>
  ): Promise<ApiResponse<ToolServerView>> =>
    api.put(`/tools/servers/${serverId}`, updates).then(res => res.data),

  deleteServer: (serverId: string): Promise<ApiResponse> =>
    api.delete(`/tools/servers/${serverId}`).then(res => res.data),

  refreshServer: (serverId: string): Promise<ApiResponse<ToolServerView>> =>
    api.post(`/tools/servers/${serverId}/refresh`).then(res => res.data),

  overrideServerTool: (
    serverId: string,
    toolName: string,
    overrides: { enabled?: boolean; sideEffect?: boolean }
  ): Promise<ApiResponse<ToolServerToolView>> =>
    api
      .put(`/tools/servers/${serverId}/tools/${toolName}`, overrides)
      .then(res => res.data),

  setCredential: (serverId: string, secret: string): Promise<ApiResponse> =>
    api
      .put(`/tools/servers/${serverId}/credential`, { secret })
      .then(res => res.data),

  deleteCredential: (serverId: string): Promise<ApiResponse> =>
    api.delete(`/tools/servers/${serverId}/credential`).then(res => res.data),

  listApprovals: (): Promise<
    ApiResponse<{ pending: ToolApprovalView[]; standing: ToolApprovalView[] }>
  > => api.get('/tools/approvals').then(res => res.data),

  decideApproval: (
    approvalId: string,
    approve: boolean,
    scope: ToolApprovalScope
  ): Promise<ApiResponse<ToolApprovalView>> =>
    api
      .post(`/tools/approvals/${approvalId}`, { approve, scope })
      .then(res => res.data),

  revokeApproval: (approvalId: string): Promise<ApiResponse> =>
    api.delete(`/tools/approvals/${approvalId}`).then(res => res.data),

  getAccessMode: (): Promise<
    ApiResponse<{ mode: 'admins' | 'all-users'; lockedByEnv: boolean }>
  > => api.get('/tools/access').then(res => res.data),

  setAccessMode: (
    mode: 'admins' | 'all-users'
  ): Promise<ApiResponse<{ mode: string }>> =>
    api.put('/tools/access', { mode }).then(res => res.data),
};
