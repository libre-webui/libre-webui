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

import type { Duplex } from 'node:stream';

import workRuntimeService, { WorkRuntimeError } from './workRuntimeService.js';
import type { WorkTaskRecord } from '../types/work.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('services:work-terminal');

// The terminal transport (Engine API exec + hijacked stream, endpoint
// resolution) lives in the runtime driver; this service owns session policy:
// admission, per-task session limits, and idle handling. These re-exports
// keep the module's public surface unchanged.
export {
  buildExecCreatePayload,
  type ExecCreatePayload,
} from './workRuntimeDriver.js';
export { resolveDockerEndpoint } from '../utils/dockerEndpoint.js';

export const WORK_TERMINAL_DEFAULTS = {
  idleTimeoutMs: 900_000,
  maxSessionsPerTask: 2,
  shell: ['/bin/bash', '-l'],
} as const;

const config = {
  idleTimeoutMs: positiveInteger(
    process.env.WORK_TERMINAL_IDLE_TIMEOUT_MS,
    WORK_TERMINAL_DEFAULTS.idleTimeoutMs
  ),
  maxSessionsPerTask: positiveInteger(
    process.env.WORK_TERMINAL_MAX_SESSIONS_PER_TASK,
    WORK_TERMINAL_DEFAULTS.maxSessionsPerTask
  ),
};

export interface WorkTerminalSession {
  stream: Duplex;
  resize: (cols: number, rows: number) => Promise<void>;
  close: () => Promise<void>;
}

export class WorkTerminalService {
  readonly idleTimeoutMs = config.idleTimeoutMs;
  readonly maxSessionsPerTask = config.maxSessionsPerTask;
  private sessionCounts = new Map<string, number>();

  unavailableReason(): string | null {
    return workRuntimeService.driver.terminalUnavailableReason();
  }

  sessionCount(taskId: string): number {
    return this.sessionCounts.get(taskId) ?? 0;
  }

  async open(task: WorkTaskRecord): Promise<WorkTerminalSession> {
    const unavailable = this.unavailableReason();
    if (unavailable) {
      throw new WorkRuntimeError(unavailable, 503, 'WORK_TERMINAL_UNAVAILABLE');
    }
    const current = this.sessionCount(task.id);
    if (current >= config.maxSessionsPerTask) {
      throw new WorkRuntimeError(
        `This Work task already has ${config.maxSessionsPerTask} open terminal session(s). Close one first.`,
        429,
        'WORK_TERMINAL_SESSION_LIMIT'
      );
    }
    this.sessionCounts.set(task.id, current + 1);

    let releaseHold: (() => Promise<void>) | undefined;
    let stream: Duplex | undefined;
    const cleanup = async () => {
      const count = (this.sessionCounts.get(task.id) ?? 1) - 1;
      if (count <= 0) {
        this.sessionCounts.delete(task.id);
      } else {
        this.sessionCounts.set(task.id, count);
      }
      stream?.destroy();
      if (releaseHold) {
        const release = releaseHold;
        releaseHold = undefined;
        await release();
      }
    };

    try {
      releaseHold = await workRuntimeService.acquireTerminalHold(task);
      const transport = await workRuntimeService.driver.openTerminal(
        task.containerName
      );
      stream = transport.stream;
      const activeStream = stream;
      let closed = false;
      const close = async () => {
        if (closed) return;
        closed = true;
        await cleanup();
      };
      activeStream.on('close', () => {
        void close();
      });
      return {
        stream: activeStream,
        resize: async (cols: number, rows: number) => {
          const width = boundedDimension(cols);
          const height = boundedDimension(rows);
          if (!width || !height) return;
          try {
            await transport.resize(width, height);
          } catch (error) {
            // Resize failures are cosmetic; the shell keeps running.
            logger.debug('Work terminal resize failed:', error);
          }
        },
        close,
      };
    } catch (error) {
      await cleanup();
      throw error;
    }
  }
}

export function boundedDimension(value: number): number | null {
  if (!Number.isInteger(value) || value < 1 || value > 1_000) return null;
  return value;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export const workTerminalService = new WorkTerminalService();
export default workTerminalService;
