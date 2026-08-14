/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import type { DurableJobEvent } from '../platform/jobs/durableJobTypes.js';

export interface ExpectedDurableChatCompletion {
  eventId: string;
  sessionId: string;
  assistantMessageId: string;
  actorUserId: string;
}

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );

/**
 * Fail closed unless the exact event is an authenticated chat completion.
 *
 * Durable reference payloads decode to `{ referenceId }`; requiring the
 * completion shape here prevents a corrupted payload-format flag from
 * bypassing the AEAD-protected payload used by chat events.
 */
export const assertDurableChatCompletionEvent = (
  event: DurableJobEvent,
  expected: ExpectedDurableChatCompletion
): void => {
  if (
    event.eventId !== expected.eventId ||
    event.streamId !== `chat:${expected.sessionId}` ||
    event.subjectId !== expected.assistantMessageId ||
    event.eventType !== 'chat.done.v1' ||
    event.actorUserId !== expected.actorUserId
  ) {
    throw new Error('Chat completion event identity is inconsistent');
  }

  const payload = event.payload;
  if (
    !isPlainRecord(payload) ||
    payload.type !== 'done' ||
    payload.messageId !== expected.assistantMessageId ||
    typeof payload.content !== 'string' ||
    (payload.thinking !== undefined && typeof payload.thinking !== 'string')
  ) {
    throw new Error('Chat completion event payload is inconsistent');
  }
};
