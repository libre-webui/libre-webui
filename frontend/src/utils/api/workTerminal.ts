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

export const WORK_TERMINAL_PATH = '/ws/work-terminal';

interface TerminalUrlEnvironment {
  protocol: string;
  host: string;
  hostname: string;
  apiBaseUrl?: string;
  production: boolean;
  token: string | null;
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
  let origin: string;
  if (environment.protocol === 'file:') {
    origin = 'ws://localhost:3001';
  } else if (environment.apiBaseUrl) {
    origin = environment.apiBaseUrl
      .replace(/\/api$/, '')
      .replace(/^http:/, 'ws:')
      .replace(/^https:/, 'wss:');
  } else {
    const scheme = environment.protocol === 'https:' ? 'wss:' : 'ws:';
    origin = environment.production
      ? `${scheme}//${environment.host}`
      : `${scheme}//${environment.hostname}:3001`;
  }
  const url = new URL(`${origin}${WORK_TERMINAL_PATH}`);
  url.searchParams.set('taskId', taskId);
  if (environment.token) url.searchParams.set('token', environment.token);
  return url.toString();
}

export function workTerminalUrl(taskId: string): string {
  return buildWorkTerminalUrl(taskId, {
    protocol: window.location.protocol,
    host: window.location.host,
    hostname: window.location.hostname,
    apiBaseUrl: import.meta.env.VITE_API_BASE_URL,
    production: import.meta.env.PROD,
    token: localStorage.getItem('auth-token'),
  });
}
