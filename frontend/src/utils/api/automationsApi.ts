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
  Automation,
  AutomationRun,
  AutomationTrigger,
} from '@/types';
import { isDemoMode } from '@/utils/demoMode';
import { api, createDemoResponse } from './client';

export interface AutomationPayload {
  name: string;
  instructions: string;
  triggers: AutomationTrigger[];
  provider?: string;
  model?: string;
  notify?: 'app' | 'off';
  target?: 'chat' | 'work';
  workPolicyId?: string;
  /** Existing Work task (agent) to run each fire inside; target must be 'work'. */
  workTaskId?: string;
}

export interface AutomationOccurrence {
  automationId: string;
  name: string;
  at: number;
}

export interface AutomationRunsSummary {
  unseenCount: number;
  days: { succeeded: number; failed: number }[];
}

export const automationsApi = {
  getAutomations: (): Promise<ApiResponse<Automation[]>> => {
    if (isDemoMode()) return createDemoResponse([]);
    return api.get('/automations').then(res => res.data);
  },

  createAutomation: (
    payload: AutomationPayload
  ): Promise<ApiResponse<Automation>> =>
    api.post('/automations', payload).then(res => res.data),

  updateAutomation: (
    automationId: string,
    payload: AutomationPayload
  ): Promise<ApiResponse<Automation>> =>
    api.put(`/automations/${automationId}`, payload).then(res => res.data),

  deleteAutomation: (automationId: string): Promise<ApiResponse> =>
    api.delete(`/automations/${automationId}`).then(res => res.data),

  pauseAutomation: (automationId: string): Promise<ApiResponse<Automation>> =>
    api.post(`/automations/${automationId}/pause`).then(res => res.data),

  resumeAutomation: (automationId: string): Promise<ApiResponse<Automation>> =>
    api.post(`/automations/${automationId}/resume`).then(res => res.data),

  runAutomationNow: (
    automationId: string
  ): Promise<ApiResponse<{ runId: string }>> =>
    api.post(`/automations/${automationId}/run`).then(res => res.data),

  getOccurrences: (
    from: number,
    to: number
  ): Promise<ApiResponse<AutomationOccurrence[]>> => {
    if (isDemoMode()) return createDemoResponse([]);
    return api
      .get(`/automations/occurrences?from=${from}&to=${to}`)
      .then(res => res.data);
  },

  getRuns: (options?: {
    automationId?: string;
    from?: number;
    to?: number;
  }): Promise<ApiResponse<AutomationRun[]>> => {
    if (isDemoMode()) return createDemoResponse([]);
    const query = new URLSearchParams();
    if (options?.automationId) query.set('automationId', options.automationId);
    if (options?.from !== undefined) query.set('from', String(options.from));
    if (options?.to !== undefined) query.set('to', String(options.to));
    const suffix = query.size > 0 ? `?${query.toString()}` : '';
    return api.get(`/automations/runs${suffix}`).then(res => res.data);
  },

  getRunsSummary: (): Promise<ApiResponse<AutomationRunsSummary>> => {
    if (isDemoMode())
      return createDemoResponse({
        unseenCount: 0,
        days: Array.from({ length: 30 }, () => ({ succeeded: 0, failed: 0 })),
      });
    return api.get('/automations/runs/summary').then(res => res.data);
  },

  markRunsSeen: (): Promise<ApiResponse<{ marked: number }>> =>
    api.post('/automations/runs/seen').then(res => res.data),
};
