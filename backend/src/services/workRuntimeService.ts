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
import { getDatabase } from '../db.js';
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
import workPreviewProxyService from './workPreviewProxyService.js';
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

interface PreviewStateHooks {
  onStarting?: () => void;
  onRunning?: (url: string) => void;
  onFailed?: () => void;
  onStopped?: () => void;
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
}

export class WorkRuntimeService {
  readonly driver: WorkRuntimeDriver;
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
  private lastDockerUnavailableReason: string | null = null;
  private runtimeLeases = new Map<string, RuntimeLease>();
  private previewLeaseReleases = new Map<string, () => void>();
  private terminalHolds = new Map<string, number>();
  private recoveryTasks = new Map<string, WorkTaskRecord>();
  private recoveryOrphans = new Map<string, DiscoveredWorkContainer>();
  private recoveryInventory?: WorkTaskRecord[];
  // Sweeps left for the empty-inventory case before giving up on a daemon
  // that never appears (30 × 10s: covers a socket proxy starting late
  // without probing a Docker-less deployment forever).
  private emptyInventorySweepsLeft = 30;
  private recoveryTimer?: NodeJS.Timeout;
  private shuttingDown = false;

  constructor(driver: WorkRuntimeDriver = new DockerWorkRuntimeDriver()) {
    this.driver = driver;
    // Authorized preview traffic keeps its task's idle clock fresh.
    workPreviewProxyService.onPreviewActivity(taskId =>
      this.noteTaskActivity(taskId)
    );
    this.scheduleIdleSweep();
  }

  // Last observed activity per task, feeding the idle sweep: a finished
  // command, a terminal session ending, or a preview fetch. In-memory only —
  // after a restart the clock restarts from the first sighting.
  private taskActivity = new Map<string, number>();
  private idleTimer?: NodeJS.Timeout;

  noteTaskActivity(taskId: string): void {
    this.taskActivity.set(taskId, Date.now());
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

  async isDockerAvailable(): Promise<boolean> {
    try {
      await this.driver.probe();
      this.lastDockerUnavailableReason = null;
      return true;
    } catch (error) {
      this.lastDockerUnavailableReason =
        error instanceof Error ? error.message : String(error);
      return false;
    }
  }

  /**
   * Why the last availability probe failed. "Docker is not available" cannot be
   * acted on: a containerized deployment fails for a missing CLI, an unreadable
   * socket, or a stopped daemon, and each needs a different change.
   */
  get dockerUnavailableReason(): string | null {
    return this.lastDockerUnavailableReason;
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
    tasks: WorkTaskRecord[]
  ): Promise<{ stopped: number; failed: number }> {
    this.recoveryInventory = tasks;
    const result = await this.sweepRecoveryTasks();
    this.scheduleRecoverySweep();
    return result;
  }

  private acquireRuntimeLease(task: WorkTaskRecord): () => void {
    this.assertTaskIsActive(task);
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
      this.runtimeLeases.set(task.id, { userId: task.userId, holders: 1 });
    }

    let released = false;
    return () => {
      if (released) return;
      released = true;
      const lease = this.runtimeLeases.get(task.id);
      if (!lease || lease.userId !== task.userId) return;
      lease.holders -= 1;
      if (lease.holders <= 0) {
        this.runtimeLeases.delete(task.id);
      }
    };
  }

  private assertRuntimeLease(task: WorkTaskRecord): void {
    const lease = this.runtimeLeases.get(task.id);
    if (!lease || lease.userId !== task.userId || lease.holders < 1) {
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
    const releaseLease = this.acquireRuntimeLease(task);
    this.assertTaskIsActive(task);
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
      this.assertTaskIsActive(task);
      await this.withLifecycleLock(task.id, async () => {
        this.assertTaskIsActive(task);
        await this.prepareWithLock(task);
        this.assertTaskIsActive(task);
      });
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
    task: WorkTaskRecord
  ): Promise<() => Promise<void>> {
    if (this.activeCommands.has(task.id)) {
      throw new WorkRuntimeError(
        'A Work command is running in this container. Wait for it to finish, then reconnect the terminal.',
        409,
        'WORK_TERMINAL_COMMAND_ACTIVE'
      );
    }
    const releaseLease = await this.prepare(task);
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
          await this.withLifecycleLock(task.id, () =>
            this.stopContainerIfIdleWithLock(task)
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

  private async sweepRecoveryTasks(): Promise<{
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
    if (this.shuttingDown || !(await this.isDockerAvailable())) {
      if (this.recoveryInventory?.length === 0) {
        // No tasks to supervise, so nothing fail-closes — but leftover
        // containers may still exist (a restored database, a daemon or
        // socket proxy that comes up after the backend). Keep retrying the
        // reconciliation quietly for a bounded window, then give up so a
        // deployment without Docker is not probed forever.
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
      Promise.allSettled(tasks.map(task => this.stopContainer(task))),
      Promise.allSettled(
        orphans.map(orphan => this.driver.removeOrphan(orphan.name))
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
    if (this.shuttingDown || this.recoveryPending) {
      return { stopped: 0 };
    }
    // Idle-stop can come from the global knob or from any named policy.
    if (
      config.idleTimeoutMs <= 0 &&
      !workPolicyService.anyIdleTimeoutConfigured()
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
      workTaskService.listAllTaskRecords().map(task => [task.id, task])
    );
    let stopped = 0;
    for (const entry of discovered) {
      if (!entry.running) continue;
      const task = records.get(entry.taskId);
      // Containers without a task row are startup reconciliation's business.
      if (!task) continue;
      const busy =
        this.activeCommands.has(task.id) ||
        (this.terminalHolds.get(task.id) ?? 0) > 0 ||
        (this.runtimeLeases.has(task.id) &&
          !this.previewLeaseReleases.has(task.id));
      const lastActivity = this.taskActivity.get(task.id);
      if (busy || lastActivity === undefined) {
        this.noteTaskActivity(task.id);
        continue;
      }
      const idleAfterMs = workPolicyService.resolve(
        task.policyId
      ).idleTimeoutMs;
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

  private markPreviewStopped(taskId: string): void {
    try {
      getDatabase()
        .prepare(
          `UPDATE work_tasks
           SET preview_status = 'stopped', preview_url = NULL, updated_at = ?
           WHERE id = ?`
        )
        .run(Date.now(), taskId);
    } catch (error) {
      logger.warn(
        `Could not persist stopped preview state for Work task ${taskId}:`,
        error
      );
    }
  }

  private async prepareWithLock(task: WorkTaskRecord): Promise<void> {
    this.assertRuntimeLease(task);
    this.assertCurrentNetworkPolicy(task);
    this.assertTaskIsActive(task);
    await this.driver.ensureWorkspace(task);
    this.assertTaskIsActive(task);
    this.assertRuntimeLease(task);
    await this.driver.ensureRuntime(task);
    if (this.shuttingDown) {
      await this.stopContainerWithLock(task);
      this.assertTaskIsActive(task);
    }
  }

  async recreateContainer(task: WorkTaskRecord): Promise<void> {
    const releaseLease = this.acquireRuntimeLease(task);
    try {
      await this.ensureImage(task);
      this.assertTaskIsActive(task);
      await this.withLifecycleLock(task.id, async () => {
        this.assertTaskIsActive(task);
        await this.recreateContainerWithLock(task);
        await this.stopContainerWithLock(task);
        this.networkPolicies.set(task.id, task.networkEnabled);
      });
      this.releasePreviewLease(task.id);
      this.markPreviewStopped(task.id);
    } finally {
      releaseLease();
    }
  }

  async changeNetworkPolicy<T>(
    before: WorkTaskRecord,
    desired: WorkTaskRecord,
    commit: () => T
  ): Promise<T> {
    this.assertTaskIsActive(before);
    if (desired.networkEnabled === before.networkEnabled) {
      return this.withLifecycleLock(before.id, async () => {
        this.assertTaskIsActive(before);
        this.assertCurrentNetworkPolicy(before);
        const result = commit();
        this.networkPolicies.set(desired.id, desired.networkEnabled);
        return result;
      });
    }

    const releaseLease = this.acquireRuntimeLease(before);
    let previewStopped = false;
    try {
      await this.ensureImage(before);
      this.assertTaskIsActive(before);
      return await this.withLifecycleLock(before.id, async () => {
        this.assertTaskIsActive(before);
        this.assertCurrentNetworkPolicy(before);
        try {
          await this.recreateContainerWithLock(desired);
          await this.stopContainerWithLock(desired);
          previewStopped = true;
          const result = commit();
          this.networkPolicies.set(desired.id, desired.networkEnabled);
          return result;
        } catch (error) {
          try {
            await this.recreateContainerWithLock(before);
            await this.stopContainerWithLock(before);
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
      });
    } finally {
      if (previewStopped) {
        this.releasePreviewLease(before.id);
        this.markPreviewStopped(before.id);
      }
      releaseLease();
    }
  }

  private async recreateContainerWithLock(task: WorkTaskRecord): Promise<void> {
    this.assertRuntimeLease(task);
    this.assertTaskIsActive(task);
    await this.driver.ensureWorkspace(task);
    this.assertTaskIsActive(task);
    await this.driver.removeRuntime(task);
    await this.driver.ensureRuntime(task);
    if (this.shuttingDown) {
      await this.stopContainerWithLock(task);
      this.assertTaskIsActive(task);
    }
  }

  async stopContainer(task: WorkTaskRecord): Promise<void> {
    await this.withLifecycleLock(task.id, () =>
      this.stopContainerWithLock(task)
    );
    this.releasePreviewLease(task.id);
    this.markPreviewStopped(task.id);
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
    this.markPreviewStopped(task.id);
    this.completeRecoveryTask(task.id);
  }

  private async stopContainerWithLock(task: WorkTaskRecord): Promise<void> {
    try {
      await this.driver.stopRuntime(task);
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
      this.assertTaskStillOwned(task);
    } else {
      this.assertTaskOwnerHasWorkAccess(task);
    }
    this.retiringTasks.add(task.id);
    try {
      await this.withLifecycleLock(task.id, () =>
        this.driver.removeTaskResources(task)
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
    this.runtimeLeases.delete(taskId);
    this.taskActivity.delete(taskId);
    workPreviewProxyService.clearPreviewUpstream(taskId);
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
    const releaseLease = this.acquireRuntimeLease(task);
    try {
      await this.ensureImage(task);
      this.assertTaskIsActive(task);
      return await this.withLifecycleLock(task.id, async () => {
        this.assertTaskIsActive(task);
        await this.prepareWithLock(task);
        this.assertTaskIsActive(task);
        try {
          return await operation();
        } finally {
          await this.stopContainerIfIdleWithLock(task);
        }
      });
    } finally {
      releaseLease();
    }
  }

  private async stopContainerIfIdleWithLock(
    task: WorkTaskRecord
  ): Promise<void> {
    if (this.activeCommands.has(task.id)) return;
    // An attached terminal session owns the running container exactly like a
    // ready preview does.
    if ((this.terminalHolds.get(task.id) ?? 0) > 0) return;
    try {
      if (
        (await this.previewProcessCheckWithLock(task)) === 'ready' &&
        this.previewLeaseReleases.has(task.id)
      ) {
        return;
      }
    } catch (error) {
      logger.warn(
        `Could not verify preview state before idling Work container ${task.containerName}; stopping it:`,
        error
      );
    }
    await this.stopContainerWithLock(task);
    this.releasePreviewLease(task.id);
    this.markPreviewStopped(task.id);
    this.completeRecoveryTask(task.id);
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
    const releaseLease = this.acquireRuntimeLease(task);
    let commandRegistered = false;
    try {
      await this.ensureImage(task);
      this.assertTaskIsActive(task);
      await this.withLifecycleLock(task.id, async () => {
        this.assertTaskIsActive(task);
        try {
          await this.prepareWithLock(task);
          this.assertTaskIsActive(task);
          if (this.activeCommands.has(task.id)) {
            throw new WorkRuntimeError(
              'This Work task already has an active command.',
              409,
              'WORK_COMMAND_ACTIVE'
            );
          }
          const previewState = await this.previewProcessCheckWithLock(task);
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
          await this.stopContainerIfIdleWithLock(task);
          throw error;
        }
      });
      return await this.exec(
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
        }
      );
    } finally {
      try {
        if (commandRegistered) {
          // This also kills intentionally detached descendants that escaped
          // the managed process group. The named volume remains durable.
          await this.stopContainer(task);
        }
      } finally {
        this.activeCommands.delete(task.id);
        releaseLease();
      }
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
    const releaseLease = this.acquireRuntimeLease(task);
    let leaseRetained = false;
    try {
      await this.ensureImage(task);
      this.assertTaskIsActive(task);
      const url = await this.withLifecycleLock(task.id, async () => {
        this.assertTaskIsActive(task);
        this.assertCurrentNetworkPolicy(task);
        if (this.activeCommands.has(task.id)) {
          throw new WorkRuntimeError(
            'Wait for the active command to finish before starting a preview.',
            409,
            'WORK_PREVIEW_COMMAND_ACTIVE'
          );
        }
        hooks.onStarting?.();
        try {
          await this.prepareWithLock(task);
          this.assertTaskIsActive(task);
          const previewLaunch: PreviewLaunch = previewCommand
            ? {
                kind: 'shell',
                workdir: '/workspace',
                command: previewCommand,
              }
            : await this.detectPreviewLaunch(task);
          const previewUrl = await this.startPreviewPrepared(
            task,
            previewLaunch
          );
          this.assertTaskIsActive(task);
          hooks.onRunning?.(previewUrl);
          return previewUrl;
        } catch (error) {
          hooks.onFailed?.();
          this.releasePreviewLease(task.id);
          throw error;
        }
      });
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
    task: WorkTaskRecord
  ): Promise<PreviewLaunch> {
    try {
      const result = await this.driver.exec(
        task,
        ['node', '-e', PREVIEW_TARGET_SCRIPT, '--', '/workspace'],
        {
          acceptFailure: true,
          timeoutMs: 5_000,
          maxOutputChars: 10_000,
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
        await this.stopPreviewPrepared(task);
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
    previewLaunch: PreviewLaunch
  ): Promise<string> {
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
          { acceptFailure: true, timeoutMs: 2_000, maxOutputChars: 2_000 }
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
        await new Promise(resolve =>
          setTimeout(resolve, PREVIEW_POLL_INTERVAL_MS)
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
      return workPreviewProxyService.createPreviewUrl(
        task.id,
        endpoint.port,
        endpoint.host
      );
    } catch (error) {
      try {
        await this.stopPreviewPrepared(task);
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
      await this.withLifecycleLock(task.id, async () => {
        this.assertCurrentNetworkPolicy(task);
        if (this.activeCommands.has(task.id)) {
          throw new WorkRuntimeError(
            'Wait for the active command to finish before stopping a preview.',
            409,
            'WORK_PREVIEW_COMMAND_ACTIVE'
          );
        }
        await this.stopPreviewPrepared(task);
        stopped = true;
        hooks.onStopped?.();
      });
    } finally {
      if (stopped) {
        this.releasePreviewLease(task.id);
      }
    }
  }

  async isPreviewRunning(task: WorkTaskRecord): Promise<boolean> {
    return this.withLifecycleLock(task.id, async () => {
      this.assertCurrentNetworkPolicy(task);
      // An ordinary command owns this running container and will stop it when
      // it finishes. Preview reconciliation must not interrupt that command.
      if (this.activeCommands.has(task.id)) return false;
      const state = await this.previewProcessCheckWithLock(task);
      if (state === 'ready' && this.previewLeaseReleases.has(task.id)) {
        return true;
      }
      if (state === 'dead' || state === 'alive') {
        await this.stopPreviewPrepared(task);
      }
      if (state === 'ready') {
        await this.stopPreviewPrepared(task);
      }
      this.releasePreviewLease(task.id);
      return false;
    });
  }

  private async previewProcessCheckWithLock(
    task: WorkTaskRecord
  ): Promise<'ready' | 'alive' | 'dead' | 'absent'> {
    if ((await this.driver.runtimeState(task)) !== 'running') return 'absent';
    const readiness = await this.driver.exec(
      task,
      ['node', '-e', PREVIEW_READY_SCRIPT, '--', String(config.previewPort)],
      { acceptFailure: true, timeoutMs: 2_000, maxOutputChars: 2_000 }
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

  private async stopPreviewPrepared(task: WorkTaskRecord): Promise<void> {
    workPreviewProxyService.clearPreviewUpstream(task.id);
    // Stop the container, not only the recorded process group. A custom
    // preview command can intentionally double-fork or create a new session;
    // Docker's container boundary guarantees those descendants are gone.
    // The named /workspace volume remains persistent across the restart.
    await this.stopContainerWithLock(task);
  }

  private async ensureImage(task: WorkTaskRecord): Promise<void> {
    // Pulls are deduplicated per image, not globally: tasks under different
    // policies may run different images.
    const image = workPolicyService.resolve(task.policyId).image;
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

  private assertTaskIsActive(task: WorkTaskRecord): void {
    this.assertAcceptingWork();
    if (this.retiringTasks.has(task.id)) {
      throw new WorkRuntimeError(
        'This Work task is being deleted.',
        409,
        'WORK_TASK_REMOVING'
      );
    }
    this.assertTaskOwnerHasWorkAccess(task);
  }

  private assertTaskOwnerHasWorkAccess(task: WorkTaskRecord): void {
    const access = getDatabase()
      .prepare(
        `SELECT users.role AS role, users.account_status AS status
         FROM work_tasks
         JOIN users ON users.id = work_tasks.user_id
         WHERE work_tasks.id = ? AND work_tasks.user_id = ?`
      )
      .get(task.id, task.userId) as
      { role: string; status: string } | undefined;
    if (!access) {
      throw new WorkRuntimeError(
        'This Work task no longer exists.',
        409,
        'WORK_TASK_REMOVING'
      );
    }
    if (!userHasWorkAccess(access)) {
      throw new WorkRuntimeError(
        'Work access for this task was revoked.',
        403,
        'WORK_ACCESS_REVOKED'
      );
    }
  }

  private assertTaskStillOwned(task: WorkTaskRecord): void {
    const persisted = getDatabase()
      .prepare(
        `SELECT 1
         FROM work_tasks
         WHERE id = ? AND user_id = ?
           AND volume_name = ? AND container_name = ?`
      )
      .get(task.id, task.userId, task.volumeName, task.containerName);
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
    operation: () => Promise<T>
  ): Promise<T> {
    const previous = this.lifecycleTails.get(taskId) || Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
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
