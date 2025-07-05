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
import { isDemoMode } from '@/utils/demoMode';

class WebSocketService {
  private ws: WebSocket | null = null;
  private url: string;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelay = 1000;
  private messageHandlers: Map<string, (data: unknown) => void> = new Map();

  constructor() {
    // Use the backend URL for WebSocket connection
    const apiUrl = import.meta.env.VITE_API_URL || 'http://localhost:3001';
    const wsUrl = apiUrl
      .replace('http://', 'ws://')
      .replace('https://', 'wss://');
    this.url = `${wsUrl}/ws`;
  }

  connect(): Promise<void> {
    if (isDemoMode()) {
      console.log('Demo mode active: skipping WebSocket connection.');
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      try {
        // Include auth token in WebSocket connection
        const token = localStorage.getItem('auth-token');
        const wsUrlWithAuth = token
          ? `${this.url}?token=${encodeURIComponent(token)}`
          : this.url;

        this.ws = new WebSocket(wsUrlWithAuth);

        this.ws.onopen = () => {
          console.log('WebSocket connected');
          this.reconnectAttempts = 0;
          resolve();
        };

        this.ws.onmessage = event => {
          try {
            const message: WebSocketMessage = JSON.parse(event.data);
            const handler = this.messageHandlers.get(message.type);
            if (handler) {
              handler(message.data);
            }
          } catch (_error) {
            console.error('Failed to parse WebSocket message:', _error);
          }
        };

        this.ws.onclose = () => {
          console.log('WebSocket disconnected');
          this.ws = null;
          this.attemptReconnect();
        };

        this.ws.onerror = error => {
          console.error('WebSocket error:', error);
          reject(error);
        };
      } catch (_error) {
        reject(_error);
      }
    });
  }

  disconnect() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  send(message: WebSocketMessage | Record<string, unknown>) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    } else {
      console.warn('WebSocket is not connected');
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
      console.log('Demo mode active: skipping WebSocket reconnection.');
      return;
    }
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      console.log(
        `Attempting to reconnect... (${this.reconnectAttempts}/${this.maxReconnectAttempts})`
      );

      setTimeout(() => {
        this.connect().catch(() => {
          // Will try again if this fails
        });
      }, this.reconnectDelay * this.reconnectAttempts);
    } else {
      console.error('Max reconnection attempts reached');
    }
  }

  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}

export default new WebSocketService();
