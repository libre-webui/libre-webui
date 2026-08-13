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

import { api } from './client';
import type { ApiResponse } from '@/types';
import {
  buildWorkTerminalUrl as buildSharedWorkTerminalUrl,
  WORK_TERMINAL_WEBSOCKET_PATH,
  type WebSocketUrlEnvironment,
} from '@/utils/websocketUrl';

export const WORK_TERMINAL_PATH = WORK_TERMINAL_WEBSOCKET_PATH;

interface TerminalUrlEnvironment extends WebSocketUrlEnvironment {
  ticket: string;
}

/**
 * Mirrors the chat WebSocket origin rules so the terminal works in Electron
 * (file://), an explicitly configured API base, production same-origin, and
 * the split-port development server.
 */
export function buildWorkTerminalUrl(
  taskId: string,
  environment: TerminalUrlEnvironment
): string {
  return buildSharedWorkTerminalUrl(taskId, environment.ticket, environment);
}

export async function workTerminalUrl(taskId: string): Promise<string> {
  const response = await api.post<
    ApiResponse<{ ticket: string; expiresAt: string }>
  >('/auth/websocket-ticket', {
    audience: 'work-terminal',
    taskId,
  });
  const ticket = response.data.data?.ticket;
  if (!ticket) throw new Error('The server did not issue a terminal ticket.');
  return buildWorkTerminalUrl(taskId, {
    protocol: window.location.protocol,
    host: window.location.host,
    hostname: window.location.hostname,
    apiBaseUrl: import.meta.env.VITE_API_BASE_URL,
    websocketBaseUrl: import.meta.env.VITE_WS_BASE_URL,
    production: import.meta.env.PROD,
    ticket,
  });
}
