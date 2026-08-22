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

export interface WorkScreenControlState {
  holder?: { you: boolean; username?: string; expiresAt: number };
  agentWaiting: boolean;
  agentWaitingReason?: string;
}

/**
 * Ask the server to start the task's Work Computer GUI session. Returns the
 * session's view-only VNC password when the image supports takeover.
 */
export async function startWorkComputer(
  taskId: string
): Promise<{ viewOnlyPassword?: string }> {
  const response = await api.post<
    ApiResponse<{ ready: boolean; viewOnlyPassword?: string }>
  >(`/work/tasks/${encodeURIComponent(taskId)}/computer/start`);
  return { viewOnlyPassword: response.data.data?.viewOnlyPassword };
}

/** Who is driving the screen, and is the agent asking for a human? */
export async function getWorkScreenControl(
  taskId: string
): Promise<WorkScreenControlState> {
  const response = await api.get<ApiResponse<WorkScreenControlState>>(
    `/work/tasks/${encodeURIComponent(taskId)}/computer/control`
  );
  return response.data.data ?? { agentWaiting: false };
}

/** Take over (or renew) control of the screen. */
export async function acquireWorkScreenControl(
  taskId: string
): Promise<{ controlPassword: string; expiresAt: number }> {
  const response = await api.post<
    ApiResponse<{ controlPassword: string; expiresAt: number }>
  >(`/work/tasks/${encodeURIComponent(taskId)}/computer/control`);
  const data = response.data.data;
  if (!data?.controlPassword) {
    throw new Error('The server did not grant screen control.');
  }
  return data;
}

/** Hand the screen back to the agent. */
export async function releaseWorkScreenControl(taskId: string): Promise<void> {
  await api.delete(
    `/work/tasks/${encodeURIComponent(taskId)}/computer/control`
  );
}

export interface WorkTeachEvent {
  t: number;
  kind: 'down' | 'up' | 'wheel' | 'key';
  x?: number;
  y?: number;
  button?: number;
  dy?: number;
  key?: string;
  ctrl?: boolean;
  alt?: boolean;
  meta?: boolean;
  shift?: boolean;
}

/** Save a recorded demonstration as a taught skill. */
export async function saveWorkScreenTeaching(
  taskId: string,
  input: {
    name: string;
    events: WorkTeachEvent[];
    screenWidth?: number;
    screenHeight?: number;
  }
): Promise<{ slug: string; name: string; steps: number; redactions: number }> {
  const response = await api.post<
    ApiResponse<{
      skill: { id: string; slug: string; name: string };
      steps: number;
      redactions: number;
    }>
  >(`/work/tasks/${encodeURIComponent(taskId)}/computer/teach`, input);
  const data = response.data.data;
  if (!data?.skill) throw new Error('The server did not save the recording.');
  return {
    slug: data.skill.slug,
    name: data.skill.name,
    steps: data.steps,
    redactions: data.redactions,
  };
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
