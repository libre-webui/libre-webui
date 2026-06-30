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

export type LibreClawRunState =
  'queued' | 'running' | 'blocked' | 'done' | 'failed' | 'cancelled';

export interface LibreClawStatus {
  connected: boolean;
  baseUrl: string;
  dashboardUrl: string;
  health?: {
    ok?: boolean;
    active_runs?: number;
    telegram_bridge?: string;
    [key: string]: unknown;
  };
  error?: string;
}

export interface LibreClawRun {
  run_id: string;
  state: LibreClawRunState;
  title: string;
  kind: string;
  provider: string;
  model: string;
  working_directory: string;
  created_at: string;
  updated_at: string;
}

export interface LibreClawEvent {
  event_id: number;
  timestamp: string;
  type: string;
  data: Record<string, unknown>;
}

export interface LibreClawAutomation {
  automation_id: string;
  name: string;
  prompt: string;
  schedule: string;
  route: string;
  provider: string;
  model: string;
  status: string;
  last_run_id?: string | null;
  next_run_at?: string | null;
  telegram_chat_id?: number | null;
}

export interface LibreClawStartRunPayload {
  message: string;
  kind?: 'chat' | 'goal';
  provider?: string;
  model?: string;
}

export type LibreClawPermissionResolution =
  'allow_once' | 'deny' | 'always_allow_tool' | 'always_allow_call';

const demoStatus: LibreClawStatus = {
  connected: false,
  baseUrl: 'http://127.0.0.1:8766',
  dashboardUrl: 'http://127.0.0.1:8766/dashboard',
  error: 'Libre Claw daemon is not connected in demo mode.',
};

export const libreClawApi = {
  status: (): Promise<ApiResponse<LibreClawStatus>> => {
    if (isDemoMode()) {
      return createDemoResponse(demoStatus);
    }
    return api.get('/libre-claw/status').then(res => res.data);
  },

  dashboard: (): Promise<ApiResponse<{ url: string }>> => {
    if (isDemoMode()) {
      return createDemoResponse({ url: demoStatus.dashboardUrl });
    }
    return api.get('/libre-claw/dashboard').then(res => res.data);
  },

  currentModel: (): Promise<ApiResponse<Record<string, unknown>>> => {
    if (isDemoMode()) {
      return createDemoResponse({
        provider: 'openrouter',
        model: 'openrouter/auto',
      });
    }
    return api.get('/libre-claw/config/model').then(res => res.data);
  },

  updateModel: (
    provider: string,
    model: string,
    persistGlobal = false
  ): Promise<ApiResponse<Record<string, unknown>>> => {
    if (isDemoMode()) {
      return createDemoResponse({
        provider,
        model,
        persist_global: persistGlobal,
      });
    }
    return api
      .patch('/libre-claw/config/model', {
        provider,
        model,
        persist_global: persistGlobal,
      })
      .then(res => res.data);
  },

  currentFallback: (): Promise<ApiResponse<Record<string, unknown>>> => {
    if (isDemoMode()) {
      return createDemoResponse({ enabled: false, routes: [] });
    }
    return api.get('/libre-claw/config/fallback').then(res => res.data);
  },

  updateFallback: (
    payload: Record<string, unknown>
  ): Promise<ApiResponse<Record<string, unknown>>> => {
    if (isDemoMode()) {
      return createDemoResponse(payload);
    }
    return api
      .patch('/libre-claw/config/fallback', payload)
      .then(res => res.data);
  },

  updateTheme: (
    theme: string,
    persistGlobal = true
  ): Promise<ApiResponse<Record<string, unknown>>> => {
    if (isDemoMode()) {
      return createDemoResponse({
        theme,
        label: theme,
        persist_global: persistGlobal,
      });
    }
    return api
      .patch('/libre-claw/config/theme', {
        theme,
        persist_global: persistGlobal,
      })
      .then(res => res.data);
  },

  usage: (
    provider = '',
    limit = 250
  ): Promise<ApiResponse<Record<string, unknown>>> => {
    const params = new URLSearchParams({ limit: String(limit) });
    if (provider) params.set('provider', provider);
    if (isDemoMode()) {
      return createDemoResponse({ summary: {}, records: [], text: '' });
    }
    return api
      .get(`/libre-claw/usage?${params.toString()}`)
      .then(res => res.data);
  },

  listRuns: (limit = 20): Promise<ApiResponse<{ runs: LibreClawRun[] }>> => {
    if (isDemoMode()) {
      return createDemoResponse({ runs: [] });
    }
    return api.get(`/libre-claw/runs?limit=${limit}`).then(res => res.data);
  },

  startRun: (
    payload: LibreClawStartRunPayload
  ): Promise<ApiResponse<{ run: LibreClawRun }>> => {
    if (isDemoMode()) {
      const now = new Date().toISOString();
      return createDemoResponse({
        run: {
          run_id: `demo-${Date.now()}`,
          state: 'queued',
          title: payload.message.slice(0, 80) || 'Libre Claw demo run',
          kind: payload.kind || 'chat',
          provider: payload.provider || 'openrouter',
          model: payload.model || 'openrouter/auto',
          working_directory: '',
          created_at: now,
          updated_at: now,
        },
      });
    }
    return api.post('/libre-claw/runs', payload).then(res => res.data);
  },

  getRun: (runId: string): Promise<ApiResponse<Record<string, unknown>>> => {
    if (isDemoMode()) {
      return createDemoResponse({ run_id: runId });
    }
    return api
      .get(`/libre-claw/runs/${encodeURIComponent(runId)}`)
      .then(res => res.data);
  },

  getEvents: (
    runId: string,
    after = 0
  ): Promise<ApiResponse<{ events: LibreClawEvent[] }>> => {
    if (isDemoMode()) {
      return createDemoResponse({ events: [] });
    }
    return api
      .get(
        `/libre-claw/runs/${encodeURIComponent(runId)}/events?after=${after}`
      )
      .then(res => res.data);
  },

  cancelRun: (runId: string): Promise<ApiResponse<Record<string, unknown>>> => {
    if (isDemoMode()) {
      return createDemoResponse({ run_id: runId, cancelled: true });
    }
    return api
      .post(`/libre-claw/runs/${encodeURIComponent(runId)}/cancel`)
      .then(res => res.data);
  },

  resolvePermission: (
    runId: string,
    toolCallId: string,
    resolution: LibreClawPermissionResolution
  ): Promise<ApiResponse<Record<string, unknown>>> => {
    if (isDemoMode()) {
      return createDemoResponse({
        run_id: runId,
        tool_call_id: toolCallId,
        resolution,
      });
    }
    return api
      .post(
        `/libre-claw/runs/${encodeURIComponent(runId)}/permissions/${encodeURIComponent(toolCallId)}`,
        { resolution }
      )
      .then(res => res.data);
  },

  listAutomations: (
    limit = 50
  ): Promise<ApiResponse<{ automations: LibreClawAutomation[] }>> => {
    if (isDemoMode()) {
      return createDemoResponse({ automations: [] });
    }
    return api
      .get(`/libre-claw/automations?limit=${limit}`)
      .then(res => res.data);
  },

  createAutomation: (
    payload: Partial<LibreClawAutomation>
  ): Promise<ApiResponse<Record<string, unknown>>> => {
    if (isDemoMode()) {
      return createDemoResponse({
        ...payload,
        automation_id: `demo-${Date.now()}`,
      });
    }
    return api.post('/libre-claw/automations', payload).then(res => res.data);
  },

  updateAutomation: (
    automationId: string,
    payload: Partial<LibreClawAutomation>
  ): Promise<ApiResponse<Record<string, unknown>>> => {
    if (isDemoMode()) {
      return createDemoResponse({ ...payload, automation_id: automationId });
    }
    return api
      .patch(
        `/libre-claw/automations/${encodeURIComponent(automationId)}`,
        payload
      )
      .then(res => res.data);
  },

  pauseAutomation: (
    automationId: string
  ): Promise<ApiResponse<Record<string, unknown>>> => {
    if (isDemoMode()) {
      return createDemoResponse({
        automation_id: automationId,
        status: 'paused',
      });
    }
    return api
      .post(`/libre-claw/automations/${encodeURIComponent(automationId)}/pause`)
      .then(res => res.data);
  },

  resumeAutomation: (
    automationId: string
  ): Promise<ApiResponse<Record<string, unknown>>> => {
    if (isDemoMode()) {
      return createDemoResponse({
        automation_id: automationId,
        status: 'active',
      });
    }
    return api
      .post(
        `/libre-claw/automations/${encodeURIComponent(automationId)}/resume`
      )
      .then(res => res.data);
  },

  runAutomationNow: (
    automationId: string
  ): Promise<ApiResponse<Record<string, unknown>>> => {
    if (isDemoMode()) {
      return createDemoResponse({ automation_id: automationId, run: true });
    }
    return api
      .post(`/libre-claw/automations/${encodeURIComponent(automationId)}/run`)
      .then(res => res.data);
  },

  deleteAutomation: (
    automationId: string
  ): Promise<ApiResponse<Record<string, unknown>>> => {
    if (isDemoMode()) {
      return createDemoResponse({ automation_id: automationId, deleted: true });
    }
    return api
      .delete(`/libre-claw/automations/${encodeURIComponent(automationId)}`)
      .then(res => res.data);
  },
};
