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
import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router';
import { useTranslation } from 'react-i18next';
import { announce } from '@/components/ui/liveAnnouncerStore';
import { useWorkStore } from '@/store/workStore';
import type { WorkTaskStatus } from '@/types/work';
import {
  backgroundWorkAnnouncements,
  hasActiveWorkTask,
} from '@/utils/workAnnouncements';

/** Slower than Work's own 1s poll: this only has to notice a finish. */
const BACKGROUND_WORK_POLL_MS = 5000;

const openWorkTaskId = (pathname: string) => {
  const match = /^\/work\/([^/]+)/.exec(pathname);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
};

/**
 * Announce Work runs that finish while their task is not on screen.
 *
 * Work announces the open task itself; this covers every other task, from any
 * page. Outside Work, the task list is polled only while a known task is still
 * working and the tab is visible, so an idle workspace makes no requests.
 */
export function useBackgroundWorkAnnouncements(enabled: boolean) {
  const { t } = useTranslation();
  const { pathname } = useLocation();
  const tasks = useWorkStore(state => state.tasks);
  const loadTasks = useWorkStore(state => state.loadTasks);
  const seenRef = useRef<Map<string, WorkTaskStatus> | null>(null);
  const onWorkPage = pathname === '/work' || pathname.startsWith('/work/');
  const openTaskId = openWorkTaskId(pathname);
  const anyActive = hasActiveWorkTask(tasks);

  useEffect(() => {
    if (!enabled) {
      // Signing out or losing access starts the next session from scratch.
      seenRef.current = null;
      return;
    }
    const { announcements, statuses } = backgroundWorkAnnouncements(
      seenRef.current ?? new Map(),
      tasks,
      openTaskId
    );
    seenRef.current = statuses;
    for (const item of announcements) {
      announce(
        t(item.key, {
          title: item.title || t('work.announce.untitledTask'),
        }),
        item.politeness
      );
    }
  }, [enabled, openTaskId, t, tasks]);

  useEffect(() => {
    // Work polls the list itself; elsewhere poll only while something runs.
    if (!enabled || onWorkPage || !anyActive) return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const schedule = () => {
      if (stopped || document.hidden) return;
      timer = setTimeout(async () => {
        timer = undefined;
        await loadTasks(true).catch(() => undefined);
        schedule();
      }, BACKGROUND_WORK_POLL_MS);
    };
    const onVisibility = () => {
      if (document.hidden) {
        if (timer) clearTimeout(timer);
        timer = undefined;
      } else if (!timer) {
        schedule();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    schedule();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [anyActive, enabled, loadTasks, onWorkPage]);
}
