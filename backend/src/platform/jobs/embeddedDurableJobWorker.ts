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

import crypto from 'node:crypto';
import {
  DurableJobError,
  DurableJobExecutionError,
  type DurableJobLease,
  type DurableJobLeaseIdentity,
  type DurableJobProgress,
  type DurableJobState,
} from './durableJobTypes.js';
import { DurableJobService } from './durableJobService.js';
import {
  OWNER_DELETE_CONTENT_JOB_TYPE,
  RESOURCE_DELETE_JOB_TYPE,
} from './domainJobContracts.js';

export interface DurableJobExecutionContext {
  signal: AbortSignal;
  payload: unknown;
  actorUserId: string;
  /** One-based durable attempt number for idempotent fault/recovery control. */
  attemptCount: number;
  /** SQL-verifiable ownership for atomic domain/outbox publication. */
  sideEffectLease: DurableJobLeaseIdentity;
  reportProgress(progress: DurableJobProgress): void | Promise<void>;
  /**
   * A handler must call this immediately before each external side effect.
   * It rechecks actor authority, cancellation, and lease ownership.
   */
  assertSideEffectAllowed(): Promise<void>;
}

export interface DurableJobExecutionResult {
  resultReference?: string | null;
}

export type DurableJobHandler = (
  context: DurableJobExecutionContext
) => Promise<DurableJobExecutionResult | void>;

export interface EmbeddedDurableJobWorkerOptions {
  service: DurableJobService;
  handlers: ReadonlyMap<string, DurableJobHandler>;
  isActorAuthorized(actorUserId: string, jobType: string): Promise<boolean>;
  workerId?: string;
  leaseMs?: number;
  pollIntervalMs?: number;
  maxRetryBackoffMs?: number;
  shutdownTimeoutMs?: number;
  random?: () => number;
  /** Reconcile cleanup-only dead letters before this worker can claim work. */
  reconcileBeforePolling?(): unknown | Promise<unknown>;
}

export interface EmbeddedDurableJobWorkerStopResult {
  activeAtStop: number;
  abandoned: number;
  failed: number;
}

const MIN_LEASE_MS = 1000;
const MAX_LEASE_MS = 15 * 60 * 1000;
const MIN_RETRY_BACKOFF_MS = 1000;
const MAX_RETRY_BACKOFF_MS = 15 * 60 * 1000;

const delay = (milliseconds: number, signal: AbortSignal): Promise<void> =>
  new Promise(resolve => {
    if (signal.aborted) {
      resolve();
      return;
    }
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    timer = setTimeout(finish, milliseconds);
    timer.unref?.();
    signal.addEventListener('abort', finish, { once: true });
  });

const safeExecutionError = (
  error: unknown
): {
  retryable: boolean;
  errorCode: string;
  errorSummary: string;
} => {
  if (error instanceof DurableJobExecutionError) {
    return {
      retryable: error.retryable,
      errorCode: error.safeCode,
      errorSummary: error.safeSummary,
    };
  }
  if (error instanceof DurableJobError && error.code === 'cancelled') {
    return {
      retryable: false,
      errorCode: 'cancelled',
      errorSummary: 'The durable job was cancelled',
    };
  }
  return {
    retryable: true,
    errorCode: 'handler-failed',
    errorSummary: 'The durable job handler failed',
  };
};

/**
 * Solo-mode embedded worker. Shutdown aborts handlers, waits for them, and
 * explicitly releases any still-owned leases for immediate recovery.
 */
export class EmbeddedDurableJobWorker {
  readonly workerId: string;
  private readonly service: DurableJobService;
  private readonly handlers: ReadonlyMap<string, DurableJobHandler>;
  private readonly isActorAuthorized: EmbeddedDurableJobWorkerOptions['isActorAuthorized'];
  private readonly leaseMs: number;
  private readonly pollIntervalMs: number;
  private readonly maxRetryBackoffMs: number;
  private readonly shutdownTimeoutMs: number;
  private readonly random: () => number;
  private readonly reconcileBeforePolling?: () => unknown | Promise<unknown>;
  private readonly shutdown = new AbortController();
  private loopPromise: Promise<void> | null = null;
  private loopError?: Error;
  private pollHealthy = false;
  private readonly active = new Map<
    string,
    { lease: DurableJobLease; abort: AbortController; promise: Promise<void> }
  >();

  constructor(options: EmbeddedDurableJobWorkerOptions) {
    this.service = options.service;
    this.handlers = options.handlers;
    this.isActorAuthorized = options.isActorAuthorized;
    this.workerId = options.workerId ?? `embedded-${crypto.randomUUID()}`;
    this.leaseMs = options.leaseMs ?? 30_000;
    this.pollIntervalMs = options.pollIntervalMs ?? 500;
    this.maxRetryBackoffMs = options.maxRetryBackoffMs ?? 60_000;
    this.reconcileBeforePolling = options.reconcileBeforePolling;
    this.shutdownTimeoutMs =
      options.shutdownTimeoutMs ?? Math.min(5000, Math.floor(this.leaseMs / 2));
    const random = options.random ?? Math.random;
    if (typeof random !== 'function') {
      throw new Error('Invalid durable job worker random source');
    }
    const firstRandom = random();
    if (!Number.isFinite(firstRandom) || firstRandom < 0 || firstRandom > 1) {
      throw new Error(
        'Durable job worker random source must return a number from 0 to 1'
      );
    }
    let bufferedRandom: number | undefined = firstRandom;
    this.random = () => {
      if (bufferedRandom !== undefined) {
        const value = bufferedRandom;
        bufferedRandom = undefined;
        return value;
      }
      const value = random();
      if (!Number.isFinite(value) || value < 0 || value > 1) {
        // A custom source that violates its contract after construction is a
        // configuration failure. The constructor validates the first sample;
        // this guard prevents an invalid backoff from reaching persistence.
        throw new Error(
          'Durable job worker random source must return a number from 0 to 1'
        );
      }
      return value;
    };
    if (
      !Number.isSafeInteger(this.leaseMs) ||
      this.leaseMs < MIN_LEASE_MS ||
      this.leaseMs > MAX_LEASE_MS
    ) {
      throw new Error(
        `Durable job worker lease must be between ${MIN_LEASE_MS} and ${MAX_LEASE_MS} ms`
      );
    }
    if (
      !Number.isSafeInteger(this.pollIntervalMs) ||
      this.pollIntervalMs < 10 ||
      this.pollIntervalMs > 60_000
    ) {
      throw new Error('Invalid durable job worker poll interval');
    }
    if (
      !Number.isSafeInteger(this.maxRetryBackoffMs) ||
      this.maxRetryBackoffMs < MIN_RETRY_BACKOFF_MS ||
      this.maxRetryBackoffMs > MAX_RETRY_BACKOFF_MS
    ) {
      throw new Error(
        `Durable job worker retry backoff must be between ${MIN_RETRY_BACKOFF_MS} and ${MAX_RETRY_BACKOFF_MS} ms`
      );
    }
    if (
      !Number.isSafeInteger(this.shutdownTimeoutMs) ||
      this.shutdownTimeoutMs < 100 ||
      this.shutdownTimeoutMs > Math.floor(this.leaseMs / 2)
    ) {
      throw new Error(
        'Durable job worker shutdown timeout must fit within half its lease'
      );
    }
  }

  start(): void {
    if (this.shutdown.signal.aborted) {
      throw new Error('A stopped durable job worker cannot restart');
    }
    if (this.loopPromise) return;
    this.loopPromise = this.runLoop().catch(error => {
      this.loopError =
        error instanceof Error
          ? error
          : new Error('Embedded durable worker loop failed');
      this.pollHealthy = false;
      this.shutdown.abort(this.loopError);
    });
  }

  isOperational(): boolean {
    return (
      Boolean(this.loopPromise) &&
      !this.shutdown.signal.aborted &&
      !this.loopError &&
      this.pollHealthy
    );
  }

  private async runLoop(): Promise<void> {
    await this.reconcileBeforePolling?.();
    this.pollHealthy = true;
    while (!this.shutdown.signal.aborted) {
      const lease = this.service.claim(this.workerId, this.leaseMs);
      if (!lease) {
        await delay(this.pollIntervalMs, this.shutdown.signal);
        continue;
      }
      const abort = new AbortController();
      const relayAbort = (): void => abort.abort(this.shutdown.signal.reason);
      this.shutdown.signal.addEventListener('abort', relayAbort, {
        once: true,
      });
      const promise = this.execute(lease, abort).finally(() => {
        this.shutdown.signal.removeEventListener('abort', relayAbort);
        this.active.delete(lease.id);
      });
      this.active.set(lease.id, { lease, abort, promise });
      await promise;
    }
  }

  private async assertActorAllowed(lease: DurableJobLease): Promise<void> {
    const beforeAuthorization = this.service.heartbeat(lease, this.leaseMs);
    if (!beforeAuthorization.owned) {
      throw new DurableJobError('lease-lost', 'The durable job lease was lost');
    }
    if (beforeAuthorization.cancellationRequested) {
      throw new DurableJobError('cancelled', 'The durable job was cancelled');
    }
    if (!(await this.isActorAuthorized(lease.actorUserId, lease.jobType))) {
      throw new DurableJobExecutionError(
        false,
        'actor-revoked',
        'The durable job actor is no longer authorized'
      );
    }
    // Authorization can involve I/O. Recheck the lease after it returns so a
    // worker cannot proceed on an authorization result obtained before a
    // concurrent reclaim or cancellation.
    const afterAuthorization = this.service.heartbeat(lease, this.leaseMs);
    if (!afterAuthorization.owned) {
      throw new DurableJobError('lease-lost', 'The durable job lease was lost');
    }
    if (afterAuthorization.cancellationRequested) {
      throw new DurableJobError('cancelled', 'The durable job was cancelled');
    }
  }

  private retryBackoff(attemptCount: number): number {
    const exponential = Math.min(
      this.maxRetryBackoffMs,
      1000 * 2 ** Math.max(0, attemptCount - 1)
    );
    return Math.floor(exponential * (0.5 + this.random() * 0.5));
  }

  private reconcileTerminalLifecycleJob(
    lease: DurableJobLease,
    state: DurableJobState
  ): void {
    if (
      (state !== 'cancelled' && state !== 'dead_letter') ||
      (lease.jobType !== RESOURCE_DELETE_JOB_TYPE &&
        lease.jobType !== OWNER_DELETE_CONTENT_JOB_TYPE)
    ) {
      return;
    }
    try {
      this.service.reconcileDeletionLifecycleJob(lease.id);
    } catch {
      // The service retains the exact terminal ID and retries it before the
      // next claim. Do not stop an otherwise healthy worker after the
      // terminal transition itself has already committed.
    }
  }

  private async execute(
    lease: DurableJobLease,
    abort: AbortController
  ): Promise<void> {
    const handler = this.handlers.get(lease.jobType);
    if (!handler) {
      const state = this.service.fail(lease, {
        retryable: false,
        errorCode: 'unsupported-job-type',
        errorSummary: 'No handler is registered for this durable job type',
        backoffMs: 0,
      });
      this.reconcileTerminalLifecycleJob(lease, state);
      return;
    }

    const heartbeatInterval = Math.max(250, Math.floor(this.leaseMs / 3));
    const heartbeat = setInterval(() => {
      try {
        const result = this.service.heartbeat(lease, this.leaseMs);
        if (!result.owned || result.cancellationRequested) abort.abort();
      } catch {
        abort.abort();
      }
    }, heartbeatInterval);
    heartbeat.unref?.();

    try {
      await this.assertActorAllowed(lease);
      const payload = this.service.readPayload(lease);
      const result = await handler({
        signal: abort.signal,
        payload,
        actorUserId: lease.actorUserId,
        attemptCount: lease.attemptCount,
        sideEffectLease: {
          jobId: lease.id,
          workerId: lease.workerId,
          leaseToken: lease.leaseToken,
        },
        reportProgress: progress =>
          this.service.reportProgress(lease, progress),
        assertSideEffectAllowed: () => this.assertActorAllowed(lease),
      });
      await this.assertActorAllowed(lease);
      this.service.complete(lease, result?.resultReference);
      if (
        lease.jobType === RESOURCE_DELETE_JOB_TYPE ||
        lease.jobType === OWNER_DELETE_CONTENT_JOB_TYPE
      ) {
        const metadata = this.service.getMetadata(lease.id);
        if (metadata) {
          this.reconcileTerminalLifecycleJob(lease, metadata.state);
        }
      }
    } catch (error) {
      if (error instanceof DurableJobError && error.code === 'lease-lost') {
        return;
      }
      const safe = safeExecutionError(error);
      try {
        let failure = safe;
        let backoffMs = 0;
        if (safe.retryable) {
          try {
            backoffMs = this.retryBackoff(lease.attemptCount);
          } catch {
            // A custom entropy source can violate its contract after its
            // constructor sample. Do not let that reject the worker loop or
            // persist an invalid delay; fail this job with redacted metadata.
            failure = {
              retryable: false,
              errorCode: 'worker-configuration-invalid',
              errorSummary: 'The durable job worker configuration is invalid',
            };
          }
        }
        const state = this.service.fail(lease, {
          ...failure,
          backoffMs,
        });
        this.reconcileTerminalLifecycleJob(lease, state);
      } catch (failure) {
        if (
          !(failure instanceof DurableJobError) ||
          failure.code !== 'lease-lost'
        ) {
          throw failure;
        }
      }
    } finally {
      clearInterval(heartbeat);
    }
  }

  async stop(): Promise<EmbeddedDurableJobWorkerStopResult> {
    this.shutdown.abort();
    const activeAtStop = this.active.size;
    for (const item of this.active.values()) item.abort.abort();
    const loop = this.loopPromise;
    const drainPromises = [
      ...(loop ? [loop] : []),
      ...[...this.active.values()].map(item => item.promise),
    ];
    let timeout: NodeJS.Timeout | undefined;
    const drained = await Promise.race([
      Promise.allSettled(drainPromises).then(() => true),
      new Promise<boolean>(resolve => {
        timeout = setTimeout(() => resolve(false), this.shutdownTimeoutMs);
      }),
    ]);
    if (timeout) clearTimeout(timeout);

    let abandoned = 0;
    let failed = this.loopError ? 1 : 0;
    // If a handler ignores AbortSignal, fencing still protects persisted job
    // state. After this release, a new claimant advances the lease token, so
    // the old handler cannot heartbeat or complete. External side effects must
    // also be idempotent and guarded by assertSideEffectAllowed().
    for (const item of this.active.values()) {
      try {
        const state = this.service.abandon(item.lease);
        if (state === 'queued' || state === 'cancelled') abandoned += 1;
      } catch (error) {
        if (
          !(error instanceof DurableJobError) ||
          error.code !== 'lease-lost'
        ) {
          failed += 1;
        }
      }
    }
    this.active.clear();
    if (drained) this.loopPromise = null;
    if (this.loopError) failed = 1;
    return { activeAtStop, abandoned, failed };
  }
}
