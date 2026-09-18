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
 * Browser client for the embedded Cordis/DSH engine.
 *
 * This module talks to `/api/cordis` and nothing else. It deliberately does not
 * import a backend type or a `@deepseek-ai/*` package: the engine is reachable
 * only through the HTTP contract, which is what keeps the engine swappable
 * without a frontend change.
 *
 * The shapes below mirror `backend/src/cordis/contracts.ts`. They are
 * restated rather than imported because the frontend and backend are separate
 * TypeScript projects with separate build outputs; an import would couple the
 * browser bundle to backend source.
 *
 * @module utils/api/cordisApi
 */

import type { ApiResponse } from '@/types';
import { isDemoMode } from '@/utils/demoMode';
import { API_BASE_URL } from '@/utils/config';
import api, { isHttpError } from './client';

/** Lifecycle state of one engine service, mirroring Cordis fibre states. */
export type CordisServiceState = 'pending' | 'ready' | 'failed';

/** One engine service as observed through the contract. */
export interface CordisServiceStatus {
  name: string;
  state: CordisServiceState;
  detail?: string;
}

/** Summary of one engine session. */
export interface CordisSessionSummary {
  id: string;
  title?: string;
  createdAt?: number;
  eventCount: number;
  workspacePath?: string;
}

/** Role of one projected message. */
export type CordisMessageRole =
  'user' | 'assistant' | 'system' | 'tool' | 'unknown';

/** One message projected from an engine session log. */
export interface CordisMessage {
  id: string;
  role: CordisMessageRole;
  text: string;
  reasoning?: string;
  seq?: number;
  source?: 'user' | 'model' | 'system' | 'context' | 'tool';
  toolCalls?: Array<{ callId: string; name: string; arguments: string }>;
  toolResults?: Array<{
    callId: string;
    name?: string;
    output: string;
    isError: boolean;
  }>;
}

export type CordisPermissionMode = 'read-only' | 'workspace-write';

export interface CordisSessionSettings {
  model?: string;
  permissionMode: CordisPermissionMode;
}

export interface CordisModel {
  id: string;
  name: string;
  providerType: 'ollama' | 'plugin' | 'dsh';
  providerId?: string;
  providerName?: string;
}

export interface CordisModelCatalog {
  models: CordisModel[];
  defaultModel?: string;
}

export interface CordisApproval {
  id: string;
  sessionId: string;
  callId?: string;
  toolName: string;
  reason?: string;
}

/** A session with its projected messages. */
export interface CordisSession extends CordisSessionSummary {
  messages: CordisMessage[];
  settings: CordisSessionSettings;
  capabilities: { permissions: boolean; approvals: boolean };
  approvals: CordisApproval[];
  active: boolean;
}

/** One live agent. */
export interface CordisAgent {
  id: string;
  root: boolean;
}

/** One tool the engine can expose to a model. */
export interface CordisTool {
  name: string;
  description: string;
}

/** One increment of a streaming agent response. */
export type CordisStreamChunk =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  /** The turn failed; `message` is the engine's own reason. */
  | { type: 'error'; message: string; code?: string }
  | { type: 'tool-call'; callId: string; name: string; arguments?: string }
  | {
      type: 'tool-result';
      callId: string;
      name: string;
      isError: boolean;
      output?: string;
    }
  | { type: 'approval-request'; approval: CordisApproval }
  | {
      type: 'approval-decision';
      approvalId: string;
      outcome: 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable';
    }
  | { type: 'done'; reason: string; interrupted?: boolean };

/** Engine health, including why the bridge cannot serve requests. */
export interface CordisHealth {
  enabled: boolean;
  ready: boolean;
  services?: CordisServiceStatus[];
  /** Machine-readable reason when the bridge is unavailable. */
  code?: 'CORDIS_DISABLED' | 'CORDIS_STARTING' | 'CORDIS_UNAVAILABLE';
  error?: string;
}

/** Administrator opt-in for the engine, including whether it is pinned. */
export interface CordisAccess {
  enabled: boolean;
  /** True when a deployment-level source pins the value. */
  lockedByEnv: boolean;
  /** Which source pinned it, when pinned. */
  lockedBy?: 'env' | 'config-file';
}

/** Options accepted when sending a chat turn. */
export interface SendCordisMessageOptions {
  /** Called for every streamed chunk, in order. */
  onChunk?: (chunk: CordisStreamChunk) => void;
  /** Abort the request; the turn stays durable on the server. */
  signal?: AbortSignal;
}

const authHeader = (): Record<string, string> => {
  const token = localStorage.getItem('auth-token');
  return token ? { Authorization: `Bearer ${token}` } : {};
};

const parseChunk = (line: string): CordisStreamChunk => {
  const chunk: unknown = JSON.parse(line);
  if (chunk && typeof chunk === 'object' && 'type' in chunk) {
    const value = chunk as Record<string, unknown>;
    switch (value.type) {
      case 'text':
      case 'reasoning':
        if (typeof value.text === 'string') return value as CordisStreamChunk;
        break;
      case 'error':
        if (typeof value.message === 'string')
          return value as CordisStreamChunk;
        break;
      case 'tool-call':
      case 'tool-result':
        if (
          typeof value.callId === 'string' &&
          typeof value.name === 'string' &&
          (value.type === 'tool-call' || typeof value.isError === 'boolean')
        ) {
          return value as CordisStreamChunk;
        }
        break;
      case 'done':
        if (typeof value.reason === 'string') return value as CordisStreamChunk;
        break;
      case 'approval-request': {
        const approval = value.approval as Partial<CordisApproval> | undefined;
        if (
          approval &&
          typeof approval.id === 'string' &&
          typeof approval.sessionId === 'string' &&
          typeof approval.toolName === 'string'
        )
          return value as CordisStreamChunk;
        break;
      }
      case 'approval-decision':
        if (
          typeof value.approvalId === 'string' &&
          ['allowed-once', 'rejected', 'cancelled', 'unavailable'].includes(
            String(value.outcome)
          )
        )
          return value as CordisStreamChunk;
        break;
    }
  }
  throw new Error('Invalid engine stream chunk');
};

export const cordisApi = {
  getModels: async (): Promise<CordisModelCatalog> => {
    const response = await api.get<CordisModelCatalog>('/cordis/models');
    return response.data;
  },

  updateSettings: async (
    sessionId: string,
    settings: Partial<CordisSessionSettings>
  ): Promise<CordisSession> => {
    const response = await api.patch<{ session: CordisSession }>(
      `/cordis/sessions/${encodeURIComponent(sessionId)}/settings`,
      settings
    );
    return response.data.session;
  },

  decideApproval: async (
    sessionId: string,
    approvalId: string,
    decision: 'allowed-once' | 'rejected'
  ): Promise<void> => {
    await api.post(
      `/cordis/sessions/${encodeURIComponent(sessionId)}/approvals/${encodeURIComponent(approvalId)}`,
      { decision }
    );
  },
  /**
   * Read bridge health.
   *
   * This route is unauthenticated by design, so the call succeeds even when no
   * session exists — which is what lets a settings page show "disabled" rather
   * than an error.
   */
  getHealth: async (): Promise<CordisHealth> => {
    try {
      const response = await api.get<CordisHealth>('/cordis/health');
      return response.data;
    } catch (error) {
      // An unavailable bridge answers 503 with the reason in the body. The
      // shared client turns any non-2xx response into an `HttpError`, so the
      // body is unwrapped here; surfacing "status code 503" instead would
      // discard the one piece of information an operator needs.
      if (isHttpError(error) && error.response?.data) {
        const data = error.response.data as CordisHealth;
        if (typeof data.ready === 'boolean') return data;
      }
      throw error;
    }
  },

  /**
   * Read the administrator opt-in.
   *
   * Administrator-only on the server: this decides whether the engine's page
   * exists for the whole deployment, so it is not a per-user preference.
   */
  getAccess: async (): Promise<CordisAccess> => {
    const response = await api.get<CordisAccess>('/cordis/access');
    return response.data;
  },

  /**
   * Set the administrator opt-in.
   *
   * Enabling starts the engine on its next request; disabling stops it at once.
   * A pinned value is rejected with 409, and the reason is surfaced rather than
   * swallowed so the settings card can explain the lock.
   */
  setAccess: async (enabled: boolean): Promise<CordisAccess> => {
    const response = await api.put<CordisAccess>('/cordis/access', { enabled });
    return response.data;
  },

  /** List engine sessions, newest first. */
  listSessions: async (): Promise<CordisSessionSummary[]> => {
    if (isDemoMode()) return [];
    const response = await api.get<{ sessions: CordisSessionSummary[] }>(
      '/cordis/sessions'
    );
    return response.data.sessions ?? [];
  },

  /** Read one session with its projected messages. */
  getSession: async (sessionId: string): Promise<CordisSession> => {
    const response = await api.get<{ session: CordisSession }>(
      `/cordis/sessions/${encodeURIComponent(sessionId)}`
    );
    return response.data.session;
  },

  /** Create a session. The id is reserved until the first message. */
  createSession: async (
    options: {
      cwd?: string;
      title?: string;
      model?: string;
      permissionMode?: CordisPermissionMode;
    } = {}
  ): Promise<CordisSession> => {
    const response = await api.post<{ session: CordisSession }>(
      '/cordis/sessions',
      options
    );
    return response.data.session;
  },

  /** Delete a session and dispose any agent bound to it. */
  deleteSession: async (sessionId: string): Promise<boolean> => {
    const response = await api.delete<ApiResponse>(
      `/cordis/sessions/${encodeURIComponent(sessionId)}`
    );
    return response.data.success;
  },

  /** List live agents. */
  listAgents: async (): Promise<CordisAgent[]> => {
    if (isDemoMode()) return [];
    const response = await api.get<{ agents: CordisAgent[] }>('/cordis/agents');
    return response.data.agents ?? [];
  },

  /** List the tools the engine registered. */
  listTools: async (): Promise<CordisTool[]> => {
    if (isDemoMode()) return [];
    const response = await api.get<{ tools: CordisTool[] }>('/cordis/tools');
    return response.data.tools ?? [];
  },

  /** Cancel the in-flight turn for a session. */
  cancel: async (sessionId: string): Promise<boolean> => {
    const response = await api.post<ApiResponse>(
      `/cordis/sessions/${encodeURIComponent(sessionId)}/cancel`
    );
    return response.data.success;
  },

  /**
   * Send a chat turn and stream the response.
   *
   * The response is newline-delimited JSON: one `CordisStreamChunk` per line,
   * ending with a `done` chunk. `fetch` is used directly rather than the shared
   * client because the shared client buffers whole responses, and buffering
   * would defeat the point of a stream.
   *
   * @param sessionId - the session the turn belongs to.
   * @param text - the user's message.
   * @param options - chunk callback and abort signal.
   * @returns every chunk in order, after the stream closes.
   */
  sendMessage: async (
    sessionId: string,
    text: string,
    options: SendCordisMessageOptions = {}
  ): Promise<CordisStreamChunk[]> => {
    if (isDemoMode()) {
      const chunks: CordisStreamChunk[] = [
        { type: 'text', text: 'Demo mode has no engine attached.' },
        { type: 'done', reason: 'demo' },
      ];
      chunks.forEach(chunk => options.onChunk?.(chunk));
      return chunks;
    }

    const response = await fetch(
      `${API_BASE_URL}/cordis/sessions/${encodeURIComponent(sessionId)}/messages`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader() },
        body: JSON.stringify({ text }),
        signal: options.signal,
      }
    );

    if (!response.ok) {
      // The route reports caller errors (unknown session, turn already in
      // flight, streaming disabled) as JSON, so surface that message rather
      // than a bare status.
      const detail = await response
        .json()
        .then((body: { error?: string }) => body.error)
        .catch(() => undefined);
      throw new Error(detail ?? `HTTP error! status: ${response.status}`);
    }
    if (!response.body) throw new Error('No response body reader available');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const chunks: CordisStreamChunk[] = [];
    let buffer = '';

    try {
      for (;;) {
        options.signal?.throwIfAborted();
        const { done, value } = await reader.read();
        options.signal?.throwIfAborted();
        buffer += decoder.decode(value, { stream: !done });

        // Preserve partial lines and UTF-8 characters between network reads.
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        if (done && buffer.trim() !== '') lines.push(buffer);
        for (const line of lines) {
          if (line.trim() === '') continue;
          const chunk = parseChunk(line);
          chunks.push(chunk);
          options.onChunk?.(chunk);
          // `done` owns termination even if a proxy leaves the socket open.
          if (chunk.type === 'done') return chunks;
        }
        if (done)
          throw new Error('Engine stream ended before completing the turn');
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  },
};

export default cordisApi;
