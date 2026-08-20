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
 * Cursor-resumed SSE consumption for the team surfaces (channel timelines
 * and the notification inbox). These streams have no terminal event: they
 * run until the caller aborts, reconnecting from the last delivered
 * cursor. REST reads remain the source of truth — a dropped stream only
 * delays awareness, never loses data.
 */

import { API_BASE_URL } from '@/utils/config';

const headers = (): Record<string, string> => {
  const token = localStorage.getItem('auth-token');
  return token ? { Authorization: `Bearer ${token}` } : {};
};

const MAX_CONSECUTIVE_FAILURES = 8;
const RECONNECT_DELAY_MS = 2000;

const delay = (milliseconds: number, signal: AbortSignal): Promise<void> =>
  new Promise(resolve => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });

export const streamTeamEvents = async (input: {
  /** Path under the API base, e.g. `/channels/<id>/events`. */
  path: string;
  signal: AbortSignal;
  onEvent: (payload: Record<string, unknown>) => void;
}): Promise<void> => {
  let cursor = 0;
  let failures = 0;
  while (!input.signal.aborted && failures < MAX_CONSECUTIVE_FAILURES) {
    try {
      const response = await fetch(
        `${API_BASE_URL}${input.path}?after=${cursor}`,
        {
          headers: { Accept: 'text/event-stream', ...headers() },
          credentials: 'same-origin',
          signal: input.signal,
        }
      );
      if (!response.ok || !response.body) {
        failures += 1;
        await delay(RECONNECT_DELAY_MS, input.signal);
        continue;
      }
      failures = 0;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        for (;;) {
          const { done, value } = await reader.read();
          buffer += decoder
            .decode(value, { stream: !done })
            .replace(/\r\n/g, '\n');
          let boundary = buffer.indexOf('\n\n');
          while (boundary >= 0) {
            const block = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            boundary = buffer.indexOf('\n\n');
            let eventCursor: number | undefined;
            const data: string[] = [];
            for (const line of block.split('\n')) {
              if (line.startsWith('id:')) {
                eventCursor = Number(line.slice(3).trim());
              }
              if (line.startsWith('data:')) {
                data.push(line.slice(5).trimStart());
              }
            }
            if (!Number.isSafeInteger(eventCursor) || data.length === 0) {
              continue;
            }
            cursor = eventCursor as number;
            try {
              input.onEvent(
                JSON.parse(data.join('\n')) as Record<string, unknown>
              );
            } catch {
              // A malformed frame never kills the stream.
            }
          }
          if (done) break;
        }
      } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
    } catch {
      if (input.signal.aborted) return;
      failures += 1;
      await delay(RECONNECT_DELAY_MS, input.signal);
    }
  }
};
