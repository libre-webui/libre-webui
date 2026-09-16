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

import { useEffect, useState } from 'react';
import type { WorkRun } from '@/types/work';
import { workApi } from '@/utils/api/workApi';

interface UseWorkRunsOptions {
  /** Skip the request entirely while the surface is hidden. */
  enabled?: boolean;
  limit?: number;
  /**
   * Changing this value refetches: pass the task status so a run that just
   * reached a terminal state shows up without a page reload.
   */
  refreshToken?: string | number;
}

interface UseWorkRunsResult {
  runs: WorkRun[];
  loaded: boolean;
}

/**
 * Persisted run history for one Work task, newest first. The list degrades
 * to empty on failure: run history is context, never the reason a task view
 * fails to render.
 */
export function useWorkRuns(
  taskId: string | undefined,
  { enabled = true, limit, refreshToken }: UseWorkRunsOptions = {}
): UseWorkRunsResult {
  const [state, setState] = useState<{
    taskId: string | undefined;
    runs: WorkRun[];
    loaded: boolean;
  }>({ taskId, runs: [], loaded: false });
  // A different task starts from nothing, adjusted during render so the
  // previous task's runs never flash in the new one's history.
  if (state.taskId !== taskId) {
    setState({ taskId, runs: [], loaded: false });
  }

  useEffect(() => {
    if (!taskId || !enabled) return;
    let alive = true;
    void (async () => {
      try {
        const response = await workApi.listRuns(taskId, limit);
        if (!alive) return;
        setState({
          taskId,
          runs:
            response.success && Array.isArray(response.data)
              ? response.data
              : [],
          loaded: true,
        });
      } catch {
        if (alive) setState({ taskId, runs: [], loaded: true });
      }
    })();
    return () => {
      alive = false;
    };
  }, [taskId, enabled, limit, refreshToken]);

  return {
    runs: state.taskId === taskId ? state.runs : [],
    loaded: state.taskId === taskId && state.loaded,
  };
}
