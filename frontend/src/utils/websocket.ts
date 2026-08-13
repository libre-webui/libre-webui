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

const logger = createLogger('websocket');

class WebSocketService {
  private ws: WebSocket | null = null;
  private url: string;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelay = 1000;
  private messageHandlers: Map<string, (data: unknown) => void> = new Map();
  private connectPromise: Promise<void> | null = null;
  private shouldReconnect = false;
  private connectionEpoch = 0;

  constructor() {
    // For WebSocket, we need to connect to the backend server (port 3001)
    // When running in Electron with file:// protocol, use localhost
    let wsUrl: string;

    if (window.location.protocol === 'file:') {
      // Electron app - use localhost directly
      wsUrl = 'ws://localhost:3001';
    } else if (import.meta.env.VITE_API_BASE_URL) {
      // Explicit API URL configured
      const apiUrl = import.meta.env.VITE_API_BASE_URL.replace(/\/api$/, '');
      wsUrl = apiUrl.replace('http://', 'ws://').replace('https://', 'wss://');
    } else if (import.meta.env.PROD) {
      // Production (npx, docker): use same origin
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      wsUrl = `${protocol}//${window.location.host}`;
    } else {
      // Development: derive from window location with port 3001
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      wsUrl = `${protocol}//${window.location.hostname}:3001`;
    }

    this.url = `${wsUrl}/ws`;
    logger.debug('WebSocket URL constructed:', this.url);
  }

  connect(): Promise<void> {
    if (isDemoMode()) {
      logger.debug('Demo mode active: skipping WebSocket connection.');
      return Promise.resolve();
    }

    if (this.ws?.readyState === WebSocket.OPEN) return Promise.resolve();
    if (this.connectPromise) return this.connectPromise;

    this.shouldReconnect = true;
    const epoch = ++this.connectionEpoch;
    const attempt = this.openWithTicket(epoch).finally(() => {
      if (this.connectPromise === attempt) this.connectPromise = null;
    });
    this.connectPromise = attempt;
    return attempt;
  }

  private async openWithTicket(epoch: number): Promise<void> {
    let response;
    try {
      response = await api.post<
        ApiResponse<{ ticket: string; expiresAt: string }>
      >('/auth/websocket-ticket', { audience: 'chat' });
    } catch (error) {
      if (this.shouldReconnect && epoch === this.connectionEpoch) {
        this.attemptReconnect();
      }
      throw error;
    }
    const ticket = response.data.data?.ticket;
    if (!ticket)
      throw new Error('The server did not issue a WebSocket ticket.');
    if (!this.shouldReconnect || epoch !== this.connectionEpoch) return;

    logger.debug('WebSocket: Attempting to connect to:', this.url);

    return new Promise((resolve, reject) => {
      try {
        const wsUrlWithAuth = `${this.url}?ticket=${encodeURIComponent(ticket)}`;

        logger.debug('WebSocket: Connecting with a one-use ticket');

        const socket = new WebSocket(wsUrlWithAuth);
        this.ws = socket;

        socket.onopen = () => {
          if (!this.shouldReconnect || epoch !== this.connectionEpoch) {
            socket.close();
            resolve();
            return;
          }
          logger.debug('WebSocket connected successfully');
          this.reconnectAttempts = 0;
          resolve();
        };

        socket.onmessage = event => {
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
          if (this.shouldReconnect && epoch === this.connectionEpoch) {
            this.attemptReconnect();
          }
        };

        socket.onerror = error => {
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
    this.connectPromise = null;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
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

  private attemptReconnect() {
    if (isDemoMode()) {
      logger.debug('Demo mode active: skipping WebSocket reconnection.');
      return;
    }
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      logger.debug(
        `Attempting to reconnect... (${this.reconnectAttempts}/${this.maxReconnectAttempts})`
      );

      setTimeout(() => {
        if (!this.shouldReconnect) return;
        this.connect().catch(() => {
          // Will try again if this fails
        });
      }, this.reconnectDelay * this.reconnectAttempts);
    } else {
      logger.error('Max reconnection attempts reached');
    }
  }

  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}

export default new WebSocketService();
