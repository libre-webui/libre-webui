/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

export const CHAT_WEBSOCKET_PATH = '/ws';
export const WORK_TERMINAL_WEBSOCKET_PATH = '/ws/work-terminal';

export interface WebSocketUrlEnvironment {
  protocol: string;
  host: string;
  hostname: string;
  apiBaseUrl?: string;
  websocketBaseUrl?: string;
  production: boolean;
}

function parseConfiguredUrl(
  value: string,
  variableName: string,
  allowedProtocols: readonly string[]
): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${variableName} must be an absolute URL.`);
  }
  if (!allowedProtocols.includes(url.protocol)) {
    throw new Error(
      `${variableName} must use ${allowedProtocols.join(' or ')}.`
    );
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      `${variableName} must not contain credentials, a query, or a fragment.`
    );
  }
  return url;
}

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, '');
}

function configuredWebSocketBase(value: string): string {
  const url = parseConfiguredUrl(value, 'VITE_WS_BASE_URL', ['ws:', 'wss:']);
  return trimTrailingSlashes(url.toString());
}

function webSocketBaseFromApi(value: string): string {
  const url = parseConfiguredUrl(value, 'VITE_API_BASE_URL', [
    'http:',
    'https:',
  ]);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = url.pathname.replace(/\/api\/?$/, '');
  return trimTrailingSlashes(url.toString());
}

/**
 * Resolve the WebSocket base once for every browser transport. An explicit
 * VITE_WS_BASE_URL wins over the API and same-origin fallbacks and may include
 * a reverse-proxy path prefix.
 */
export function resolveWebSocketBaseUrl(
  environment: WebSocketUrlEnvironment
): string {
  const configured = environment.websocketBaseUrl?.trim();
  if (configured) return configuredWebSocketBase(configured);

  if (environment.protocol === 'file:') return 'ws://localhost:3001';

  const apiBase = environment.apiBaseUrl?.trim();
  if (apiBase) return webSocketBaseFromApi(apiBase);

  const scheme = environment.protocol === 'https:' ? 'wss:' : 'ws:';
  return environment.production
    ? `${scheme}//${environment.host}`
    : `${scheme}//${environment.hostname}:3001`;
}

function buildWebSocketUrl(
  path: string,
  environment: WebSocketUrlEnvironment,
  parameters: Record<string, string>
): string {
  const base = resolveWebSocketBaseUrl(environment);
  const url = new URL(`${base}/${path.replace(/^\/+/, '')}`);
  for (const [name, value] of Object.entries(parameters)) {
    url.searchParams.set(name, value);
  }
  return url.toString();
}

export function buildChatWebSocketUrl(
  ticket: string,
  environment: WebSocketUrlEnvironment
): string {
  return buildWebSocketUrl(CHAT_WEBSOCKET_PATH, environment, { ticket });
}

export function buildWorkTerminalUrl(
  taskId: string,
  ticket: string,
  environment: WebSocketUrlEnvironment
): string {
  return buildWebSocketUrl(WORK_TERMINAL_WEBSOCKET_PATH, environment, {
    taskId,
    ticket,
  });
}
