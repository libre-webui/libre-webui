/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */

import { createHash } from 'node:crypto';

import { getCoordinator } from './service.js';
import type { CoordinationPermit, Coordinator } from './types.js';

export const SHARED_CAPACITY_DEFAULT_TTL_MS = 60_000;
export const SHARED_CAPACITY_DEFAULT_RENEW_INTERVAL_MS = 20_000;
export const SHARED_COORDINATION_OPERATION_TIMEOUT_MS = 5_000;

export interface SharedCapacityLimit {
  /** Stable, non-user-controlled resource name such as `stt.global`. */
  scope: string;
  capacity: number;
  /** Optional tenant/resource identity. It is hashed before entering Redis. */
  subject?: string;
}

export interface SharedCapacityOptions {
  limits: readonly SharedCapacityLimit[];
  ttlMs?: number;
  renewIntervalMs?: number;
  operationTimeoutMs?: number;
  /** Test seam. Production callers use the lifecycle-owned coordinator. */
  coordinator?: Coordinator;
}

export class SharedCapacityExceededError extends Error {
  readonly status = 429;

  constructor(readonly scope: string) {
    super('Shared capacity limit reached');
    this.name = 'SharedCapacityExceededError';
  }
}

export class SharedCapacityUnavailableError extends Error {
  readonly status = 503;
  readonly cause?: unknown;

  constructor(
    message = 'Shared capacity coordination is unavailable',
    cause?: unknown
  ) {
    super(message);
    this.name = 'SharedCapacityUnavailableError';
    this.cause = cause;
  }
}

export interface SharedCapacityReservation {
  /** Aborts when a renewable permit can no longer be proven. */
  readonly signal: AbortSignal;
  readonly keys: readonly string[];
  readonly released: boolean;
  release(): Promise<void>;
}

const assertScope = (scope: string): string => {
  const normalized = scope.trim().toLowerCase();
  if (!/^[a-z][a-z0-9.-]{0,95}$/.test(normalized)) {
    throw new Error(
      'Shared-capacity scope must contain 1-96 lowercase letters, numbers, dots, or hyphens.'
    );
  }
  return normalized;
};

const subjectDigest = (subject: string): string =>
  createHash('sha256').update(subject).digest('base64url');

export const sharedCapacityKey = (scope: string, subject?: string): string => {
  const normalizedScope = assertScope(scope);
  return subject === undefined
    ? `capacity:${normalizedScope}:global`
    : `capacity:${normalizedScope}:subject:${subjectDigest(subject)}`;
};

const releasePermits = async (
  permits: readonly CoordinationPermit[],
  timeoutMs: number
): Promise<void> => {
  await Promise.allSettled(
    [...permits].reverse().map(permit =>
      withCoordinationTimeout(
        Promise.resolve().then(() => permit.release()),
        timeoutMs
      )
    )
  );
};

export class CoordinationOperationTimeoutError extends Error {
  constructor() {
    super('Coordination operation timed out');
    this.name = 'CoordinationOperationTimeoutError';
  }
}

export const withCoordinationTimeout = async <T>(
  operation: Promise<T>,
  timeoutMs = SHARED_COORDINATION_OPERATION_TIMEOUT_MS
): Promise<T> => {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error('Coordination operation timeout must be positive.');
  }
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new CoordinationOperationTimeoutError()),
          timeoutMs
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

/**
 * Reserves one or more shared capacity dimensions without ever falling back to
 * a process-local counter. A partial acquisition is rolled back. Long-running
 * operations must observe `signal`; losing any renewal aborts it fail closed.
 */
export const acquireSharedCapacity = async (
  options: SharedCapacityOptions
): Promise<SharedCapacityReservation> => {
  if (options.limits.length === 0) {
    throw new Error('At least one shared-capacity limit is required.');
  }
  const ttlMs = options.ttlMs ?? SHARED_CAPACITY_DEFAULT_TTL_MS;
  const renewIntervalMs =
    options.renewIntervalMs ?? SHARED_CAPACITY_DEFAULT_RENEW_INTERVAL_MS;
  const operationTimeoutMs =
    options.operationTimeoutMs ?? SHARED_COORDINATION_OPERATION_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(renewIntervalMs) ||
    renewIntervalMs < 1 ||
    renewIntervalMs >= ttlMs
  ) {
    throw new Error(
      'Shared-capacity renewal interval must be a positive integer below its TTL.'
    );
  }

  let coordinator: Coordinator;
  try {
    coordinator = options.coordinator ?? getCoordinator();
  } catch (error) {
    throw new SharedCapacityUnavailableError(undefined, error);
  }
  const permits: CoordinationPermit[] = [];
  const keys: string[] = [];
  try {
    for (const limit of options.limits) {
      const key = sharedCapacityKey(limit.scope, limit.subject);
      let abandoned = false;
      const pendingPermit = coordinator.acquireSemaphore(
        key,
        limit.capacity,
        ttlMs
      );
      void pendingPermit
        .then(permit => {
          if (!abandoned || !permit) return;
          void withCoordinationTimeout(
            Promise.resolve().then(() => permit.release()),
            operationTimeoutMs
          ).catch(() => undefined);
        })
        .catch(() => undefined);
      let permit: CoordinationPermit | null;
      try {
        permit = await withCoordinationTimeout(
          pendingPermit,
          operationTimeoutMs
        );
      } catch (error) {
        abandoned = true;
        throw error;
      }
      if (!permit) {
        await releasePermits(permits, operationTimeoutMs);
        throw new SharedCapacityExceededError(limit.scope);
      }
      permits.push(permit);
      keys.push(key);
    }
  } catch (error) {
    if (error instanceof SharedCapacityExceededError) throw error;
    await releasePermits(permits, operationTimeoutMs);
    throw new SharedCapacityUnavailableError(undefined, error);
  }

  const loss = new AbortController();
  let released = false;
  let renewal: Promise<void> | undefined;
  let releasePromise: Promise<void> | undefined;

  const markLost = (cause?: unknown): void => {
    if (released || loss.signal.aborted) return;
    loss.abort(
      new SharedCapacityUnavailableError(
        'Shared capacity permit could not be renewed',
        cause
      )
    );
  };

  const renew = async (): Promise<void> => {
    if (released || loss.signal.aborted || renewal) return;
    renewal = (async () => {
      try {
        const extended = await withCoordinationTimeout(
          Promise.all(permits.map(permit => permit.extend(ttlMs))),
          Math.min(operationTimeoutMs, renewIntervalMs)
        );
        if (extended.some(result => !result)) {
          markLost();
          return;
        }
      } catch (error) {
        markLost(error);
      }
    })().finally(() => {
      renewal = undefined;
    });
    await renewal;
  };

  const timer = setInterval(() => {
    void renew();
  }, renewIntervalMs);
  timer.unref?.();

  const reservation: SharedCapacityReservation = {
    signal: loss.signal,
    keys,
    get released() {
      return released;
    },
    release: () => {
      if (releasePromise) return releasePromise;
      released = true;
      clearInterval(timer);
      releasePromise = (async () => {
        await renewal;
        await releasePermits(permits, operationTimeoutMs);
      })();
      return releasePromise;
    },
  };
  return reservation;
};

/**
 * Combines client cancellation with the shared-permit loss fence. Callers must
 * still release their reservation in `finally`.
 */
export const combineAbortSignals = (
  ...signals: Array<AbortSignal | undefined>
): AbortSignal => {
  const active = signals.filter(
    (signal): signal is AbortSignal => signal !== undefined
  );
  if (active.length === 0) return new AbortController().signal;
  if (active.length === 1) return active[0];
  return AbortSignal.any(active);
};
