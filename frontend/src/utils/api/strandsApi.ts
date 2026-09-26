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

/**
 * Client for the embedded Strands agent engine (/api/strands). The shapes are
 * restated here rather than imported because the frontend and backend are
 * separate TypeScript projects.
 */
import type { ApiResponse, StrandsAccessMode } from '@/types';
import { isDemoMode } from '@/utils/demoMode';
import { API_BASE_URL } from '@/utils/config';
import { api, createDemoResponse } from './client';

export interface StrandsAccess {
  mode: StrandsAccessMode;
  lockedByEnv: boolean;
}

export interface StrandsHealth {
  available: boolean;
  harnessVersion: string | null;
  sdkVersion: string | null;
}

export interface StrandsModel {
  /** Route id, `ollama:<model>` or `plugin:<pluginId>:<model>`. */
  id: string;
  name: string;
  providerType: 'ollama' | 'plugin';
  providerId: string | null;
  providerName: string;
}

export interface StrandsSession {
  id: string;
  title: string;
  model: string | null;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

export interface StrandsToolTrace {
  id: string;
  name: string;
  input: unknown;
  status?: 'success' | 'error';
  output?: string;
}

export interface StrandsMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  thinking?: string;
  tools?: StrandsToolTrace[];
  stopReason?: string;
  error?: string;
  createdAt: number;
}

export interface StrandsSessionDetail {
  session: StrandsSession;
  messages: StrandsMessage[];
  running: boolean;
}

export type StrandsTurnEvent =
  | { type: 'turn-start'; sessionId: string; messageId: string }
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool-start'; toolUseId: string; name: string; input: unknown }
  | {
      type: 'tool-result';
      toolUseId: string;
      status: 'success' | 'error';
      output: string;
    }
  | {
      type: 'done';
      stopReason: string;
      usage?: { inputTokens: number; outputTokens: number };
    }
  | { type: 'error'; message: string };

export interface SendStrandsMessageOptions {
  onEvent?: (event: StrandsTurnEvent) => void;
  signal?: AbortSignal;
}

const authHeader = (): Record<string, string> => {
  const token = localStorage.getItem('auth-token');
  return token ? { Authorization: `Bearer ${token}` } : {};
};

const sessionPath = (sessionId: string) =>
  `/strands/sessions/${encodeURIComponent(sessionId)}`;

const parseEvent = (line: string): StrandsTurnEvent => {
  const event: unknown = JSON.parse(line);
  if (
    !event ||
    typeof event !== 'object' ||
    typeof (event as { type?: unknown }).type !== 'string'
  ) {
    throw new Error('The Strands engine sent an invalid event.');
  }
  return event as StrandsTurnEvent;
};

export const strandsApi = {
  getAccess: (): Promise<ApiResponse<StrandsAccess>> => {
    if (isDemoMode())
      return createDemoResponse({ mode: 'disabled', lockedByEnv: false });
    return api.get('/strands/access').then(res => res.data);
  },

  setAccess: (mode: StrandsAccessMode): Promise<ApiResponse<StrandsAccess>> => {
    if (isDemoMode()) return createDemoResponse({ mode, lockedByEnv: false });
    return api.put('/strands/access', { mode }).then(res => res.data);
  },

  health: (): Promise<ApiResponse<StrandsHealth>> =>
    api.get('/strands/health').then(res => res.data),

  models: (): Promise<ApiResponse<StrandsModel[]>> => {
    if (isDemoMode()) return createDemoResponse([] as StrandsModel[]);
    return api.get('/strands/models').then(res => res.data);
  },

  listSessions: (): Promise<ApiResponse<StrandsSession[]>> => {
    if (isDemoMode()) return createDemoResponse([] as StrandsSession[]);
    return api.get('/strands/sessions').then(res => res.data);
  },

  createSession: (input: {
    title?: string;
    model?: string | null;
  }): Promise<ApiResponse<StrandsSession>> =>
    api.post('/strands/sessions', input).then(res => res.data),

  getSession: (sessionId: string): Promise<ApiResponse<StrandsSessionDetail>> =>
    api.get(sessionPath(sessionId)).then(res => res.data),

  updateSession: (
    sessionId: string,
    input: { title?: string; model?: string | null }
  ): Promise<ApiResponse<StrandsSession>> =>
    api.patch(sessionPath(sessionId), input).then(res => res.data),

  deleteSession: (sessionId: string): Promise<ApiResponse<void>> =>
    api.delete(sessionPath(sessionId)).then(res => res.data),

  cancel: (sessionId: string): Promise<ApiResponse<{ cancelled: boolean }>> =>
    api.post(`${sessionPath(sessionId)}/cancel`).then(res => res.data),

  /**
   * Run one turn and stream its events. Aborting the signal closes the
   * connection, which cancels the turn on the server.
   */
  sendMessage: async (
    sessionId: string,
    text: string,
    options: SendStrandsMessageOptions = {}
  ): Promise<StrandsTurnEvent[]> => {
    const response = await fetch(
      `${API_BASE_URL}${sessionPath(sessionId)}/messages`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader() },
        body: JSON.stringify({ text }),
        signal: options.signal,
      }
    );
    if (!response.ok) {
      const detail = await response
        .json()
        .then((body: { error?: string }) => body.error)
        .catch(() => undefined);
      throw new Error(detail ?? `HTTP error! status: ${response.status}`);
    }
    if (!response.body) throw new Error('No response body reader available');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const events: StrandsTurnEvent[] = [];
    let buffer = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        if (done && buffer.trim() !== '') lines.push(buffer);
        for (const line of lines) {
          if (line.trim() === '') continue;
          const event = parseEvent(line);
          events.push(event);
          options.onEvent?.(event);
          if (event.type === 'done' || event.type === 'error') return events;
        }
        if (done) throw new Error('The Strands turn ended unexpectedly.');
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  },
};

export default strandsApi;
