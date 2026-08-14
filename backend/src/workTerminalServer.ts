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

class DrainingWorkTerminalServer extends WebSocketServer {
  private closing = false;
  private closePromise: Promise<void> | undefined;
  private readonly activeOperations = new Set<Promise<unknown>>();

  get isShuttingDown(): boolean {
    return this.closing;
  }

  track(operation: Promise<unknown>, description: string): void {
    this.activeOperations.add(operation);
    void operation.then(
      () => this.activeOperations.delete(operation),
      error => {
        this.activeOperations.delete(operation);
        logger.error(`Work terminal ${description} failed:`, error);
      }
    );
  }

  private async drain(): Promise<void> {
    // Operations may schedule cleanup while settling. Repeat until shutdown
    // reaches a stable empty set instead of taking a one-time snapshot.
    while (this.activeOperations.size > 0) {
      await Promise.allSettled([...this.activeOperations]);
    }
  }

  override close(callback?: (error?: Error) => void): void {
    this.closing = true;
    if (!this.closePromise) {
      this.closePromise = (async () => {
        let closeError: Error | undefined;
        await new Promise<void>(resolve => {
          super.close(error => {
            closeError = error;
            resolve();
          });
        });
        await this.drain();
        if (closeError) throw closeError;
      })();
    }
    void this.closePromise.then(
      () => callback?.(),
      error =>
        callback?.(
          error instanceof Error
            ? error
            : new Error('Work terminal shutdown failed')
        )
    );
  }
}

/**
 * Re-evaluate the mutable authorization state for an established terminal.
 * Tickets prove who opened the socket, while this check makes account
 * suspension, Work-access revocation, task deletion, and ownership changes
 * effective before any further shell input is accepted.
 */
export async function requireCurrentTerminalTask(
  userId: string,
  taskId: string,
  isShuttingDown: () => boolean = () => false
): Promise<WorkTaskRecord> {
  if (isShuttingDown()) {
    throw new WorkRuntimeError(
      'The Work terminal is shutting down.',
      503,
      'WORK_TERMINAL_SHUTTING_DOWN'
    );
  }
  const currentUser = await userModel.getUserById(userId);
  if (isShuttingDown()) {
    throw new WorkRuntimeError(
      'The Work terminal is shutting down.',
      503,
      'WORK_TERMINAL_SHUTTING_DOWN'
    );
  }
  if (
    !currentUser ||
    currentUser.status !== 'active' ||
    !(await userHasWorkAccess(currentUser))
  ) {
    throw new WorkRuntimeError(
      'Work access required.',
      403,
      'WORK_TERMINAL_FORBIDDEN'
    );
  }

  const task = await workTaskService.getTaskRecord(taskId, userId);
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
async function authorizeTerminalRequest(
  req: IncomingMessage,
  lifecycle: DrainingWorkTerminalServer
): Promise<TerminalAuthResult> {
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
  const consumed = await websocketTicketService.consume(
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
  if (lifecycle.isShuttingDown) {
    throw new WorkRuntimeError(
      'The Work terminal is shutting down.',
      503,
      'WORK_TERMINAL_SHUTTING_DOWN'
    );
  }
  const task = await requireCurrentTerminalTask(
    consumed.userId,
    taskId,
    () => lifecycle.isShuttingDown
  );
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
  req: IncomingMessage,
  lifecycle: DrainingWorkTerminalServer
): Promise<void> {
  if (lifecycle.isShuttingDown) {
    ws.terminate();
    return;
  }
  let task: WorkTaskRecord;
  let userId: string;
  let sessionExpiresAt: number;
  try {
    ({ task, userId, sessionExpiresAt } = await authorizeTerminalRequest(
      req,
      lifecycle
    ));
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
  if (lifecycle.isShuttingDown) {
    ws.terminate();
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
  if (lifecycle.isShuttingDown) {
    try {
      await session.close();
    } catch (error) {
      logger.warn(
        `Work terminal cleanup failed during shutdown for task ${task.id}:`,
        error
      );
    }
    ws.terminate();
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
  let endPromise: Promise<void> | undefined;
  const endSession = (code: number, reason: string): Promise<void> => {
    if (endPromise) return endPromise;
    ended = true;
    endPromise = (async () => {
      if (idleTimer) clearTimeout(idleTimer);
      if (sessionExpiryTimer) clearTimeout(sessionExpiryTimer);
      try {
        await session.close();
      } catch (error) {
        logger.warn(`Work terminal cleanup failed for task ${task.id}:`, error);
      }
      if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) {
        try {
          ws.close(code, reason);
        } catch (error) {
          logger.debug(
            `Work terminal socket close failed for ${task.id}:`,
            error
          );
        }
      }
    })();
    lifecycle.track(endPromise, `cleanup for task ${task.id}`);
    return endPromise;
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

  let inputQueue = Promise.resolve();
  ws.on('message', (data, isBinary) => {
    if (lifecycle.isShuttingDown || ended) return;
    inputQueue = inputQueue
      .then(async () => {
        if (lifecycle.isShuttingDown || ended || isBinary) return;
        const message = parseTerminalClientMessage(data.toString());
        if (!message) return;
        if (message.type === 'input') {
          await requireCurrentTerminalTask(
            userId,
            task.id,
            () => lifecycle.isShuttingDown
          );
          if (lifecycle.isShuttingDown || ended) return;
          armIdleTimer();
          session.stream.write(message.data);
          return;
        }
        if (lifecycle.isShuttingDown || ended) return;
        armIdleTimer();
        await session.resize(message.cols, message.rows);
      })
      .catch(error => {
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
      });
    lifecycle.track(inputQueue, `input handler for task ${task.id}`);
  });

  ws.on('close', () => {
    void endSession(1000, 'client-close');
  });
  ws.on('error', () => {
    void endSession(1011, 'ws-error');
  });
}

export function createWorkTerminalServer(): WebSocketServer {
  const wss = new DrainingWorkTerminalServer({
    noServer: true,
    maxPayload: WORK_TERMINAL_MAX_INPUT_BYTES,
  });
  wss.on('connection', (ws, req) => {
    if (wss.isShuttingDown) {
      ws.terminate();
      return;
    }
    const connection = handleTerminalConnection(ws, req, wss).catch(error => {
      logger.error('Work terminal connection failed:', error);
      try {
        ws.close(1011, 'internal-error');
      } catch {
        // Already closed.
      }
    });
    wss.track(connection, 'connection handler');
  });
  return wss;
}
