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
import { authService } from './services/authService.js';
import workTaskService from './services/workTaskService.js';
import workTerminalService from './services/workTerminalService.js';
import { WorkRuntimeError } from './services/workRuntimeService.js';
import type { WorkTaskRecord } from './types/work.js';
import { createLogger } from './utils/logger.js';

const logger = createLogger('work-terminal');

export const WORK_TERMINAL_WS_PATH = '/ws/work-terminal';
const MAX_INPUT_BYTES = 1_048_576;
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
  if (raw.length > MAX_INPUT_BYTES) return null;
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
}

/**
 * The terminal enforces the exact HTTP Work-route contract: a valid JWT is
 * mandatory (no default-user fallback) and the current database role must be
 * admin, so a demotion takes effect immediately. The task must belong to the
 * authenticated administrator.
 */
function authorizeTerminalRequest(req: IncomingMessage): TerminalAuthResult {
  const url = new URL(req.url || '', 'http://localhost');
  const token = url.searchParams.get('token') || '';
  const taskId = url.searchParams.get('taskId') || '';
  if (!token) {
    throw new WorkRuntimeError(
      'The Work terminal requires authentication.',
      401,
      'WORK_TERMINAL_UNAUTHORIZED'
    );
  }
  const payload = authService.verifyToken(token);
  if (!payload) {
    throw new WorkRuntimeError(
      'Invalid or expired terminal session token.',
      401,
      'WORK_TERMINAL_UNAUTHORIZED'
    );
  }
  const currentUser = userModel.getUserById(payload.userId);
  if (!currentUser || currentUser.role !== 'admin') {
    throw new WorkRuntimeError(
      'Admin access required.',
      403,
      'WORK_TERMINAL_FORBIDDEN'
    );
  }
  const task = workTaskService.getTaskRecord(taskId, payload.userId);
  if (!task) {
    throw new WorkRuntimeError(
      'Work task not found.',
      404,
      'WORK_TERMINAL_TASK_NOT_FOUND'
    );
  }
  return { task };
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
  try {
    ({ task } = authorizeTerminalRequest(req));
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
    try {
      await session.close();
    } catch (error) {
      logger.warn(`Work terminal cleanup failed for task ${task.id}:`, error);
    }
    if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) {
      ws.close(code, reason);
    }
  };

  armIdleTimer();

  session.stream.on('data', (chunk: Buffer) => {
    if (ws.readyState !== ws.OPEN) return;
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
    if (isBinary) return;
    const message = parseTerminalClientMessage(data.toString());
    if (!message) return;
    armIdleTimer();
    if (message.type === 'input') {
      session.stream.write(message.data);
      return;
    }
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
  const wss = new WebSocketServer({ noServer: true });
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
