/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * Who is using a Work task right now, kept outside process memory.
 *
 * The runtime tracks commands, previews, terminals and screens in maps that
 * die with the process and are invisible to other replicas and to
 * administrators. Every hold is mirrored here as a coordinator presence
 * member carrying its kind, user and start time, refreshed on a heartbeat
 * and expiring on its own if the holder disappears. Sweeps ask this before
 * touching a task, the admin overview shows it, and a task's detail carries
 * it. Solo mode uses the local coordinator, which is enough for one process
 * and keeps the code path identical.
 */

import { randomUUID } from 'crypto';
import { getCoordinator } from '../platform/coordination/service.js';
import type { Coordinator } from '../platform/coordination/types.js';
import {
  SHARED_COORDINATION_OPERATION_TIMEOUT_MS,
  withCoordinationTimeout,
} from '../platform/coordination/sharedAdmission.js';
import { createLogger } from '../utils/logger.js';
import type { WorkTaskUsage, WorkUsageKind } from '../types/work.js';

const logger = createLogger('work-usage');

export const WORK_USAGE_KINDS: readonly WorkUsageKind[] = [
  'command',
  'preview',
  'terminal',
  'screen',
];

const PRESENCE_TTL_MS = 30_000;
const REFRESH_INTERVAL_MS = 10_000;
const SEPARATOR = '|';

const usageScope = (taskId: string): string => `work-task-usage:${taskId}`;

/** Member ids must survive the coordinator's name rules and stay parseable. */
const sanitize = (value: string): string =>
  value.replace(/[|\r\n\0]/g, '_').slice(0, 64);

export const encodeUsageMember = (
  usage: Omit<WorkTaskUsage, 'member'>,
  processId: string
): string =>
  [usage.kind, sanitize(usage.userId), usage.since, processId].join(SEPARATOR);

export const decodeUsageMember = (member: string): WorkTaskUsage | null => {
  const [kind, userId, since, processId] = member.split(SEPARATOR);
  if (
    !WORK_USAGE_KINDS.includes(kind as WorkUsageKind) ||
    !userId ||
    !processId
  ) {
    return null;
  }
  const startedAt = Number.parseInt(since ?? '', 10);
  if (!Number.isSafeInteger(startedAt) || startedAt <= 0) return null;
  return { kind: kind as WorkUsageKind, userId, since: startedAt, member };
};

class WorkUsageService {
  private readonly processId =
    `${process.env.LIBRE_PROCESS_ROLE || 'standalone'}-${process.pid}-` +
    randomUUID().slice(0, 8);
  private readonly timers = new Map<string, NodeJS.Timeout>();

  /** The registry is optional infrastructure: without a coordinator it is silent. */
  private coordinator(): Coordinator | null {
    try {
      return getCoordinator();
    } catch {
      return null;
    }
  }

  /**
   * Registers a hold and returns its release. Registration is best effort:
   * a coordinator hiccup is logged, never surfaced to the user action that
   * caused the hold.
   */
  async begin(
    taskId: string,
    kind: WorkUsageKind,
    userId: string
  ): Promise<() => void> {
    const member = encodeUsageMember(
      { kind, userId, since: Date.now() },
      this.processId
    );
    const scope = usageScope(taskId);
    const coordinator = this.coordinator();
    if (!coordinator) return () => undefined;
    const refresh = async (): Promise<void> =>
      withCoordinationTimeout(
        coordinator.setPresence(scope, member, PRESENCE_TTL_MS),
        SHARED_COORDINATION_OPERATION_TIMEOUT_MS
      );
    try {
      await refresh();
    } catch (error) {
      logger.warn(`Could not record ${kind} usage for Work task ${taskId}:`, {
        error,
      });
    }
    const timer = setInterval(() => {
      void refresh().catch(error =>
        logger.warn(
          `Could not refresh ${kind} usage for Work task ${taskId}:`,
          {
            error,
          }
        )
      );
    }, REFRESH_INTERVAL_MS);
    timer.unref?.();
    this.timers.set(member, timer);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      clearInterval(timer);
      this.timers.delete(member);
      void withCoordinationTimeout(
        coordinator.clearPresence(scope, member),
        SHARED_COORDINATION_OPERATION_TIMEOUT_MS
      ).catch(error =>
        logger.warn(`Could not clear ${kind} usage for Work task ${taskId}:`, {
          error,
        })
      );
    };
  }

  /** Current holds on a task, oldest first. Empty when the coordinator fails. */
  async list(taskId: string): Promise<WorkTaskUsage[]> {
    const coordinator = this.coordinator();
    if (!coordinator) return [];
    try {
      const members = await withCoordinationTimeout(
        coordinator.listPresence(usageScope(taskId)),
        SHARED_COORDINATION_OPERATION_TIMEOUT_MS
      );
      return members
        .map(decodeUsageMember)
        .filter((entry): entry is WorkTaskUsage => entry !== null)
        .sort((a, b) => a.since - b.since);
    } catch (error) {
      logger.warn(`Could not list usage for Work task ${taskId}:`, { error });
      return [];
    }
  }

  async isInUse(taskId: string): Promise<boolean> {
    return (await this.list(taskId)).length > 0;
  }

  async listMany(
    taskIds: readonly string[]
  ): Promise<Map<string, WorkTaskUsage[]>> {
    const entries = await Promise.all(
      taskIds.map(async taskId => [taskId, await this.list(taskId)] as const)
    );
    return new Map(entries);
  }

  /** Drops this process's heartbeats; the members expire on their own. */
  stopHeartbeats(): void {
    for (const timer of this.timers.values()) clearInterval(timer);
    this.timers.clear();
  }
}

export const workUsageService = new WorkUsageService();
export default workUsageService;
