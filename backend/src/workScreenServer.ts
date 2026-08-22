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
import net from 'net';
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

  // Forward only the WebSocket handshake headers websockify needs. The
  // upstream leg is a raw TCP socket with a hand-written handshake: Node's
  // HTTP-client upgrade path proved to tear the connection down shortly
  // after large frames transit, while a plain piped socket streams the VNC
  // session indefinitely.
  const headerLines = [
    `GET / HTTP/1.1`,
    `Host: ${endpoint.host}:${endpoint.port}`,
    `Connection: Upgrade`,
    `Upgrade: ${request.headers.upgrade || 'websocket'}`,
  ];
  for (const name of [
    'sec-websocket-key',
    'sec-websocket-version',
    'sec-websocket-protocol',
    'sec-websocket-extensions',
  ]) {
    const value = request.headers[name];
    if (typeof value === 'string') headerLines.push(`${name}: ${value}`);
  }

  socket.once('error', error => {
    logger.debug('Screen client socket closed with an error:', error);
  });

  const upstreamSocket = net.connect({
    host: endpoint.host,
    port: endpoint.port,
  });
  upstreamSocket.setNoDelay(true);
  let upstreamBuffer = Buffer.alloc(0);
  let established = false;

  const failUpstream = (message: string): void => {
    logger.warn(`Work screen relay failed: ${message}`);
    if (!established) httpError(socket, 502, message);
    upstreamSocket.destroy();
    if (established) socket.destroy();
  };
  upstreamSocket.once('error', error => {
    logger.debug('Screen upstream socket closed with an error:', error);
    failUpstream('The Work Computer screen is unreachable.');
  });
  upstreamSocket.setTimeout(10_000, () => {
    if (!established) failUpstream('The Work Computer screen timed out.');
  });
  upstreamSocket.once('connect', () => {
    upstreamSocket.write(`${headerLines.join('\r\n')}\r\n\r\n`);
  });

  const onHandshakeData = (chunk: Buffer): void => {
    upstreamBuffer = Buffer.concat([upstreamBuffer, chunk]);
    const headerEnd = upstreamBuffer.indexOf('\r\n\r\n');
    if (headerEnd < 0) {
      if (upstreamBuffer.length > 16_384) {
        failUpstream('The Work Computer screen sent an invalid handshake.');
      }
      return;
    }
    upstreamSocket.off('data', onHandshakeData);
    const rawResponse = upstreamBuffer.subarray(0, headerEnd).toString();
    const remainder = upstreamBuffer.subarray(headerEnd + 4);
    upstreamBuffer = Buffer.alloc(0);
    const [statusLine = '', ...responseHeaderLines] = rawResponse.split('\r\n');
    if (!/^HTTP\/1\.1 101 /.test(statusLine)) {
      failUpstream('Screen upgrade failed.');
      return;
    }
    const safeLines = responseHeaderLines.filter(line => {
      const name = line.slice(0, line.indexOf(':')).trim().toLowerCase();
      return SAFE_RESPONSE_HEADERS.has(name);
    });
    established = true;
    upstreamSocket.setTimeout(0);
    // A raw upgraded socket keeps the HTTP server's keep-alive timeout
    // unless it is cleared — the ws library does this for the terminal; a
    // raw relay must do it itself.
    (socket as { setTimeout?: (ms: number) => void }).setTimeout?.(0);
    (socket as { setNoDelay?: (on: boolean) => void }).setNoDelay?.(true);

    viewersByTask.set(task.id, (viewersByTask.get(task.id) ?? 0) + 1);
    workRuntimeService.noteTaskActivity(task.id);
    // The viewer owns the running container for the connection's lifetime:
    // without this hold, any workspace-helper call (a Files refresh) would
    // stop the sandbox and kill the GUI session mid-view.
    let releaseScreenSession: (() => Promise<void>) | undefined;
    void workRuntimeService
      .beginScreenSession(task)
      .then(release => {
        releaseScreenSession = release;
        if (socket.destroyed) void release();
      })
      .catch(error => {
        logger.warn(
          `Could not hold the Work container for a screen session on ${task.id}:`,
          error
        );
      });
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

    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\n${safeLines.join('\r\n')}\r\n\r\n`
    );
    if (remainder.length > 0) socket.write(remainder);
    if (head.length > 0) upstreamSocket.write(head);

    const cleanup = (): void => {
      clearInterval(activityTimer);
      if (expiryTimer) clearTimeout(expiryTimer);
      const remaining = (viewersByTask.get(task.id) ?? 1) - 1;
      if (remaining <= 0) viewersByTask.delete(task.id);
      else viewersByTask.set(task.id, remaining);
      workRuntimeService.noteTaskActivity(task.id);
      void releaseScreenSession?.();
    };
    upstreamSocket.once('close', () => {
      socket.destroy();
    });
    socket.once('close', () => {
      upstreamSocket.destroy();
      cleanup();
    });
    upstreamSocket.pipe(socket);
    socket.pipe(upstreamSocket);
  };
  upstreamSocket.on('data', onHandshakeData);
}
