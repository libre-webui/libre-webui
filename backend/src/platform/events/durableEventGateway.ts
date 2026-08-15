/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import type {
  Coordinator,
  CoordinationUnsubscribe,
} from '../coordination/index.js';
import {
  SHARED_COORDINATION_OPERATION_TIMEOUT_MS,
  withCoordinationTimeout,
} from '../coordination/sharedAdmission.js';
import type {
  DurableJobEvent,
  DurableJobEventAppendInput,
} from '../jobs/durableJobTypes.js';
import type { DurableJobRuntimeService } from '../jobs/durableJobRuntime.js';

const WAKE_TOPIC = 'platform.events.available';
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_BATCH_SIZE = 100;

export interface DurableEventSubscriptionOptions {
  afterCursor: number;
  streamId?: string;
  /** Optional durable subject within the stream (for example one chat generation). */
  subjectId?: string;
  batchSize?: number;
  pollIntervalMs?: number;
  signal?: AbortSignal;
  /** Rechecked before each delivery so a long-lived stream fails closed. */
  authorize?(): boolean | Promise<boolean>;
  /** Hard bound across the initial catch-up pass. */
  maxReplayEvents?: number;
  onEvent(event: DurableJobEvent): void | Promise<void>;
  onError?(error: Error): void;
}

export interface DurableEventSubscription {
  readonly cursor: number;
  close(): Promise<void>;
}

/**
 * Ordered, replayable event fan-out.
 *
 * Redis is only a wake-up hint. Every subscriber resumes from the canonical
 * SQL cursor, so a lost pub/sub message or replica restart cannot create an
 * event gap. Handlers are awaited one at a time, which provides bounded
 * backpressure instead of buffering an unbounded websocket/SSE queue.
 */
export class DurableEventGateway {
  private closing = false;
  private readonly subscriptions = new Set<() => Promise<void>>();

  constructor(
    private readonly service: DurableJobRuntimeService,
    private readonly coordinator: Coordinator,
    private readonly coordinationTimeoutMs = SHARED_COORDINATION_OPERATION_TIMEOUT_MS
  ) {}

  async append(
    input: DurableJobEventAppendInput
  ): Promise<{ cursor: number; fanoutNotified: boolean }> {
    if (this.closing) throw new Error('Durable event gateway is closing.');
    const cursor = await this.service.appendEvent(input);
    return {
      cursor,
      fanoutNotified: await this.notify(cursor),
    };
  }

  /**
   * Best-effort wake after a transaction that appended one or more events.
   * Failure never rolls back or hides the committed SQL event; polling is the
   * recovery path and callers must not retry an external side effect merely
   * because Redis was unavailable.
   */
  async notify(cursor?: number): Promise<boolean> {
    try {
      await withCoordinationTimeout(
        this.coordinator.publish(WAKE_TOPIC, {
          ...(cursor === undefined ? {} : { cursor }),
        }),
        this.coordinationTimeoutMs
      );
      return true;
    } catch {
      return false;
    }
  }

  /** Return the latest committed global cursor for one stream without replaying it. */
  async latestCursor(streamId: string): Promise<number> {
    if (this.closing) throw new Error('Durable event gateway is closing.');
    if (!streamId) throw new Error('Event stream ID is required.');
    return this.service.latestEventCursor(streamId);
  }

  async subscribe(
    options: DurableEventSubscriptionOptions
  ): Promise<DurableEventSubscription> {
    if (this.closing) throw new Error('Durable event gateway is closing.');
    if (!Number.isSafeInteger(options.afterCursor) || options.afterCursor < 0) {
      throw new Error('Event replay cursor must be a non-negative integer.');
    }
    const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 500) {
      throw new Error('Event replay batch size must be between 1 and 500.');
    }
    const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    if (
      !Number.isSafeInteger(pollIntervalMs) ||
      pollIntervalMs < 100 ||
      pollIntervalMs > 60_000
    ) {
      throw new Error(
        'Event polling interval must be between 100 and 60000 ms.'
      );
    }
    const maxReplayEvents = options.maxReplayEvents ?? 10_000;
    if (
      !Number.isSafeInteger(maxReplayEvents) ||
      maxReplayEvents < 1 ||
      maxReplayEvents > 100_000
    ) {
      throw new Error('Event replay bound must be between 1 and 100000.');
    }

    let cursor = options.afterCursor;
    let replayed = 0;
    let initialReplay = true;
    let closed = false;
    let draining: Promise<void> | undefined;
    let rerun = false;
    let unsubscribe: CoordinationUnsubscribe | undefined;
    let timer: NodeJS.Timeout | undefined;
    let closePromise: Promise<void> | undefined;
    const safeErrors = new WeakMap<object, Error>();
    const reportedErrors = new WeakSet<Error>();

    const safeError = (error: unknown): Error => {
      if (error !== null && typeof error === 'object') {
        const cached = safeErrors.get(error);
        if (cached) return cached;
        const safe =
          error instanceof Error
            ? new Error(error.message || 'Durable event delivery failed.')
            : new Error('Durable event delivery failed.');
        safeErrors.set(error, safe);
        return safe;
      }
      return new Error('Durable event delivery failed.');
    };

    const report = (error: unknown): Error => {
      const safe = safeError(error);
      if (reportedErrors.has(safe)) return safe;
      reportedErrors.add(safe);
      try {
        options.onError?.(safe);
      } catch {
        // Error observers cannot replace the delivery failure or prevent
        // deterministic subscription cleanup.
      }
      return safe;
    };

    const drain = async (): Promise<void> => {
      if (closed || options.signal?.aborted) return;
      if (draining) {
        rerun = true;
        return draining;
      }
      const operation = (async () => {
        do {
          rerun = false;
          while (!closed && !options.signal?.aborted) {
            const events = await this.service.replayEvents(cursor, {
              limit: batchSize,
              ...(options.streamId ? { streamId: options.streamId } : {}),
              ...(options.subjectId ? { subjectId: options.subjectId } : {}),
            });
            if (events.length === 0) break;
            for (const event of events) {
              if (closed || options.signal?.aborted) return;
              if (options.authorize && !(await options.authorize())) {
                throw new Error(
                  'Durable event subscription authorization was revoked.'
                );
              }
              if (closed || options.signal?.aborted) return;
              if (initialReplay) replayed += 1;
              if (initialReplay && replayed > maxReplayEvents) {
                throw new Error(
                  'Durable event replay exceeded the configured delivery bound.'
                );
              }
              await options.onEvent(event);
              cursor = event.cursor;
            }
            if (events.length < batchSize) break;
          }
        } while (rerun && !closed && !options.signal?.aborted);
      })().finally(() => {
        if (draining === operation) draining = undefined;
      });
      draining = operation;
      return draining;
    };

    const close = async (): Promise<void> => {
      if (closePromise) return closePromise;
      closed = true;
      closePromise = (async () => {
        if (timer) clearInterval(timer);
        timer = undefined;
        options.signal?.removeEventListener('abort', closeOnAbort);
        if (unsubscribe) {
          await withCoordinationTimeout(
            unsubscribe(),
            this.coordinationTimeoutMs
          ).catch(report);
        }
        unsubscribe = undefined;
        // The operation that initiated shutdown reports its own delivery
        // failure. Waiting here must not report that same rejection twice.
        await draining?.catch(() => undefined);
        this.subscriptions.delete(close);
      })();
      return closePromise;
    };
    const closeOnAbort = (): void => void close();
    const drainLive = (): Promise<void> =>
      drain().catch(error => {
        report(error);
      });

    // Make an in-flight subscription setup visible to gateway shutdown and
    // request cancellation before awaiting Redis. If the generic coordinator
    // resolves after our deadline, tear down that late handler as well.
    options.signal?.addEventListener('abort', closeOnAbort, { once: true });
    this.subscriptions.add(close);
    if (this.closing || options.signal?.aborted) {
      await close();
      if (options.signal?.aborted) {
        throw options.signal.reason ?? new Error('Subscription cancelled.');
      }
      throw new Error('Durable event gateway is closing.');
    }

    // Subscribe before the initial SQL replay. A commit between these two
    // operations produces a wake and/or is observed by the replay itself.
    const pendingSubscribe = this.coordinator.subscribe(WAKE_TOPIC, drainLive);
    try {
      const candidate = await withCoordinationTimeout(
        pendingSubscribe,
        this.coordinationTimeoutMs
      );
      if (closed || this.closing || options.signal?.aborted) {
        await withCoordinationTimeout(
          candidate(),
          this.coordinationTimeoutMs
        ).catch(report);
      } else {
        unsubscribe = candidate;
      }
    } catch {
      // Redis fan-out is only a wake optimization. SQL polling below remains
      // authoritative when subscription setup is unavailable or stalls.
      unsubscribe = undefined;
      void pendingSubscribe
        .then(lateUnsubscribe =>
          withCoordinationTimeout(
            lateUnsubscribe(),
            this.coordinationTimeoutMs
          ).catch(report)
        )
        .catch(() => undefined);
    }
    if (closed || this.closing || options.signal?.aborted) {
      await close();
      if (options.signal?.aborted) {
        throw options.signal.reason ?? new Error('Subscription cancelled.');
      }
      throw new Error('Durable event gateway is closing.');
    }
    timer = setInterval(() => void drainLive(), pollIntervalMs);
    timer.unref?.();
    try {
      await drain();
    } catch (error) {
      const safe = report(error);
      await close();
      throw safe;
    }
    if (closed || this.closing || options.signal?.aborted) {
      await close();
      if (options.signal?.aborted) {
        throw options.signal.reason ?? new Error('Subscription cancelled.');
      }
      throw new Error('Durable event gateway is closing.');
    }
    initialReplay = false;

    return {
      get cursor() {
        return cursor;
      },
      close,
    };
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    await Promise.allSettled([...this.subscriptions].map(close => close()));
    this.subscriptions.clear();
  }
}
