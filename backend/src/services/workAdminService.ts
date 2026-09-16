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
 * One aggregated snapshot of everything Work is doing across every user,
 * for the admin System page: task inventory with owners, live runtime
 * state (from the single labeled listing the drivers already provide),
 * terminal sessions, admission headroom, reconciliation state, and the
 * access mode. Read-only: this module never mutates runtime state.
 */

import { getWorkAccessMode, type WorkAccessMode } from './workAccessService.js';
import workRuntimeService from './workRuntimeService.js';
import workTaskService from './workTaskService.js';
import workTerminalService from './workTerminalService.js';
import type { WorkRun, WorkTaskRecord, WorkTaskUsage } from '../types/work.js';
import workUsageService from './workUsageService.js';

export interface WorkAdminTask {
  id: string;
  title: string;
  ownerId: string;
  ownerUsername: string;
  model: string;
  status: string;
  previewStatus: string;
  networkEnabled: boolean;
  hostWorkspace: boolean;
  /** null when the runtime could not be asked (backend unavailable). */
  running: boolean | null;
  terminalSessions: number;
  /** Live holds recorded by the usage registry: who is on this task now. */
  usage: WorkTaskUsage[];
  /** What the task's most recent finished run ended on, when it has one. */
  lastRun?: {
    exitState?: string;
    finishedAt?: number;
    /** First 160 characters of the run summary; the table shows one line. */
    summary?: string;
  };
  updatedAt: number;
}

export interface WorkAdminOverview {
  generatedAt: number;
  accessMode: WorkAccessMode;
  runtimeAvailable: boolean;
  runtimeReason?: string;
  recoveryPending: number;
  admission: {
    activeGlobal: number;
    maxGlobal: number;
    maxPerUser: number;
  };
  tasks: WorkAdminTask[];
  /** Managed containers whose task record no longer exists. */
  orphanContainers: Array<{ name: string; taskId: string; running: boolean }>;
}

interface WorkAdminDeps {
  listTasksWithOwner: () => Promise<
    Array<{
      record: WorkTaskRecord;
      ownerUsername: string;
    }>
  >;
  listManaged: () => Promise<
    Array<{ name: string; taskId: string; running: boolean }>
  >;
  isRuntimeAvailable: () => Promise<boolean>;
  runtimeUnavailableReason: () => string | null;
  sessionCount: (taskId: string) => number;
  activeGlobal: () => number;
  limits: () => { maxGlobal: number; maxPerUser: number };
  recoveryPending: () => number;
  accessMode: () => Promise<WorkAccessMode> | WorkAccessMode;
  usage: (taskIds: readonly string[]) => Promise<Map<string, WorkTaskUsage[]>>;
  /** The task's newest finished run, or undefined when it never finished one. */
  lastRun: (taskId: string) => Promise<WorkRun | undefined>;
}

const defaultDeps: WorkAdminDeps = {
  listTasksWithOwner: () => workTaskService.listAllTasksWithOwner(),
  listManaged: () => workRuntimeService.driver.listManaged(),
  isRuntimeAvailable: () => workRuntimeService.isRuntimeAvailable(),
  runtimeUnavailableReason: () => workRuntimeService.runtimeUnavailableReason,
  sessionCount: taskId => workTerminalService.sessionCount(taskId),
  activeGlobal: () => workRuntimeService.activeRuntimeCounts().global,
  limits: () => ({
    maxGlobal: workRuntimeService.limits.maxActiveRuntimesGlobal,
    maxPerUser: workRuntimeService.limits.maxActiveRuntimesPerUser,
  }),
  recoveryPending: () => workRuntimeService.recoveryPendingCount,
  accessMode: () => getWorkAccessMode(),
  usage: taskIds => workUsageService.listMany(taskIds),
  lastRun: async taskId =>
    (await workTaskService.listRuns(taskId, WORK_ADMIN_RUN_LOOKBACK)).find(
      run => run.finishedAt !== undefined
    ),
};

const lastRunSummary = (
  run: WorkRun | undefined
): Pick<WorkAdminTask, 'lastRun'> => {
  if (!run) return {};
  const summary = run.summary?.trim();
  return {
    lastRun: {
      ...(run.exitState ? { exitState: run.exitState } : {}),
      ...(run.finishedAt !== undefined ? { finishedAt: run.finishedAt } : {}),
      ...(summary
        ? { summary: summary.slice(0, WORK_ADMIN_SUMMARY_MAX_CHARS) }
        : {}),
    },
  };
};

/** How far back the overview looks for a finished run per task. */
const WORK_ADMIN_RUN_LOOKBACK = 5;
/** The overview shows one line of a run summary, never the whole reply. */
const WORK_ADMIN_SUMMARY_MAX_CHARS = 160;

export async function buildWorkAdminOverview(
  deps: WorkAdminDeps = defaultDeps
): Promise<WorkAdminOverview> {
  const tasks = await deps.listTasksWithOwner();
  const runtimeAvailable = await deps.isRuntimeAvailable();

  // One labeled listing answers "what is actually running" for every task
  // at once. When the runtime is down the inventory is still useful, so
  // per-task state degrades to unknown instead of failing the overview.
  let managed: Array<{ name: string; taskId: string; running: boolean }> = [];
  let managedKnown = false;
  if (runtimeAvailable) {
    try {
      managed = await deps.listManaged();
      managedKnown = true;
    } catch {
      managedKnown = false;
    }
  }
  const runningByTask = new Map(
    managed.map(entry => [entry.taskId, entry.running])
  );
  const taskIds = new Set(tasks.map(task => task.record.id));

  const limits = deps.limits();
  const usageByTask = await deps.usage(tasks.map(task => task.record.id));
  // Last-run results, resolved per task: an overview row should say what the
  // task last produced, not only whether something is running right now.
  const lastRunByTask = new Map<string, WorkRun>();
  await Promise.all(
    tasks.map(async ({ record }) => {
      try {
        const run = await deps.lastRun(record.id);
        if (run) lastRunByTask.set(record.id, run);
      } catch {
        // A single unreadable run must not cost the whole overview.
      }
    })
  );
  return {
    generatedAt: Date.now(),
    accessMode: await deps.accessMode(),
    runtimeAvailable,
    runtimeReason: runtimeAvailable
      ? undefined
      : (deps.runtimeUnavailableReason() ?? undefined),
    recoveryPending: deps.recoveryPending(),
    admission: {
      activeGlobal: deps.activeGlobal(),
      maxGlobal: limits.maxGlobal,
      maxPerUser: limits.maxPerUser,
    },
    tasks: tasks.map(({ record, ownerUsername }) => ({
      id: record.id,
      title: record.title,
      ownerId: record.userId,
      ownerUsername,
      model: record.model,
      status: record.status,
      previewStatus: record.previewStatus,
      networkEnabled: record.networkEnabled,
      hostWorkspace: Boolean(record.hostPath),
      running: managedKnown ? (runningByTask.get(record.id) ?? false) : null,
      terminalSessions: deps.sessionCount(record.id),
      usage: usageByTask.get(record.id) ?? [],
      ...lastRunSummary(lastRunByTask.get(record.id)),
      updatedAt: record.updatedAt,
    })),
    orphanContainers: managed.filter(entry => !taskIds.has(entry.taskId)),
  };
}
