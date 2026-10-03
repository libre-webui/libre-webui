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
import type { WorkTaskStatus } from '@/types/work';
import type { AnnouncementPoliteness } from '@/components/ui/liveAnnouncerStore';
export interface WorkAnnouncement {
  /** i18n key; interpolates `{{title}}`. */
  key: string;
  politeness: AnnouncementPoliteness;
}
const isActive = (status: WorkTaskStatus) =>
  status === 'preparing' || status === 'running';
/**
 * What a screen reader should hear when a task leaves the working states.
 * Finishing is polite; anything that needs the user or went wrong is
 * assertive. Only a move out of preparing/running speaks, so loading a task,
 * switching tasks, or a summary refresh at rest stay silent.
 */
export function workStatusAnnouncement(
  previous: WorkTaskStatus,
  next: WorkTaskStatus
): WorkAnnouncement | null {
  if (!isActive(previous) || isActive(next)) return null;
  switch (next) {
    case 'completed':
      return { key: 'work.announce.completed', politeness: 'polite' };
    case 'needs_input':
      return { key: 'work.announce.needsInput', politeness: 'assertive' };
    case 'failed':
      return { key: 'work.announce.failed', politeness: 'assertive' };
    case 'cancelled':
      return { key: 'work.announce.cancelled', politeness: 'polite' };
    default:
      return null;
  }
}

export interface BackgroundWorkAnnouncement extends WorkAnnouncement {
  taskId: string;
  title: string;
}

/**
 * Diff two task-list snapshots for tasks other than the one on screen.
 * `previous` is the last status seen per task; a task appearing for the first
 * time only seeds its status, so the first load and newly listed tasks never
 * speak. The open task is skipped because Work announces it itself.
 */
export function backgroundWorkAnnouncements(
  previous: ReadonlyMap<string, WorkTaskStatus>,
  tasks: ReadonlyArray<{ id: string; title: string; status: WorkTaskStatus }>,
  openTaskId: string | null
): {
  announcements: BackgroundWorkAnnouncement[];
  statuses: Map<string, WorkTaskStatus>;
} {
  const statuses = new Map<string, WorkTaskStatus>();
  const announcements: BackgroundWorkAnnouncement[] = [];
  for (const task of tasks) {
    statuses.set(task.id, task.status);
    const before = previous.get(task.id);
    if (before === undefined || task.id === openTaskId) continue;
    const announcement = workStatusAnnouncement(before, task.status);
    if (announcement) {
      announcements.push({
        ...announcement,
        taskId: task.id,
        title: task.title,
      });
    }
  }
  return { announcements, statuses };
}

/** Whether any listed task can still change on its own. */
export const hasActiveWorkTask = (
  tasks: ReadonlyArray<{ status: WorkTaskStatus }>
) => tasks.some(task => isActive(task.status));
