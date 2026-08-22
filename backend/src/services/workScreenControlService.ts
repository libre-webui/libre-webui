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
 * Work Computer control leases: who is allowed to drive a task's screen
 * right now. One human holder per task, TTL-bounded (the TTL is the expiry
 * sweep — an abandoned takeover lapses on its own), renewed while the
 * takeover UI is open, released by "I'm done". State lives in the platform
 * coordinator, so acquisition, renewal, and the agent's wait all agree
 * across replicas without a schema change. The lease is authorization
 * state, not X-layer enforcement: it decides who receives the full-control
 * VNC password and blocks the agent's computer tools while a human drives.
 */

import { getCoordinator } from '../platform/coordination/service.js';
import {
  SHARED_COORDINATION_OPERATION_TIMEOUT_MS,
  withCoordinationTimeout,
} from '../platform/coordination/sharedAdmission.js';
import type { Coordinator } from '../platform/coordination/types.js';
import { WorkRuntimeError } from './workRuntimeShared.js';

/** A takeover lapses this long after its last acquire/renew. */
export const WORK_SCREEN_CONTROL_TTL_MS = 120_000;
/** An unanswered request_takeover stops waiting after this long. */
export const WORK_SCREEN_ASSIST_TIMEOUT_MS = 300_000;
const ASSIST_POLL_INTERVAL_MS = 2_000;
const MUTEX_TTL_MS = 5_000;
const MUTEX_ATTEMPTS = 10;
const MUTEX_RETRY_DELAY_MS = 150;

export interface WorkScreenControlHolder {
  userId: string;
  acquiredAt: number;
  expiresAt: number;
}

export type WorkScreenAssistPhase = 'requested' | 'taken' | 'released';

export interface WorkScreenAssistState {
  reason: string;
  requestedAt: number;
  phase: WorkScreenAssistPhase;
}

const controlKey = (taskId: string): string => `work:screen-control:${taskId}`;
const assistKey = (taskId: string): string => `work:screen-assist:${taskId}`;

const isHolder = (value: unknown): value is WorkScreenControlHolder => {
  const record = value as WorkScreenControlHolder | null;
  return (
    !!record &&
    typeof record === 'object' &&
    typeof record.userId === 'string' &&
    record.userId.length > 0 &&
    Number.isSafeInteger(record.acquiredAt) &&
    Number.isSafeInteger(record.expiresAt)
  );
};

const isAssistState = (value: unknown): value is WorkScreenAssistState => {
  const record = value as WorkScreenAssistState | null;
  return (
    !!record &&
    typeof record === 'object' &&
    typeof record.reason === 'string' &&
    Number.isSafeInteger(record.requestedAt) &&
    (record.phase === 'requested' ||
      record.phase === 'taken' ||
      record.phase === 'released')
  );
};

export class WorkScreenControlService {
  constructor(
    private readonly coordinatorProvider: () => Coordinator = getCoordinator,
    private readonly now: () => number = Date.now,
    private readonly operationTimeoutMs = SHARED_COORDINATION_OPERATION_TIMEOUT_MS
  ) {}

  /**
   * Acquire (or renew) the control lease for a task. Fails with a conflict
   * while a different user's unexpired lease exists — takeover is
   * cooperative, never a seizure from another human.
   */
  async acquire(
    taskId: string,
    userId: string,
    ttlMs = WORK_SCREEN_CONTROL_TTL_MS
  ): Promise<WorkScreenControlHolder> {
    return this.withMutex(taskId, async coordinator => {
      const current = await this.readHolder(coordinator, taskId);
      if (current && current.userId !== userId) {
        throw new WorkRuntimeError(
          'Another user currently controls this Work Computer.',
          409,
          'WORK_SCREEN_CONTROL_HELD'
        );
      }
      const now = this.now();
      const holder: WorkScreenControlHolder = {
        userId,
        acquiredAt: current?.acquiredAt ?? now,
        expiresAt: now + ttlMs,
      };
      await withCoordinationTimeout(
        coordinator.setCache(controlKey(taskId), holder, ttlMs),
        this.operationTimeoutMs
      );
      const assist = await this.readAssist(coordinator, taskId);
      if (assist && assist.phase === 'requested') {
        await this.writeAssist(coordinator, taskId, {
          ...assist,
          phase: 'taken',
        });
      }
      return holder;
    });
  }

  /**
   * Release the lease. Only the holder releases their own; `force` is for
   * lifecycle cleanup, not for other users.
   */
  async release(
    taskId: string,
    userId: string,
    options: { force?: boolean } = {}
  ): Promise<void> {
    await this.withMutex(taskId, async coordinator => {
      const current = await this.readHolder(coordinator, taskId);
      if (!current) return;
      if (current.userId !== userId && !options.force) {
        throw new WorkRuntimeError(
          'Only the user controlling this Work Computer can release it.',
          403,
          'WORK_SCREEN_CONTROL_NOT_HOLDER'
        );
      }
      await withCoordinationTimeout(
        coordinator.deleteCache(controlKey(taskId)),
        this.operationTimeoutMs
      );
      const assist = await this.readAssist(coordinator, taskId);
      if (assist && assist.phase === 'taken') {
        await this.writeAssist(coordinator, taskId, {
          ...assist,
          phase: 'released',
        });
      }
    });
  }

  /** The current unexpired holder, if any. */
  async current(taskId: string): Promise<WorkScreenControlHolder | undefined> {
    return this.readHolder(this.coordinatorProvider(), taskId);
  }

  /** The active takeover request from the agent, if any. */
  async assistState(
    taskId: string
  ): Promise<WorkScreenAssistState | undefined> {
    return this.readAssist(this.coordinatorProvider(), taskId);
  }

  /**
   * The agent asks for a human. Registers the request (surfaced by the
   * screen-control endpoint the UI polls), then waits until a human takes
   * control and hands it back, the timeout lapses, or the run aborts.
   */
  async waitForAssist(
    taskId: string,
    reason: string,
    options: {
      timeoutMs?: number;
      signal?: AbortSignal;
      pollIntervalMs?: number;
    } = {}
  ): Promise<'released' | 'timeout' | 'still_controlled'> {
    const timeoutMs = options.timeoutMs ?? WORK_SCREEN_ASSIST_TIMEOUT_MS;
    const pollIntervalMs = options.pollIntervalMs ?? ASSIST_POLL_INTERVAL_MS;
    const coordinator = this.coordinatorProvider();
    const requestedAt = this.now();
    const deadline = requestedAt + timeoutMs;
    // A human already driving counts as the takeover having happened.
    const preHeld = await this.readHolder(coordinator, taskId);
    await this.writeAssist(
      coordinator,
      taskId,
      {
        reason,
        requestedAt,
        phase: preHeld ? 'taken' : 'requested',
      },
      timeoutMs + WORK_SCREEN_CONTROL_TTL_MS
    );
    try {
      while (this.now() < deadline) {
        if (options.signal?.aborted) {
          throw new WorkRuntimeError(
            'The takeover request was cancelled.',
            409,
            'WORK_SCREEN_ASSIST_CANCELLED'
          );
        }
        const assist = await this.readAssist(coordinator, taskId);
        // Releasing control (or the request record disappearing after a
        // human drove) completes the hand-back.
        if (!assist || assist.phase === 'released') return 'released';
        await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
      }
      return (await this.readHolder(coordinator, taskId))
        ? 'still_controlled'
        : 'timeout';
    } finally {
      const assist = await this.readAssist(coordinator, taskId).catch(
        () => undefined
      );
      if (assist) {
        await withCoordinationTimeout(
          coordinator.deleteCache(assistKey(taskId)),
          this.operationTimeoutMs
        ).catch(() => undefined);
      }
    }
  }

  private async readHolder(
    coordinator: Coordinator,
    taskId: string
  ): Promise<WorkScreenControlHolder | undefined> {
    const value = await withCoordinationTimeout(
      coordinator.getCache(controlKey(taskId)),
      this.operationTimeoutMs
    );
    if (!isHolder(value)) return undefined;
    return value.expiresAt > this.now() ? value : undefined;
  }

  private async readAssist(
    coordinator: Coordinator,
    taskId: string
  ): Promise<WorkScreenAssistState | undefined> {
    const value = await withCoordinationTimeout(
      coordinator.getCache(assistKey(taskId)),
      this.operationTimeoutMs
    );
    return isAssistState(value) ? value : undefined;
  }

  private async writeAssist(
    coordinator: Coordinator,
    taskId: string,
    state: WorkScreenAssistState,
    ttlMs = WORK_SCREEN_ASSIST_TIMEOUT_MS + WORK_SCREEN_CONTROL_TTL_MS
  ): Promise<void> {
    await withCoordinationTimeout(
      coordinator.setCache(assistKey(taskId), state, ttlMs),
      this.operationTimeoutMs
    );
  }

  /**
   * Serialize lease mutations per task through a short coordinator lease so
   * two replicas cannot both admit a holder in the read-then-write gap.
   */
  private async withMutex<T>(
    taskId: string,
    fn: (coordinator: Coordinator) => Promise<T>
  ): Promise<T> {
    const coordinator = this.coordinatorProvider();
    for (let attempt = 0; attempt < MUTEX_ATTEMPTS; attempt++) {
      const lease = await withCoordinationTimeout(
        coordinator.acquireLease(
          `work:screen-control-mutex:${taskId}`,
          MUTEX_TTL_MS
        ),
        this.operationTimeoutMs
      );
      if (!lease) {
        await new Promise(resolve => setTimeout(resolve, MUTEX_RETRY_DELAY_MS));
        continue;
      }
      try {
        return await fn(coordinator);
      } finally {
        await lease.release().catch(() => undefined);
      }
    }
    throw new WorkRuntimeError(
      'The Work Computer control state is busy. Try again.',
      503,
      'WORK_SCREEN_CONTROL_BUSY'
    );
  }
}

export const workScreenControlService = new WorkScreenControlService();
export default workScreenControlService;
