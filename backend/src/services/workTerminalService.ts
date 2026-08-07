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

import http from 'node:http';
import type { Duplex } from 'node:stream';

import workRuntimeService, { WorkRuntimeError } from './workRuntimeService.js';
import type { WorkTaskRecord } from '../types/work.js';
import {
  dockerEndpointRequestOptions,
  resolveDockerEndpoint,
} from '../utils/dockerEndpoint.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('services:work-terminal');

export { resolveDockerEndpoint } from '../utils/dockerEndpoint.js';

export const WORK_TERMINAL_DEFAULTS = {
  idleTimeoutMs: 900_000,
  maxSessionsPerTask: 2,
  shell: ['/bin/bash', '-l'],
} as const;

const config = {
  endpoint: resolveDockerEndpoint(
    process.env.WORK_DOCKER_SOCKET,
    process.env.DOCKER_HOST,
    process.env.DOCKER_TLS_VERIFY
  ),
  idleTimeoutMs: positiveInteger(
    process.env.WORK_TERMINAL_IDLE_TIMEOUT_MS,
    WORK_TERMINAL_DEFAULTS.idleTimeoutMs
  ),
  maxSessionsPerTask: positiveInteger(
    process.env.WORK_TERMINAL_MAX_SESSIONS_PER_TASK,
    WORK_TERMINAL_DEFAULTS.maxSessionsPerTask
  ),
};

/**
 * The terminal talks to the Docker Engine API directly because a TTY exec
 * needs a hijacked bidirectional stream, which the docker CLI only offers to
 * an interactive controlling terminal. The connection is the resolved Docker
 * endpoint: the Unix socket, or a plain-HTTP tcp:// endpoint such as a
 * socket proxy holding the socket on the app's behalf — the hijacked
 * stream survives an HTTP-aware proxy because it rides a standard
 * Connection: Upgrade tunnel. Endpoints this client cannot speak to
 * (ssh://, TLS-verified tcp) make the terminal report itself unavailable
 * instead of guessing.
 */

export interface ExecCreatePayload {
  AttachStdin: boolean;
  AttachStdout: boolean;
  AttachStderr: boolean;
  Tty: boolean;
  User: string;
  WorkingDir: string;
  Env: string[];
  Cmd: string[];
}

export function buildExecCreatePayload(
  shell: readonly string[] = WORK_TERMINAL_DEFAULTS.shell
): ExecCreatePayload {
  // Mirrors the container policy: the shell runs as the same unprivileged
  // user, in the workspace, inside the already-hardened container. Nothing
  // about the sandbox weakens because a human is typing instead of the model.
  return {
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    Tty: true,
    User: '1000:1000',
    WorkingDir: '/workspace',
    Env: ['TERM=xterm-256color'],
    Cmd: [...shell],
  };
}

export interface WorkTerminalSession {
  stream: Duplex;
  resize: (cols: number, rows: number) => Promise<void>;
  close: () => Promise<void>;
}

interface DockerApiResponse {
  status: number;
  body: string;
}

export class WorkTerminalService {
  readonly idleTimeoutMs = config.idleTimeoutMs;
  readonly maxSessionsPerTask = config.maxSessionsPerTask;
  private sessionCounts = new Map<string, number>();

  unavailableReason(): string | null {
    if (!config.endpoint) {
      return 'The Work terminal needs a reachable Docker Engine API. Set WORK_DOCKER_SOCKET to the Unix socket path, or point DOCKER_HOST at a plain-HTTP tcp:// endpoint such as a socket proxy (DOCKER_HOST currently names an endpoint this client cannot speak to).';
    }
    return null;
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
      const created = await this.dockerApi(
        'POST',
        `/containers/${encodeURIComponent(task.containerName)}/exec`,
        buildExecCreatePayload()
      );
      const execId = parseExecId(created);
      stream = await this.startExecStream(execId);
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
            await this.dockerApi(
              'POST',
              `/exec/${encodeURIComponent(execId)}/resize?w=${width}&h=${height}`
            );
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

  /**
   * Transport options for the resolved endpoint. A Unix socket needs an
   * explicit Host header (there is no authority in the request target); a
   * tcp endpoint gets the real host:port so an HTTP-aware proxy can route
   * on it.
   */
  private transport(): {
    options: { socketPath: string } | { host: string; port: number };
    hostHeader: Record<string, string>;
  } {
    const endpoint = config.endpoint;
    if (!endpoint) {
      throw new WorkRuntimeError(
        this.unavailableReason() ?? 'The Work terminal is unavailable.',
        503,
        'WORK_TERMINAL_UNAVAILABLE'
      );
    }
    return {
      options: dockerEndpointRequestOptions(endpoint),
      hostHeader: endpoint.kind === 'unix' ? { Host: 'docker' } : {},
    };
  }

  private dockerApi(
    method: 'GET' | 'POST',
    path: string,
    payload?: unknown
  ): Promise<DockerApiResponse> {
    return new Promise((resolve, reject) => {
      const body = payload === undefined ? undefined : JSON.stringify(payload);
      const { options, hostHeader } = this.transport();
      const request = http.request(
        {
          ...options,
          method,
          path,
          headers: {
            ...hostHeader,
            'Content-Type': 'application/json',
            'Content-Length': body ? Buffer.byteLength(body) : 0,
          },
        },
        response => {
          const chunks: Buffer[] = [];
          response.on('data', chunk => chunks.push(chunk));
          response.on('end', () => {
            resolve({
              status: response.statusCode ?? 0,
              body: Buffer.concat(chunks).toString('utf8'),
            });
          });
        }
      );
      request.setTimeout(10_000, () => {
        request.destroy(new Error('Docker Engine API request timed out.'));
      });
      request.on('error', error => {
        reject(
          new WorkRuntimeError(
            `Could not reach the Docker Engine socket for the terminal: ${error.message}`,
            503,
            'WORK_TERMINAL_UNAVAILABLE'
          )
        );
      });
      if (body) request.write(body);
      request.end();
    });
  }

  private startExecStream(execId: string): Promise<Duplex> {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify({ Detach: false, Tty: true });
      const { options, hostHeader } = this.transport();
      const request = http.request({
        ...options,
        method: 'POST',
        path: `/exec/${encodeURIComponent(execId)}/start`,
        headers: {
          ...hostHeader,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          Connection: 'Upgrade',
          Upgrade: 'tcp',
        },
      });
      request.on('upgrade', (_response, socket, head) => {
        // With Tty:true the hijacked stream is raw terminal bytes in both
        // directions; no stream-multiplexing frames to parse.
        if (head.length > 0) socket.unshift(head);
        resolve(socket);
      });
      request.on('response', response => {
        const chunks: Buffer[] = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => {
          reject(
            new WorkRuntimeError(
              `The Docker Engine refused the terminal stream (HTTP ${response.statusCode}): ${Buffer.concat(chunks).toString('utf8').trim()}`,
              503,
              'WORK_TERMINAL_UNAVAILABLE'
            )
          );
        });
      });
      request.on('error', error => {
        reject(
          new WorkRuntimeError(
            `Could not open the terminal stream: ${error.message}`,
            503,
            'WORK_TERMINAL_UNAVAILABLE'
          )
        );
      });
      request.write(body);
      request.end();
    });
  }
}

function parseExecId(response: DockerApiResponse): string {
  if (response.status < 200 || response.status >= 300) {
    throw new WorkRuntimeError(
      `The Docker Engine rejected the terminal exec (HTTP ${response.status}): ${response.body.trim()}`,
      503,
      'WORK_TERMINAL_UNAVAILABLE'
    );
  }
  try {
    const parsed = JSON.parse(response.body) as { Id?: unknown };
    if (typeof parsed.Id === 'string' && parsed.Id) return parsed.Id;
  } catch {
    // Fall through to the error below.
  }
  throw new WorkRuntimeError(
    'The Docker Engine returned an unexpected exec-create response.',
    503,
    'WORK_TERMINAL_UNAVAILABLE'
  );
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
