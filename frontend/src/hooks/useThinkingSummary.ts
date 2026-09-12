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

import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '@/store/appStore';
import { chatApi } from '@/utils/api';
import { isDemoMode } from '@/utils/demoMode';

const MIN_THINKING_LENGTH = 80;
const MAX_EXCERPT_LENGTH = 4000;
const UPDATE_INTERVAL_MS = 5000;
const FAILURE_BACKOFF_MS = 15000;

interface ThinkingSummaryOptions {
  sessionId: string | undefined;
  messageId: string;
  thinking: string | null;
  isThinking: boolean;
  isPrivate: boolean;
}

/** Keep one bounded, cancellable task-model request ahead of the latest text. */
export function useThinkingSummary({
  sessionId,
  messageId,
  thinking,
  isThinking,
  isPrivate,
}: ThinkingSummaryOptions): string | null {
  const settings = useAppStore(state => state.preferences.titleSettings);
  const latestThinking = useRef(thinking);
  const [result, setResult] = useState<{
    sessionId: string;
    messageId: string;
    summary: string;
  } | null>(null);
  const { autoTitle, taskModel, taskProviderType, taskProviderId } =
    settings ?? {};

  // Updating the excerpt must not abort the request on every streamed token.
  useEffect(() => {
    latestThinking.current = thinking;
  }, [thinking]);

  useEffect(() => {
    if (
      !sessionId ||
      !isThinking ||
      isPrivate ||
      !autoTitle ||
      !taskModel ||
      isDemoMode()
    ) {
      return;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    let lastExcerpt = '';
    const controller = new AbortController();
    const update = async () => {
      const excerpt = (latestThinking.current ?? '')
        .slice(-MAX_EXCERPT_LENGTH)
        .trim();
      if (excerpt.length < MIN_THINKING_LENGTH || excerpt === lastExcerpt) {
        if (!cancelled) timer = setTimeout(() => void update(), 400);
        return;
      }
      lastExcerpt = excerpt;
      const startedAt = Date.now();
      let delay = UPDATE_INTERVAL_MS;
      try {
        const response = await chatApi.summarizeThinking(
          sessionId,
          {
            model: taskModel,
            thinking: excerpt,
            providerType: taskProviderType,
            providerId: taskProviderId,
          },
          controller.signal
        );
        if (!response.success || !response.data?.summary?.trim()) {
          throw new Error('Thinking summary unavailable');
        }
        if (!cancelled) {
          setResult({
            sessionId,
            messageId,
            summary: response.data.summary.trim().slice(0, 160),
          });
        }
      } catch {
        // This optional status must never interrupt the answer or log the
        // reasoning excerpt. Keep the last usable summary on a transient error.
        delay = FAILURE_BACKOFF_MS;
      }
      if (!cancelled) {
        timer = setTimeout(
          () => void update(),
          Math.max(0, delay - (Date.now() - startedAt))
        );
      }
    };

    timer = setTimeout(() => void update(), 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, [
    sessionId,
    messageId,
    isThinking,
    isPrivate,
    autoTitle,
    taskModel,
    taskProviderType,
    taskProviderId,
  ]);

  return result &&
    result.sessionId === sessionId &&
    result.messageId === messageId
    ? result.summary
    : null;
}
