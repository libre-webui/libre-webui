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

import axios, { AxiosError, AxiosInstance } from 'axios';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('services:libre-claw');
const DEFAULT_BASE_URL = 'http://127.0.0.1:8766';

export type LibreClawRunState =
  'queued' | 'running' | 'blocked' | 'done' | 'failed' | 'cancelled';

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
  path?: string;
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
  status: 'active' | 'paused' | string;
  last_run_id?: string | null;
  next_run_at?: string | null;
  telegram_chat_id?: number | null;
  [key: string]: unknown;
}

export interface LibreClawStatus {
  connected: boolean;
  baseUrl: string;
  dashboardUrl: string;
  health?: Record<string, unknown>;
  error?: string;
}

export interface LibreClawRunRequest {
  message: string;
  kind?: 'chat' | 'goal';
  provider?: string;
  model?: string;
  surface?: string;
  session?: unknown;
  attachments?: unknown;
}

export interface LibreClawModelUpdate {
  provider: string;
  model: string;
  persist_global?: boolean;
}

export interface LibreClawPermissionResolution {
  resolution: 'allow_once' | 'deny' | 'always_allow_tool' | 'always_allow_call';
}

export class LibreClawServiceError extends Error {
  status: number;
  details?: unknown;

  constructor(message: string, status = 502, details?: unknown) {
    super(message);
    this.name = 'LibreClawServiceError';
    this.status = status;
    this.details = details;
  }
}

export class LibreClawService {
  private client: AxiosInstance;
  readonly baseUrl: string;

  constructor(baseUrl = process.env.LIBRE_CLAW_BASE_URL || DEFAULT_BASE_URL) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.client = axios.create({
      baseURL: this.baseUrl,
      timeout: Number(process.env.LIBRE_CLAW_TIMEOUT_MS || 30000),
      headers: { Accept: 'application/json' },
    });
  }

  dashboardUrl(): string {
    return `${this.baseUrl}/dashboard`;
  }

  async status(): Promise<LibreClawStatus> {
    try {
      const health = await this.health();
      return {
        connected: true,
        baseUrl: this.baseUrl,
        dashboardUrl: this.dashboardUrl(),
        health,
      };
    } catch (error) {
      const message = getLibreClawErrorMessage(error);
      logger.debug('Libre Claw status check failed:', message);
      return {
        connected: false,
        baseUrl: this.baseUrl,
        dashboardUrl: this.dashboardUrl(),
        error: message,
      };
    }
  }

  async health(): Promise<Record<string, unknown>> {
    return this.request('GET', '/health');
  }

  async currentModel(): Promise<Record<string, unknown>> {
    return this.request('GET', '/config/model');
  }

  async updateModel(
    payload: LibreClawModelUpdate
  ): Promise<Record<string, unknown>> {
    return this.request('PATCH', '/config/model', payload);
  }

  async currentFallback(): Promise<Record<string, unknown>> {
    return this.request('GET', '/config/fallback');
  }

  async updateFallback(
    payload: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    return this.request('PATCH', '/config/fallback', payload);
  }

  async updateTheme(payload: {
    theme: string;
    persist_global?: boolean;
  }): Promise<Record<string, unknown>> {
    return this.request('PATCH', '/config/theme', payload);
  }

  async listRuns(limit = 20): Promise<{ runs: LibreClawRun[] }> {
    return this.request(
      'GET',
      `/runs?limit=${encodeURIComponent(String(limit))}`
    );
  }

  async getRun(runId: string): Promise<Record<string, unknown>> {
    return this.request('GET', `/runs/${encodeURIComponent(runId)}`);
  }

  async getEvents(
    runId: string,
    after = 0
  ): Promise<{ events: LibreClawEvent[] }> {
    return this.request(
      'GET',
      `/runs/${encodeURIComponent(runId)}/events?after=${encodeURIComponent(String(after))}`
    );
  }

  async startRun(payload: LibreClawRunRequest): Promise<{ run: LibreClawRun }> {
    return this.request('POST', '/runs', {
      ...payload,
      surface: payload.surface || 'libre-webui',
    });
  }

  async cancelRun(runId: string): Promise<Record<string, unknown>> {
    return this.request('POST', `/runs/${encodeURIComponent(runId)}/cancel`);
  }

  async resolvePermission(
    runId: string,
    toolCallId: string,
    payload: LibreClawPermissionResolution
  ): Promise<Record<string, unknown>> {
    return this.request(
      'POST',
      `/runs/${encodeURIComponent(runId)}/permissions/${encodeURIComponent(toolCallId)}`,
      payload
    );
  }

  async usage(provider = '', limit = 250): Promise<Record<string, unknown>> {
    const params = new URLSearchParams({ limit: String(limit) });
    if (provider) {
      params.set('provider', provider);
    }
    return this.request('GET', `/usage?${params.toString()}`);
  }

  async listAutomations(
    limit = 50
  ): Promise<{ automations: LibreClawAutomation[] }> {
    return this.request(
      'GET',
      `/automations?limit=${encodeURIComponent(String(limit))}`
    );
  }

  async getAutomation(automationId: string): Promise<Record<string, unknown>> {
    return this.request(
      'GET',
      `/automations/${encodeURIComponent(automationId)}`
    );
  }

  async createAutomation(
    payload: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    return this.request('POST', '/automations', payload);
  }

  async updateAutomation(
    automationId: string,
    payload: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    return this.request(
      'PATCH',
      `/automations/${encodeURIComponent(automationId)}`,
      payload
    );
  }

  async pauseAutomation(
    automationId: string
  ): Promise<Record<string, unknown>> {
    return this.request(
      'POST',
      `/automations/${encodeURIComponent(automationId)}/pause`
    );
  }

  async resumeAutomation(
    automationId: string
  ): Promise<Record<string, unknown>> {
    return this.request(
      'POST',
      `/automations/${encodeURIComponent(automationId)}/resume`
    );
  }

  async runAutomationNow(
    automationId: string
  ): Promise<Record<string, unknown>> {
    return this.request(
      'POST',
      `/automations/${encodeURIComponent(automationId)}/run`
    );
  }

  async deleteAutomation(
    automationId: string
  ): Promise<Record<string, unknown>> {
    return this.request(
      'DELETE',
      `/automations/${encodeURIComponent(automationId)}`
    );
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    data?: unknown
  ): Promise<T> {
    try {
      const response = await this.client.request<T>({
        method,
        url: path,
        data,
      });
      return response.data;
    } catch (error) {
      throw normalizeLibreClawError(error);
    }
  }
}

const normalizeLibreClawError = (error: unknown): LibreClawServiceError => {
  if (axios.isAxiosError(error)) {
    const axiosError = error as AxiosError<{
      error?: string;
      message?: string;
    }>;
    const status = axiosError.response?.status || 502;
    const message =
      axiosError.response?.data?.error ||
      axiosError.response?.data?.message ||
      axiosError.message ||
      'Libre Claw daemon request failed';
    return new LibreClawServiceError(
      message,
      status,
      axiosError.response?.data
    );
  }

  if (error instanceof LibreClawServiceError) {
    return error;
  }

  return new LibreClawServiceError(getLibreClawErrorMessage(error));
};

const getLibreClawErrorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }
  return 'Libre Claw daemon is not reachable';
};

export const libreClawService = new LibreClawService();

export default libreClawService;
