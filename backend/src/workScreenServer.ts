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
 * Work Computer screen relay: bridges an authenticated browser WebSocket to
 * the websockify endpoint inside a task's sandbox, view-only in this phase.
 *
 * Auth mirrors the Work terminal exactly — a short-lived one-use ticket
 * bound to the 'work-screen' audience and the task, then a live check that
 * the current database state still grants Work access and task ownership.
 * The relay itself is a raw byte pipe after both WebSocket handshakes: the
 * browser and websockify speak RFB over WS framing end to end, so nothing
 * here parses frames. The GUI policy gate and the published-port lookup run
 * per connection; a task whose policy lost the GUI cannot be watched.
 */

import http from 'http';
import type { IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import {
  websocketTicketService,
  WebSocketTicketCoordinationError,
} from './services/websocketTicketService.js';
import { requireCurrentTerminalTask } from './workTerminalServer.js';
import workRuntimeService from './services/workRuntimeService.js';
import workPolicyService from './services/workPolicyService.js';
import { WorkRuntimeError } from './services/workRuntimeShared.js';
import type { WorkTaskRecord } from './types/work.js';
import { createLogger } from './utils/logger.js';

const logger = createLogger('work-screen');

export const WORK_SCREEN_WS_PATH = '/ws/work-screen';
/** Concurrent viewers per task; watching is cheap but not free. */
export const WORK_SCREEN_MAX_VIEWERS_PER_TASK = 4;
/** Screen viewing counts as task activity at this cadence (idle sweep). */
const ACTIVITY_TICK_MS = 60_000;

/** Response headers a WebSocket client may see from the upstream 101. */
const SAFE_RESPONSE_HEADERS = new Set([
  'upgrade',
  'connection',
  'sec-websocket-accept',
  'sec-websocket-protocol',
  'sec-websocket-extensions',
]);

const viewersByTask = new Map<string, number>();

const httpError = (socket: Duplex, status: number, message: string): void => {
  if (!socket.destroyed) {
    socket.end(
      `HTTP/1.1 ${status} ${http.STATUS_CODES[status] || 'Error'}\r\n` +
        `Content-Type: text/plain\r\nConnection: close\r\n\r\n${message}`
    );
  }
};

interface ScreenAuthResult {
  task: WorkTaskRecord;
  userId: string;
  sessionExpiresAt?: number;
}

async function authorizeScreenRequest(
  req: IncomingMessage
): Promise<ScreenAuthResult> {
  const url = new URL(req.url || '', 'http://localhost');
  const ticket = url.searchParams.get('ticket') || '';
  const taskId = url.searchParams.get('taskId') || '';
  if (!ticket || !taskId) {
    throw new WorkRuntimeError(
      'The Work Computer screen requires authentication.',
      401,
      'WORK_SCREEN_UNAUTHORIZED'
    );
  }
  let consumed;
  try {
    consumed = await websocketTicketService.consume(
      ticket,
      'work-screen',
      taskId
    );
  } catch (error) {
    if (error instanceof WebSocketTicketCoordinationError) {
      throw new WorkRuntimeError(
        'Work Computer authentication is temporarily unavailable.',
        503,
        'WORK_SCREEN_AUTH_UNAVAILABLE'
      );
    }
    throw error;
  }
  if (!consumed) {
    throw new WorkRuntimeError(
      'Invalid or expired screen session ticket.',
      401,
      'WORK_SCREEN_UNAUTHORIZED'
    );
  }
  // Same live re-check the terminal uses: active account, current Work
  // access mode, and task ownership — a revocation is effective immediately.
  const task = await requireCurrentTerminalTask(consumed.userId, taskId);
  return {
    task,
    userId: consumed.userId,
    ...(consumed.sessionExpiresAt
      ? { sessionExpiresAt: consumed.sessionExpiresAt }
      : {}),
  };
}

/**
 * Claims upgrade requests for the screen path. Returns true when handled.
 * Registered from the shared upgrade dispatcher after origin filtering.
 */
export function tryHandleScreenUpgrade(
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer
): boolean {
  let pathname: string;
  try {
    pathname = new URL(request.url || '', 'http://localhost').pathname;
  } catch {
    return false;
  }
  if (pathname !== WORK_SCREEN_WS_PATH) return false;
  socket.pause();
  void handleScreenUpgrade(request, socket, head).catch(error => {
    logger.warn('Work screen upgrade failed:', error);
    if (!socket.destroyed) socket.destroy();
  });
  return true;
}

async function handleScreenUpgrade(
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer
): Promise<void> {
  let auth: ScreenAuthResult;
  try {
    auth = await authorizeScreenRequest(request);
  } catch (error) {
    const status = error instanceof WorkRuntimeError ? error.status : 500;
    const message =
      error instanceof WorkRuntimeError
        ? error.message
        : 'Screen authorization failed.';
    httpError(socket, status, message);
    return;
  }
  const { task } = auth;

  const policy = await workPolicyService.resolve(task.policyId);
  if (policy.guiEnabled !== true) {
    httpError(socket, 403, 'This task has no Work Computer.');
    return;
  }
  if ((viewersByTask.get(task.id) ?? 0) >= WORK_SCREEN_MAX_VIEWERS_PER_TASK) {
    httpError(socket, 409, 'Too many viewers on this screen.');
    return;
  }

  let endpoint;
  try {
    endpoint = await workRuntimeService.driver.screenEndpoint(task);
  } catch (error) {
    logger.warn(`Screen endpoint lookup failed for ${task.id}:`, error);
  }
  if (!endpoint) {
    httpError(socket, 409, 'The Work Computer screen is not running.');
    return;
  }
  socket.resume();

  // Forward only the WebSocket handshake headers websockify needs.
  const headers: Record<string, string> = {
    host: `${endpoint.host}:${endpoint.port}`,
    connection: 'Upgrade',
    upgrade: request.headers.upgrade || 'websocket',
  };
  for (const name of [
    'sec-websocket-key',
    'sec-websocket-version',
    'sec-websocket-protocol',
    'sec-websocket-extensions',
  ]) {
    const value = request.headers[name];
    if (typeof value === 'string') headers[name] = value;
  }

  const upstreamRequest = http.request({
    hostname: endpoint.host,
    port: endpoint.port,
    path: '/',
    method: 'GET',
    headers,
  });
  socket.once('error', error => {
    logger.debug('Screen client socket closed with an error:', error);
  });

  upstreamRequest.on('upgrade', (upstream, upstreamSocket, upstreamHead) => {
    viewersByTask.set(task.id, (viewersByTask.get(task.id) ?? 0) + 1);
    workRuntimeService.noteTaskActivity(task.id);
    const activityTimer = setInterval(() => {
      workRuntimeService.noteTaskActivity(task.id);
    }, ACTIVITY_TICK_MS);
    activityTimer.unref();
    // The ticket's backing auth session bounds how long a viewer may stay.
    const expiryTimer = auth.sessionExpiresAt
      ? setTimeout(
          () => socket.destroy(),
          Math.max(0, auth.sessionExpiresAt - Date.now())
        )
      : undefined;
    expiryTimer?.unref();

    const statusLine = `HTTP/${upstream.httpVersion} ${upstream.statusCode || 101} ${upstream.statusMessage || 'Switching Protocols'}\r\n`;
    const headerLines: string[] = [];
    for (let index = 0; index < upstream.rawHeaders.length; index += 2) {
      const name = upstream.rawHeaders[index];
      const value = upstream.rawHeaders[index + 1];
      if (!name || !SAFE_RESPONSE_HEADERS.has(name.toLowerCase())) continue;
      headerLines.push(`${name}: ${value}`);
    }
    socket.write(`${statusLine}${headerLines.join('\r\n')}\r\n\r\n`);
    if (upstreamHead.length > 0) socket.write(upstreamHead);
    if (head.length > 0) upstreamSocket.write(head);

    const cleanup = (): void => {
      clearInterval(activityTimer);
      if (expiryTimer) clearTimeout(expiryTimer);
      const remaining = (viewersByTask.get(task.id) ?? 1) - 1;
      if (remaining <= 0) viewersByTask.delete(task.id);
      else viewersByTask.set(task.id, remaining);
      workRuntimeService.noteTaskActivity(task.id);
    };
    upstreamSocket.once('error', error => {
      logger.debug('Screen upstream socket closed with an error:', error);
      socket.destroy();
    });
    socket.once('close', () => {
      upstreamSocket.destroy();
      cleanup();
    });
    upstreamSocket.pipe(socket);
    socket.pipe(upstreamSocket);
  });
  upstreamRequest.on('response', upstream => {
    upstream.resume();
    httpError(socket, upstream.statusCode || 502, 'Screen upgrade failed.');
  });
  upstreamRequest.on('error', error => {
    logger.warn('Work screen relay failed:', error.message);
    httpError(socket, 502, 'The Work Computer screen is unreachable.');
  });
  upstreamRequest.end();
}
