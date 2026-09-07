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

import { WebSocketMessage } from '@/types';
import type { ApiResponse } from '@/types';
import { api } from '@/utils/api/client';
import { isDemoMode } from '@/utils/demoMode';
import { createLogger } from '@/utils/logger';
import {
  buildChatWebSocketUrl,
  resolveWebSocketBaseUrl,
  type WebSocketUrlEnvironment,
} from '@/utils/websocketUrl';

const logger = createLogger('websocket');

const isAuthenticationFailure = (error: unknown): boolean => {
  // The shared HTTP client replaces a 401 with this error after signing out.
  if (error instanceof Error && error.message === 'Session expired')
    return true;
  const status = (error as { response?: { status?: number } } | null)?.response
    ?.status;
  return status === 401 || status === 403;
};

export class WebSocketService {
  private ws: WebSocket | null = null;
  private readonly urlEnvironment: WebSocketUrlEnvironment;
  private reconnectAttempts = 0;
  private reconnectDelay = 1000;
  private maxReconnectDelay = 30_000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private messageHandlers: Map<string, (data: unknown) => void> = new Map();
  private connectPromise: Promise<void> | null = null;
  private shouldReconnect = false;
  private connectionEpoch = 0;

  constructor() {
    this.urlEnvironment = {
      protocol: window.location.protocol,
      host: window.location.host,
      hostname: window.location.hostname,
      apiBaseUrl: import.meta.env?.VITE_API_BASE_URL,
      websocketBaseUrl: import.meta.env?.VITE_WS_BASE_URL,
      production: import.meta.env?.PROD === true,
    };
    logger.debug(
      'WebSocket base URL resolved:',
      resolveWebSocketBaseUrl(this.urlEnvironment)
    );
  }

  connect(): Promise<void> {
    if (isDemoMode()) {
      logger.debug('Demo mode active: skipping WebSocket connection.');
      return Promise.resolve();
    }

    if (this.ws?.readyState === WebSocket.OPEN) return Promise.resolve();
    if (this.connectPromise) return this.connectPromise;

    this.clearReconnectTimer();
    this.shouldReconnect = true;
    const epoch = ++this.connectionEpoch;
    const attempt = this.openWithTicket(epoch)
      .catch(error => {
        if (!this.shouldReconnect || epoch !== this.connectionEpoch) return;
        if (isAuthenticationFailure(error)) {
          this.shouldReconnect = false;
          this.clearReconnectTimer();
        } else {
          this.attemptReconnect(epoch);
        }
        throw error;
      })
      .finally(() => {
        if (this.connectPromise === attempt) this.connectPromise = null;
      });
    this.connectPromise = attempt;
    return attempt;
  }

  private async openWithTicket(epoch: number): Promise<void> {
    const response = await api.post<
      ApiResponse<{ ticket: string; expiresAt: string }>
    >('/auth/websocket-ticket', { audience: 'chat' });
    const ticket = response.data.data?.ticket;
    if (!ticket)
      throw new Error('The server did not issue a WebSocket ticket.');
    if (!this.shouldReconnect || epoch !== this.connectionEpoch) return;

    logger.debug('WebSocket: Attempting to connect');

    return new Promise((resolve, reject) => {
      try {
        const wsUrlWithAuth = buildChatWebSocketUrl(
          ticket,
          this.urlEnvironment
        );

        logger.debug('WebSocket: Connecting with a one-use ticket');

        const socket = new WebSocket(wsUrlWithAuth);
        let opened = false;
        this.ws = socket;

        socket.onopen = () => {
          if (!this.shouldReconnect || epoch !== this.connectionEpoch) {
            socket.close();
            resolve();
            return;
          }
          logger.debug('WebSocket connected successfully');
          opened = true;
          this.reconnectAttempts = 0;
          this.clearReconnectTimer();
          resolve();
        };

        socket.onmessage = event => {
          if (!this.shouldReconnect || epoch !== this.connectionEpoch) return;
          try {
            const message: WebSocketMessage = JSON.parse(event.data);
            const handler = this.messageHandlers.get(message.type);
            if (handler) {
              handler(message.data);
            } else if (message.type === 'connected') {
              logger.debug('WebSocket: Server confirmed connection');
            } else {
              logger.warn(
                'WebSocket: No handler for message type:',
                message.type
              );
            }
          } catch (_error) {
            logger.error('Failed to parse WebSocket message:', _error);
          }
        };

        socket.onclose = () => {
          logger.debug('WebSocket disconnected');
          if (this.ws === socket) this.ws = null;
          if (epoch !== this.connectionEpoch) {
            // Settle a superseded attempt so its awaiter never hangs when
            // the browser skips the error event for a pre-open close.
            resolve();
            return;
          }
          if (!opened) {
            // Some failed handshakes close without an error event. Settle the
            // attempt so the retry can acquire a new ticket instead of reusing
            // a permanently pending connectPromise.
            reject(new Error('WebSocket closed before opening'));
          } else if (this.shouldReconnect) {
            this.attemptReconnect(epoch);
          }
        };

        socket.onerror = error => {
          if (epoch !== this.connectionEpoch) {
            // A newer connect superseded this attempt (login re-dial,
            // explicit disconnect). Being replaced is not a failure of
            // the caller's current connection.
            resolve();
            return;
          }
          logger.error('WebSocket error:', error);
          reject(error);
        };
      } catch (_error) {
        reject(_error);
      }
    });
  }

  disconnect() {
    this.shouldReconnect = false;
    this.connectionEpoch += 1;
    this.clearReconnectTimer();
    this.reconnectAttempts = 0;
    this.connectPromise = null;
    const socket = this.ws;
    if (!socket) return;
    this.ws = null;
    if (socket.readyState === WebSocket.CONNECTING) {
      // Closing mid-handshake makes the browser log the attempt as a failed
      // connection. The open handler sees the bumped epoch and closes the
      // socket the moment it is established; a failed handshake settles
      // through the epoch-guarded error and close handlers.
      return;
    }
    socket.close();
  }

  /**
   * Atomically supersede any open socket or in-flight attempt and dial
   * fresh. Callers must use this instead of pairing disconnect() with
   * connect(): that pairing races other connect callers, whose awaited
   * attempt would be killed mid-handshake and reject.
   */
  reconnect(): Promise<void> {
    this.disconnect();
    return this.connect();
  }

  send(message: WebSocketMessage | Record<string, unknown>): boolean {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      logger.debug('WebSocket: Sending message:', message);
      this.ws.send(JSON.stringify(message));
      return true;
    } else {
      logger.warn(
        'WebSocket is not connected. ReadyState:',
        this.ws?.readyState
      );
      return false;
    }
  }

  onMessage(type: string, handler: (data: unknown) => void) {
    // Remove any existing handler for this type first
    this.messageHandlers.delete(type);
    this.messageHandlers.set(type, handler);
  }

  offMessage(type: string) {
    this.messageHandlers.delete(type);
  }

  /** Deliver a transport-neutral event through the existing chat handlers. */
  dispatchMessage(type: string, data: unknown): void {
    this.messageHandlers.get(type)?.(data);
  }

  private clearReconnectTimer() {
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private attemptReconnect(epoch: number) {
    if (
      isDemoMode() ||
      !this.shouldReconnect ||
      epoch !== this.connectionEpoch ||
      this.reconnectTimer !== null
    ) {
      return;
    }
    const delay = Math.min(
      this.reconnectDelay * 2 ** this.reconnectAttempts,
      this.maxReconnectDelay
    );
    this.reconnectAttempts = Math.min(this.reconnectAttempts + 1, 5);
    logger.debug(`Reconnecting WebSocket in ${delay}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.shouldReconnect || epoch !== this.connectionEpoch) return;
      void this.connect().catch(() => {
        // connect owns the single retry timer for transient failures.
      });
    }, delay);
  }

  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}

export default new WebSocketService();
