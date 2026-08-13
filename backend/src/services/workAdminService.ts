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
import type { WorkTaskRecord } from '../types/work.js';

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
  listTasksWithOwner: () => Array<{
    record: WorkTaskRecord;
    ownerUsername: string;
  }>;
  listManaged: () => Promise<
    Array<{ name: string; taskId: string; running: boolean }>
  >;
  isRuntimeAvailable: () => Promise<boolean>;
  runtimeUnavailableReason: () => string | null;
  sessionCount: (taskId: string) => number;
  activeGlobal: () => number;
  limits: () => { maxGlobal: number; maxPerUser: number };
  recoveryPending: () => number;
  accessMode: () => WorkAccessMode;
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
};

export async function buildWorkAdminOverview(
  deps: WorkAdminDeps = defaultDeps
): Promise<WorkAdminOverview> {
  const tasks = deps.listTasksWithOwner();
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
  return {
    generatedAt: Date.now(),
    accessMode: deps.accessMode(),
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
      updatedAt: record.updatedAt,
    })),
    orphanContainers: managed.filter(entry => !taskIds.has(entry.taskId)),
  };
}
