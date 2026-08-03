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

import { parseThinkingContent } from '@/utils';

type ThinkingTimerEntry =
  | { state: 'none' }
  | { state: 'open'; startedAt: number }
  | { state: 'done'; durationMs: number };

const timers = new Map<string, ThinkingTimerEntry>();

/**
 * Observe a streaming message's accumulated content and time its thinking
 * phase. Content only ever grows by appending, so a message whose first chunk
 * does not open with a thinking marker never will, and is marked 'none' to
 * skip re-parsing on later chunks.
 */
export function trackThinkingProgress(messageId: string, content: string) {
  const existing = timers.get(messageId);
  if (existing && existing.state !== 'open') {
    return;
  }
  if (!content) {
    return;
  }

  const parsed = parseThinkingContent(content);
  if (!existing) {
    if (!parsed.thinkingComplete) {
      timers.set(messageId, { state: 'open', startedAt: Date.now() });
    } else {
      // Either no thinking marker, or the whole thought arrived in one chunk —
      // in both cases there is no phase to time.
      timers.set(messageId, { state: 'none' });
    }
    return;
  }

  if (parsed.thinkingComplete) {
    timers.set(messageId, {
      state: 'done',
      durationMs: Date.now() - existing.startedAt,
    });
  }
}

/** Duration in ms if the message's thinking phase was timed, else undefined. */
export function peekThinkingDuration(messageId: string): number | undefined {
  const entry = timers.get(messageId);
  if (!entry) return undefined;
  if (entry.state === 'done') return entry.durationMs;
  if (entry.state === 'open') return Date.now() - entry.startedAt;
  return undefined;
}

/** Consume the timer at end of stream, returning the duration if timed. */
export function takeThinkingDuration(messageId: string): number | undefined {
  const entry = timers.get(messageId);
  timers.delete(messageId);
  if (!entry) return undefined;
  if (entry.state === 'done') return entry.durationMs;
  if (entry.state === 'open') return Date.now() - entry.startedAt;
  return undefined;
}

/** "0.6s", "12s", "1m 34s" — locale-neutral so a single i18n key suffices. */
export function formatThinkingDuration(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 0.95) return `${Math.max(0.1, Math.round(seconds * 10) / 10)}s`;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return rest > 0 ? `${minutes}m ${rest}s` : `${minutes}m`;
}
