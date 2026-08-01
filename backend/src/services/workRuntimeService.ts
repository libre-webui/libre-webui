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

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { getDatabase } from '../db.js';
import { WorkFileEntry, WorkTaskRecord } from '../types/work.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('services:work-runtime');
const activeDockerProcesses = new Set<ReturnType<typeof spawn>>();

export const WORK_RUNTIME_DEFAULTS = {
  image:
    'node:22.22-bookworm@sha256:2d178f2785b96dfbf62a416ca2e40f50e30150b4ff3320d706f0d96e90600eb3',
  dockerCommand: 'docker',
  commandTimeoutMs: 120_000,
  maxOutputChars: 50_000,
  maxAgentRounds: 48,
  memoryLimit: '2g',
  cpuLimit: '2',
  pidsLimit: 256,
  previewPort: 4173,
  previewBind: '127.0.0.1',
  networkName: 'libre-webui-work',
} as const;

// Two runtimes per administrator so a second task does not have to wait for
// the first, three per instance to bound the worst case at three containers'
// resource caps. Both remain tunable through WORK_MAX_ACTIVE_RUNTIMES_*.
export const WORK_RUNTIME_ADMISSION_DEFAULTS = {
  maxActiveRuntimesGlobal: 3,
  maxActiveRuntimesPerUser: 2,
} as const;

const config = {
  image: process.env.WORK_RUNTIME_IMAGE || WORK_RUNTIME_DEFAULTS.image,
  dockerCommand:
    process.env.WORK_DOCKER_COMMAND || WORK_RUNTIME_DEFAULTS.dockerCommand,
  commandTimeoutMs: positiveInteger(
    process.env.WORK_COMMAND_TIMEOUT_MS,
    WORK_RUNTIME_DEFAULTS.commandTimeoutMs
  ),
  maxOutputChars: positiveInteger(
    process.env.WORK_MAX_OUTPUT_CHARS,
    WORK_RUNTIME_DEFAULTS.maxOutputChars
  ),
  maxAgentRounds: positiveInteger(
    process.env.WORK_MAX_AGENT_ROUNDS,
    WORK_RUNTIME_DEFAULTS.maxAgentRounds
  ),
  memoryLimit:
    process.env.WORK_MEMORY_LIMIT || WORK_RUNTIME_DEFAULTS.memoryLimit,
  cpuLimit: process.env.WORK_CPU_LIMIT || WORK_RUNTIME_DEFAULTS.cpuLimit,
  pidsLimit: positiveInteger(
    process.env.WORK_PIDS_LIMIT,
    WORK_RUNTIME_DEFAULTS.pidsLimit
  ),
  previewPort: positiveInteger(
    process.env.WORK_PREVIEW_PORT,
    WORK_RUNTIME_DEFAULTS.previewPort
  ),
  // Interface the daemon publishes a task preview on. Loopback keeps a preview
  // private to the Docker host, which is correct when the browser runs there.
  previewBind:
    process.env.WORK_PREVIEW_BIND || WORK_RUNTIME_DEFAULTS.previewBind,
  // Host advertised in the preview URL. It differs from the bind address when
  // the browser reaches the Docker host by another name.
  previewHost:
    process.env.WORK_PREVIEW_HOST ||
    process.env.WORK_PREVIEW_BIND ||
    WORK_RUNTIME_DEFAULTS.previewBind,
  maxActiveRuntimesGlobal: positiveInteger(
    process.env.WORK_MAX_ACTIVE_RUNTIMES_GLOBAL,
    WORK_RUNTIME_ADMISSION_DEFAULTS.maxActiveRuntimesGlobal
  ),
  maxActiveRuntimesPerUser: positiveInteger(
    process.env.WORK_MAX_ACTIVE_RUNTIMES_PER_USER,
    WORK_RUNTIME_ADMISSION_DEFAULTS.maxActiveRuntimesPerUser
  ),
  // Dedicated bridge network for networked Work tasks. It is created with
  // inter-container communication disabled, so a sandbox cannot reach other
  // Work sandboxes or the deployment's own containers on the default bridge.
  networkName:
    process.env.WORK_NETWORK_NAME || WORK_RUNTIME_DEFAULTS.networkName,
  // Optional resolvers forced onto every networked sandbox. Pointing this at
  // a filtering resolver is the supported egress-policy hook.
  dnsServers: parseDnsServers(process.env.WORK_RUNTIME_DNS),
};
const PREVIEW_READY_TIMEOUT_MS = 15_000;
const PREVIEW_POLL_INTERVAL_MS = 250;
const runtimePolicyFingerprint = createHash('sha256')
  .update(
    JSON.stringify({
      version: 2,
      memoryLimit: config.memoryLimit,
      cpuLimit: config.cpuLimit,
      pidsLimit: config.pidsLimit,
      previewPort: config.previewPort,
      previewBind: config.previewBind,
      networkName: config.networkName,
      dnsServers: config.dnsServers,
      memorySwapPinned: true,
    })
  )
  .digest('hex');

export interface WorkCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

interface ProcessOptions {
  timeoutMs?: number;
  maxOutputChars?: number;
  input?: string;
  acceptFailure?: boolean;
}

interface ProcessResult extends WorkCommandResult {
  signal?: NodeJS.Signals;
}

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

export class WorkRuntimeError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(
    message: string,
    status = 503,
    code = 'WORK_RUNTIME_UNAVAILABLE'
  ) {
    super(message);
    this.name = 'WorkRuntimeError';
    this.status = status;
    this.code = code;
  }
}

export class WorkRuntimeService {
  readonly image = config.image;
  readonly previewPort = config.previewPort;
  readonly limits = {
    maxRounds: config.maxAgentRounds,
    commandTimeoutMs: config.commandTimeoutMs,
    maxOutputChars: config.maxOutputChars,
    maxActiveRuntimesGlobal: config.maxActiveRuntimesGlobal,
    maxActiveRuntimesPerUser: config.maxActiveRuntimesPerUser,
  };
  private imagePreparation?: Promise<void>;
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
  private recoveryTimer?: NodeJS.Timeout;
  private shuttingDown = false;

  get recoveryPending(): boolean {
    return this.recoveryTasks.size > 0;
  }

  get recoveryPendingCount(): number {
    return this.recoveryTasks.size;
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
      await this.docker(['info', '--format', '{{.ServerVersion}}'], {
        timeoutMs: 5_000,
      });
      this.lastDockerUnavailableReason = null;
      return true;
    } catch (error) {
      this.lastDockerUnavailableReason = describeDockerUnavailable(
        error,
        config.dockerCommand
      );
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
    for (const task of tasks) {
      this.recoveryTasks.set(task.id, task);
    }
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
      await waitForAbortSignal(this.ensureImage(), signal);
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
    for (const child of activeDockerProcesses) {
      child.kill('SIGKILL');
    }
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
    if (this.recoveryTasks.size === 0) {
      return { stopped: 0, failed: 0 };
    }
    if (this.shuttingDown || !(await this.isDockerAvailable())) {
      return { stopped: 0, failed: this.recoveryTasks.size };
    }

    const tasks = [...this.recoveryTasks.values()];
    const results = await Promise.allSettled(
      tasks.map(task => this.stopContainer(task))
    );
    let stopped = 0;
    results.forEach((result, index) => {
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
    if (this.recoveryTasks.size === 0) {
      logger.info('Work startup container recovery completed.');
    }
    return { stopped, failed: this.recoveryTasks.size };
  }

  private scheduleRecoverySweep(): void {
    if (
      this.shuttingDown ||
      this.recoveryTasks.size === 0 ||
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
    if (removed && this.recoveryTasks.size === 0) {
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
    await this.ensureVolume(task);
    this.assertTaskIsActive(task);
    await this.ensureContainer(task);
    if (this.shuttingDown) {
      await this.stopContainerWithLock(task);
      this.assertTaskIsActive(task);
    }
  }

  private async ensureWorkNetwork(task: WorkTaskRecord): Promise<void> {
    if (!task.networkEnabled) return;
    const inspect = await this.docker(
      [
        'network',
        'inspect',
        '--format',
        '{{index .Labels "ai.libre-webui.managed"}} {{index .Options "com.docker.network.bridge.enable_icc"}}',
        config.networkName,
      ],
      { acceptFailure: true }
    );
    if (inspect.exitCode === 0) {
      const [managed, icc] = inspect.stdout.trim().split(' ');
      if (managed !== 'true' || icc !== 'false') {
        throw new WorkRuntimeError(
          `Docker network "${config.networkName}" exists but is not the managed Work sandbox network (label ai.libre-webui.managed=true with inter-container communication disabled). Remove it or point WORK_NETWORK_NAME at an unused name.`,
          503,
          'WORK_NETWORK_CONFLICT'
        );
      }
      return;
    }
    const created = await this.docker(
      [
        'network',
        'create',
        '--label',
        'ai.libre-webui.managed=true',
        '--opt',
        'com.docker.network.bridge.enable_icc=false',
        config.networkName,
      ],
      { acceptFailure: true }
    );
    if (created.exitCode !== 0 && !/already exists/i.test(created.stderr)) {
      throw new WorkRuntimeError(
        `Could not create the Work sandbox network "${config.networkName}": ${created.stderr.trim()}`,
        503,
        'WORK_NETWORK_UNAVAILABLE'
      );
    }
  }

  private async ensureContainer(task: WorkTaskRecord): Promise<void> {
    this.assertRuntimeLease(task);
    await this.ensureWorkNetwork(task);
    if (await this.containerExists(task.containerName)) {
      await this.assertManagedContainer(task);
      if (!(await this.containerMatchesTaskPolicy(task))) {
        logger.warn(
          `Recreating Work container ${task.containerName} because its isolation policy is stale.`
        );
        await this.docker(['rm', '-f', task.containerName]);
        await this.docker(buildWorkContainerRunArgs(task, this.image));
        return;
      }
      const state = await this.docker([
        'inspect',
        '--format',
        '{{.State.Running}}',
        task.containerName,
      ]);
      if (state.stdout.trim() !== 'true') {
        await this.docker(['start', task.containerName]);
      }
      return;
    }
    await this.docker(buildWorkContainerRunArgs(task, this.image));
  }

  async recreateContainer(task: WorkTaskRecord): Promise<void> {
    const releaseLease = this.acquireRuntimeLease(task);
    try {
      await this.ensureImage();
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
      await this.ensureImage();
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
    await this.ensureVolume(task);
    this.assertTaskIsActive(task);
    if (await this.containerExists(task.containerName)) {
      await this.assertManagedContainer(task);
      await this.docker(['rm', '-f', task.containerName]);
    }
    await this.ensureContainer(task);
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
      if (!(await this.containerExists(task.containerName))) return;
      await this.assertManagedContainer(task);
      await this.docker(['stop', '--time', '1', task.containerName], {
        timeoutMs: 10_000,
      });
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
      this.assertTaskOwnerIsAdmin(task);
    }
    this.retiringTasks.add(task.id);
    try {
      await this.withLifecycleLock(task.id, async () => {
        const [hasContainer, hasVolume] = await Promise.all([
          this.containerExists(task.containerName),
          this.volumeExists(task.volumeName),
        ]);
        // Validate every destructive target before removing either one, so a
        // conflicting unmanaged Docker resource cannot cause partial cleanup.
        if (hasContainer) {
          await this.assertManagedContainer(task);
        }
        if (hasVolume) {
          await this.assertManagedVolume(task);
        }
        if (hasContainer) {
          await this.docker(['rm', '-f', task.containerName], {
            timeoutMs: 15_000,
          });
        }
        if (hasVolume) {
          await this.docker(['volume', 'rm', task.volumeName], {
            timeoutMs: 15_000,
          });
        }
      });
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
      await this.ensureImage();
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
        { maxOutputChars: 12_100_000 }
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
      await this.ensureImage();
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
      await this.ensureImage();
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
      const result = await this.docker(
        [
          'exec',
          '--user',
          '1000:1000',
          '--workdir',
          '/workspace',
          task.containerName,
          'node',
          '-e',
          PREVIEW_TARGET_SCRIPT,
          '--',
          '/workspace',
        ],
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
      const launch = await this.docker(
        [
          'exec',
          '--user',
          '1000:1000',
          '--workdir',
          previewLaunch.workdir,
          task.containerName,
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
        { acceptFailure: true, timeoutMs: 5_000 }
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
        const readiness = await this.docker(
          [
            'exec',
            '--user',
            '1000:1000',
            task.containerName,
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
      const portResult = await this.docker([
        'port',
        task.containerName,
        `${config.previewPort}/tcp`,
      ]);
      const publishedPort = parsePublishedPort(
        portResult.stdout,
        config.previewPort
      );
      if (!publishedPort) {
        throw new WorkRuntimeError(
          'Docker did not publish the preview port.',
          503,
          'WORK_PREVIEW_PORT_UNAVAILABLE'
        );
      }
      return `http://${formatPreviewHost(config.previewHost)}:${publishedPort}`;
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
    const log = await this.docker(
      [
        'exec',
        '--user',
        '1000:1000',
        task.containerName,
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
    if (!(await this.containerExists(task.containerName))) return 'absent';
    await this.assertManagedContainer(task);
    if (!(await this.containerIsRunning(task.containerName))) return 'absent';
    const readiness = await this.docker(
      [
        'exec',
        '--user',
        '1000:1000',
        task.containerName,
        'node',
        '-e',
        PREVIEW_READY_SCRIPT,
        '--',
        String(config.previewPort),
      ],
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
    // Stop the container, not only the recorded process group. A custom
    // preview command can intentionally double-fork or create a new session;
    // Docker's container boundary guarantees those descendants are gone.
    // The named /workspace volume remains persistent across the restart.
    await this.stopContainerWithLock(task);
  }

  private async ensureImage(): Promise<void> {
    if (!this.imagePreparation) {
      this.imagePreparation = (async () => {
        const inspected = await this.docker(['image', 'inspect', this.image], {
          timeoutMs: 10_000,
          acceptFailure: true,
        });
        if (inspected.exitCode === 0) return;
        logger.info(`Pulling Work runtime image ${this.image}`);
        await this.docker(['pull', this.image], { timeoutMs: 900_000 });
      })().catch(error => {
        this.imagePreparation = undefined;
        throw error;
      });
    }
    await this.imagePreparation;
  }

  private async initializeVolume(task: WorkTaskRecord): Promise<void> {
    await this.docker([
      'run',
      '--rm',
      '--network',
      'none',
      '--read-only',
      '--tmpfs',
      '/tmp:rw,noexec,nosuid,size=64m',
      '--cap-drop',
      'ALL',
      '--cap-add',
      'CHOWN',
      '--mount',
      `type=volume,src=${task.volumeName},dst=/workspace`,
      this.image,
      'chown',
      '-R',
      '1000:1000',
      '/workspace',
    ]);
  }

  private async ensureVolume(task: WorkTaskRecord): Promise<void> {
    if (await this.volumeExists(task.volumeName)) {
      await this.assertManagedVolume(task);
      return;
    }
    await this.docker([
      'volume',
      'create',
      '--label',
      'ai.libre-webui.managed=true',
      '--label',
      `ai.libre-webui.task=${task.id}`,
      task.volumeName,
    ]);
    // Docker returns an existing volume from `volume create` if another
    // process wins the name race, so prove ownership before mounting it.
    await this.assertManagedVolume(task);
    try {
      await this.initializeVolume(task);
    } catch (error) {
      await this.docker(['volume', 'rm', task.volumeName], {
        acceptFailure: true,
      });
      throw error;
    }
  }

  private async volumeExists(name: string): Promise<boolean> {
    const result = await this.docker(['volume', 'inspect', name], {
      timeoutMs: 5_000,
      acceptFailure: true,
    });
    if (result.exitCode === 0) return true;
    if (/no such volume/i.test(`${result.stderr}\n${result.stdout}`)) {
      return false;
    }
    throw new WorkRuntimeError(
      `Could not inspect Work volume "${name}": ${result.stderr.trim() || result.stdout.trim() || `Docker exited with code ${result.exitCode}.`}`,
      503,
      'WORK_DOCKER_INSPECT_FAILED'
    );
  }

  private async containerExists(name: string): Promise<boolean> {
    const result = await this.docker(['container', 'inspect', name], {
      timeoutMs: 5_000,
      acceptFailure: true,
    });
    if (result.exitCode === 0) return true;
    if (
      /no such (?:container|object)/i.test(`${result.stderr}\n${result.stdout}`)
    ) {
      return false;
    }
    throw new WorkRuntimeError(
      `Could not inspect Work container "${name}": ${result.stderr.trim() || result.stdout.trim() || `Docker exited with code ${result.exitCode}.`}`,
      503,
      'WORK_DOCKER_INSPECT_FAILED'
    );
  }

  private async containerIsRunning(name: string): Promise<boolean> {
    const result = await this.docker([
      'inspect',
      '--format',
      '{{.State.Running}}',
      name,
    ]);
    const state = result.stdout.trim();
    if (state === 'true') return true;
    if (state === 'false') return false;
    throw new WorkRuntimeError(
      `Docker returned an invalid state for Work container "${name}".`,
      503,
      'WORK_DOCKER_INSPECT_FAILED'
    );
  }

  private async assertManagedContainer(task: WorkTaskRecord): Promise<void> {
    const result = await this.docker([
      'inspect',
      '--format',
      '{{ index .Config.Labels "ai.libre-webui.task" }}',
      task.containerName,
    ]);
    if (result.stdout.trim() !== task.id) {
      throw new WorkRuntimeError(
        `Refusing to operate unmanaged container "${task.containerName}".`,
        409,
        'WORK_CONTAINER_NAME_CONFLICT'
      );
    }
  }

  private async containerMatchesTaskPolicy(
    task: WorkTaskRecord
  ): Promise<boolean> {
    const result = await this.docker([
      'inspect',
      '--format',
      '{{json .}}',
      task.containerName,
    ]);
    let inspected: Record<string, unknown>;
    try {
      inspected = JSON.parse(result.stdout) as Record<string, unknown>;
    } catch {
      return false;
    }
    const containerConfig = objectRecord(inspected.Config);
    const hostConfig = objectRecord(inspected.HostConfig);
    const labels = objectRecord(containerConfig.Labels);
    const env = stringArray(containerConfig.Env);
    const capDrop = stringArray(hostConfig.CapDrop);
    const securityOpt = stringArray(hostConfig.SecurityOpt);
    const command = stringArray(containerConfig.Cmd);
    const mounts = Array.isArray(inspected.Mounts)
      ? inspected.Mounts.map(objectRecord)
      : [];
    const workspaceMount = mounts.find(
      mount => mount.Destination === '/workspace'
    );
    const expectedNetwork = task.networkEnabled ? config.networkName : 'none';
    const portBindings = objectRecord(hostConfig.PortBindings);
    const previewBindings = Array.isArray(
      portBindings[`${config.previewPort}/tcp`]
    )
      ? (portBindings[`${config.previewPort}/tcp`] as unknown[]).map(
          objectRecord
        )
      : [];
    const portPolicyMatches = task.networkEnabled
      ? Object.keys(portBindings).length === 1 &&
        previewBindings.length === 1 &&
        previewBindings[0]?.HostIp === config.previewBind
      : Object.keys(portBindings).length === 0;
    return (
      labels['ai.libre-webui.managed'] === 'true' &&
      labels['ai.libre-webui.task'] === task.id &&
      labels['ai.libre-webui.policy'] === runtimePolicyFingerprint &&
      containerConfig.Image === this.image &&
      containerConfig.User === '1000:1000' &&
      containerConfig.WorkingDir === '/workspace' &&
      command.join('\0') === ['tail', '-f', '/dev/null'].join('\0') &&
      env.includes('HOME=/tmp') &&
      env.includes('NPM_CONFIG_CACHE=/tmp/npm-cache') &&
      hostConfig.ReadonlyRootfs === true &&
      hostConfig.Privileged === false &&
      capDrop.includes('ALL') &&
      securityOpt.includes('no-new-privileges') &&
      Number(hostConfig.PidsLimit) === config.pidsLimit &&
      Number(hostConfig.Memory) > 0 &&
      Number(hostConfig.MemorySwap) === Number(hostConfig.Memory) &&
      Number(hostConfig.NanoCpus) > 0 &&
      hostConfig.NetworkMode === expectedNetwork &&
      portPolicyMatches &&
      workspaceMount?.Type === 'volume' &&
      workspaceMount.Name === task.volumeName &&
      workspaceMount.RW === true
    );
  }

  private async assertManagedVolume(task: WorkTaskRecord): Promise<void> {
    const result = await this.docker([
      'volume',
      'inspect',
      '--format',
      '{{ index .Labels "ai.libre-webui.task" }}',
      task.volumeName,
    ]);
    if (result.stdout.trim() !== task.id) {
      throw new WorkRuntimeError(
        `Refusing to operate unmanaged volume "${task.volumeName}".`,
        409,
        'WORK_VOLUME_NAME_CONFLICT'
      );
    }
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
    this.assertTaskOwnerIsAdmin(task);
  }

  private assertTaskOwnerIsAdmin(task: WorkTaskRecord): void {
    const access = getDatabase()
      .prepare(
        `SELECT users.role
         FROM work_tasks
         JOIN users ON users.id = work_tasks.user_id
         WHERE work_tasks.id = ? AND work_tasks.user_id = ?`
      )
      .get(task.id, task.userId) as { role: string } | undefined;
    if (!access) {
      throw new WorkRuntimeError(
        'This Work task no longer exists.',
        409,
        'WORK_TASK_REMOVING'
      );
    }
    if (access.role !== 'admin') {
      throw new WorkRuntimeError(
        'Administrator access to this Work task was revoked.',
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

  private async exec(
    task: WorkTaskRecord,
    command: string[],
    options: ProcessOptions = {}
  ): Promise<ProcessResult> {
    const args = [
      'exec',
      ...(options.input !== undefined ? ['--interactive'] : []),
      '--user',
      '1000:1000',
      '--workdir',
      '/workspace',
      task.containerName,
      ...command,
    ];
    return this.docker(args, options);
  }

  private async docker(
    args: string[],
    options: ProcessOptions = {}
  ): Promise<ProcessResult> {
    try {
      return await runProcess(config.dockerCommand, args, options);
    } catch (error) {
      if (error instanceof WorkRuntimeError) throw error;
      throw new WorkRuntimeError(
        error instanceof Error ? error.message : 'Docker command failed.'
      );
    }
  }
}

/** Bracket a bare IPv6 literal so it can carry a port in a URL. */
export function formatPreviewHost(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

/**
 * Turn a failed `docker info` into the change an operator has to make. These
 * are the three ways a containerized Libre WebUI fails to reach the daemon:
 * the image has no CLI, the bind-mounted socket is owned by a group the
 * backend user is not in, or no daemon is listening.
 */
export function describeDockerUnavailable(
  error: unknown,
  dockerCommand = config.dockerCommand
): string {
  const message = error instanceof Error ? error.message : String(error);

  if (/ENOENT/.test(message)) {
    return `The "${dockerCommand}" CLI is not installed in the Libre WebUI runtime. Run an image that ships the Docker CLI and mount the host Docker socket, or point WORK_DOCKER_COMMAND at the CLI path.`;
  }
  if (/EACCES/.test(message) || /permission denied/i.test(message)) {
    return 'The Docker socket is mounted but the Libre WebUI user cannot open it. Add the backend user to the group that owns /var/run/docker.sock (Compose: group_add with the socket GID).';
  }
  if (
    /cannot connect to the docker daemon/i.test(message) ||
    /is the docker daemon running/i.test(message) ||
    /no such file or directory/i.test(message)
  ) {
    return 'No Docker daemon is reachable. Start Docker, or mount the host socket into the Libre WebUI container with -v /var/run/docker.sock:/var/run/docker.sock.';
  }

  return message;
}

export function buildWorkContainerRunArgs(
  task: WorkTaskRecord,
  image = config.image
): string[] {
  const args = [
    'run',
    '--detach',
    '--name',
    task.containerName,
    '--init',
    '--label',
    'ai.libre-webui.managed=true',
    '--label',
    `ai.libre-webui.task=${task.id}`,
    '--label',
    `ai.libre-webui.policy=${runtimePolicyFingerprint}`,
    '--user',
    '1000:1000',
    '--workdir',
    '/workspace',
    '--read-only',
    '--tmpfs',
    '/tmp:rw,nosuid,size=512m',
    '--env',
    'HOME=/tmp',
    '--env',
    'NPM_CONFIG_CACHE=/tmp/npm-cache',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--pids-limit',
    String(config.pidsLimit),
    '--memory',
    config.memoryLimit,
    // Same value as --memory: the memory cap cannot be sidestepped via swap.
    '--memory-swap',
    config.memoryLimit,
    '--cpus',
    config.cpuLimit,
    '--network',
    task.networkEnabled ? config.networkName : 'none',
  ];
  if (task.networkEnabled) {
    args.push('--publish', `${config.previewBind}::${config.previewPort}`);
    for (const server of config.dnsServers) {
      args.push('--dns', server);
    }
  }
  args.push(
    '--mount',
    `type=volume,src=${task.volumeName},dst=/workspace,volume-nocopy`,
    image,
    'tail',
    '-f',
    '/dev/null'
  );
  return args;
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

export function parsePublishedPort(
  output: string,
  _containerPort = config.previewPort,
  bindAddress = config.previewBind
): number | undefined {
  // Only a binding on the interface this deployment asked for counts. The
  // default stays loopback, so a stray wildcard binding is still rejected.
  const allowed = new Set(
    bindAddress === WORK_RUNTIME_DEFAULTS.previewBind
      ? ['127.0.0.1', '[::1]']
      : [bindAddress, formatPreviewHost(bindAddress)]
  );

  for (const line of output.trim().split(/\r?\n/)) {
    const match = line.match(/^(.*):(\d+)$/);
    if (!match || !allowed.has(match[1])) continue;
    const port = Number(match[2]);
    if (Number.isInteger(port) && port > 0 && port <= 65535) return port;
  }
  return undefined;
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

async function runProcess(
  command: string,
  args: string[],
  options: ProcessOptions
): Promise<ProcessResult> {
  const timeoutMs = options.timeoutMs ?? config.commandTimeoutMs;
  const maxOutputChars = options.maxOutputChars ?? config.maxOutputChars;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });
    activeDockerProcesses.add(child);
    let stdout = '';
    let stderr = '';
    let truncated = false;
    let settled = false;
    let stdinError: Error | undefined;
    let timer: NodeJS.Timeout | undefined;
    const claimSettlement = (): boolean => {
      if (settled) return false;
      settled = true;
      if (timer) clearTimeout(timer);
      return true;
    };
    const append = (current: string, chunk: Buffer): string => {
      const next = current + chunk.toString('utf8');
      if (next.length <= maxOutputChars) return next;
      truncated = true;
      const half = Math.floor(maxOutputChars / 2);
      return `${next.slice(0, half)}\n... output truncated ...\n${next.slice(-half)}`;
    };
    child.stdout.on('data', chunk => {
      stdout = append(stdout, chunk as Buffer);
    });
    child.stderr.on('data', chunk => {
      stderr = append(stderr, chunk as Buffer);
    });
    child.stdin.on('error', error => {
      // A helper may reject the request and close stdin before a large input
      // has finished writing. EPIPE is then expected; the process exit carries
      // the useful error. Other stdin failures are reported when it closes.
      if ((error as NodeJS.ErrnoException).code !== 'EPIPE') {
        stdinError = error;
      }
    });
    child.on('error', error => {
      activeDockerProcesses.delete(child);
      if (!claimSettlement()) return;
      reject(
        new WorkRuntimeError(
          `Could not start ${command}: ${error.message}`,
          503,
          'WORK_DOCKER_UNAVAILABLE'
        )
      );
    });
    child.on('close', (code, signal) => {
      activeDockerProcesses.delete(child);
      const result: ProcessResult = {
        exitCode: code ?? -1,
        stdout,
        stderr,
        truncated,
        signal: signal || undefined,
      };
      if (stdinError && !options.acceptFailure) {
        if (!claimSettlement()) return;
        reject(
          new WorkRuntimeError(
            `Could not write command input: ${stdinError.message}`,
            503,
            'WORK_DOCKER_STDIN_FAILED'
          )
        );
        return;
      }
      if (result.exitCode !== 0 && !options.acceptFailure) {
        if (!claimSettlement()) return;
        reject(
          new WorkRuntimeError(
            stderr.trim() ||
              stdout.trim() ||
              `${command} exited with code ${result.exitCode}.`,
            503,
            'WORK_DOCKER_COMMAND_FAILED'
          )
        );
        return;
      }
      if (claimSettlement()) resolve(result);
    });
    timer = setTimeout(() => {
      child.kill('SIGKILL');
      if (!claimSettlement()) return;
      reject(
        new WorkRuntimeError(
          `Command timed out after ${timeoutMs}ms.`,
          504,
          'WORK_COMMAND_TIMEOUT'
        )
      );
    }, timeoutMs);
    timer.unref();
    if (options.input !== undefined) {
      child.stdin.end(options.input);
    } else {
      child.stdin.end();
    }
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

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function parseDnsServers(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map(server => server.trim())
    .filter(server => {
      if (!server) return false;
      if (/^[0-9a-fA-F:.]+$/.test(server)) return true;
      logger.warn(
        `Ignoring WORK_RUNTIME_DNS entry "${server}": not an IPv4/IPv6 address.`
      );
      return false;
    });
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
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
console.log(JSON.stringify({
  content: fs.readFileSync(targetReal, 'utf8'),
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

export const workRuntimeService = new WorkRuntimeService();
export default workRuntimeService;
