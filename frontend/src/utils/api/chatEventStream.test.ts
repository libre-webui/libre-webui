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

import assert from 'node:assert/strict';
import test from 'node:test';
import type { DurableGenerationReservation } from './chatEventStream';

Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: { getItem: () => 'test-token' },
});
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: {
    location: {
      protocol: 'https:',
      hostname: 'chat.example.test',
      origin: 'https://chat.example.test',
    },
    setTimeout(callback: () => void) {
      queueMicrotask(callback);
      return 1;
    },
    clearTimeout() {},
  },
});

const {
  acceptDurableGenerationJob,
  reconcileCancelledDurableGeneration,
  reconcileCompletedDurableGeneration,
  releaseDurableGenerationCancellationFence,
  requestDurableGenerationStop,
  streamDurableChatGeneration,
} = await import('./chatEventStream');

const event = (cursor: number, payload: Record<string, unknown>): string =>
  `id: ${cursor}\ndata: ${JSON.stringify(payload)}\n\n`;

const response = (...chunks: string[]): Response => {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { headers: { 'Content-Type': 'text/event-stream' } }
  );
};

test('reconnects from generation cursors beyond 10,000 while allowing global gaps', async () => {
  const requests: URL[] = [];
  const responses = [
    response(
      event(10_002, {
        type: 'chunk',
        content: 'first',
        total: 'first',
      }).slice(0, 23),
      event(10_002, {
        type: 'chunk',
        content: 'first',
        total: 'first',
      }).slice(23) +
        event(10_004, {
          type: 'chunk',
          content: ' second',
          total: 'first second',
        })
    ),
    response(
      event(10_006, {
        type: 'done',
        content: 'first second',
      })
    ),
  ];
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    value: async (input: URL | RequestInfo) => {
      requests.push(new URL(String(input)));
      const next = responses.shift();
      assert.ok(next, 'the stream must stop after its terminal event');
      return next;
    },
  });

  const received: Record<string, unknown>[] = [];
  await streamDurableChatGeneration({
    sessionId: 'long/session',
    assistantMessageId: 'current assistant',
    signal: new AbortController().signal,
    onEvent: payload => received.push(payload),
  });

  assert.equal(requests.length, 2);
  assert.equal(requests[0]?.searchParams.get('after'), '0');
  assert.equal(requests[1]?.searchParams.get('after'), '10004');
  assert.ok(
    requests.every(
      url => url.searchParams.get('generation') === 'current assistant'
    )
  );
  assert.deepEqual(
    received.map(payload => [payload.type, payload.total ?? payload.content]),
    [
      ['chunk', 'first'],
      ['chunk', 'first second'],
      ['done', 'first second'],
    ]
  );
});

test('treats a synthesized generation error as terminal at the current cursor', async () => {
  let requests = 0;
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    value: async () => {
      requests += 1;
      return response(
        event(0, {
          type: 'error',
          error: 'Chat generation was cancelled',
        })
      );
    },
  });
  const received: Record<string, unknown>[] = [];
  await streamDurableChatGeneration({
    sessionId: 'cancelled-session',
    assistantMessageId: 'cancelled-assistant',
    signal: new AbortController().signal,
    onEvent: payload => received.push(payload),
  });
  assert.equal(requests, 1);
  assert.deepEqual(received, [
    { type: 'error', error: 'Chat generation was cancelled' },
  ]);
});

test('replays an event when the consumer throws before accepting its cursor', async () => {
  const requests: URL[] = [];
  const responses = [
    response(event(20_001, { type: 'chunk', content: 'retry me' })),
    response(
      event(20_001, { type: 'chunk', content: 'retry me' }) +
        event(20_003, { type: 'done', content: 'retry me' })
    ),
  ];
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    value: async (input: URL | RequestInfo) => {
      requests.push(new URL(String(input)));
      const next = responses.shift();
      assert.ok(next, 'the accepted terminal event must stop reconnects');
      return next;
    },
  });

  let chunkAttempts = 0;
  const received: Record<string, unknown>[] = [];
  await streamDurableChatGeneration({
    sessionId: 'consumer-retry',
    assistantMessageId: 'assistant-retry',
    signal: new AbortController().signal,
    onEvent: payload => {
      if (payload.type === 'chunk') {
        chunkAttempts += 1;
        if (chunkAttempts === 1) throw new Error('consumer rejected event');
      }
      received.push(payload);
    },
  });

  assert.deepEqual(
    requests.map(url => url.searchParams.get('after')),
    ['0', '0']
  );
  assert.equal(chunkAttempts, 2);
  assert.deepEqual(
    received.map(payload => payload.type),
    ['chunk', 'done']
  );
});

test('Stop retains a pending enqueue identity and cancels after the late 202', async () => {
  const reservation: DurableGenerationReservation = {
    sessionId: 'pending-session',
    assistantMessageId: 'pending-assistant',
    abort: new AbortController(),
    cancelRequested: false,
  };
  const cancellations: string[] = [];

  requestDurableGenerationStop(reservation);
  assert.equal(reservation.cancelRequested, true);
  assert.equal(
    reservation.abort.signal.aborted,
    false,
    'the enqueue request must remain alive until its durable job ID is known'
  );

  const shouldStream = await acceptDurableGenerationJob(
    reservation,
    {
      jobId: 'late-job',
      assistantMessageId: reservation.assistantMessageId,
    },
    {
      byJob: async jobId => {
        cancellations.push(`job:${jobId}`);
      },
      byIdentity: async (sessionId, assistantMessageId) => {
        cancellations.push(`generation:${sessionId}:${assistantMessageId}`);
        return {
          completed: false,
          pending: false,
          jobId: 'late-job',
          state: 'cancelled',
        };
      },
    }
  );

  assert.equal(shouldStream, 'cancelled');
  assert.equal(reservation.jobId, 'late-job');
  assert.equal(reservation.abort.signal.aborted, true);
  assert.deepEqual(cancellations.sort(), [
    'generation:pending-session:pending-assistant',
    'job:late-job',
  ]);
});

test('unmount cleanup fences a pending enqueue rejection into cancellation reconciliation', async () => {
  const reservation: DurableGenerationReservation = {
    sessionId: 'unmounted-session',
    assistantMessageId: 'unmounted-assistant',
    abort: new AbortController(),
  };
  const cancelledMessageIds = new Set<string>();
  let rejectEnqueue: (error: Error) => void = () => undefined;
  const pendingEnqueue = new Promise<never>((_resolve, reject) => {
    rejectEnqueue = reject;
  });

  // This is the hook cleanup boundary: the fetch must remain alive until its
  // durable identity is known, while its eventual rejection is fenced away
  // from component setters and toast handling.
  requestDurableGenerationStop(reservation, cancelledMessageIds);
  assert.equal(cancelledMessageIds.has(reservation.assistantMessageId), true);
  assert.equal(reservation.abort.signal.aborted, false);

  const pendingDecision = { completed: false, pending: true };
  // The cleanup request resolves first, while enqueue is still outstanding.
  releaseDurableGenerationCancellationFence({
    assistantMessageId: reservation.assistantMessageId,
    cancelledMessageIds,
    decision: pendingDecision,
    retainForContinuation: true,
  });
  assert.equal(
    cancelledMessageIds.has(reservation.assistantMessageId),
    true,
    'a pending cleanup decision must not release the enqueue catch fence'
  );

  rejectEnqueue(new Error('enqueue response connection closed'));
  let componentFailurePathReached = false;
  let settledDecision: { completed: boolean; pending: boolean } | undefined;
  try {
    await pendingEnqueue;
  } catch {
    const cancellationHandled = await reconcileCancelledDurableGeneration({
      sessionId: reservation.sessionId,
      assistantMessageId: reservation.assistantMessageId,
      cancelledMessageIds,
      cancelByIdentity: async () => pendingDecision,
      settle: async decision => {
        settledDecision = decision;
        releaseDurableGenerationCancellationFence({
          assistantMessageId: reservation.assistantMessageId,
          cancelledMessageIds,
          decision,
        });
      },
    });
    if (!cancellationHandled) componentFailurePathReached = true;
  }

  assert.equal(componentFailurePathReached, false);
  assert.deepEqual(settledDecision, { completed: false, pending: true });
  assert.equal(
    cancelledMessageIds.has(reservation.assistantMessageId),
    false,
    'the enqueue rejection catch consumes its cancellation fence'
  );
});

test('Stop reloads the authoritative regeneration branch when completion wins', async () => {
  const reservation: DurableGenerationReservation = {
    sessionId: 'regeneration-session',
    assistantMessageId: 'completed-branch',
    abort: new AbortController(),
  };
  requestDurableGenerationStop(reservation);

  const requests: string[] = [];
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    value: async (input: URL | RequestInfo) => {
      const url = String(input);
      requests.push(url);
      const data = url.includes('/chat/sessions/')
        ? { completed: true }
        : { state: 'succeeded' };
      return new Response(JSON.stringify({ success: true, data }), {
        status: 202,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });

  const disposition = await acceptDurableGenerationJob(reservation, {
    jobId: 'completed-job',
    assistantMessageId: reservation.assistantMessageId,
  });
  assert.equal(disposition, 'completed');
  assert.equal(reservation.abort.signal.aborted, true);
  assert.equal(requests.length, 2);

  const authoritativeSession = {
    id: reservation.sessionId,
    messages: [
      {
        id: 'original-branch',
        role: 'assistant',
        isActive: false,
        siblingCount: 2,
      },
      {
        id: reservation.assistantMessageId,
        role: 'assistant',
        parentId: 'original-branch',
        branchIndex: 1,
        isActive: true,
        siblingCount: 2,
      },
    ],
  };
  let appliedSession;
  await reconcileCompletedDurableGeneration({
    sessionId: reservation.sessionId,
    assistantMessageId: reservation.assistantMessageId,
    loadSession: async () => authoritativeSession,
    applySession: session => {
      appliedSession = session;
    },
  });

  assert.equal(appliedSession, authoritativeSession);
  assert.equal(authoritativeSession.messages[0]?.isActive, false);
  assert.equal(authoritativeSession.messages[1]?.isActive, true);
});
