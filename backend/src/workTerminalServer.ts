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

import type { IncomingMessage } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';

import { userModel } from './models/userModel.js';
import { userHasWorkAccess } from './services/workAccessService.js';
import { websocketTicketService } from './services/websocketTicketService.js';
import workTaskService from './services/workTaskService.js';
import workTerminalService from './services/workTerminalService.js';
import { WorkRuntimeError } from './services/workRuntimeService.js';
import type { WorkTaskRecord } from './types/work.js';
import { createLogger } from './utils/logger.js';

const logger = createLogger('work-terminal');

export const WORK_TERMINAL_WS_PATH = '/ws/work-terminal';
export const WORK_TERMINAL_MAX_INPUT_BYTES = 1_048_576;
const MAX_BUFFERED_OUTPUT_BYTES = 4_194_304;
const OUTPUT_PAUSE_THRESHOLD_BYTES = 1_048_576;

export type WorkTerminalClientMessage =
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number };

/**
 * Parse one client frame. Text frames carry JSON control messages; anything
 * malformed is rejected rather than forwarded to the shell.
 */
export function parseTerminalClientMessage(
  raw: string
): WorkTerminalClientMessage | null {
  if (raw.length > WORK_TERMINAL_MAX_INPUT_BYTES) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const message = parsed as Record<string, unknown>;
  if (message.type === 'input' && typeof message.data === 'string') {
    return { type: 'input', data: message.data };
  }
  if (
    message.type === 'resize' &&
    typeof message.cols === 'number' &&
    typeof message.rows === 'number'
  ) {
    return { type: 'resize', cols: message.cols, rows: message.rows };
  }
  return null;
}

interface TerminalAuthResult {
  task: WorkTaskRecord;
  userId: string;
  sessionExpiresAt: number;
}

/**
 * Re-evaluate the mutable authorization state for an established terminal.
 * Tickets prove who opened the socket, while this check makes account
 * suspension, Work-access revocation, task deletion, and ownership changes
 * effective before any further shell input is accepted.
 */
export function requireCurrentTerminalTask(
  userId: string,
  taskId: string
): WorkTaskRecord {
  const currentUser = userModel.getUserById(userId);
  if (
    !currentUser ||
    currentUser.status !== 'active' ||
    !userHasWorkAccess(currentUser)
  ) {
    throw new WorkRuntimeError(
      'Work access required.',
      403,
      'WORK_TERMINAL_FORBIDDEN'
    );
  }

  const task = workTaskService.getTaskRecord(taskId, userId);
  if (!task) {
    throw new WorkRuntimeError(
      'Work task not found.',
      404,
      'WORK_TERMINAL_TASK_NOT_FOUND'
    );
  }
  return task;
}

/**
 * The terminal enforces the exact HTTP Work-route contract through a
 * short-lived, one-use ticket bound to this protocol and task. Current
 * database state must still grant Work access, so a demotion or access-mode
 * change takes effect immediately.
 */
function authorizeTerminalRequest(req: IncomingMessage): TerminalAuthResult {
  const url = new URL(req.url || '', 'http://localhost');
  const ticket = url.searchParams.get('ticket') || '';
  const taskId = url.searchParams.get('taskId') || '';
  if (!ticket || !taskId) {
    throw new WorkRuntimeError(
      'The Work terminal requires authentication.',
      401,
      'WORK_TERMINAL_UNAUTHORIZED'
    );
  }
  const consumed = websocketTicketService.consume(
    ticket,
    'work-terminal',
    taskId
  );
  if (!consumed) {
    throw new WorkRuntimeError(
      'Invalid or expired terminal session ticket.',
      401,
      'WORK_TERMINAL_UNAUTHORIZED'
    );
  }
  const task = requireCurrentTerminalTask(consumed.userId, taskId);
  return {
    task,
    userId: consumed.userId,
    sessionExpiresAt: consumed.sessionExpiresAt,
  };
}

function sendControl(ws: WebSocket, message: Record<string, unknown>): void {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

async function handleTerminalConnection(
  ws: WebSocket,
  req: IncomingMessage
): Promise<void> {
  let task: WorkTaskRecord;
  let userId: string;
  let sessionExpiresAt: number;
  try {
    ({ task, userId, sessionExpiresAt } = authorizeTerminalRequest(req));
  } catch (error) {
    const detail =
      error instanceof WorkRuntimeError
        ? { message: error.message, code: error.code }
        : {
            message: 'Terminal authorization failed.',
            code: 'WORK_TERMINAL_UNAUTHORIZED',
          };
    sendControl(ws, { type: 'error', ...detail });
    ws.close(4401, detail.code);
    return;
  }

  let session;
  try {
    session = await workTerminalService.open(task);
  } catch (error) {
    const detail =
      error instanceof WorkRuntimeError
        ? { message: error.message, code: error.code }
        : {
            message: 'Could not open the terminal.',
            code: 'WORK_TERMINAL_UNAVAILABLE',
          };
    logger.warn(`Work terminal open failed for task ${task.id}:`, error);
    sendControl(ws, { type: 'error', ...detail });
    ws.close(4503, detail.code);
    return;
  }

  logger.info(`Work terminal attached to task ${task.id}.`);
  sendControl(ws, { type: 'ready' });

  let idleTimer: NodeJS.Timeout | undefined;
  let sessionExpiryTimer: NodeJS.Timeout | undefined;
  const armIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      sendControl(ws, {
        type: 'error',
        code: 'WORK_TERMINAL_IDLE_TIMEOUT',
        message: 'Terminal session closed after inactivity.',
      });
      void endSession(4408, 'idle');
    }, workTerminalService.idleTimeoutMs);
    idleTimer.unref?.();
  };

  let ended = false;
  const endSession = async (code: number, reason: string) => {
    if (ended) return;
    ended = true;
    if (idleTimer) clearTimeout(idleTimer);
    if (sessionExpiryTimer) clearTimeout(sessionExpiryTimer);
    try {
      await session.close();
    } catch (error) {
      logger.warn(`Work terminal cleanup failed for task ${task.id}:`, error);
    }
    if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) {
      ws.close(code, reason);
    }
  };

  sessionExpiryTimer = setTimeout(
    () => {
      sendControl(ws, {
        type: 'error',
        code: 'WORK_TERMINAL_SESSION_EXPIRED',
        message: 'The authenticated session expired.',
      });
      void endSession(4401, 'session-expired');
    },
    Math.max(0, Math.min(sessionExpiresAt - Date.now(), 2_147_483_647))
  );
  sessionExpiryTimer.unref?.();

  armIdleTimer();

  session.stream.on('data', (chunk: Buffer) => {
    if (ended || ws.readyState !== ws.OPEN) return;
    if (ws.bufferedAmount > MAX_BUFFERED_OUTPUT_BYTES) {
      sendControl(ws, {
        type: 'error',
        code: 'WORK_TERMINAL_OUTPUT_OVERFLOW',
        message: 'Terminal output overwhelmed the connection.',
      });
      void endSession(4409, 'overflow');
      return;
    }
    ws.send(chunk, { binary: true });
    if (ws.bufferedAmount > OUTPUT_PAUSE_THRESHOLD_BYTES) {
      session.stream.pause();
      const resume = () => {
        if (ws.readyState !== ws.OPEN) return;
        if (ws.bufferedAmount > OUTPUT_PAUSE_THRESHOLD_BYTES) {
          setTimeout(resume, 25).unref?.();
          return;
        }
        session.stream.resume();
      };
      setTimeout(resume, 25).unref?.();
    }
  });

  session.stream.on('close', () => {
    sendControl(ws, { type: 'exit' });
    void endSession(1000, 'exit');
  });
  session.stream.on('error', () => {
    sendControl(ws, { type: 'exit' });
    void endSession(1011, 'stream-error');
  });

  ws.on('message', (data, isBinary) => {
    if (ended || isBinary) return;
    const message = parseTerminalClientMessage(data.toString());
    if (!message) return;
    if (message.type === 'input') {
      try {
        requireCurrentTerminalTask(userId, task.id);
      } catch (error) {
        const detail =
          error instanceof WorkRuntimeError
            ? { message: error.message, code: error.code, status: error.status }
            : {
                message: 'Terminal authorization failed.',
                code: 'WORK_TERMINAL_UNAUTHORIZED',
                status: 401,
              };
        sendControl(ws, {
          type: 'error',
          message: detail.message,
          code: detail.code,
        });
        void endSession(
          detail.status === 404 ? 4404 : detail.status === 403 ? 4403 : 4401,
          detail.code
        );
        return;
      }
      armIdleTimer();
      session.stream.write(message.data);
      return;
    }
    armIdleTimer();
    void session.resize(message.cols, message.rows);
  });

  ws.on('close', () => {
    void endSession(1000, 'client-close');
  });
  ws.on('error', () => {
    void endSession(1011, 'ws-error');
  });
}

export function createWorkTerminalServer(): WebSocketServer {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: WORK_TERMINAL_MAX_INPUT_BYTES,
  });
  wss.on('connection', (ws, req) => {
    void handleTerminalConnection(ws, req).catch(error => {
      logger.error('Work terminal connection failed:', error);
      try {
        ws.close(1011, 'internal-error');
      } catch {
        // Already closed.
      }
    });
  });
  return wss;
}
