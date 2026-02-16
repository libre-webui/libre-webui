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

import WebSocket from 'ws';
import { randomUUID } from 'crypto';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface GatewayFrame {
  type: 'req' | 'res' | 'event';
  id?: string;
  method?: string;
  params?: unknown;
  ok?: boolean;
  payload?: unknown;
  error?: { message?: string };
  event?: string;
  seq?: number;
}

interface PendingRequest {
  resolve: (payload: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface ToolStreamEvent {
  toolCallId: string;
  name: string;
  phase: string; // start | update | result
  args?: unknown;
  result?: unknown;
  partialResult?: unknown;
}

export interface ChatDeltaEvent {
  runId: string;
  sessionKey: string;
  state: 'delta' | 'final' | 'aborted' | 'error';
  message?: unknown;
  errorMessage?: string;
}

export type SessionEventCallback = (
  type: 'chat' | 'tool' | 'connected' | 'disconnected' | 'error',
  data: unknown
) => void;

// ---------------------------------------------------------------------------
// OpenClawSessionService
// ---------------------------------------------------------------------------

class OpenClawSessionService {
  private ws: WebSocket | null = null;
  private pending = new Map<string, PendingRequest>();
  private gatewayUrl: string = '';
  private gatewayToken: string = '';
  private sessionKey: string = 'main';
  private connected = false;
  private connectNonce: string | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private backoffMs = 800;
  private listeners = new Set<SessionEventCallback>();
  private closing = false;

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /** Configure and connect to the OpenClaw gateway WebSocket. */
  connect(opts: {
    gatewayUrl: string;
    token: string;
    sessionKey?: string;
  }): void {
    // Derive WS URL from HTTP URL
    const httpUrl = opts.gatewayUrl.replace(/\/v1\/chat\/completions$/, '');
    this.gatewayUrl = httpUrl
      .replace(/^http:/, 'ws:')
      .replace(/^https:/, 'wss:');
    this.gatewayToken = opts.token;
    this.sessionKey = opts.sessionKey ?? 'main';
    this.closing = false;
    this.doConnect();
  }

  /** Disconnect from the gateway. */
  disconnect(): void {
    this.closing = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
    this.connected = false;
    this.flushPending(new Error('disconnected'));
  }

  /** Subscribe to session events (chat deltas, tool calls, etc.). */
  subscribe(cb: SessionEventCallback): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Send a chat message into the agent session. Returns the runId. */
  async sendMessage(
    message: string,
    sessionKey?: string
  ): Promise<{ runId: string; status: string }> {
    const key = sessionKey ?? this.sessionKey;
    const idempotencyKey = randomUUID();
    const result = (await this.request('chat.send', {
      sessionKey: key,
      message,
      deliver: false,
      idempotencyKey,
    })) as { runId?: string; status?: string };
    return {
      runId: result?.runId ?? idempotencyKey,
      status: result?.status ?? 'started',
    };
  }

  /** Abort the current run. */
  async abort(sessionKey?: string, runId?: string): Promise<void> {
    const params: Record<string, string> = {
      sessionKey: sessionKey ?? this.sessionKey,
    };
    if (runId) params.runId = runId;
    await this.request('chat.abort', params);
  }

  /** Fetch chat history. */
  async history(
    sessionKey?: string,
    limit = 200
  ): Promise<{ messages: unknown[] }> {
    const result = (await this.request('chat.history', {
      sessionKey: sessionKey ?? this.sessionKey,
      limit,
    })) as { messages?: unknown[] };
    return { messages: result?.messages ?? [] };
  }

  get isConnected(): boolean {
    return this.connected;
  }

  // -------------------------------------------------------------------------
  // WebSocket lifecycle
  // -------------------------------------------------------------------------

  private doConnect(): void {
    if (this.closing) return;
    console.log(`[OpenClawSession] Connecting to gateway: ${this.gatewayUrl}`);

    try {
      this.ws = new WebSocket(this.gatewayUrl);
    } catch (err) {
      console.error('[OpenClawSession] Failed to create WebSocket:', err);
      this.scheduleReconnect();
      return;
    }

    this.ws.on('open', () => {
      console.log('[OpenClawSession] WebSocket open, waiting for challenge…');
    });

    this.ws.on('message', (data: WebSocket.Data) => {
      this.handleMessage(String(data));
    });

    this.ws.on('close', (code: number, reason: Buffer) => {
      const reasonStr = reason?.toString() ?? '';
      console.log(`[OpenClawSession] WebSocket closed (${code}): ${reasonStr}`);
      this.ws = null;
      this.connected = false;
      this.flushPending(new Error(`gateway closed (${code}): ${reasonStr}`));
      this.emit('disconnected', { code, reason: reasonStr });
      this.scheduleReconnect();
    });

    this.ws.on('error', (err: Error) => {
      console.error('[OpenClawSession] WebSocket error:', err.message);
    });
  }

  private scheduleReconnect(): void {
    if (this.closing) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 1.7, 15000);
    this.reconnectTimer = setTimeout(() => this.doConnect(), delay);
  }

  // -------------------------------------------------------------------------
  // Protocol handling
  // -------------------------------------------------------------------------

  private handleMessage(raw: string): void {
    let frame: GatewayFrame;
    try {
      frame = JSON.parse(raw);
    } catch {
      return;
    }

    if (frame.type === 'event') {
      this.handleEvent(frame);
      return;
    }

    if (frame.type === 'res') {
      const pending = this.pending.get(frame.id!);
      if (!pending) return;
      this.pending.delete(frame.id!);
      clearTimeout(pending.timer);
      if (frame.ok) {
        pending.resolve(frame.payload);
      } else {
        pending.reject(new Error(frame.error?.message ?? 'request failed'));
      }
    }
  }

  private handleEvent(frame: GatewayFrame): void {
    // Handle connect challenge
    if (frame.event === 'connect.challenge') {
      const payload = frame.payload as { nonce?: string } | undefined;
      if (payload?.nonce) {
        this.connectNonce = payload.nonce;
        this.sendConnect();
      }
      return;
    }

    // Handle chat events — forward to listeners
    if (frame.event === 'chat') {
      this.emit('chat', frame.payload);
      return;
    }

    // Handle agent events (tool streaming)
    if (frame.event === 'agent') {
      const payload = frame.payload as {
        stream?: string;
        data?: Record<string, unknown>;
        runId?: string;
        sessionKey?: string;
      };
      if (payload?.stream === 'tool' && payload.data) {
        const toolEvent: ToolStreamEvent = {
          toolCallId: (payload.data.toolCallId as string) ?? '',
          name: (payload.data.name as string) ?? 'tool',
          phase: (payload.data.phase as string) ?? '',
          args: payload.data.args,
          result: payload.data.result,
          partialResult: payload.data.partialResult,
        };
        this.emit('tool', toolEvent);
      }
      return;
    }
  }

  private async sendConnect(): Promise<void> {
    const params = {
      minProtocol: 3,
      maxProtocol: 3,
      client: {
        id: 'gateway-client',
        version: '1.0.0',
        platform: 'node',
        mode: 'backend',
      },
      role: 'operator',
      scopes: ['operator.read', 'operator.write'],
      caps: [],
      auth: { token: this.gatewayToken },
      userAgent: 'libre-webui/1.0.0',
      locale: 'en-US',
    };

    try {
      const result = (await this.request('connect', params)) as {
        type?: string;
        protocol?: number;
      };
      console.log(
        '[OpenClawSession] Connected to gateway, protocol:',
        result?.protocol
      );
      this.connected = true;
      this.backoffMs = 800;
      this.emit('connected', {});
    } catch (err) {
      console.error('[OpenClawSession] Connect failed:', err);
      this.ws?.close(4008, 'connect failed');
    }
  }

  // -------------------------------------------------------------------------
  // Request/response
  // -------------------------------------------------------------------------

  private request(method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return reject(new Error('gateway not connected'));
      }

      const id = randomUUID();
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`request timeout: ${method}`));
      }, 30000);

      this.pending.set(id, { resolve, reject, timer });

      const frame: GatewayFrame = {
        type: 'req',
        id,
        method,
        params,
      };
      this.ws.send(JSON.stringify(frame));
    });
  }

  private flushPending(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  // -------------------------------------------------------------------------
  // Event emission
  // -------------------------------------------------------------------------

  private emit(
    type: 'chat' | 'tool' | 'connected' | 'disconnected' | 'error',
    data: unknown
  ): void {
    for (const cb of this.listeners) {
      try {
        cb(type, data);
      } catch (err) {
        console.error('[OpenClawSession] Listener error:', err);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers to extract text from gateway chat message format
// ---------------------------------------------------------------------------

export function extractTextFromMessage(message: unknown): string | null {
  if (!message || typeof message !== 'object') return null;
  const msg = message as Record<string, unknown>;

  // Direct text field
  if (typeof msg.text === 'string') return msg.text;

  // content field — string or array
  const content = msg.content;
  if (typeof content === 'string') return content;

  if (Array.isArray(content)) {
    const parts = content
      .filter(
        (block: unknown) =>
          typeof block === 'object' &&
          block !== null &&
          (block as Record<string, unknown>).type === 'text' &&
          typeof (block as Record<string, unknown>).text === 'string'
      )
      .map((block: unknown) => (block as Record<string, string>).text);
    if (parts.length > 0) return parts.join('\n');
  }

  return null;
}

// Singleton
const openclawSessionService = new OpenClawSessionService();
export default openclawSessionService;
