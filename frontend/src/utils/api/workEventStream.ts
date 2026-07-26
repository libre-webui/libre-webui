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

import type { WorkRunEvent } from '@/types/work';
import { API_BASE_URL } from '@/utils/config';
import { WorkEventStreamParser } from './workEventParser';

const responseError = async (response: Response): Promise<Error> => {
  try {
    const payload = (await response.json()) as {
      error?: unknown;
      message?: unknown;
    };
    const message =
      typeof payload.error === 'string'
        ? payload.error
        : typeof payload.message === 'string'
          ? payload.message
          : undefined;
    if (message) return new Error(message);
  } catch {
    // Fall through to the HTTP status when the response is not JSON.
  }
  return new Error(`Work event stream failed with status ${response.status}.`);
};

export interface WorkRunEventStreamOptions {
  taskId: string;
  runId: string;
  after: number;
  signal: AbortSignal;
  onEvent: (event: WorkRunEvent) => void;
}

export const streamWorkRunEvents = async ({
  taskId,
  runId,
  after,
  signal,
  onEvent,
}: WorkRunEventStreamOptions): Promise<void> => {
  const token = localStorage.getItem('auth-token');
  const url = new URL(
    `${API_BASE_URL}/work/tasks/${encodeURIComponent(
      taskId
    )}/runs/${encodeURIComponent(runId)}/events`,
    window.location.origin
  );
  url.searchParams.set('after', String(Math.max(0, Math.trunc(after))));

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Accept: 'text/event-stream',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    cache: 'no-store',
    credentials: 'same-origin',
    signal,
  });
  if (!response.ok) throw await responseError(response);
  if (!response.body)
    throw new Error('Work event stream has no response body.');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parser = new WorkEventStreamParser(taskId, runId, onEvent);
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      parser.push(decoder.decode(value, { stream: true }));
    }
    parser.finish(decoder.decode());
  } finally {
    reader.releaseLock();
  }
};
