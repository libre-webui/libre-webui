/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

const WORK_DRAFT_PREFIX = 'libre-webui:work-draft:';

export interface WorkDraft {
  content: string;
  baseUpdatedAt?: number;
}

const storageKey = (taskId: string, path: string): string =>
  `${WORK_DRAFT_PREFIX}${taskId}:${path}`;

export const loadWorkDraft = (
  taskId: string,
  path: string
): WorkDraft | null => {
  try {
    const value = window.sessionStorage.getItem(storageKey(taskId, path));
    if (!value) return null;
    const draft = JSON.parse(value) as Partial<WorkDraft>;
    return typeof draft.content === 'string'
      ? {
          content: draft.content,
          baseUpdatedAt:
            typeof draft.baseUpdatedAt === 'number'
              ? draft.baseUpdatedAt
              : undefined,
        }
      : null;
  } catch {
    return null;
  }
};

export const saveWorkDraft = (
  taskId: string,
  path: string,
  draft: WorkDraft
): boolean => {
  try {
    window.sessionStorage.setItem(
      storageKey(taskId, path),
      JSON.stringify(draft)
    );
    return true;
  } catch {
    // Storage can be disabled or full. The in-memory editor remains usable.
    return false;
  }
};

export const clearWorkDraft = (taskId: string, path: string): void => {
  try {
    window.sessionStorage.removeItem(storageKey(taskId, path));
  } catch {
    // Ignore unavailable browser storage.
  }
};

export const clearWorkTaskDrafts = (taskId: string): void => {
  const taskPrefix = `${WORK_DRAFT_PREFIX}${taskId}:`;
  try {
    for (let index = window.sessionStorage.length - 1; index >= 0; index--) {
      const key = window.sessionStorage.key(index);
      if (key?.startsWith(taskPrefix)) {
        window.sessionStorage.removeItem(key);
      }
    }
  } catch {
    // Ignore unavailable browser storage.
  }
};

export const clearAllWorkDrafts = (): void => {
  try {
    for (let index = window.sessionStorage.length - 1; index >= 0; index--) {
      const key = window.sessionStorage.key(index);
      if (key?.startsWith(WORK_DRAFT_PREFIX)) {
        window.sessionStorage.removeItem(key);
      }
    }
  } catch {
    // Ignore unavailable browser storage.
  }
};
