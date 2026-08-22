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

import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getWorkPersistence } from '../platform/workPersistence/index.js';
import {
  getCoordinator,
  getPlatformRuntimeConfig,
} from '../platform/coordination/service.js';
import type { CoordinationLease } from '../platform/coordination/types.js';
import {
  combineAbortSignals,
  SHARED_COORDINATION_OPERATION_TIMEOUT_MS,
  withCoordinationTimeout,
} from '../platform/coordination/sharedAdmission.js';
import {
  WorkFileEntry,
  WorkGitDiff,
  WorkGitStatus,
  WorkTaskRecord,
} from '../types/work.js';
import { createLogger } from '../utils/logger.js';
import {
  buildWorkGitCommand,
  parseWorkGitBranches,
  parseWorkGitLog,
  parseWorkGitStatus,
  validateWorkGitBranchName,
  validateWorkGitRepositoryPaths,
} from '../utils/workGit.js';
import { userHasWorkAccess } from './workAccessService.js';
import workPolicyService from './workPolicyService.js';
import workPreviewProxyService, {
  normalizePreviewUpstreamHost,
} from './workPreviewProxyService.js';
import workTaskService from './workTaskService.js';
import { KubernetesWorkRuntimeDriver } from './workKubernetesDriver.js';
import {
  DockerWorkRuntimeDriver,
  type DiscoveredWorkContainer,
  type WorkRuntimeDriver,
} from './workRuntimeDriver.js';
import {
  type ProcessOptions,
  type ProcessResult,
  type WorkCommandResult,
  WorkRuntimeError,
  workRuntimeConfig as config,
} from './workRuntimeShared.js';

// The public surface of the Work runtime is unchanged by the driver split:
// consumers and tests keep importing everything from this module.
export {
  WORK_RUNTIME_ADMISSION_DEFAULTS,
  WORK_RUNTIME_DEFAULTS,
  WorkRuntimeError,
  parseDnsServers,
} from './workRuntimeShared.js';
export type { WorkCommandResult } from './workRuntimeShared.js';
export {
  DockerWorkRuntimeDriver,
  buildWorkContainerRunArgs,
  describeDockerUnavailable,
  formatPreviewHost,
  parseManagedContainerList,
  parsePublishedPort,
} from './workRuntimeDriver.js';
export type {
  DiscoveredWorkContainer,
  WorkRuntimeDriver,
} from './workRuntimeDriver.js';

const logger = createLogger('services:work-runtime');

const PREVIEW_READY_TIMEOUT_MS = 15_000;
const PREVIEW_POLL_INTERVAL_MS = 250;

/** Per-session VNC passwords for the Work Computer screen. */
export interface WorkComputerCredentials {
  /** Full mouse/keyboard control — takeover-lease holders only. */
  control: string;
  /** Watch-only. */
  view: string;
}

/** One observation of the Work Computer screen — the agent's eyes. */
export interface WorkComputerObservation {
  width: number;
  height: number;
  cursorX: number;
  cursorY: number;
  window: string;
  screenshotBase64: string;
}

export type WorkComputerAction =
  | { type: 'move'; x: number; y: number }
  | {
      type: 'click' | 'double_click' | 'right_click';
      x?: number;
      y?: number;
    }
  | { type: 'type'; text: string }
  | { type: 'key'; keys: string }
  | {
      type: 'scroll';
      direction: 'up' | 'down';
      amount: number;
      x?: number;
      y?: number;
    }
  | { type: 'wait'; ms: number };

/** Most actions a single computer_act batch may carry (rakazo-scale). */
export const WORK_COMPUTER_ACTION_LIMIT = 24;
const WORK_COMPUTER_TEXT_LIMIT = 4_000;
const WORK_COMPUTER_WAIT_LIMIT_MS = 5_000;
const WORK_COMPUTER_WAIT_TOTAL_LIMIT_MS = 30_000;
const WORK_COMPUTER_COORDINATE_LIMIT = 10_000;
/** xdotool key syntax: chords like ctrl+shift+t, keysyms like Return. */
const WORK_COMPUTER_KEYS_PATTERN = /^[A-Za-z0-9_]+(\+[A-Za-z0-9_]+)*$/;

/**
 * Validate a computer_act batch before anything reaches the sandbox. The
 * output is plain data safe to JSON-encode into the in-container action
 * interpreter; every rejected batch names the exact offending action.
 */
export function validateWorkComputerActions(
  actions: unknown
): WorkComputerAction[] {
  if (!Array.isArray(actions) || actions.length === 0) {
    throw new WorkRuntimeError(
      'computer_act requires a non-empty "actions" array.',
      400,
      'WORK_COMPUTER_INVALID_ACTION'
    );
  }
  if (actions.length > WORK_COMPUTER_ACTION_LIMIT) {
    throw new WorkRuntimeError(
      `computer_act accepts at most ${WORK_COMPUTER_ACTION_LIMIT} actions per call.`,
      400,
      'WORK_COMPUTER_INVALID_ACTION'
    );
  }
  const invalid = (index: number, reason: string): WorkRuntimeError =>
    new WorkRuntimeError(
      `computer_act action ${index + 1} is invalid: ${reason}`,
      400,
      'WORK_COMPUTER_INVALID_ACTION'
    );
  const coordinate = (value: unknown, index: number, name: string): number => {
    if (
      typeof value !== 'number' ||
      !Number.isInteger(value) ||
      value < 0 ||
      value > WORK_COMPUTER_COORDINATE_LIMIT
    ) {
      throw invalid(
        index,
        `"${name}" must be an integer between 0 and ${WORK_COMPUTER_COORDINATE_LIMIT}.`
      );
    }
    return value;
  };
  let totalWaitMs = 0;
  const validated: WorkComputerAction[] = [];
  for (const [index, value] of actions.entries()) {
    const action =
      value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
    if (!action || typeof action.type !== 'string') {
      throw invalid(index, 'each action must be an object with a "type".');
    }
    switch (action.type) {
      case 'move':
        validated.push({
          type: 'move',
          x: coordinate(action.x, index, 'x'),
          y: coordinate(action.y, index, 'y'),
        });
        break;
      case 'click':
      case 'double_click':
      case 'right_click': {
        const hasX = action.x !== undefined;
        const hasY = action.y !== undefined;
        if (hasX !== hasY) {
          throw invalid(index, 'provide both "x" and "y" or neither.');
        }
        validated.push({
          type: action.type,
          ...(hasX
            ? {
                x: coordinate(action.x, index, 'x'),
                y: coordinate(action.y, index, 'y'),
              }
            : {}),
        });
        break;
      }
      case 'type': {
        if (
          typeof action.text !== 'string' ||
          action.text.length === 0 ||
          action.text.length > WORK_COMPUTER_TEXT_LIMIT
        ) {
          throw invalid(
            index,
            `"text" must be a string of 1 to ${WORK_COMPUTER_TEXT_LIMIT} characters.`
          );
        }
        validated.push({ type: 'type', text: action.text });
        break;
      }
      case 'key': {
        if (
          typeof action.keys !== 'string' ||
          !WORK_COMPUTER_KEYS_PATTERN.test(action.keys) ||
          action.keys.length > 64
        ) {
          throw invalid(
            index,
            '"keys" must be an xdotool key name or chord such as "Return" or "ctrl+l".'
          );
        }
        validated.push({ type: 'key', keys: action.keys });
        break;
      }
      case 'scroll': {
        if (action.direction !== 'up' && action.direction !== 'down') {
          throw invalid(index, '"direction" must be "up" or "down".');
        }
        const amount = action.amount ?? 3;
        if (
          typeof amount !== 'number' ||
          !Number.isInteger(amount) ||
          amount < 1 ||
          amount > 20
        ) {
          throw invalid(index, '"amount" must be an integer between 1 and 20.');
        }
        const hasX = action.x !== undefined;
        const hasY = action.y !== undefined;
        if (hasX !== hasY) {
          throw invalid(index, 'provide both "x" and "y" or neither.');
        }
        validated.push({
          type: 'scroll',
          direction: action.direction,
          amount,
          ...(hasX
            ? {
                x: coordinate(action.x, index, 'x'),
                y: coordinate(action.y, index, 'y'),
              }
            : {}),
        });
        break;
      }
      case 'wait': {
        if (
          typeof action.ms !== 'number' ||
          !Number.isInteger(action.ms) ||
          action.ms < 1 ||
          action.ms > WORK_COMPUTER_WAIT_LIMIT_MS
        ) {
          throw invalid(
            index,
            `"ms" must be an integer between 1 and ${WORK_COMPUTER_WAIT_LIMIT_MS}.`
          );
        }
        totalWaitMs += action.ms;
        if (totalWaitMs > WORK_COMPUTER_WAIT_TOTAL_LIMIT_MS) {
          throw invalid(
            index,
            `total wait time per call is limited to ${WORK_COMPUTER_WAIT_TOTAL_LIMIT_MS} ms.`
          );
        }
        validated.push({ type: 'wait', ms: action.ms });
        break;
      }
      default:
        throw invalid(index, `unknown action type "${action.type}".`);
    }
  }
  return validated;
}

/** How long a run waits for the shared runtime lease before conflicting. */
const runLeaseWaitMs = (): number => {
  const parsed = Number.parseInt(process.env.WORK_RUN_LEASE_WAIT_MS ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 60_000;
};

/**
 * Acquire a shared runtime lease, polling until the deadline when a caller
 * can wait. Transient holders — a racing Files helper on the app replica,
 * task-creation prepare — release within seconds; a genuine long-lived
 * holder on another replica still conflicts once the deadline passes.
 */
export const acquireSharedRuntimeLeaseWithWait = async <T>(
  attempt: () => Promise<T | null>,
  options: {
    waitMs: number;
    signal?: AbortSignal | undefined;
    beforeRetry?: () => Promise<void>;
  }
): Promise<T> => {
  const deadline = Date.now() + options.waitMs;
  for (;;) {
    const lease = await attempt();
    if (lease) return lease;
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new WorkRuntimeError(
        'This Work task is active on another replica.',
        409,
        'WORK_RUNTIME_LEASE_CONFLICT'
      );
    }
    // The sleep is actively awaited by the caller, so it must keep the
    // event loop alive until it fires.
    await waitForAbortSignal(
      new Promise<void>(resolve => {
        setTimeout(resolve, Math.min(1_000, Math.max(50, remaining)));
      }),
      options.signal
    );
    await options.beforeRetry?.();
  }
};

interface PreviewStateHooks {
  onStarting?: () => void | Promise<void>;
  onRunning?: (
    url: string,
    endpoint: { host: string; port: number }
  ) => void | Promise<void>;
  onFailed?: () => void | Promise<void>;
  onStopped?: () => void | Promise<void>;
}

type PreviewLaunch =
  | {
      kind: 'shell';
      workdir: string;
      command: string;
    }
  | {
      kind: 'static';
      workdir: string;
    };

interface PreviewDetection {
  kind: 'npm' | 'static' | 'none' | 'ambiguous';
  workdir?: string;
  runner?: 'standard' | 'next';
  candidates?: string[];
}

interface RuntimeLease {
  userId: string;
  holders: number;
  presenceTimer?: NodeJS.Timeout;
  sharedLease?: CoordinationLease;
  sharedLeaseTimer?: NodeJS.Timeout;
  sharedLeaseLost?: boolean;
}

export class WorkRuntimeService {
  readonly driver: WorkRuntimeDriver;
  readonly runtimeKind: 'docker' | 'kubernetes';
  readonly image = config.image;
  readonly previewPort = config.previewPort;
  readonly limits = {
    maxRounds: config.maxAgentRounds,
    commandTimeoutMs: config.commandTimeoutMs,
    maxOutputChars: config.maxOutputChars,
    maxActiveRuntimesGlobal: config.maxActiveRuntimesGlobal,
    maxActiveRuntimesPerUser: config.maxActiveRuntimesPerUser,
  };
  private imagePreparations = new Map<string, Promise<void>>();
  private lifecycleTails = new Map<string, Promise<void>>();
  private preparations = new Map<string, Promise<void>>();
  private retiringTasks = new Set<string>();
  private networkPolicies = new Map<string, boolean>();
  private activeCommands = new Set<string>();
  private lastRuntimeUnavailableReason: string | null = null;
  private runtimeLeases = new Map<string, RuntimeLease>();
  private previewLeaseReleases = new Map<string, () => void>();
  private terminalHolds = new Map<string, number>();
  private screenHolds = new Map<string, number>();
  // Cross-replica mirror of screenHolds: presence members that tell another
  // replica's teardown (a run ending on the durable worker) that a viewer
  // here still owns the container.
  private viewerPresenceCounts = new Map<string, number>();
  private viewerPresenceTimers = new Map<string, NodeJS.Timeout>();
  private recoveryTasks = new Map<string, WorkTaskRecord>();
  private recoveryOrphans = new Map<string, DiscoveredWorkContainer>();
  private recoveryInventory?: WorkTaskRecord[];
  // Sweeps left for the empty-inventory case before giving up on a runtime
  // that never appears (30 × 10s covers a late Docker socket proxy or
  // Kubernetes API without probing an intentionally disabled backend forever).
  private emptyInventorySweepsLeft = 30;
  private recoveryTimer?: NodeJS.Timeout;
  private shuttingDown = false;
  private readonly activityMemberId =
    `${process.env.LIBRE_PROCESS_ROLE || 'standalone'}-${process.pid}-` +
    randomUUID();

  constructor(driver: WorkRuntimeDriver = new DockerWorkRuntimeDriver()) {
    this.driver = driver;
    this.runtimeKind = driver.kind;
    // Authorized preview traffic keeps its task's idle clock fresh.
    workPreviewProxyService.onPreviewActivity(taskId =>
      this.noteTaskActivity(taskId)
    );
    if (process.env.LIBRE_PROCESS_ROLE !== 'app-external') {
      this.scheduleIdleSweep();
    }
  }

  // Last observed activity per task, feeding the idle sweep: a finished
  // command, a terminal session ending, or a preview fetch. In-memory only —
  // after a restart the clock restarts from the first sighting.
  private taskActivity = new Map<string, number>();
  private idleTimer?: NodeJS.Timeout;

  noteTaskActivity(taskId: string): void {
    this.taskActivity.set(taskId, Date.now());
    if (getPlatformRuntimeConfig().mode === 'team') {
      void getCoordinator()
        .setCache(`work-task-activity:${taskId}`, Date.now(), 86_400_000)
        .catch(error =>
          logger.warn(`Could not persist Work activity for ${taskId}:`, error)
        );
    }
  }

  get recoveryPending(): boolean {
    return this.recoveryPendingCount > 0;
  }

  get recoveryPendingCount(): number {
    // Before reconciliation has run, every inventoried task counts as
    // pending: nothing has been proven about its container yet.
    return (
      (this.recoveryInventory?.length ?? 0) +
      this.recoveryTasks.size +
      this.recoveryOrphans.size
    );
  }

  assertAcceptingWork(): void {
    if (this.shuttingDown) {
      throw new WorkRuntimeError(
        'The Work runtime is shutting down.',
        503,
        'WORK_RUNTIME_SHUTTING_DOWN'
      );
    }
    if (this.recoveryPending) {
      throw new WorkRuntimeError(
        `Work is temporarily unavailable while ${this.recoveryPendingCount} container cleanup(s) are retried.`,
        503,
        'WORK_RUNTIME_RECOVERING'
      );
    }
  }

  async isRuntimeAvailable(): Promise<boolean> {
    try {
      await this.driver.probe();
      this.lastRuntimeUnavailableReason = null;
      return true;
    } catch (error) {
      this.lastRuntimeUnavailableReason =
        error instanceof Error ? error.message : String(error);
      return false;
    }
  }

  /**
   * Why the last availability probe failed. A generic "runtime unavailable"
   * message cannot be acted on, so drivers return their operator-facing cause.
   */
  get runtimeUnavailableReason(): string | null {
    return this.lastRuntimeUnavailableReason;
  }

  /**
   * Live runtime occupancy, so the interface can say "1 of 2 runtimes in use"
   * instead of surprising the administrator with a 429 at submit time.
   */
  activeRuntimeCounts(userId?: string): { global: number; user: number } {
    let user = 0;
    if (userId) {
      for (const lease of this.runtimeLeases.values()) {
        if (lease.userId === userId) user += 1;
      }
    }
    return { global: this.runtimeLeases.size, user };
  }

  async beginRecovery(
    tasks: WorkTaskRecord[],
    assertRecoveryLease?: () => Promise<void>
  ): Promise<{ stopped: number; failed: number }> {
    this.recoveryInventory = tasks;
    const result = await this.sweepRecoveryTasks(assertRecoveryLease);
    if (assertRecoveryLease) {
      // An external worker must never hand unfinished destructive recovery to
      // an unfenced background retry after releasing the global startup lease.
      if (this.recoveryInventory !== undefined && result.failed === 0) {
        return { ...result, failed: 1 };
      }
    } else {
      this.scheduleRecoverySweep();
    }
    return result;
  }

  private async acquireRuntimeLease(
    task: WorkTaskRecord,
    signal?: AbortSignal,
    options?: { sharedWaitMs?: number }
  ): Promise<() => void> {
    signal?.throwIfAborted();
    await this.assertTaskIsActive(task);
    signal?.throwIfAborted();
    const existing = this.runtimeLeases.get(task.id);
    if (existing) {
      if (existing.userId !== task.userId) {
        throw new WorkRuntimeError(
          'This Work runtime lease belongs to a different administrator.',
          409,
          'WORK_RUNTIME_LEASE_CONFLICT'
        );
      }
      existing.holders += 1;
    } else {
      const perUser = [...this.runtimeLeases.values()].filter(
        lease => lease.userId === task.userId
      ).length;
      if (perUser >= config.maxActiveRuntimesPerUser) {
        throw new WorkRuntimeError(
          `This administrator already has ${config.maxActiveRuntimesPerUser} active Work runtime(s). Wait for another operation or preview to stop.`,
          429,
          'WORK_USER_RUNTIME_LIMIT'
        );
      }
      if (this.runtimeLeases.size >= config.maxActiveRuntimesGlobal) {
        throw new WorkRuntimeError(
          `This Libre WebUI instance already has ${config.maxActiveRuntimesGlobal} active Work runtime(s). Wait for another operation or preview to stop.`,
          429,
          'WORK_GLOBAL_RUNTIME_LIMIT'
        );
      }
      const runtimeLease: RuntimeLease = {
        userId: task.userId,
        holders: 1,
      };
      if (getPlatformRuntimeConfig().mode === 'team') {
        const attemptSharedLease =
          async (): Promise<CoordinationLease | null> => {
            let abandoned = false;
            const pendingSharedLease = getCoordinator().acquireLease(
              `work-task-runtime:${task.id}`,
              60_000
            );
            void pendingSharedLease
              .then(lease => {
                if (!abandoned || !lease) return;
                void withCoordinationTimeout(
                  lease.release(),
                  SHARED_COORDINATION_OPERATION_TIMEOUT_MS
                ).catch(() => undefined);
              })
              .catch(() => undefined);
            try {
              return await waitForAbortSignal(
                withCoordinationTimeout(
                  pendingSharedLease,
                  SHARED_COORDINATION_OPERATION_TIMEOUT_MS
                ),
                signal
              );
            } catch (error) {
              abandoned = true;
              throw error;
            }
          };
        const sharedLease = await acquireSharedRuntimeLeaseWithWait(
          attemptSharedLease,
          {
            waitMs: options?.sharedWaitMs ?? 0,
            signal,
            beforeRetry: () => this.assertTaskIsActive(task),
          }
        );
        runtimeLease.sharedLease = sharedLease;
        runtimeLease.sharedLeaseTimer = setInterval(() => {
          void withCoordinationTimeout(
            sharedLease.extend(60_000),
            SHARED_COORDINATION_OPERATION_TIMEOUT_MS
          )
            .then(extended => {
              if (!extended) throw new Error('lease ownership was lost');
            })
            .catch(error => {
              if (runtimeLease.sharedLeaseLost) return;
              runtimeLease.sharedLeaseLost = true;
              logger.error(
                `Shared Work runtime lease was lost for task ${task.id}; stopping its sandbox:`,
                error
              );
              void this.driver
                .stopRuntime(task)
                .catch(stopError =>
                  logger.error(
                    `Could not stop Work task ${task.id} after lease loss:`,
                    stopError
                  )
                );
            });
        }, 20_000);
        runtimeLease.sharedLeaseTimer.unref?.();
        const refreshPresence = (): Promise<void> =>
          withCoordinationTimeout(
            getCoordinator().setPresence(
              `work-task-active:${task.id}`,
              this.activityMemberId,
              30_000
            ),
            SHARED_COORDINATION_OPERATION_TIMEOUT_MS
          );
        try {
          await waitForAbortSignal(refreshPresence(), signal);
        } catch (error) {
          if (runtimeLease.sharedLeaseTimer) {
            clearInterval(runtimeLease.sharedLeaseTimer);
          }
          await withCoordinationTimeout(
            sharedLease.release(),
            SHARED_COORDINATION_OPERATION_TIMEOUT_MS
          ).catch(() => false);
          throw error;
        }
        runtimeLease.presenceTimer = setInterval(() => {
          void refreshPresence().catch(error =>
            logger.warn(
              `Could not refresh Work activity for ${task.id}:`,
              error
            )
          );
        }, 10_000);
        runtimeLease.presenceTimer.unref?.();
      }
      this.runtimeLeases.set(task.id, runtimeLease);
    }

    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.releaseRuntimeLease(task.id, task.userId);
    };
  }

  private releaseRuntimeLease(
    taskId: string,
    expectedUserId?: string,
    force = false
  ): void {
    const lease = this.runtimeLeases.get(taskId);
    if (!lease || (expectedUserId && lease.userId !== expectedUserId)) return;
    if (!force) lease.holders -= 1;
    if (!force && lease.holders > 0) return;
    if (lease.presenceTimer) clearInterval(lease.presenceTimer);
    if (lease.sharedLeaseTimer) clearInterval(lease.sharedLeaseTimer);
    this.runtimeLeases.delete(taskId);
    void lease.sharedLease?.release().catch(() => false);
    if (getPlatformRuntimeConfig().mode === 'team') {
      void getCoordinator()
        .clearPresence(`work-task-active:${taskId}`, this.activityMemberId)
        .catch(error =>
          logger.warn(`Could not clear Work activity for ${taskId}:`, error)
        );
    }
  }

  private assertRuntimeLease(task: WorkTaskRecord): void {
    const lease = this.runtimeLeases.get(task.id);
    if (
      !lease ||
      lease.userId !== task.userId ||
      lease.holders < 1 ||
      lease.sharedLeaseLost
    ) {
      throw new WorkRuntimeError(
        'Work container acquisition requires a runtime capacity lease.',
        503,
        'WORK_RUNTIME_LEASE_REQUIRED'
      );
    }
  }

  private releasePreviewLease(taskId: string): void {
    if (!this.previewLeaseReleases.has(taskId)) return;
    const release = this.previewLeaseReleases.get(taskId);
    this.previewLeaseReleases.delete(taskId);
    if (typeof release === 'function') {
      release();
    }
  }

  async prepare(
    task: WorkTaskRecord,
    signal?: AbortSignal
  ): Promise<() => void> {
    // The run executor waits out short-lived lease holders (a racing Files
    // helper on the app replica, task-creation prepare) instead of failing
    // the user's first run with a replica conflict.
    const releaseLease = await this.acquireRuntimeLease(task, signal, {
      sharedWaitMs: runLeaseWaitMs(),
    });
    await this.assertTaskIsActive(task);
    const active = this.preparations.get(task.id);
    if (active) {
      try {
        await waitForAbortSignal(active, signal);
        return releaseLease;
      } catch (error) {
        releaseLease();
        throw error;
      }
    }
    let tracked: Promise<void>;
    tracked = (async () => {
      await waitForAbortSignal(this.ensureImage(task), signal);
      await this.assertTaskIsActive(task);
      await this.withLifecycleLock(
        task.id,
        async (_assertHeld, leaseSignal) => {
          const operationSignal = combineAbortSignals(signal, leaseSignal);
          await this.assertTaskIsActive(task);
          await this.prepareWithLock(task, operationSignal);
          await this.assertTaskIsActive(task);
        }
      );
    })().finally(() => {
      if (this.preparations.get(task.id) === tracked) {
        this.preparations.delete(task.id);
      }
    });
    this.preparations.set(task.id, tracked);
    try {
      await tracked;
      return releaseLease;
    } catch (error) {
      releaseLease();
      throw error;
    }
  }

  /**
   * Hold the task container up for an interactive terminal session. The hold
   * goes through the same admission (runtime lease), policy verification, and
   * container preparation as every other runtime operation, and keeps the
   * idle-stop path from tearing the container down while a shell is attached.
   */
  async acquireTerminalHold(
    task: WorkTaskRecord,
    signal?: AbortSignal
  ): Promise<() => Promise<void>> {
    if (this.activeCommands.has(task.id)) {
      throw new WorkRuntimeError(
        'A Work command is running in this container. Wait for it to finish, then reconnect the terminal.',
        409,
        'WORK_TERMINAL_COMMAND_ACTIVE'
      );
    }
    const releaseLease = await this.prepare(task, signal);
    this.terminalHolds.set(task.id, (this.terminalHolds.get(task.id) ?? 0) + 1);
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      this.noteTaskActivity(task.id);
      const remaining = (this.terminalHolds.get(task.id) ?? 1) - 1;
      if (remaining <= 0) {
        this.terminalHolds.delete(task.id);
      } else {
        this.terminalHolds.set(task.id, remaining);
      }
      try {
        if (remaining <= 0 && !this.shuttingDown) {
          await this.withLifecycleLock(task.id, (_assertHeld, signal) =>
            this.stopContainerIfIdleWithLock(task, signal)
          );
        }
      } catch (error) {
        logger.warn(
          `Could not idle Work container ${task.containerName} after terminal session:`,
          error
        );
      } finally {
        releaseLease();
      }
    };
  }

  terminalSessionCount(taskId: string): number {
    return this.terminalHolds.get(taskId) ?? 0;
  }

  /**
   * A connected Screen viewer owns the running container the way an
   * attached terminal does: while someone watches the Work Computer,
   * workspace-helper teardown and run-end cleanup must not stop the
   * sandbox out from under the GUI session. Callers hold the returned
   * release for the lifetime of the viewer connection.
   */
  async beginScreenSession(task: WorkTaskRecord): Promise<() => Promise<void>> {
    // Deliberately NOT the runtime lease: in team mode the task's run holds
    // that lease on the durable worker for its whole duration, and a viewer
    // must neither fail against it nor block the next run by holding it.
    // Local holds stop this process's teardown; the presence member stops
    // every other replica's.
    await this.assertTaskIsActive(task);
    const releasePresence = await this.acquireViewerPresence(task.id);
    this.screenHolds.set(task.id, (this.screenHolds.get(task.id) ?? 0) + 1);
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      this.noteTaskActivity(task.id);
      const remaining = (this.screenHolds.get(task.id) ?? 1) - 1;
      if (remaining <= 0) {
        this.screenHolds.delete(task.id);
      } else {
        this.screenHolds.set(task.id, remaining);
      }
      releasePresence();
      try {
        if (remaining <= 0 && !this.shuttingDown) {
          await this.withLifecycleLock(task.id, (_assertHeld, signal) =>
            this.stopContainerIfIdleWithLock(task, signal)
          );
        }
      } catch (error) {
        logger.warn(
          `Could not idle Work container ${task.containerName} after a screen session:`,
          error
        );
      }
    };
  }

  /**
   * Register this process as an active viewer of the task in the shared
   * presence scope, refreshed for as long as at least one viewer remains.
   * Solo mode needs no cross-replica signal and returns a no-op.
   */
  private async acquireViewerPresence(taskId: string): Promise<() => void> {
    if (getPlatformRuntimeConfig().mode !== 'team') {
      return () => undefined;
    }
    const member = `${this.activityMemberId}:viewer`;
    const refresh = (): Promise<void> =>
      withCoordinationTimeout(
        getCoordinator().setPresence(
          `work-task-active:${taskId}`,
          member,
          30_000
        ),
        SHARED_COORDINATION_OPERATION_TIMEOUT_MS
      );
    await refresh();
    const count = this.viewerPresenceCounts.get(taskId) ?? 0;
    if (count === 0) {
      const timer = setInterval(() => {
        void refresh().catch(error =>
          logger.warn(
            `Could not refresh Work viewer presence for ${taskId}:`,
            error
          )
        );
      }, 10_000);
      timer.unref?.();
      this.viewerPresenceTimers.set(taskId, timer);
    }
    this.viewerPresenceCounts.set(taskId, count + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (this.viewerPresenceCounts.get(taskId) ?? 1) - 1;
      if (remaining > 0) {
        this.viewerPresenceCounts.set(taskId, remaining);
        return;
      }
      this.viewerPresenceCounts.delete(taskId);
      const timer = this.viewerPresenceTimers.get(taskId);
      if (timer) clearInterval(timer);
      this.viewerPresenceTimers.delete(taskId);
      void getCoordinator()
        .clearPresence(`work-task-active:${taskId}`, member)
        .catch(error =>
          logger.warn(
            `Could not clear Work viewer presence for ${taskId}:`,
            error
          )
        );
    };
  }

  screenSessionCount(taskId: string): number {
    return this.screenHolds.get(taskId) ?? 0;
  }

  beginShutdown(): void {
    this.shuttingDown = true;
    if (this.recoveryTimer) {
      clearTimeout(this.recoveryTimer);
      this.recoveryTimer = undefined;
    }
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
    for (const taskId of [...this.previewLeaseReleases.keys()]) {
      this.releasePreviewLease(taskId);
    }
    for (const taskId of [...this.runtimeLeases.keys()]) {
      this.releaseRuntimeLease(taskId, undefined, true);
    }
    this.driver.shutdown();
  }

  beginTaskSuspension(taskId: string): void {
    if (this.retiringTasks.has(taskId)) {
      throw new WorkRuntimeError(
        'This Work task is already being suspended or deleted.',
        409,
        'WORK_TASK_REMOVING'
      );
    }
    this.retiringTasks.add(taskId);
  }

  releaseTaskSuspension(taskId: string): void {
    this.retiringTasks.delete(taskId);
  }

  private async sweepRecoveryTasks(
    assertRecoveryLease: () => Promise<void> = async () => undefined
  ): Promise<{
    stopped: number;
    failed: number;
  }> {
    if (
      this.recoveryInventory === undefined &&
      this.recoveryTasks.size === 0 &&
      this.recoveryOrphans.size === 0
    ) {
      return { stopped: 0, failed: 0 };
    }
    if (this.shuttingDown || !(await this.isRuntimeAvailable())) {
      if (this.recoveryInventory?.length === 0) {
        // No tasks to supervise, so nothing fail-closes — but leftover
        // sandboxes may still exist after a database restore, or the runtime
        // control plane may start after the backend. Retry for a bounded
        // window without probing an intentionally disabled runtime forever.
        if (this.shuttingDown || this.emptyInventorySweepsLeft <= 0) {
          this.recoveryInventory = undefined;
          return { stopped: 0, failed: 0 };
        }
        this.emptyInventorySweepsLeft -= 1;
        return { stopped: 0, failed: 0 };
      }
      return { stopped: 0, failed: this.recoveryPendingCount };
    }

    if (this.recoveryInventory !== undefined) {
      // Reconcile against what actually exists instead of stopping every
      // known task blind: one labeled listing decides which containers are
      // running unsupervised, which are at rest, and which are orphans left
      // by a task whose database row is gone.
      let discovered: DiscoveredWorkContainer[];
      try {
        await assertRecoveryLease();
        discovered = await this.driver.listManaged();
      } catch (error) {
        logger.warn(
          'Could not list Work containers for startup reconciliation:',
          error
        );
        return { stopped: 0, failed: this.recoveryPendingCount };
      }
      const plan = planStartupReconciliation(
        this.recoveryInventory,
        discovered
      );
      for (const task of plan.stop) {
        this.recoveryTasks.set(task.id, task);
      }
      for (const orphan of plan.removeOrphans) {
        this.recoveryOrphans.set(orphan.name, orphan);
      }
      await this.reportOrphanWorkspaces(this.recoveryInventory);
      this.recoveryInventory = undefined;
      if (this.recoveryPendingCount > 0 || plan.atRest > 0) {
        logger.info(
          `Work startup reconciliation: ${plan.stop.length} running container(s) to stop, ` +
            `${plan.removeOrphans.length} orphaned container(s) to remove, ` +
            `${plan.atRest} container(s) already at rest.`
        );
      }
    }

    const tasks = [...this.recoveryTasks.values()];
    const orphans = [...this.recoveryOrphans.values()];
    const [taskResults, orphanResults] = await Promise.all([
      Promise.allSettled(
        tasks.map(async task => {
          await assertRecoveryLease();
          await this.stopContainer(task);
          await assertRecoveryLease();
        })
      ),
      Promise.allSettled(
        orphans.map(async orphan => {
          await assertRecoveryLease();
          await this.driver.removeOrphan(orphan.name);
          await assertRecoveryLease();
        })
      ),
    ]);
    let stopped = 0;
    taskResults.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        this.recoveryTasks.delete(tasks[index].id);
        stopped += 1;
      } else {
        logger.warn(
          `Could not stop Work container ${tasks[index].containerName} during recovery:`,
          result.reason
        );
      }
    });
    orphanResults.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        this.recoveryOrphans.delete(orphans[index].name);
        stopped += 1;
      } else {
        logger.warn(
          `Could not remove orphaned Work container ${orphans[index].name} during recovery:`,
          result.reason
        );
      }
    });
    if (this.recoveryPendingCount === 0 && (tasks.length || orphans.length)) {
      logger.info('Work startup container recovery completed.');
    }
    return { stopped, failed: this.recoveryPendingCount };
  }

  /**
   * Workspaces whose task record no longer exists are reported, never
   * auto-deleted: a workspace is the durable half of a task, so removal is
   * always an explicit operator decision.
   */
  private async reportOrphanWorkspaces(
    inventory: WorkTaskRecord[]
  ): Promise<void> {
    if (!this.driver.listWorkspaces) return;
    try {
      const known = new Set(inventory.map(task => task.id));
      const orphaned = (await this.driver.listWorkspaces()).filter(
        workspace => !known.has(workspace.taskId)
      );
      if (orphaned.length > 0) {
        logger.warn(
          `Work found ${orphaned.length} workspace(s) with no task record, left in place: ` +
            orphaned.map(workspace => workspace.name).join(', ')
        );
      }
    } catch (error) {
      logger.warn(
        'Could not list Work workspaces for orphan reporting:',
        error
      );
    }
  }

  /**
   * Stop sandboxes that have seen no activity — no command finished, no
   * terminal attached, no preview fetch — for WORK_RUNTIME_IDLE_TIMEOUT_MS.
   * Stopping is cheap and the workspace persists, so the sweep only spends
   * an admission slot holder that nobody is using. Busy tasks (active
   * command, terminal, or a non-preview operation lease) refresh their
   * clock instead of being considered. A running sandbox seen for the
   * first time starts its clock at the sighting rather than being stopped
   * on a guess.
   */
  async sweepIdleRuntimes(now = Date.now()): Promise<{ stopped: number }> {
    if (
      process.env.LIBRE_PROCESS_ROLE === 'app-external' ||
      this.shuttingDown ||
      this.recoveryPending
    ) {
      return { stopped: 0 };
    }
    // Idle-stop can come from the global knob or from any named policy.
    if (
      config.idleTimeoutMs <= 0 &&
      !(await workPolicyService.anyIdleTimeoutConfigured())
    ) {
      return { stopped: 0 };
    }
    let discovered: DiscoveredWorkContainer[];
    try {
      discovered = await this.driver.listManaged();
    } catch {
      // The runtime is unreachable; nothing can be stopped anyway.
      return { stopped: 0 };
    }
    const records = new Map(
      (await workTaskService.listAllTaskRecords()).map(task => [task.id, task])
    );
    let stopped = 0;
    for (const entry of discovered) {
      if (!entry.running) continue;
      const task = records.get(entry.taskId);
      // Containers without a task row are startup reconciliation's business.
      if (!task) continue;
      if (
        getPlatformRuntimeConfig().mode === 'team' &&
        (await getCoordinator().listPresence(`work-task-active:${task.id}`))
          .length > 0
      ) {
        continue;
      }
      const busy =
        this.activeCommands.has(task.id) ||
        (this.terminalHolds.get(task.id) ?? 0) > 0 ||
        (this.screenHolds.get(task.id) ?? 0) > 0 ||
        (this.runtimeLeases.has(task.id) &&
          !this.previewLeaseReleases.has(task.id));
      const sharedActivity =
        getPlatformRuntimeConfig().mode === 'team'
          ? await getCoordinator().getCache<number>(
              `work-task-activity:${task.id}`
            )
          : null;
      const lastActivity = sharedActivity ?? this.taskActivity.get(task.id);
      if (busy || lastActivity === undefined) {
        this.noteTaskActivity(task.id);
        continue;
      }
      const idleAfterMs = (await workPolicyService.resolve(task.policyId))
        .idleTimeoutMs;
      if (idleAfterMs <= 0 || now - lastActivity < idleAfterMs) continue;
      try {
        if (this.previewLeaseReleases.has(task.id)) {
          await this.stopPreview(task, {
            onStopped: () => workTaskService.updatePreview(task.id, 'stopped'),
          });
        } else {
          await this.stopContainer(task);
        }
        this.taskActivity.delete(task.id);
        stopped += 1;
        logger.info(
          `Stopped idle Work sandbox ${task.containerName} after ${idleAfterMs}ms of inactivity.`
        );
      } catch (error) {
        logger.warn(
          `Could not stop idle Work sandbox ${task.containerName}:`,
          error
        );
      }
    }
    return { stopped };
  }

  private scheduleIdleSweep(): void {
    if (this.shuttingDown || this.idleTimer) {
      return;
    }
    // Policies can enable idle-stop at runtime even when the global knob is
    // off, so the timer always runs; the sweep itself exits in one cheap
    // query when nothing configures a timeout. With a global timeout the
    // interval sits well inside it, so an idle sandbox overshoots its
    // deadline by a fraction, not a multiple.
    const interval =
      config.idleTimeoutMs > 0
        ? Math.max(
            15_000,
            Math.min(60_000, Math.floor(config.idleTimeoutMs / 4))
          )
        : 60_000;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      void this.sweepIdleRuntimes()
        .catch(error => {
          logger.warn('Work idle sweep failed:', error);
        })
        .finally(() => {
          this.scheduleIdleSweep();
        });
    }, interval);
    this.idleTimer.unref();
  }

  private scheduleRecoverySweep(): void {
    if (
      this.shuttingDown ||
      (this.recoveryPendingCount === 0 &&
        this.recoveryInventory === undefined) ||
      this.recoveryTimer
    ) {
      return;
    }
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = undefined;
      void this.sweepRecoveryTasks()
        .catch(error => {
          logger.warn('Work startup container recovery retry failed:', error);
        })
        .finally(() => {
          this.scheduleRecoverySweep();
        });
    }, 10_000);
    this.recoveryTimer.unref();
  }

  private queueFailedCleanup(task: WorkTaskRecord, error: unknown): void {
    this.recoveryTasks.set(task.id, task);
    logger.warn(
      `Work is fail-closed until container ${task.containerName} can be stopped:`,
      error
    );
    this.scheduleRecoverySweep();
  }

  private completeRecoveryTask(taskId: string): void {
    const removed = this.recoveryTasks.delete(taskId);
    if (removed && this.recoveryPendingCount === 0) {
      logger.info('Pending Work container cleanup completed.');
    }
  }

  private async markPreviewStopped(taskId: string): Promise<void> {
    try {
      await getWorkPersistence().updatePreview(
        taskId,
        'stopped',
        null,
        null,
        null,
        Date.now()
      );
    } catch (error) {
      logger.warn(
        `Could not persist stopped preview state for Work task ${taskId}:`,
        error
      );
    }
  }

  private async prepareWithLock(
    task: WorkTaskRecord,
    signal?: AbortSignal
  ): Promise<void> {
    signal?.throwIfAborted();
    this.assertRuntimeLease(task);
    this.assertCurrentNetworkPolicy(task);
    await this.assertTaskIsActive(task);
    await this.driver.ensureWorkspace(task, signal);
    await this.assertTaskIsActive(task);
    this.assertRuntimeLease(task);
    await this.driver.ensureRuntime(task, signal);
    if (this.shuttingDown) {
      await this.stopContainerWithLock(task, signal);
      await this.assertTaskIsActive(task);
    }
  }

  async recreateContainer(task: WorkTaskRecord): Promise<void> {
    const releaseLease = await this.acquireRuntimeLease(task);
    try {
      await this.ensureImage(task);
      await this.assertTaskIsActive(task);
      await this.withLifecycleLock(task.id, async (_assertHeld, signal) => {
        await this.assertTaskIsActive(task);
        await this.recreateContainerWithLock(task, signal);
        await this.stopContainerWithLock(task, signal);
        this.networkPolicies.set(task.id, task.networkEnabled);
      });
      this.releasePreviewLease(task.id);
      await this.markPreviewStopped(task.id);
    } finally {
      releaseLease();
    }
  }

  async changeNetworkPolicy<T>(
    before: WorkTaskRecord,
    desired: WorkTaskRecord,
    commit: () => T | Promise<T>
  ): Promise<T> {
    await this.assertTaskIsActive(before);
    if (desired.networkEnabled === before.networkEnabled) {
      return this.withLifecycleLock(before.id, async assertHeld => {
        await this.assertTaskIsActive(before);
        this.assertCurrentNetworkPolicy(before);
        await assertHeld();
        const result = await commit();
        this.networkPolicies.set(desired.id, desired.networkEnabled);
        return result;
      });
    }

    const releaseLease = await this.acquireRuntimeLease(before);
    let previewStopped = false;
    try {
      await this.ensureImage(before);
      await this.assertTaskIsActive(before);
      return await this.withLifecycleLock(
        before.id,
        async (assertHeld, signal) => {
          await this.assertTaskIsActive(before);
          this.assertCurrentNetworkPolicy(before);
          try {
            await this.recreateContainerWithLock(desired, signal);
            await assertHeld();
            await this.stopContainerWithLock(desired, signal);
            previewStopped = true;
            await assertHeld();
            const result = await commit();
            this.networkPolicies.set(desired.id, desired.networkEnabled);
            return result;
          } catch (error) {
            try {
              await this.recreateContainerWithLock(before, signal);
              await this.stopContainerWithLock(before, signal);
              previewStopped = true;
              this.networkPolicies.set(before.id, before.networkEnabled);
            } catch (rollbackError) {
              logger.error(
                `Could not restore prior network policy for Work task ${before.id}:`,
                rollbackError
              );
            }
            throw error;
          }
        }
      );
    } finally {
      if (previewStopped) {
        this.releasePreviewLease(before.id);
        await this.markPreviewStopped(before.id);
      }
      releaseLease();
    }
  }

  private async recreateContainerWithLock(
    task: WorkTaskRecord,
    signal?: AbortSignal
  ): Promise<void> {
    this.assertRuntimeLease(task);
    await this.assertTaskIsActive(task);
    await this.driver.ensureWorkspace(task, signal);
    await this.assertTaskIsActive(task);
    await this.driver.removeRuntime(task, signal);
    await this.driver.ensureRuntime(task, signal);
    if (this.shuttingDown) {
      await this.stopContainerWithLock(task, signal);
      await this.assertTaskIsActive(task);
    }
  }

  async stopContainer(task: WorkTaskRecord): Promise<void> {
    await this.withLifecycleLock(task.id, (_assertHeld, signal) =>
      this.stopContainerWithLock(task, signal)
    );
    this.releasePreviewLease(task.id);
    await this.markPreviewStopped(task.id);
    this.completeRecoveryTask(task.id);
  }

  /**
   * Interrupt an already-running helper, command, or preview without waiting
   * behind its lifecycle queue. Callers must first suspend the task, then
   * follow this with the regular serialized stop to catch a container that
   * was still being created when this interrupt ran.
   */
  async interruptContainer(task: WorkTaskRecord): Promise<void> {
    await this.stopContainerWithLock(task);
    this.releasePreviewLease(task.id);
    await this.markPreviewStopped(task.id);
    this.completeRecoveryTask(task.id);
  }

  private async stopContainerWithLock(
    task: WorkTaskRecord,
    signal?: AbortSignal
  ): Promise<void> {
    try {
      await this.driver.stopRuntime(task, signal);
    } catch (error) {
      this.queueFailedCleanup(task, error);
      throw error;
    }
  }

  async removeTask(
    task: WorkTaskRecord,
    allowRevokedOwner = false
  ): Promise<void> {
    if (allowRevokedOwner) {
      await this.assertTaskStillOwned(task);
    } else {
      await this.assertTaskOwnerHasWorkAccess(task);
    }
    this.retiringTasks.add(task.id);
    try {
      await this.withLifecycleLock(task.id, (_assertHeld, signal) =>
        this.driver.removeTaskResources(task, signal)
      );
    } catch (error) {
      this.retiringTasks.delete(task.id);
      throw error;
    }
  }

  finalizeTaskRemoval(taskId: string): void {
    this.retiringTasks.delete(taskId);
    this.networkPolicies.delete(taskId);
    this.preparations.delete(taskId);
    this.activeCommands.delete(taskId);
    this.releasePreviewLease(taskId);
    this.releaseRuntimeLease(taskId, undefined, true);
    this.taskActivity.delete(taskId);
  }

  async listFiles(
    task: WorkTaskRecord,
    requestedPath = '.'
  ): Promise<{ path: string; entries: WorkFileEntry[] }> {
    const workspacePath = validateWorkspacePath(requestedPath);
    return this.withWorkspaceHelperContainer(task, async () => {
      const result = await this.exec(
        task,
        ['node', '-e', LIST_FILES_SCRIPT, '--', workspacePath],
        { maxOutputChars: 2_000_000 }
      );
      const payload = parseJsonOutput<{ entries: WorkFileEntry[] }>(
        result.stdout
      );
      return { path: workspacePath, entries: payload.entries };
    });
  }

  private async withWorkspaceHelperContainer<T>(
    task: WorkTaskRecord,
    operation: () => Promise<T>
  ): Promise<T> {
    let releaseLease: () => void;
    try {
      releaseLease = await this.acquireRuntimeLease(task);
    } catch (error) {
      // In team mode the lease holder is usually this deployment's own
      // durable worker executing the task's run. When the sandbox is already
      // up and reachable through the shared container runtime, workspace
      // helpers attach to it instead of failing the Files pane; lifecycle
      // transitions (start, stop, recreate, preview) stay lease-guarded.
      if (
        error instanceof WorkRuntimeError &&
        error.code === 'WORK_RUNTIME_LEASE_CONFLICT'
      ) {
        await this.assertTaskIsActive(task);
        if ((await this.driver.runtimeState(task)) === 'running') {
          return operation();
        }
      }
      throw error;
    }
    try {
      await this.ensureImage(task);
      await this.assertTaskIsActive(task);
      return await this.withLifecycleLock(
        task.id,
        async (_assertHeld, signal) => {
          await this.assertTaskIsActive(task);
          await this.prepareWithLock(task, signal);
          await this.assertTaskIsActive(task);
          try {
            return await operation();
          } finally {
            await this.stopContainerIfIdleWithLock(task, signal);
          }
        }
      );
    } finally {
      releaseLease();
    }
  }

  /** Returns true when the container was actually stopped. */
  private async stopContainerIfIdleWithLock(
    task: WorkTaskRecord,
    signal?: AbortSignal,
    options: { ignoreActiveCommands?: boolean } = {}
  ): Promise<boolean> {
    if (!options.ignoreActiveCommands && this.activeCommands.has(task.id)) {
      return false;
    }
    // An attached terminal session owns the running container exactly like a
    // ready preview does.
    if ((this.terminalHolds.get(task.id) ?? 0) > 0) return false;
    // So does a watched Work Computer screen: without this, every Files
    // refresh would destroy the GUI session mid-view.
    if ((this.screenHolds.get(task.id) ?? 0) > 0) return false;
    // Holds on other replicas are only visible through the presence scope:
    // a screen viewer on the app process must survive the durable worker's
    // run-end teardown, and a run on the worker must survive an app-side
    // helper's teardown. Own members are excluded — this process's holds
    // were checked directly above, and a run's own presence must not block
    // its own cleanup. When coordination is unreachable, keep the container;
    // the idle sweep is the backstop.
    if (getPlatformRuntimeConfig().mode === 'team') {
      try {
        const members = await withCoordinationTimeout(
          getCoordinator().listPresence(`work-task-active:${task.id}`),
          SHARED_COORDINATION_OPERATION_TIMEOUT_MS
        );
        if (members.some(member => !member.startsWith(this.activityMemberId))) {
          return false;
        }
      } catch (error) {
        logger.warn(
          `Could not check cross-replica activity before idling Work container ${task.containerName}; keeping it:`,
          error
        );
        return false;
      }
    }
    try {
      if (
        (await this.previewProcessCheckWithLock(task, signal)) === 'ready' &&
        this.previewLeaseReleases.has(task.id)
      ) {
        return false;
      }
    } catch (error) {
      logger.warn(
        `Could not verify preview state before idling Work container ${task.containerName}; stopping it:`,
        error
      );
    }
    // The preview probe above awaits a container exec; a terminal or screen
    // hold can land during that window. Re-check synchronously so a viewer
    // who just attached does not lose the session to a stale decision.
    if (
      (!options.ignoreActiveCommands && this.activeCommands.has(task.id)) ||
      (this.terminalHolds.get(task.id) ?? 0) > 0 ||
      (this.screenHolds.get(task.id) ?? 0) > 0
    ) {
      return false;
    }
    await this.stopContainerWithLock(task, signal);
    this.releasePreviewLease(task.id);
    await this.markPreviewStopped(task.id);
    this.completeRecoveryTask(task.id);
    return true;
  }

  async readFile(
    task: WorkTaskRecord,
    requestedPath: string
  ): Promise<{
    path: string;
    content: string;
    size: number;
    updatedAt: number;
    modifiedAt: number;
  }> {
    const workspacePath = validateWorkspacePath(requestedPath, false);
    return this.withWorkspaceHelperContainer(task, async () => {
      const result = await this.exec(
        task,
        ['node', '-e', READ_FILE_SCRIPT, '--', workspacePath],
        // JSON may escape each input byte as a six-character Unicode sequence.
        { maxOutputChars: 12_100_000, acceptFailure: true }
      );
      if (result.exitCode === 24) {
        throw new WorkRuntimeError(
          'This file is not valid UTF-8 and cannot be opened in the text editor.',
          415,
          'WORK_FILE_NOT_UTF8'
        );
      }
      this.assertSuccessfulHelperCommand(
        result,
        'The workspace file could not be read.',
        'WORK_FILE_READ_FAILED'
      );
      const payload = parseJsonOutput<{
        content: string;
        size: number;
        updatedAt: number;
      }>(result.stdout);
      return {
        path: workspacePath,
        ...payload,
        modifiedAt: payload.updatedAt,
      };
    });
  }

  async getGitStatus(task: WorkTaskRecord): Promise<WorkGitStatus> {
    return this.withWorkspaceHelperContainer(task, () =>
      this.loadGitStatus(task)
    );
  }

  async getGitDiff(
    task: WorkTaskRecord,
    requestedPath?: string
  ): Promise<WorkGitDiff> {
    const workspacePath = requestedPath
      ? validateWorkspacePath(requestedPath, false)
      : undefined;
    return this.withWorkspaceHelperContainer(task, async () => {
      const status = await this.loadGitStatus(task);
      if (!status.initialized) {
        throw new WorkRuntimeError(
          'Initialize Git before requesting a diff.',
          409,
          'WORK_GIT_NOT_INITIALIZED'
        );
      }
      const revisionArgs = status.head ? ['HEAD'] : ['--cached'];
      const result = await this.execGit(
        task,
        [
          'diff',
          ...revisionArgs,
          '--no-ext-diff',
          '--no-textconv',
          '--',
          ...(workspacePath ? [workspacePath] : []),
        ],
        { maxOutputChars: 600_000 }
      );
      return {
        ...(workspacePath ? { path: workspacePath } : {}),
        patch: result.stdout,
        truncated: result.truncated,
      };
    });
  }

  async initializeGit(task: WorkTaskRecord): Promise<WorkGitStatus> {
    return this.withGitMutation(task, async () => {
      const current = await this.loadGitStatus(task);
      if (current.initialized) return current;
      await this.requireGitSuccess(
        task,
        ['init', '--initial-branch=main', '--template=', '.'],
        'Git could not initialize this workspace.'
      );
      return this.loadGitStatus(task);
    });
  }

  async stageGitPaths(
    task: WorkTaskRecord,
    requestedPaths: string[]
  ): Promise<WorkGitStatus> {
    if (requestedPaths.length < 1 || requestedPaths.length > 200) {
      throw new WorkRuntimeError(
        'Choose between 1 and 200 workspace paths to stage.',
        400,
        'WORK_GIT_INVALID_PATHS'
      );
    }
    const workspacePaths = [
      ...new Set(
        requestedPaths.map(value => validateWorkspacePath(value, false))
      ),
    ];
    return this.withGitMutation(task, async () => {
      await this.requireGitRepository(task);
      await this.assertNoExecutableGitFilters(task);
      await this.requireGitSuccess(
        task,
        ['add', '--all', '--', ...workspacePaths],
        'Git could not stage the selected paths.'
      );
      return this.loadGitStatus(task);
    });
  }

  async commitGit(
    task: WorkTaskRecord,
    message: string,
    identity: { name: string; email: string }
  ): Promise<WorkGitStatus> {
    const commitMessage = message.trim();
    if (
      !commitMessage ||
      commitMessage.length > 4_000 ||
      commitMessage.includes('\0')
    ) {
      throw new WorkRuntimeError(
        'Commit message must contain between 1 and 4,000 characters.',
        400,
        'WORK_GIT_INVALID_COMMIT_MESSAGE'
      );
    }
    const name = validateGitIdentity(identity.name, 'name');
    const email = validateGitIdentity(identity.email, 'email');
    return this.withGitMutation(task, async () => {
      await this.requireGitRepository(task);
      await this.requireGitSuccess(
        task,
        [
          '-c',
          `user.name=${name}`,
          '-c',
          `user.email=${email}`,
          'commit',
          '--no-verify',
          '-m',
          commitMessage,
        ],
        'Git could not create the commit.'
      );
      return this.loadGitStatus(task);
    });
  }

  async createGitBranch(
    task: WorkTaskRecord,
    requestedName: string
  ): Promise<WorkGitStatus> {
    const branchName = validateGitBranchInput(requestedName);
    return this.withGitMutation(task, async () => {
      const status = await this.loadGitStatus(task);
      if (!status.initialized) {
        throw new WorkRuntimeError(
          'Initialize Git before creating a branch.',
          409,
          'WORK_GIT_NOT_INITIALIZED'
        );
      }
      if (!status.head) {
        throw new WorkRuntimeError(
          'Create the first commit before creating another branch.',
          409,
          'WORK_GIT_UNBORN_BRANCH'
        );
      }
      await this.requireValidGitBranch(task, branchName);
      await this.requireGitSuccess(
        task,
        ['branch', branchName],
        'Git could not create the branch.'
      );
      return this.loadGitStatus(task);
    });
  }

  async switchGitBranch(
    task: WorkTaskRecord,
    requestedName: string
  ): Promise<WorkGitStatus> {
    const branchName = validateGitBranchInput(requestedName);
    return this.withGitMutation(task, async () => {
      const status = await this.loadGitStatus(task);
      if (!status.initialized) {
        throw new WorkRuntimeError(
          'Initialize Git before switching branches.',
          409,
          'WORK_GIT_NOT_INITIALIZED'
        );
      }
      if (status.changes.length > 0) {
        throw new WorkRuntimeError(
          'Commit or discard workspace changes before switching branches.',
          409,
          'WORK_GIT_DIRTY_WORKTREE'
        );
      }
      if (!status.branches.includes(branchName)) {
        throw new WorkRuntimeError(
          'Only an existing local branch can be selected.',
          400,
          'WORK_GIT_UNKNOWN_BRANCH'
        );
      }
      await this.assertNoExecutableGitFilters(task);
      await this.requireGitSuccess(
        task,
        ['switch', '--no-guess', branchName],
        'Git could not switch branches.'
      );
      return this.loadGitStatus(task);
    });
  }

  async writeFile(
    task: WorkTaskRecord,
    requestedPath: string,
    content: string,
    expectedUpdatedAt?: number
  ): Promise<{
    path: string;
    content: string;
    size: number;
    updatedAt: number;
    modifiedAt: number;
  }> {
    const workspacePath = validateWorkspacePath(requestedPath, false);
    if (Buffer.byteLength(content, 'utf8') > 2_000_000) {
      throw new WorkRuntimeError(
        'File content exceeds the 2,000,000 byte limit.',
        413,
        'WORK_FILE_TOO_LARGE'
      );
    }
    if (
      expectedUpdatedAt !== undefined &&
      (!Number.isFinite(expectedUpdatedAt) || expectedUpdatedAt < 0)
    ) {
      throw new WorkRuntimeError(
        'expectedUpdatedAt must be a non-negative number.',
        400,
        'WORK_INVALID_FILE_VERSION'
      );
    }
    return this.withWorkspaceHelperContainer(task, async () => {
      const result = await this.exec(
        task,
        [
          'node',
          '-e',
          WRITE_FILE_SCRIPT,
          '--',
          workspacePath,
          expectedUpdatedAt === undefined ? '' : String(expectedUpdatedAt),
        ],
        { input: content, maxOutputChars: 10_000, acceptFailure: true }
      );
      if (result.exitCode === 23) {
        throw new WorkRuntimeError(
          'The file changed since it was opened. Reload it before saving.',
          409,
          'WORK_FILE_CONFLICT'
        );
      }
      if (result.exitCode !== 0) {
        throw new WorkRuntimeError(
          result.stderr.trim() || 'Could not write workspace file.',
          503,
          'WORK_FILE_WRITE_FAILED'
        );
      }
      const payload = parseJsonOutput<{ size: number; updatedAt: number }>(
        result.stdout
      );
      return {
        path: workspacePath,
        content,
        ...payload,
        modifiedAt: payload.updatedAt,
      };
    });
  }

  /**
   * Delete a workspace file, symlink, or directory. Directories require an
   * explicit recursive flag, and the workspace root is never deletable. Runs
   * through the helper container, so it also works while a preview holds the
   * task container.
   */
  async deletePath(
    task: WorkTaskRecord,
    requestedPath: string,
    recursive = false
  ): Promise<{ path: string; type: 'file' | 'directory' | 'symlink' }> {
    const workspacePath = validateWorkspacePath(requestedPath, false);
    return this.withWorkspaceHelperContainer(task, async () => {
      const result = await this.exec(
        task,
        [
          'node',
          '-e',
          DELETE_PATH_SCRIPT,
          '--',
          workspacePath,
          recursive ? 'recursive' : '',
        ],
        { maxOutputChars: 10_000, acceptFailure: true }
      );
      if (result.exitCode === 21) {
        throw new WorkRuntimeError(
          `No file or directory exists at ${workspacePath}.`,
          404,
          'WORK_FILE_NOT_FOUND'
        );
      }
      if (result.exitCode === 22) {
        throw new WorkRuntimeError(
          `${workspacePath} is a directory. Pass recursive: true to delete it with its contents.`,
          409,
          'WORK_DELETE_REQUIRES_RECURSIVE'
        );
      }
      if (result.exitCode !== 0) {
        throw new WorkRuntimeError(
          result.stderr.trim() || 'Could not delete the workspace path.',
          503,
          'WORK_FILE_DELETE_FAILED'
        );
      }
      const payload = parseJsonOutput<{
        type: 'file' | 'directory' | 'symlink';
      }>(result.stdout);
      return { path: workspacePath, type: payload.type };
    });
  }

  /**
   * Move or rename a workspace file or directory. Destination parents are
   * created inside the workspace, an existing destination is never
   * overwritten, and like deletePath this works while a preview is running.
   */
  async movePath(
    task: WorkTaskRecord,
    requestedFrom: string,
    requestedTo: string
  ): Promise<{ from: string; to: string }> {
    const fromPath = validateWorkspacePath(requestedFrom, false);
    const toPath = validateWorkspacePath(requestedTo, false);
    return this.withWorkspaceHelperContainer(task, async () => {
      const result = await this.exec(
        task,
        ['node', '-e', MOVE_PATH_SCRIPT, '--', fromPath, toPath],
        { maxOutputChars: 10_000, acceptFailure: true }
      );
      if (result.exitCode === 21) {
        throw new WorkRuntimeError(
          `No file or directory exists at ${fromPath}.`,
          404,
          'WORK_FILE_NOT_FOUND'
        );
      }
      if (result.exitCode === 24) {
        throw new WorkRuntimeError(
          `${toPath} already exists. Delete it first or choose another destination.`,
          409,
          'WORK_DESTINATION_EXISTS'
        );
      }
      if (result.exitCode !== 0) {
        throw new WorkRuntimeError(
          result.stderr.trim() || 'Could not move the workspace path.',
          503,
          'WORK_FILE_MOVE_FAILED'
        );
      }
      parseJsonOutput<{ moved: boolean }>(result.stdout);
      return { from: fromPath, to: toPath };
    });
  }

  async searchFiles(
    task: WorkTaskRecord,
    query: string,
    requestedPath = '.'
  ): Promise<WorkCommandResult> {
    const workspacePath = validateWorkspacePath(requestedPath);
    if (!query.trim() || query.length > 500) {
      throw new WorkRuntimeError(
        'Search query must contain 1 to 500 characters.',
        400,
        'WORK_INVALID_SEARCH'
      );
    }
    return this.withWorkspaceHelperContainer(task, () =>
      this.exec(
        task,
        ['node', '-e', SEARCH_FILES_SCRIPT, '--', workspacePath, query],
        { maxOutputChars: config.maxOutputChars }
      )
    );
  }

  async runCommand(
    task: WorkTaskRecord,
    command: string,
    timeoutMs = config.commandTimeoutMs
  ): Promise<WorkCommandResult> {
    if (!command.trim() || command.length > 20_000) {
      throw new WorkRuntimeError(
        'Command must contain 1 to 20,000 characters.',
        400,
        'WORK_INVALID_COMMAND'
      );
    }
    const boundedTimeout = Math.min(Math.max(timeoutMs, 1_000), 600_000);
    const releaseLease = await this.acquireRuntimeLease(task);
    let commandRegistered = false;
    let containerStopped = false;
    try {
      await this.ensureImage(task);
      await this.assertTaskIsActive(task);
      return await this.withLifecycleLock(
        task.id,
        async (assertHeld, signal) => {
          await this.assertTaskIsActive(task);
          try {
            await this.prepareWithLock(task, signal);
            await this.assertTaskIsActive(task);
            if (this.activeCommands.has(task.id)) {
              throw new WorkRuntimeError(
                'This Work task already has an active command.',
                409,
                'WORK_COMMAND_ACTIVE'
              );
            }
            const previewState = await this.previewProcessCheckWithLock(
              task,
              signal
            );
            if (previewState === 'ready' || previewState === 'alive') {
              throw new WorkRuntimeError(
                'Stop the Work preview before running another command.',
                409,
                'WORK_COMMAND_REQUIRES_STOPPED_PREVIEW'
              );
            }
            this.activeCommands.add(task.id);
            commandRegistered = true;
          } catch (error) {
            await this.stopContainerIfIdleWithLock(task, signal);
            throw error;
          }

          try {
            const result = await this.exec(
              task,
              [
                'timeout',
                '--signal=TERM',
                '--kill-after=3s',
                `${Math.ceil(boundedTimeout / 1000)}s`,
                '/bin/bash',
                '-c',
                MANAGED_COMMAND_SCRIPT,
                '--',
                command,
              ],
              {
                timeoutMs: boundedTimeout + 5_000,
                maxOutputChars: config.maxOutputChars,
                acceptFailure: true,
                abortSignal: signal,
              }
            );
            await assertHeld();
            return result;
          } finally {
            if (commandRegistered) {
              // Keep the distributed lifecycle fence through teardown. A
              // second replica must never stop or recreate this sandbox in
              // the gap between preparation and Docker exec. The managed
              // command script already reaped the command's process group,
              // so a container held by a screen viewer, terminal, or ready
              // preview may keep running.
              containerStopped = await this.stopContainerIfIdleWithLock(
                task,
                signal,
                { ignoreActiveCommands: true }
              );
            }
          }
        }
      );
    } finally {
      this.activeCommands.delete(task.id);
      try {
        if (containerStopped) {
          this.releasePreviewLease(task.id);
          await this.markPreviewStopped(task.id);
          this.completeRecoveryTask(task.id);
        }
      } finally {
        releaseLease();
      }
    }
  }

  /**
   * Start (or confirm) the Work Computer GUI session in a task's sandbox:
   * virtual display, window manager, browser, and the localhost-only
   * VNC-to-WebSocket bridge. Idempotent — the in-container script exits 0
   * when a session is already running. Requires a policy with the GUI
   * enabled and a networked task (the screen is reached over the published
   * loopback port, and a computer without network is not useful anyway).
   */
  async startComputer(task: WorkTaskRecord): Promise<void> {
    await this.withComputerSession(task, async () => undefined);
  }

  /** Whether this task may use the agent computer tools. */
  async computerToolsAvailable(task: {
    networkEnabled: boolean;
    policyId?: string | null;
  }): Promise<boolean> {
    return (
      task.networkEnabled &&
      (await workPolicyService.resolve(task.policyId)).guiEnabled === true
    );
  }

  /**
   * The session's VNC passwords, generated in-container at session start.
   * `view` goes to every authorized watcher; `control` goes only to the
   * current takeover-lease holder — the VNC server itself keeps everyone
   * else's input inert. Undefined on a pre-takeover GUI image (no passwd
   * file), where the session is view-only for everyone.
   */
  async computerCredentials(
    task: WorkTaskRecord
  ): Promise<WorkComputerCredentials | undefined> {
    return this.withComputerSession(task, async signal => {
      const result = await this.driver.exec(
        task,
        [
          '/bin/sh',
          '-c',
          'cat "${LIBRE_COMPUTER_STATE_DIR:-/tmp/libre-computer}/passwd"',
        ],
        {
          timeoutMs: 10_000,
          maxOutputChars: 10_000,
          acceptFailure: true,
          abortSignal: signal,
        }
      );
      if (result.exitCode !== 0) return undefined;
      const lines = result.stdout
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean);
      const marker = lines.indexOf('__BEGIN_VIEWONLY__');
      const control = lines[0];
      const view = marker > 0 ? lines[marker + 1] : undefined;
      if (!control || control === '__BEGIN_VIEWONLY__' || !view) {
        return undefined;
      }
      return { control, view };
    });
  }

  /**
   * The agent's eyes: current screenshot plus cursor and window state from
   * the task's Work Computer session. Starts the session when needed.
   */
  async computerObserve(
    task: WorkTaskRecord
  ): Promise<WorkComputerObservation> {
    return this.withComputerSession(task, signal =>
      this.runComputerScript(task, COMPUTER_OBSERVE_SCRIPT, [], 30_000, signal)
    );
  }

  /**
   * The agent's hands: a validated action batch executed with xdotool, then
   * a settle-and-observe so the caller sees the resulting screen in the same
   * round trip.
   */
  async computerAct(
    task: WorkTaskRecord,
    actions: unknown
  ): Promise<WorkComputerObservation> {
    const validated = validateWorkComputerActions(actions);
    // Waits and slow synthetic typing both extend the exec deadline; the
    // batch must never be killed mid-gesture by a fixed timeout.
    const extraBudgetMs = validated.reduce(
      (total, action) =>
        total +
        (action.type === 'wait' ? action.ms : 0) +
        (action.type === 'type' ? action.text.length * 15 : 0),
      0
    );
    return this.withComputerSession(task, signal =>
      this.runComputerScript(
        task,
        COMPUTER_ACT_SCRIPT,
        [JSON.stringify(validated)],
        60_000 + extraBudgetMs,
        signal
      )
    );
  }

  private async runComputerScript(
    task: WorkTaskRecord,
    script: string,
    args: string[],
    timeoutMs: number,
    signal: AbortSignal | undefined
  ): Promise<WorkComputerObservation> {
    const result = await this.driver.exec(
      task,
      ['node', '-e', script, '--', ...args],
      {
        timeoutMs,
        maxOutputChars: 4_000_000,
        acceptFailure: true,
        abortSignal: signal,
      }
    );
    if (result.exitCode !== 0) {
      throw new WorkRuntimeError(
        `The Work Computer action failed: ${(
          result.stderr ||
          result.stdout ||
          'unknown error'
        )
          .trim()
          .slice(0, 300)}`,
        500,
        'WORK_COMPUTER_ACTION_FAILED'
      );
    }
    const parsed = parseJsonOutput<{
      width?: unknown;
      height?: unknown;
      cursorX?: unknown;
      cursorY?: unknown;
      window?: unknown;
      image?: unknown;
    }>(result.stdout);
    if (
      typeof parsed.width !== 'number' ||
      typeof parsed.height !== 'number' ||
      typeof parsed.cursorX !== 'number' ||
      typeof parsed.cursorY !== 'number' ||
      typeof parsed.image !== 'string' ||
      parsed.image.length === 0
    ) {
      throw new WorkRuntimeError(
        'The Work Computer returned an invalid observation.',
        500,
        'WORK_COMPUTER_ACTION_FAILED'
      );
    }
    return {
      width: parsed.width,
      height: parsed.height,
      cursorX: parsed.cursorX,
      cursorY: parsed.cursorY,
      window: typeof parsed.window === 'string' ? parsed.window : '',
      screenshotBase64: parsed.image,
    };
  }

  private async withComputerSession<T>(
    task: WorkTaskRecord,
    fn: (signal?: AbortSignal) => Promise<T>
  ): Promise<T> {
    if (!task.networkEnabled) {
      throw new WorkRuntimeError(
        'The Work Computer requires network access. Enable network access for this Work task first.',
        409,
        'WORK_COMPUTER_REQUIRES_NETWORK'
      );
    }
    const policy = await workPolicyService.resolve(task.policyId);
    if (policy.guiEnabled !== true) {
      throw new WorkRuntimeError(
        "This task's Work policy does not enable the Work Computer.",
        409,
        'WORK_COMPUTER_NOT_ENABLED'
      );
    }
    let releaseLease: () => void;
    try {
      releaseLease = await this.acquireRuntimeLease(task);
    } catch (error) {
      // In team mode the lease holder is usually this deployment's own
      // durable worker executing the task's run — exactly when a human
      // wants to see the screen. When the sandbox is already running,
      // attach to it the way workspace helpers do: start-computer is
      // idempotent, and lifecycle transitions stay lease-guarded.
      if (
        error instanceof WorkRuntimeError &&
        error.code === 'WORK_RUNTIME_LEASE_CONFLICT'
      ) {
        await this.assertTaskIsActive(task);
        if ((await this.driver.runtimeState(task)) === 'running') {
          await this.startComputerInContainer(task);
          const value = await fn();
          this.noteTaskActivity(task.id);
          return value;
        }
      }
      throw error;
    }
    try {
      await this.ensureImage(task);
      await this.assertTaskIsActive(task);
      return await this.withLifecycleLock(
        task.id,
        async (assertHeld, signal) => {
          await this.assertTaskIsActive(task);
          this.assertCurrentNetworkPolicy(task);
          await assertHeld();
          await this.prepareWithLock(task, signal);
          await this.startComputerInContainer(task, signal);
          const value = await fn(signal);
          this.noteTaskActivity(task.id);
          return value;
        }
      );
    } finally {
      releaseLease();
    }
  }

  private async startComputerInContainer(
    task: WorkTaskRecord,
    signal?: AbortSignal
  ): Promise<void> {
    const result = await this.driver.exec(
      task,
      ['/usr/local/bin/start-computer'],
      { timeoutMs: 60_000, ...(signal ? { abortSignal: signal } : {}) }
    );
    if (result.exitCode !== 0) {
      const detail = (result.stderr || result.stdout || '')
        .trim()
        .slice(0, 300);
      throw new WorkRuntimeError(
        `The Work Computer could not start${detail ? `: ${detail}` : '.'} ` +
          'The policy image must include the Work Computer GUI stack.',
        500,
        'WORK_COMPUTER_START_FAILED'
      );
    }
  }

  async startPreview(
    task: WorkTaskRecord,
    command?: string,
    hooks: PreviewStateHooks = {}
  ): Promise<string> {
    if (!task.networkEnabled) {
      throw new WorkRuntimeError(
        'Preview requires network access. Enable network access for this Work task first.',
        409,
        'WORK_PREVIEW_REQUIRES_NETWORK'
      );
    }
    const previewCommand = command?.trim();
    if (previewCommand && previewCommand.length > 20_000) {
      throw new WorkRuntimeError(
        'Preview command is too long.',
        400,
        'WORK_INVALID_COMMAND'
      );
    }
    const releaseLease = await this.acquireRuntimeLease(task);
    let leaseRetained = false;
    try {
      await this.ensureImage(task);
      await this.assertTaskIsActive(task);
      const url = await this.withLifecycleLock(
        task.id,
        async (assertHeld, signal) => {
          await this.assertTaskIsActive(task);
          this.assertCurrentNetworkPolicy(task);
          if (this.activeCommands.has(task.id)) {
            throw new WorkRuntimeError(
              'Wait for the active command to finish before starting a preview.',
              409,
              'WORK_PREVIEW_COMMAND_ACTIVE'
            );
          }
          await assertHeld();
          await hooks.onStarting?.();
          try {
            await this.prepareWithLock(task, signal);
            await this.assertTaskIsActive(task);
            const previewLaunch: PreviewLaunch = previewCommand
              ? {
                  kind: 'shell',
                  workdir: '/workspace',
                  command: previewCommand,
                }
              : await this.detectPreviewLaunch(task, signal);
            const preview = await this.startPreviewPrepared(
              task,
              previewLaunch,
              signal
            );
            await this.assertTaskIsActive(task);
            await assertHeld();
            await hooks.onRunning?.(preview.url, preview.endpoint);
            return preview.url;
          } catch (error) {
            await hooks.onFailed?.();
            this.releasePreviewLease(task.id);
            throw error;
          }
        }
      );
      if (this.previewLeaseReleases.has(task.id)) {
        releaseLease();
      } else {
        this.previewLeaseReleases.set(task.id, releaseLease);
      }
      leaseRetained = true;
      return url;
    } finally {
      if (!leaseRetained) {
        releaseLease();
      }
    }
  }

  private async detectPreviewLaunch(
    task: WorkTaskRecord,
    signal?: AbortSignal
  ): Promise<PreviewLaunch> {
    try {
      const result = await this.driver.exec(
        task,
        ['node', '-e', PREVIEW_TARGET_SCRIPT, '--', '/workspace'],
        {
          acceptFailure: true,
          timeoutMs: 5_000,
          maxOutputChars: 10_000,
          abortSignal: signal,
        }
      );
      if (result.exitCode !== 0) {
        throw new WorkRuntimeError(
          `Could not inspect the workspace for a previewable app.${result.stderr.trim() ? `\n${result.stderr.trim()}` : ''}`,
          422,
          'WORK_PREVIEW_DETECTION_FAILED'
        );
      }

      const detection = parseJsonOutput<PreviewDetection>(result.stdout);
      if (
        !detection ||
        !['npm', 'static', 'none', 'ambiguous'].includes(detection.kind)
      ) {
        throw new WorkRuntimeError(
          'Workspace preview detection returned an invalid response.',
          500,
          'WORK_HELPER_INVALID_RESPONSE'
        );
      }
      if (detection.kind === 'none') {
        throw new WorkRuntimeError(
          'No previewable app was found. Add an index.html file or a package.json dev script, or enter a custom start command.',
          422,
          'WORK_PREVIEW_NOT_FOUND'
        );
      }
      if (detection.kind === 'ambiguous') {
        const candidates = (detection.candidates || []).slice(0, 8).join(', ');
        throw new WorkRuntimeError(
          `More than one previewable app was found${candidates ? `: ${candidates}` : ''}. Custom commands run from /workspace, so select the intended app with a command such as "cd <app-directory> && npm run dev".`,
          422,
          'WORK_PREVIEW_AMBIGUOUS'
        );
      }
      if (!isSafePreviewWorkdir(detection.workdir)) {
        throw new WorkRuntimeError(
          'Workspace preview detection returned an unsafe working directory.',
          500,
          'WORK_HELPER_INVALID_RESPONSE'
        );
      }
      if (detection.kind === 'static') {
        return { kind: 'static', workdir: detection.workdir };
      }
      if (
        detection.runner !== undefined &&
        detection.runner !== 'standard' &&
        detection.runner !== 'next'
      ) {
        throw new WorkRuntimeError(
          'Workspace preview detection returned an unsupported npm runner.',
          500,
          'WORK_HELPER_INVALID_RESPONSE'
        );
      }
      return {
        kind: 'shell',
        workdir: detection.workdir,
        command:
          detection.runner === 'next'
            ? `npm run dev -- --hostname 0.0.0.0 --port ${config.previewPort}`
            : `npm run dev -- --host 0.0.0.0 --port ${config.previewPort}`,
      };
    } catch (error) {
      try {
        await this.stopPreviewPrepared(task, signal);
      } catch (cleanupError) {
        logger.warn(
          `Could not clean up failed preview detection for Work task ${task.id}:`,
          cleanupError
        );
      }
      throw error;
    }
  }

  private async startPreviewPrepared(
    task: WorkTaskRecord,
    previewLaunch: PreviewLaunch,
    signal?: AbortSignal
  ): Promise<{
    url: string;
    endpoint: { host: string; port: number };
  }> {
    try {
      const launch = await this.driver.exec(
        task,
        [
          '/bin/bash',
          '-lc',
          `if [ -s /tmp/libre-work-preview.pid ] &&
            kill -0 "$(cat /tmp/libre-work-preview.pid)" 2>/dev/null; then
           exit 17
         fi
         if [ "$1" = "static" ]; then
           nohup setsid node -e "$2" -- "$3" \
             > /tmp/libre-work-preview.log 2>&1 < /dev/null &
         elif [ "$1" = "shell" ]; then
           nohup setsid /bin/bash -lc "$2" \
             > /tmp/libre-work-preview.log 2>&1 < /dev/null &
         else
           exit 18
         fi
         echo $! > /tmp/libre-work-preview.pid`,
          '--',
          previewLaunch.kind,
          previewLaunch.kind === 'static'
            ? STATIC_PREVIEW_SERVER_SCRIPT
            : previewLaunch.command,
          String(config.previewPort),
        ],
        {
          workdir: previewLaunch.workdir,
          acceptFailure: true,
          timeoutMs: 5_000,
          abortSignal: signal,
        }
      );
      if (launch.exitCode !== 0 && launch.exitCode !== 17) {
        throw await this.previewStartError(
          task,
          'Preview process could not be launched.',
          launch.stderr
        );
      }

      const deadline = Date.now() + PREVIEW_READY_TIMEOUT_MS;
      while (true) {
        const readiness = await this.driver.exec(
          task,
          [
            'node',
            '-e',
            PREVIEW_READY_SCRIPT,
            '--',
            String(config.previewPort),
          ],
          {
            acceptFailure: true,
            timeoutMs: 2_000,
            maxOutputChars: 2_000,
            abortSignal: signal,
          }
        );
        if (readiness.exitCode === 0) break;
        if (readiness.exitCode !== 3) {
          throw await this.previewStartError(
            task,
            'Preview command exited before becoming ready.',
            readiness.stderr
          );
        }
        if (Date.now() >= deadline) {
          throw await this.previewStartError(
            task,
            `Preview did not listen on port ${config.previewPort} within ${PREVIEW_READY_TIMEOUT_MS / 1000} seconds.`
          );
        }
        await waitForAbortSignal(
          new Promise(resolve => setTimeout(resolve, PREVIEW_POLL_INTERVAL_MS)),
          signal
        );
      }
      const endpoint = await this.driver.previewEndpoint(task);
      if (!endpoint) {
        throw new WorkRuntimeError(
          'The runtime did not expose the preview port.',
          503,
          'WORK_PREVIEW_PORT_UNAVAILABLE'
        );
      }
      const upstream = {
        host: normalizePreviewUpstreamHost(endpoint.host),
        port: endpoint.port,
      };
      return {
        url: workPreviewProxyService.createPreviewUrl(task.id, endpoint.port),
        endpoint: upstream,
      };
    } catch (error) {
      try {
        await this.stopPreviewPrepared(task, signal);
      } catch (cleanupError) {
        logger.warn(
          `Could not clean up failed preview for Work task ${task.id}:`,
          cleanupError
        );
      }
      throw error;
    }
  }

  private async previewStartError(
    task: WorkTaskRecord,
    reason: string,
    detail = ''
  ): Promise<WorkRuntimeError> {
    const log = await this.driver.exec(
      task,
      [
        '/bin/bash',
        '-lc',
        'tail -c 4000 /tmp/libre-work-preview.log 2>/dev/null || true',
      ],
      { acceptFailure: true, timeoutMs: 5_000, maxOutputChars: 4_000 }
    );
    const diagnostic = [detail.trim(), log.stdout.trim()]
      .filter(Boolean)
      .join('\n');
    return new WorkRuntimeError(
      `${reason}${diagnostic ? `\n${diagnostic}` : ''}`,
      422,
      'WORK_PREVIEW_START_FAILED'
    );
  }

  async stopPreview(
    task: WorkTaskRecord,
    hooks: PreviewStateHooks = {}
  ): Promise<void> {
    let stopped = false;
    try {
      await this.withLifecycleLock(task.id, async (assertHeld, signal) => {
        this.assertCurrentNetworkPolicy(task);
        if (this.activeCommands.has(task.id)) {
          throw new WorkRuntimeError(
            'Wait for the active command to finish before stopping a preview.',
            409,
            'WORK_PREVIEW_COMMAND_ACTIVE'
          );
        }
        await this.stopPreviewPrepared(task, signal);
        stopped = true;
        await assertHeld();
        await hooks.onStopped?.();
      });
    } finally {
      if (stopped) {
        this.releasePreviewLease(task.id);
      }
    }
  }

  async isPreviewRunning(task: WorkTaskRecord): Promise<boolean> {
    return this.withLifecycleLock(task.id, async (_assertHeld, signal) => {
      this.assertCurrentNetworkPolicy(task);
      // An ordinary command owns this running container and will stop it when
      // it finishes. Preview reconciliation must not interrupt that command.
      if (this.activeCommands.has(task.id)) return false;
      const state = await this.previewProcessCheckWithLock(task, signal);
      if (state === 'ready' && this.previewLeaseReleases.has(task.id)) {
        return true;
      }
      if (state === 'dead' || state === 'alive') {
        await this.stopPreviewPrepared(task, signal);
      }
      if (state === 'ready') {
        await this.stopPreviewPrepared(task, signal);
      }
      this.releasePreviewLease(task.id);
      return false;
    });
  }

  private async previewProcessCheckWithLock(
    task: WorkTaskRecord,
    signal?: AbortSignal
  ): Promise<'ready' | 'alive' | 'dead' | 'absent'> {
    if ((await this.driver.runtimeState(task)) !== 'running') return 'absent';
    const readiness = await this.driver.exec(
      task,
      ['node', '-e', PREVIEW_READY_SCRIPT, '--', String(config.previewPort)],
      {
        acceptFailure: true,
        timeoutMs: 2_000,
        maxOutputChars: 2_000,
        abortSignal: signal,
      }
    );
    if (readiness.exitCode === 0) return 'ready';
    if (readiness.exitCode === 3) return 'alive';
    if (readiness.exitCode === 2) return 'dead';
    throw new WorkRuntimeError(
      readiness.stderr.trim() || 'Could not inspect the Work preview.',
      503,
      'WORK_PREVIEW_INSPECT_FAILED'
    );
  }

  private async stopPreviewPrepared(
    task: WorkTaskRecord,
    signal?: AbortSignal
  ): Promise<void> {
    // Stop the container, not only the recorded process group. A custom
    // preview command can intentionally double-fork or create a new session;
    // Docker's container boundary guarantees those descendants are gone.
    // The named /workspace volume remains persistent across the restart.
    await this.stopContainerWithLock(task, signal);
  }

  private async ensureImage(task: WorkTaskRecord): Promise<void> {
    // Pulls are deduplicated per image, not globally: tasks under different
    // policies may run different images.
    const image = (await workPolicyService.resolve(task.policyId)).image;
    let preparation = this.imagePreparations.get(image);
    if (!preparation) {
      preparation = this.driver.ensureImage(image).catch(error => {
        this.imagePreparations.delete(image);
        throw error;
      });
      this.imagePreparations.set(image, preparation);
    }
    await preparation;
  }

  private async assertTaskIsActive(task: WorkTaskRecord): Promise<void> {
    this.assertAcceptingWork();
    if (this.retiringTasks.has(task.id)) {
      throw new WorkRuntimeError(
        'This Work task is being deleted.',
        409,
        'WORK_TASK_REMOVING'
      );
    }
    await this.assertTaskOwnerHasWorkAccess(task);
  }

  private async assertTaskOwnerHasWorkAccess(
    task: WorkTaskRecord
  ): Promise<void> {
    const access = await getWorkPersistence().findTaskOwnerAccess(
      task.id,
      task.userId
    );
    if (!access) {
      throw new WorkRuntimeError(
        'This Work task no longer exists.',
        409,
        'WORK_TASK_REMOVING'
      );
    }
    if (!(await userHasWorkAccess(access))) {
      throw new WorkRuntimeError(
        'Work access for this task was revoked.',
        403,
        'WORK_ACCESS_REVOKED'
      );
    }
  }

  private async assertTaskStillOwned(task: WorkTaskRecord): Promise<void> {
    const persisted = await getWorkPersistence().taskStillOwnsResources({
      taskId: task.id,
      userId: task.userId,
      volumeName: task.volumeName,
      containerName: task.containerName,
    });
    if (!persisted) {
      throw new WorkRuntimeError(
        'This Work task no longer exists or its managed resources changed.',
        409,
        'WORK_TASK_REMOVING'
      );
    }
  }

  private assertCurrentNetworkPolicy(task: WorkTaskRecord): void {
    const current = this.networkPolicies.get(task.id);
    if (current === undefined) {
      this.networkPolicies.set(task.id, task.networkEnabled);
      return;
    }
    if (current !== task.networkEnabled) {
      throw new WorkRuntimeError(
        'This Work task view is stale; reload it before accessing the workspace.',
        409,
        'WORK_STALE_TASK_POLICY'
      );
    }
  }

  private async withLifecycleLock<T>(
    taskId: string,
    operation: (
      assertHeld: () => Promise<void>,
      signal: AbortSignal
    ) => Promise<T>
  ): Promise<T> {
    const previous = this.lifecycleTails.get(taskId) || Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(async () => {
        let sharedLease: CoordinationLease | null = null;
        if (getPlatformRuntimeConfig().mode === 'team') {
          const deadline = Date.now() + 10_000;
          do {
            let abandoned = false;
            const pendingLease = getCoordinator().acquireLease(
              `work-task-lifecycle:${taskId}`,
              60_000
            );
            void pendingLease
              .then(lease => {
                if (!abandoned || !lease) return;
                void withCoordinationTimeout(
                  lease.release(),
                  SHARED_COORDINATION_OPERATION_TIMEOUT_MS
                ).catch(() => undefined);
              })
              .catch(() => undefined);
            try {
              sharedLease = await withCoordinationTimeout(
                pendingLease,
                SHARED_COORDINATION_OPERATION_TIMEOUT_MS
              );
            } catch (_error) {
              abandoned = true;
              throw new WorkRuntimeError(
                'Work task lifecycle coordination is unavailable.',
                503,
                'WORK_RUNTIME_LEASE_CONFLICT'
              );
            }
            if (!sharedLease) {
              await new Promise(resolve => setTimeout(resolve, 25));
            }
          } while (!sharedLease && Date.now() < deadline);
          if (!sharedLease) {
            throw new WorkRuntimeError(
              'This Work task has a lifecycle operation on another replica.',
              409,
              'WORK_RUNTIME_LEASE_CONFLICT'
            );
          }
        }
        let closed = false;
        let lost = false;
        const lossController = new AbortController();
        let renewalTimer: NodeJS.Timeout | undefined;
        const leaseLostError = (): WorkRuntimeError =>
          new WorkRuntimeError(
            'The shared Work task lifecycle lease was lost.',
            503,
            'WORK_RUNTIME_LEASE_CONFLICT'
          );
        const markLost = (): void => {
          if (lost) return;
          lost = true;
          lossController.abort(leaseLostError());
        };
        const assertHeld = async (): Promise<void> => {
          if (!sharedLease) return;
          if (closed || lost) throw leaseLostError();
          try {
            if (
              await withCoordinationTimeout(
                sharedLease.extend(60_000),
                SHARED_COORDINATION_OPERATION_TIMEOUT_MS
              )
            ) {
              return;
            }
          } catch {
            // Report expiry and coordination outages through one safe fence.
          }
          markLost();
          throw leaseLostError();
        };
        if (sharedLease) {
          const renew = async (): Promise<void> => {
            if (closed) return;
            try {
              if (
                !(await withCoordinationTimeout(
                  sharedLease?.extend(60_000) ?? Promise.resolve(false),
                  SHARED_COORDINATION_OPERATION_TIMEOUT_MS
                ))
              ) {
                markLost();
              }
            } catch {
              markLost();
            }
            if (!closed && !lost) renewalTimer = setTimeout(renew, 20_000);
          };
          renewalTimer = setTimeout(renew, 20_000);
          renewalTimer.unref?.();
        }
        try {
          await assertHeld();
          const result = await operation(assertHeld, lossController.signal);
          return result;
        } finally {
          closed = true;
          if (renewalTimer) clearTimeout(renewalTimer);
          if (sharedLease) {
            await withCoordinationTimeout(
              sharedLease.release(),
              SHARED_COORDINATION_OPERATION_TIMEOUT_MS
            ).catch(() => false);
          }
        }
      });
    const tail = current.then(
      () => undefined,
      () => undefined
    );
    this.lifecycleTails.set(taskId, tail);
    try {
      return await current;
    } finally {
      if (this.lifecycleTails.get(taskId) === tail) {
        this.lifecycleTails.delete(taskId);
      }
    }
  }

  private async withGitMutation<T>(
    task: WorkTaskRecord,
    operation: () => Promise<T>
  ): Promise<T> {
    this.assertGitMutationIdle(task.id);
    return this.withWorkspaceHelperContainer(task, async () => {
      this.assertGitMutationIdle(task.id);
      return operation();
    });
  }

  private assertGitMutationIdle(taskId: string): void {
    if (
      this.activeCommands.has(taskId) ||
      (this.terminalHolds.get(taskId) ?? 0) > 0 ||
      this.previewLeaseReleases.has(taskId)
    ) {
      throw new WorkRuntimeError(
        'Stop the active Work run, terminal, and preview before changing Git state.',
        409,
        'WORK_GIT_RUNTIME_BUSY'
      );
    }
  }

  private async loadGitStatus(task: WorkTaskRecord): Promise<WorkGitStatus> {
    if (!(await this.probeGitRepository(task))) {
      return {
        initialized: false,
        detached: false,
        ahead: 0,
        behind: 0,
        changes: [],
        branches: [],
        commits: [],
      };
    }
    const statusResult = await this.execGit(
      task,
      ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'],
      { maxOutputChars: 2_000_000 }
    );
    if (statusResult.truncated) {
      throw new WorkRuntimeError(
        'Git status is too large to display safely.',
        413,
        'WORK_GIT_STATUS_TOO_LARGE'
      );
    }
    const status = parseWorkGitStatus(statusResult.stdout);
    const branchesResult = await this.execGit(
      task,
      ['for-each-ref', '--format=%(refname:short)', 'refs/heads'],
      { maxOutputChars: 100_000 }
    );
    if (branchesResult.truncated) {
      throw new WorkRuntimeError(
        'The local branch list is too large to display safely.',
        413,
        'WORK_GIT_BRANCHES_TOO_LARGE'
      );
    }
    status.branches = parseWorkGitBranches(branchesResult.stdout);
    if (status.branch && !status.branches.includes(status.branch)) {
      status.branches.unshift(status.branch);
    }
    if (status.head) {
      const logResult = await this.execGit(
        task,
        ['log', '-n', '20', '--format=format:%H%x00%h%x00%an%x00%aI%x00%s%x00'],
        { maxOutputChars: 200_000 }
      );
      if (logResult.truncated) {
        throw new WorkRuntimeError(
          'Git history is too large to display safely.',
          413,
          'WORK_GIT_HISTORY_TOO_LARGE'
        );
      }
      status.commits = parseWorkGitLog(logResult.stdout);
    }
    return status;
  }

  private async probeGitRepository(task: WorkTaskRecord): Promise<boolean> {
    const result = await this.execGit(
      task,
      [
        'rev-parse',
        '--path-format=absolute',
        '--show-toplevel',
        '--git-dir',
        '--git-common-dir',
      ],
      { acceptFailure: true, maxOutputChars: 20_000 }
    );
    if (result.exitCode === 127) {
      throw new WorkRuntimeError(
        'Git is not installed in the configured Work runtime image.',
        503,
        'WORK_GIT_UNAVAILABLE'
      );
    }
    if (result.exitCode !== 0) return false;
    try {
      validateWorkGitRepositoryPaths(result.stdout);
    } catch (error) {
      throw new WorkRuntimeError(
        error instanceof Error
          ? error.message
          : 'Git repository layout is unsafe.',
        409,
        'WORK_GIT_UNSAFE_REPOSITORY'
      );
    }
    const [, gitDirectory, commonDirectory] = result.stdout
      .trimEnd()
      .split('\n');
    const realPathCheck = await this.exec(
      task,
      [
        'node',
        '-e',
        VALIDATE_GIT_REPOSITORY_PATHS_SCRIPT,
        '--',
        gitDirectory,
        commonDirectory,
      ],
      { acceptFailure: true, maxOutputChars: 10_000 }
    );
    if (realPathCheck.exitCode !== 0) {
      throw new WorkRuntimeError(
        'Git metadata must resolve inside /workspace.',
        409,
        'WORK_GIT_UNSAFE_REPOSITORY'
      );
    }
    return true;
  }

  private async requireGitRepository(task: WorkTaskRecord): Promise<void> {
    if (await this.probeGitRepository(task)) return;
    throw new WorkRuntimeError(
      'Initialize Git before changing repository state.',
      409,
      'WORK_GIT_NOT_INITIALIZED'
    );
  }

  private async assertNoExecutableGitFilters(
    task: WorkTaskRecord
  ): Promise<void> {
    const result = await this.execGit(
      task,
      [
        'config',
        '--includes',
        '--get-regexp',
        '^filter\\..*\\.(clean|smudge|process)$',
      ],
      { acceptFailure: true, maxOutputChars: 20_000 }
    );
    if (result.exitCode > 1) {
      this.throwGitFailure(result, 'Git configuration could not be inspected.');
    }
    if (result.stdout.trim()) {
      throw new WorkRuntimeError(
        'This repository configures executable Git filters. Remove them before using Git write actions in Work.',
        409,
        'WORK_GIT_EXECUTABLE_FILTER_BLOCKED'
      );
    }
  }

  private async requireValidGitBranch(
    task: WorkTaskRecord,
    branchName: string
  ): Promise<void> {
    const result = await this.execGit(
      task,
      ['check-ref-format', '--branch', branchName],
      { acceptFailure: true, maxOutputChars: 10_000 }
    );
    if (result.exitCode !== 0) {
      throw new WorkRuntimeError(
        'Branch name is invalid.',
        400,
        'WORK_GIT_INVALID_BRANCH'
      );
    }
  }

  private async requireGitSuccess(
    task: WorkTaskRecord,
    args: string[],
    fallbackMessage: string
  ): Promise<ProcessResult> {
    const result = await this.execGit(task, args, {
      acceptFailure: true,
      maxOutputChars: 100_000,
    });
    if (result.exitCode !== 0) this.throwGitFailure(result, fallbackMessage);
    return result;
  }

  private throwGitFailure(
    result: ProcessResult,
    fallbackMessage: string
  ): never {
    throw new WorkRuntimeError(
      result.stderr.trim() || result.stdout.trim() || fallbackMessage,
      409,
      'WORK_GIT_COMMAND_FAILED'
    );
  }

  private assertSuccessfulHelperCommand(
    result: ProcessResult,
    fallbackMessage: string,
    code: string
  ): void {
    if (result.exitCode === 0) return;
    throw new WorkRuntimeError(
      result.stderr.trim() || result.stdout.trim() || fallbackMessage,
      503,
      code
    );
  }

  private async execGit(
    task: WorkTaskRecord,
    args: string[],
    options: ProcessOptions = {}
  ): Promise<ProcessResult> {
    return this.exec(task, buildWorkGitCommand(args), options);
  }

  private async exec(
    task: WorkTaskRecord,
    command: string[],
    options: ProcessOptions = {}
  ): Promise<ProcessResult> {
    try {
      return await this.driver.exec(task, command, options);
    } finally {
      this.noteTaskActivity(task.id);
    }
  }
}

export interface StartupReconciliationPlan {
  /** Known tasks whose container is running unsupervised: stop them. */
  stop: WorkTaskRecord[];
  /** Managed containers whose task row no longer exists: remove them. */
  removeOrphans: DiscoveredWorkContainer[];
  /** Known-task containers already stopped: left exactly as they are. */
  atRest: number;
}

/**
 * Decide the minimal startup cleanup from the task inventory and the labeled
 * containers Docker actually has. A task without a container needs nothing —
 * which is the common case, and why recovery is no longer O(tasks) docker
 * calls. Ownership is decided by the task label alone (stamped at creation
 * together with the managed label): a managed container whose label matches
 * no inventory row is unowned, and stopping it through a task record would
 * be refused by the ownership assertion anyway.
 */
export function planStartupReconciliation(
  tasks: WorkTaskRecord[],
  containers: DiscoveredWorkContainer[]
): StartupReconciliationPlan {
  const byId = new Map(tasks.map(task => [task.id, task]));
  const stop = new Map<string, WorkTaskRecord>();
  const removeOrphans: DiscoveredWorkContainer[] = [];
  let atRest = 0;
  for (const container of containers) {
    const task = byId.get(container.taskId);
    if (!task) {
      removeOrphans.push(container);
    } else if (container.running) {
      stop.set(task.id, task);
    } else {
      atRest += 1;
    }
  }
  return { stop: [...stop.values()], removeOrphans, atRest };
}

export function validateWorkspacePath(input: string, allowRoot = true): string {
  const value = String(input || '.').trim();
  if (
    !value ||
    value.includes('\0') ||
    value.includes('\\') ||
    value.length > 1024 ||
    path.posix.isAbsolute(value) ||
    value.split('/').includes('..')
  ) {
    throw new WorkRuntimeError(
      'Path must be a relative path inside /workspace.',
      400,
      'WORK_INVALID_PATH'
    );
  }
  const normalized = path.posix.normalize(value);
  const canonical = normalized.replace(/^(?:\.\/)+/, '') || '.';
  if ((!allowRoot && canonical === '.') || canonical.startsWith('../')) {
    throw new WorkRuntimeError(
      'Path must identify an item inside /workspace.',
      400,
      'WORK_INVALID_PATH'
    );
  }
  return canonical;
}

function validateGitBranchInput(input: string): string {
  try {
    return validateWorkGitBranchName(input);
  } catch {
    throw new WorkRuntimeError(
      'Branch name is invalid.',
      400,
      'WORK_GIT_INVALID_BRANCH'
    );
  }
}

function validateGitIdentity(value: string, field: 'name' | 'email'): string {
  const maximum = field === 'name' ? 200 : 320;
  const hasControlCharacter = [...value].some(character => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
  if (!value || value.length > maximum || hasControlCharacter) {
    throw new WorkRuntimeError(
      `Git ${field} is invalid.`,
      400,
      'WORK_GIT_INVALID_IDENTITY'
    );
  }
  return value;
}

async function waitForAbortSignal<T>(
  promise: Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  if (!signal) return promise;
  const cancelled = () =>
    new WorkRuntimeError(
      'Work runtime preparation was cancelled.',
      409,
      'WORK_RUN_CANCELLED'
    );
  if (signal.aborted) throw cancelled();

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      reject(cancelled());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      value => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      error => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      }
    );
  });
}

function parseJsonOutput<T>(output: string): T {
  try {
    return JSON.parse(output.trim()) as T;
  } catch {
    throw new WorkRuntimeError(
      'Workspace helper returned an invalid response.',
      500,
      'WORK_HELPER_INVALID_RESPONSE'
    );
  }
}

function isSafePreviewWorkdir(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length > 4096 ||
    value.includes('\0')
  ) {
    return false;
  }
  return (
    path.posix.normalize(value) === value &&
    (value === '/workspace' || value.startsWith('/workspace/'))
  );
}

const MANAGED_COMMAND_SCRIPT = String.raw`
setsid /bin/bash -lc "$1" &
command_pid=$!
cleanup() {
  trap - EXIT INT TERM
  kill -TERM -- "-$command_pid" 2>/dev/null || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    kill -0 -- "-$command_pid" 2>/dev/null || return
    sleep 0.1
  done
  kill -KILL -- "-$command_pid" 2>/dev/null || true
}
trap cleanup EXIT INT TERM
wait "$command_pid"
status=$?
exit "$status"
`;

const COMMON_PATH_GUARD = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const root = '/workspace';
const rootReal = fs.realpathSync(root);
const inside = candidate => candidate === rootReal || candidate.startsWith(rootReal + path.sep);
const rel = process.argv[1] || '.';
const target = path.resolve(root, rel);
if (!inside(target)) throw new Error('Path escapes workspace');
`;

const VALIDATE_GIT_REPOSITORY_PATHS_SCRIPT = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const root = fs.realpathSync('/workspace');
const inside = candidate => candidate === root || candidate.startsWith(root + path.sep);
for (const candidate of process.argv.slice(1)) {
  let resolved;
  try {
    resolved = fs.realpathSync(candidate);
  } catch {
    process.exit(25);
  }
  if (!inside(resolved) || !fs.statSync(resolved).isDirectory()) process.exit(25);
}
`;

const PREVIEW_READY_SCRIPT = String.raw`
const fs = require('node:fs');
const net = require('node:net');
const port = Number(process.argv[1]);
let pid;
try {
  pid = Number(fs.readFileSync('/tmp/libre-work-preview.pid', 'utf8').trim());
  if (!Number.isInteger(pid) || pid <= 0) process.exit(2);
  process.kill(pid, 0);
} catch {
  process.exit(2);
}
let settled = false;
const socket = net.createConnection({host:'127.0.0.1', port});
const finish = code => {
  if (settled) return;
  settled = true;
  socket.destroy();
  process.exit(code);
};
socket.setTimeout(750, () => finish(3));
socket.once('connect', () => finish(0));
socket.once('error', () => finish(3));
`;

export const PREVIEW_TARGET_SCRIPT = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const root = fs.realpathSync(process.argv[1] || '/workspace');
const ignored = new Set([
  '.git',
  '.next',
  '.nuxt',
  '.output',
  '.svelte-kit',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'target'
]);
const candidates = [];
const queue = [{directory:root, depth:0}];
let cursor = 0;
while (cursor < queue.length && cursor < 500) {
  const {directory, depth} = queue[cursor];
  cursor += 1;
  let entries;
  try {
    entries = fs.readdirSync(directory, {withFileTypes:true})
      .sort((left, right) => left.name.localeCompare(right.name));
  } catch {
    continue;
  }
  const packageEntry = entries.find(
    entry => entry.isFile() && entry.name === 'package.json'
  );
  if (packageEntry) {
    try {
      const manifestPath = path.join(directory, packageEntry.name);
      if (fs.statSync(manifestPath).size > 1000000) {
        throw new Error('Manifest is too large');
      }
      const manifest = JSON.parse(
        fs.readFileSync(manifestPath, 'utf8')
      );
      if (
        manifest &&
        manifest.scripts &&
        typeof manifest.scripts.dev === 'string' &&
        manifest.scripts.dev.trim()
      ) {
        const dependencies = {
          ...(manifest.dependencies || {}),
          ...(manifest.devDependencies || {})
        };
        const runner =
          typeof dependencies.next === 'string' ||
          /(^|\\s)next(?:\\s|$)/.test(manifest.scripts.dev)
            ? 'next'
            : 'standard';
        candidates.push({
          kind:'npm',
          workdir:directory,
          depth,
          rank:0,
          runner
        });
      }
    } catch {}
  }
  if (entries.some(entry => entry.isFile() && entry.name === 'index.html')) {
    candidates.push({kind:'static', workdir:directory, depth, rank:1});
  }
  for (const entry of entries) {
    if (
      !entry.isDirectory() ||
      ignored.has(entry.name) ||
      entry.name.startsWith('.')
    ) {
      continue;
    }
    if (depth < 4 && queue.length < 1500) {
      queue.push({
        directory:path.join(directory, entry.name),
        depth:depth + 1
      });
    }
  }
}
if (candidates.length === 0) {
  process.stdout.write(JSON.stringify({kind:'none'}));
} else {
  const rootNpm = candidates.filter(
    candidate => candidate.depth === 0 && candidate.rank === 0
  );
  const rootStatic = candidates.filter(
    candidate => candidate.depth === 0 && candidate.rank === 1
  );
  const nestedNpm = candidates.filter(
    candidate => candidate.depth > 0 && candidate.rank === 0
  );
  const nestedStatic = candidates.filter(
    candidate => candidate.depth > 0 && candidate.rank === 1
  );
  const pool =
    rootNpm.length > 0
      ? rootNpm
      : rootStatic.length > 0
        ? rootStatic
        : nestedNpm.length > 0
          ? nestedNpm
          : nestedStatic;
  pool.sort(
    (left, right) =>
      left.depth - right.depth ||
      left.workdir.localeCompare(right.workdir)
  );
  const best = pool[0];
  const competing = pool.filter(candidate => candidate.depth === best.depth);
  if (competing.length > 1) {
    process.stdout.write(JSON.stringify({
      kind:'ambiguous',
      candidates:competing.map(candidate =>
        path.relative(root, candidate.workdir) || '.'
      )
    }));
  } else {
    process.stdout.write(JSON.stringify({
      kind:best.kind,
      workdir:best.workdir,
      ...(best.runner ? {runner:best.runner} : {})
    }));
  }
}
`;

export const STATIC_PREVIEW_SERVER_SCRIPT = String.raw`
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const root = fs.realpathSync(process.cwd());
const port = Number(process.argv[1]);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('Invalid preview port');
}
const inside = candidate =>
  candidate === root || candidate.startsWith(root + path.sep);
const mimeTypes = {
  '.avif':'image/avif',
  '.css':'text/css; charset=utf-8',
  '.gif':'image/gif',
  '.htm':'text/html; charset=utf-8',
  '.html':'text/html; charset=utf-8',
  '.ico':'image/x-icon',
  '.jpeg':'image/jpeg',
  '.jpg':'image/jpeg',
  '.js':'text/javascript; charset=utf-8',
  '.json':'application/json; charset=utf-8',
  '.mjs':'text/javascript; charset=utf-8',
  '.mp3':'audio/mpeg',
  '.mp4':'video/mp4',
  '.ogg':'audio/ogg',
  '.otf':'font/otf',
  '.png':'image/png',
  '.svg':'image/svg+xml',
  '.ttf':'font/ttf',
  '.txt':'text/plain; charset=utf-8',
  '.wasm':'application/wasm',
  '.webm':'video/webm',
  '.webp':'image/webp',
  '.woff':'font/woff',
  '.woff2':'font/woff2',
  '.xml':'application/xml; charset=utf-8'
};
const resolveFile = requestPath => {
  if (
    requestPath
      .split('/')
      .filter(Boolean)
      .some(segment => segment.startsWith('.'))
  ) {
    return;
  }
  const lexical = path.resolve(root, '.' + requestPath);
  if (!inside(lexical)) return;
  let real;
  let stat;
  try {
    real = fs.realpathSync(lexical);
    if (!inside(real)) return;
    stat = fs.statSync(real);
  } catch {
    return;
  }
  if (stat.isDirectory()) {
    try {
      real = fs.realpathSync(path.join(real, 'index.html'));
      if (!inside(real)) return;
      stat = fs.statSync(real);
    } catch {
      return;
    }
  }
  return stat.isFile() ? {file:real, stat} : undefined;
};
const sendText = (response, status, message) => {
  response.writeHead(status, {
    'Content-Type':'text/plain; charset=utf-8',
    'X-Content-Type-Options':'nosniff'
  });
  response.end(message);
};
const server = http.createServer((request, response) => {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.setHeader('Allow', 'GET, HEAD');
    sendText(response, 405, 'Method not allowed');
    return;
  }
  let pathname;
  try {
    pathname = decodeURIComponent(
      new URL(request.url || '/', 'http://127.0.0.1').pathname
    );
  } catch {
    sendText(response, 400, 'Invalid URL');
    return;
  }
  let resolved = resolveFile(pathname);
  if (
    !resolved &&
    request.headers.accept &&
    request.headers.accept.includes('text/html') &&
    !path.posix.extname(pathname)
  ) {
    resolved = resolveFile('/index.html');
  }
  if (!resolved) {
    sendText(response, 404, 'Not found');
    return;
  }
  response.writeHead(200, {
    'Content-Type':
      mimeTypes[path.extname(resolved.file).toLowerCase()] ||
      'application/octet-stream',
    'Content-Length':String(resolved.stat.size),
    'Cache-Control':'no-store',
    'X-Content-Type-Options':'nosniff'
  });
  if (request.method === 'HEAD') {
    response.end();
    return;
  }
  const stream = fs.createReadStream(resolved.file);
  stream.on('error', () => response.destroy());
  stream.pipe(response);
});
server.on('error', error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
server.listen(port, '0.0.0.0', () => {
  console.log('Static preview listening on 0.0.0.0:' + port);
});
`;

const LIST_FILES_SCRIPT = `${COMMON_PATH_GUARD}
const targetReal = fs.realpathSync(target);
if (!inside(targetReal)) throw new Error('Path escapes workspace');
const entries = fs.readdirSync(targetReal, {withFileTypes:true}).slice(0, 1000).map(entry => {
  const full = path.join(targetReal, entry.name);
  const stat = fs.lstatSync(full);
  const itemPath = rel === '.' ? entry.name : path.posix.join(rel, entry.name);
  return {
    name: entry.name,
    path: itemPath,
    type: entry.isDirectory() ? 'directory' : 'file',
    size: stat.size,
    updatedAt: stat.mtimeMs,
    modifiedAt: stat.mtimeMs
  };
});
console.log(JSON.stringify({entries}));
`;

const READ_FILE_SCRIPT = `${COMMON_PATH_GUARD}
const targetReal = fs.realpathSync(target);
if (!inside(targetReal)) throw new Error('Path escapes workspace');
const stat = fs.statSync(targetReal);
if (!stat.isFile()) throw new Error('Path is not a file');
if (stat.size > 2000000) throw new Error('File exceeds 2 MB limit');
let content;
try {
  content = new TextDecoder('utf-8', {fatal:true}).decode(fs.readFileSync(targetReal));
} catch {
  process.exit(24);
}
console.log(JSON.stringify({
  content,
  size: stat.size,
  updatedAt: stat.mtimeMs
}));
`;

const WRITE_FILE_SCRIPT = `${COMMON_PATH_GUARD}
const parent = path.dirname(target);
const parentParts = path.relative(root, parent).split(path.sep).filter(Boolean);
let parentReal = rootReal;
for (const part of parentParts) {
  const next = path.join(parentReal, part);
  if (!fs.existsSync(next)) fs.mkdirSync(next, {mode:0o755});
  if (fs.lstatSync(next).isSymbolicLink()) throw new Error('Refusing to traverse symlink');
  parentReal = fs.realpathSync(next);
  if (!inside(parentReal) || !fs.statSync(parentReal).isDirectory()) {
    throw new Error('Path escapes workspace');
  }
}
const safeTarget = path.join(parentReal, path.basename(target));
const targetExists = fs.existsSync(safeTarget);
if (targetExists && fs.lstatSync(safeTarget).isSymbolicLink()) throw new Error('Refusing to write through symlink');
const targetMode = targetExists ? fs.statSync(safeTarget).mode & 0o777 : 0o644;
const expectedText = process.argv[2] || '';
let expectedStat;
if (expectedText) {
  if (!targetExists) process.exit(23);
  const expected = Number(expectedText);
  expectedStat = fs.statSync(safeTarget);
  if (!Number.isFinite(expected) || expectedStat.mtimeMs !== expected) process.exit(23);
}
let content = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => content += chunk);
process.stdin.on('end', () => {
  const temporary = path.join(
    parentReal,
    '.' + path.basename(safeTarget) + '.libre-tmp-' + process.pid + '-' + Date.now()
  );
  const exitWithConflict = () => {
    try { fs.unlinkSync(temporary); } catch {}
    process.exit(23);
  };
  let descriptor;
  try {
    descriptor = fs.openSync(
      temporary,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
      targetMode
    );
    fs.writeFileSync(descriptor, content, {encoding:'utf8'});
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    if (expectedStat) {
      if (
        !fs.existsSync(safeTarget) ||
        fs.lstatSync(safeTarget).isSymbolicLink()
      ) {
        exitWithConflict();
      }
      const currentStat = fs.statSync(safeTarget);
      if (
        currentStat.dev !== expectedStat.dev ||
        currentStat.ino !== expectedStat.ino ||
        currentStat.size !== expectedStat.size ||
        currentStat.mtimeMs !== expectedStat.mtimeMs ||
        currentStat.ctimeMs !== expectedStat.ctimeMs
      ) {
        exitWithConflict();
      }
    }
    fs.renameSync(temporary, safeTarget);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try { fs.unlinkSync(temporary); } catch {}
  }
  const stat = fs.statSync(safeTarget);
  console.log(JSON.stringify({size:stat.size, updatedAt:stat.mtimeMs}));
});
`;

const DELETE_PATH_SCRIPT = `${COMMON_PATH_GUARD}
if (target === rootReal) throw new Error('Refusing to delete the workspace root');
const parentReal = fs.realpathSync(path.dirname(target));
if (!inside(parentReal)) throw new Error('Path escapes workspace');
const safeTarget = path.join(parentReal, path.basename(target));
let stat;
try { stat = fs.lstatSync(safeTarget); } catch { process.exit(21); }
const recursive = process.argv[2] === 'recursive';
let type;
if (stat.isSymbolicLink()) {
  type = 'symlink';
  fs.unlinkSync(safeTarget);
} else if (stat.isDirectory()) {
  if (!recursive) process.exit(22);
  type = 'directory';
  fs.rmSync(safeTarget, {recursive: true});
} else {
  type = 'file';
  fs.unlinkSync(safeTarget);
}
process.stdout.write(JSON.stringify({type}));
`;

const MOVE_PATH_SCRIPT = `${COMMON_PATH_GUARD}
const destRel = process.argv[2] || '';
if (!destRel) throw new Error('Destination path is required');
const destTarget = path.resolve(root, destRel);
if (!inside(destTarget)) throw new Error('Path escapes workspace');
if (target === rootReal || destTarget === rootReal) {
  throw new Error('Refusing to move the workspace root');
}
const sourceParentReal = fs.realpathSync(path.dirname(target));
if (!inside(sourceParentReal)) throw new Error('Path escapes workspace');
const safeSource = path.join(sourceParentReal, path.basename(target));
let sourceStat;
try { sourceStat = fs.lstatSync(safeSource); } catch { process.exit(21); }
const destParent = path.dirname(destTarget);
const destParts = path.relative(root, destParent).split(path.sep).filter(Boolean);
let destParentReal = rootReal;
for (const part of destParts) {
  const next = path.join(destParentReal, part);
  if (!fs.existsSync(next)) fs.mkdirSync(next, {mode:0o755});
  if (fs.lstatSync(next).isSymbolicLink()) throw new Error('Refusing to traverse symlink');
  destParentReal = fs.realpathSync(next);
  if (!inside(destParentReal) || !fs.statSync(destParentReal).isDirectory()) {
    throw new Error('Path escapes workspace');
  }
}
const safeDest = path.join(destParentReal, path.basename(destTarget));
let destTaken = false;
try { fs.lstatSync(safeDest); destTaken = true; } catch {}
if (destTaken) process.exit(24);
if (safeSource === safeDest) throw new Error('Source and destination are the same path');
if (sourceStat.isDirectory() && safeDest.startsWith(safeSource + path.sep)) {
  throw new Error('Cannot move a directory inside itself');
}
fs.renameSync(safeSource, safeDest);
process.stdout.write(JSON.stringify({moved: true}));
`;

const SEARCH_FILES_SCRIPT = `${COMMON_PATH_GUARD}
const query = String(process.argv[2] || '').toLowerCase();
const targetReal = fs.realpathSync(target);
if (!inside(targetReal)) throw new Error('Path escapes workspace');
const ignored = new Set(['node_modules','.git','dist','build','.next']);
const results = [];
const walk = directory => {
  if (results.length >= 100) return;
  for (const entry of fs.readdirSync(directory, {withFileTypes:true})) {
    if (results.length >= 100 || ignored.has(entry.name)) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) { walk(full); continue; }
    if (!entry.isFile()) continue;
    const stat = fs.statSync(full);
    if (stat.size > 1000000) continue;
    let text;
    try { text = fs.readFileSync(full, 'utf8'); } catch { continue; }
    const lines = text.split(/\\r?\\n/);
    lines.forEach((line, index) => {
      if (results.length < 100 && line.toLowerCase().includes(query)) {
        results.push(path.relative(rootReal, full) + ':' + (index + 1) + ':' + line.slice(0, 500));
      }
    });
  }
};
walk(targetReal);
process.stdout.write(results.join('\\n'));
`;

/**
 * Shared observation core for the Work Computer scripts: cursor, active
 * window, display geometry, and a full-screen PNG captured with ImageMagick
 * from the session's Xvfb display.
 */
const COMPUTER_OBSERVE_COMMON = String.raw`
const {execFileSync} = require('node:child_process');
process.env.DISPLAY = ':' + (process.env.LIBRE_COMPUTER_DISPLAY || '1');
const out = (cmd, args, timeout = 10000) =>
  execFileSync(cmd, args, {encoding: 'utf8', timeout});
const observe = () => {
  const cursor = {x: 0, y: 0};
  for (const line of out('xdotool', ['getmouselocation', '--shell']).split('\n')) {
    const [key, value] = line.split('=');
    if (key === 'X') cursor.x = Number(value);
    if (key === 'Y') cursor.y = Number(value);
  }
  let windowName = '';
  try {
    windowName = out('xdotool', ['getactivewindow', 'getwindowname']).trim();
  } catch {}
  const geometry = out('xdotool', ['getdisplaygeometry']).trim().split(' ');
  const png = execFileSync('import', ['-window', 'root', '-silent', 'png:-'], {
    timeout: 20000,
    maxBuffer: 32 * 1024 * 1024,
  });
  return {
    width: Number(geometry[0]),
    height: Number(geometry[1]),
    cursorX: cursor.x,
    cursorY: cursor.y,
    window: windowName.slice(0, 300),
    image: png.toString('base64'),
  };
};
`;

const COMPUTER_OBSERVE_SCRIPT = String.raw`${COMPUTER_OBSERVE_COMMON}
process.stdout.write(JSON.stringify(observe()));
`;

/**
 * Interpreter for a backend-validated computer_act batch. Input is trusted
 * JSON (validateWorkComputerActions runs first); every gesture goes through
 * xdotool argv — no shell interpolation anywhere.
 */
const COMPUTER_ACT_SCRIPT = String.raw`${COMPUTER_OBSERVE_COMMON}
const actions = JSON.parse(process.argv[1] || '[]');
const xdotool = args => out('xdotool', args, 120000);
const wait = ms =>
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const moveTo = action => {
  if (action.x !== undefined) {
    xdotool(['mousemove', '--sync', String(action.x), String(action.y)]);
  }
};
for (const action of actions) {
  if (action.type === 'move') {
    xdotool(['mousemove', '--sync', String(action.x), String(action.y)]);
  } else if (action.type === 'click') {
    moveTo(action);
    xdotool(['click', '1']);
  } else if (action.type === 'double_click') {
    moveTo(action);
    xdotool(['click', '--repeat', '2', '--delay', '150', '1']);
  } else if (action.type === 'right_click') {
    moveTo(action);
    xdotool(['click', '3']);
  } else if (action.type === 'type') {
    xdotool(['type', '--clearmodifiers', '--delay', '15', '--', action.text]);
  } else if (action.type === 'key') {
    xdotool(['key', '--clearmodifiers', '--', action.keys]);
  } else if (action.type === 'scroll') {
    moveTo(action);
    xdotool([
      'click',
      '--repeat',
      String(action.amount),
      '--delay',
      '50',
      action.direction === 'up' ? '4' : '5',
    ]);
  } else if (action.type === 'wait') {
    wait(action.ms);
  }
}
wait(400);
process.stdout.write(JSON.stringify(observe()));
`;

/**
 * Select the runtime backend for this deployment. Docker remains the
 * default; WORK_RUNTIME_BACKEND=kubernetes runs sandboxes as Pods in a
 * namespace instead (no Docker daemon or socket anywhere). An unknown value
 * fails startup loudly rather than silently running the wrong backend.
 */
export function createWorkRuntimeDriver(
  backend = process.env.WORK_RUNTIME_BACKEND
): WorkRuntimeDriver {
  const selected = backend?.trim() || 'docker';
  if (selected === 'docker') return new DockerWorkRuntimeDriver();
  if (selected === 'kubernetes') return new KubernetesWorkRuntimeDriver();
  throw new WorkRuntimeError(
    `Unknown WORK_RUNTIME_BACKEND "${selected}". Use "docker" or "kubernetes".`,
    503,
    'WORK_RUNTIME_BACKEND_INVALID'
  );
}

export { KubernetesWorkRuntimeDriver } from './workKubernetesDriver.js';

export const workRuntimeService = new WorkRuntimeService(
  createWorkRuntimeDriver()
);
export default workRuntimeService;
