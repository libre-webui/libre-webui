/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import { API_BASE_URL } from '@/utils/config';

export interface QueuedChatGeneration {
  jobId: string;
  assistantMessageId: string;
}

const errorFrom = async (response: Response): Promise<Error> => {
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
    // Use the status-only error below for non-JSON responses.
  }
  return new Error(`Chat event request failed with status ${response.status}.`);
};

const headers = (): Record<string, string> => {
  const token = localStorage.getItem('auth-token');
  return token ? { Authorization: `Bearer ${token}` } : {};
};

export const enqueueDurableChatGeneration = async (input: {
  sessionId: string;
  message: string;
  images?: string[];
  userMessageId: string;
  assistantMessageId: string;
  options: Record<string, unknown>;
  webSearch: boolean;
  regenerate?: boolean;
  originalMessageId?: string;
  signal: AbortSignal;
}): Promise<QueuedChatGeneration> => {
  const response = await fetch(
    `${API_BASE_URL}/chat/sessions/${encodeURIComponent(input.sessionId)}/generations`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...headers(),
      },
      credentials: 'same-origin',
      signal: input.signal,
      body: JSON.stringify({
        message: input.message,
        images: input.images,
        userMessageId: input.userMessageId,
        assistantMessageId: input.assistantMessageId,
        options: input.options,
        webSearch: input.webSearch,
        regenerate: input.regenerate === true,
        originalMessageId: input.originalMessageId,
      }),
    }
  );
  if (!response.ok) throw await errorFrom(response);
  const payload = (await response.json()) as {
    data?: QueuedChatGeneration;
  };
  if (!payload.data?.jobId) {
    throw new Error('Chat generation response did not include a durable job.');
  }
  return payload.data;
};

const consumeSse = async (
  response: Response,
  onEvent: (cursor: number, payload: Record<string, unknown>) => void
): Promise<{ cursor: number; terminal: boolean }> => {
  if (!response.body)
    throw new Error('Chat event stream has no response body.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let cursor = 0;
  let terminal = false;
  const parse = (block: string): void => {
    let eventCursor: number | undefined;
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('id:')) eventCursor = Number(line.slice(3).trim());
      if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
    }
    if (!Number.isSafeInteger(eventCursor) || !data.length) return;
    const payload = JSON.parse(data.join('\n')) as Record<string, unknown>;
    cursor = eventCursor as number;
    terminal = payload.type === 'done' || payload.type === 'error';
    onEvent(cursor, payload);
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done }).replace(/\r\n/g, '\n');
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        parse(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf('\n\n');
      }
      if (done || terminal) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return { cursor, terminal };
};

/**
 * Reconnect until a terminal SQL event arrives. The global cursor makes every
 * retry safe across replicas; Redis is only a wake-up hint on the server.
 */
export const streamDurableChatGeneration = async (input: {
  sessionId: string;
  assistantMessageId: string;
  signal: AbortSignal;
  onEvent: (payload: Record<string, unknown>) => void;
}): Promise<void> => {
  let after = 0;
  let failures = 0;
  while (!input.signal.aborted) {
    const url = new URL(
      `${API_BASE_URL}/chat/sessions/${encodeURIComponent(input.sessionId)}/events`,
      window.location.origin
    );
    url.searchParams.set('after', String(after));
    url.searchParams.set('generation', input.assistantMessageId);
    try {
      const response = await fetch(url, {
        headers: { Accept: 'text/event-stream', ...headers() },
        credentials: 'same-origin',
        cache: 'no-store',
        signal: input.signal,
      });
      if (!response.ok) throw await errorFrom(response);
      const result = await consumeSse(response, (cursor, payload) => {
        after = cursor;
        input.onEvent(payload);
      });
      if (result.terminal) return;
      failures = 0;
    } catch (error) {
      if (input.signal.aborted) throw error;
      failures += 1;
      if (failures > 8) throw error;
    }
    await new Promise<void>((resolve, reject) => {
      const finish = (): void => {
        input.signal.removeEventListener('abort', abort);
        resolve();
      };
      const timer = window.setTimeout(
        finish,
        Math.min(5_000, failures * 500 + 250)
      );
      const abort = (): void => {
        window.clearTimeout(timer);
        input.signal.removeEventListener('abort', abort);
        reject(input.signal.reason ?? new Error('Chat stream cancelled'));
      };
      input.signal.addEventListener('abort', abort, { once: true });
    });
  }
};

export const cancelDurableChatGeneration = async (
  jobId: string
): Promise<void> => {
  const response = await fetch(
    `${API_BASE_URL}/jobs/${encodeURIComponent(jobId)}/cancel`,
    {
      method: 'POST',
      headers: headers(),
      credentials: 'same-origin',
    }
  );
  if (!response.ok) throw await errorFrom(response);
};
