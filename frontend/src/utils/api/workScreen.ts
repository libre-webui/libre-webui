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
import { buildWorkScreenUrl } from '../websocketUrl';

/** Ask the server to start the task's Work Computer GUI session. */
export async function startWorkComputer(taskId: string): Promise<void> {
  await api.post(`/work/tasks/${encodeURIComponent(taskId)}/computer/start`);
}

/**
 * Mint a one-use screen ticket and build the authenticated WebSocket URL,
 * mirroring the Work terminal's flow exactly.
 */
export async function workScreenUrl(taskId: string): Promise<string> {
  const response = await api.post<
    ApiResponse<{ ticket: string; expiresAt: string }>
  >('/auth/websocket-ticket', {
    audience: 'work-screen',
    taskId,
  });
  const ticket = response.data.data?.ticket;
  if (!ticket) throw new Error('The server did not issue a screen ticket.');
  return buildWorkScreenUrl(taskId, ticket, {
    protocol: window.location.protocol,
    host: window.location.host,
    hostname: window.location.hostname,
    apiBaseUrl: import.meta.env.VITE_API_BASE_URL,
    websocketBaseUrl: import.meta.env.VITE_WS_BASE_URL,
    production: import.meta.env.PROD,
  });
}
