/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import crypto from 'node:crypto';
import {
  DurableJobError,
  DurableJobExecutionError,
  type DurableJobLease,
  type DurableJobState,
} from './durableJobTypes.js';
import {
  DEFAULT_AUTHORITY_RECHECK_INTERVAL_MS,
  DEFAULT_MAX_CONCURRENT_JOBS,
  MAX_AUTHORITY_RECHECK_INTERVAL_MS,
  MAX_CONCURRENT_JOBS_LIMIT,
  type DurableJobHandler,
} from './embeddedDurableJobWorker.js';
import { PostgresDurableJobService } from './postgresDurableJobService.js';
import {
  OWNER_DELETE_CONTENT_JOB_TYPE,
  RESOURCE_DELETE_JOB_TYPE,
} from './domainJobContracts.js';

const MIN_LEASE_MS = 1_000;
const MAX_LEASE_MS = 15 * 60_000;

export const waitForPostgresWorkerPoll = (
  milliseconds: number,
  signal: AbortSignal
): Promise<void> =>
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
    signal.addEventListener('abort', finish, { once: true });
  });

export interface PostgresDurableJobWorkerOptions {
  service: PostgresDurableJobService;
  handlers: ReadonlyMap<string, DurableJobHandler>;
  isActorAuthorized(actorUserId: string, jobType: string): Promise<boolean>;
  workerId?: string;
  leaseMs?: number;
  pollIntervalMs?: number;
  shutdownTimeoutMs?: number;
  maxConcurrentJobs?: number;
  /** 0 revalidates actor authority on every side-effect assertion. */
  authorityRecheckIntervalMs?: number;
  /** Reconcile cleanup-only dead letters before this worker can claim work. */
  reconcileBeforePolling?(): unknown | Promise<unknown>;
}

/** Async pooled-database worker; every state transition awaits PostgreSQL. */
export class PostgresDurableJobWorker {
  readonly workerId: string;
  private readonly shutdown = new AbortController();
  private readonly leaseMs: number;
  private readonly pollIntervalMs: number;
  private readonly shutdownTimeoutMs: number;
  private loop?: Promise<void>;
  private loopError?: Error;
  private pollHealthy = false;
  private consecutivePollFailures = 0;
  private readonly maxConcurrentJobs: number;
  private readonly authorityRecheckIntervalMs: number;
  private readonly active = new Map<
    string,
    { lease: DurableJobLease; abort: AbortController; promise: Promise<void> }
  >();

  constructor(private readonly options: PostgresDurableJobWorkerOptions) {
    this.workerId = options.workerId ?? `postgres-${crypto.randomUUID()}`;
    this.leaseMs = options.leaseMs ?? 30_000;
    this.pollIntervalMs = options.pollIntervalMs ?? 500;
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? 5_000;
    this.maxConcurrentJobs =
      options.maxConcurrentJobs ?? DEFAULT_MAX_CONCURRENT_JOBS;
    this.authorityRecheckIntervalMs =
      options.authorityRecheckIntervalMs ??
      DEFAULT_AUTHORITY_RECHECK_INTERVAL_MS;
    if (
      !Number.isSafeInteger(this.leaseMs) ||
      this.leaseMs < MIN_LEASE_MS ||
      this.leaseMs > MAX_LEASE_MS
    ) {
      throw new Error(
        `PostgreSQL worker lease must be between ${MIN_LEASE_MS} and ${MAX_LEASE_MS} ms`
      );
    }
    if (
      !Number.isSafeInteger(this.pollIntervalMs) ||
      this.pollIntervalMs < 10 ||
      this.pollIntervalMs > 60_000
    ) {
      throw new Error('Invalid PostgreSQL worker poll interval');
    }
    if (
      !Number.isSafeInteger(this.shutdownTimeoutMs) ||
      this.shutdownTimeoutMs < 100 ||
      this.shutdownTimeoutMs > Math.floor(this.leaseMs / 2)
    ) {
      throw new Error(
        'PostgreSQL worker shutdown timeout must fit within half its lease'
      );
    }
    if (
      !Number.isSafeInteger(this.maxConcurrentJobs) ||
      this.maxConcurrentJobs < 1 ||
      this.maxConcurrentJobs > MAX_CONCURRENT_JOBS_LIMIT
    ) {
      throw new Error(
        `PostgreSQL worker concurrency must be between 1 and ${MAX_CONCURRENT_JOBS_LIMIT}`
      );
    }
    if (
      !Number.isSafeInteger(this.authorityRecheckIntervalMs) ||
      this.authorityRecheckIntervalMs < 0 ||
      this.authorityRecheckIntervalMs > MAX_AUTHORITY_RECHECK_INTERVAL_MS
    ) {
      throw new Error(
        `PostgreSQL worker authority recheck interval must be between 0 and ${MAX_AUTHORITY_RECHECK_INTERVAL_MS} ms`
      );
    }
  }

  start(): void {
    if (this.shutdown.signal.aborted)
      throw new Error('A stopped PostgreSQL worker cannot restart');
    this.loop ||= this.run().catch(error => {
      this.loopError =
        error instanceof Error
          ? error
          : new Error('PostgreSQL durable worker loop failed');
      this.shutdown.abort(this.loopError);
    });
  }

  isOperational(): boolean {
    return (
      Boolean(this.loop) &&
      !this.shutdown.signal.aborted &&
      !this.loopError &&
      this.pollHealthy
    );
  }

  /**
   * Abort one active handler immediately, ahead of the heartbeat noticing a
   * durable cancellation. SQL remains authoritative: a wake for a job this
   * worker does not hold is a no-op.
   */
  abortJob(jobId: string): boolean {
    const item = this.active.get(jobId);
    if (!item) return false;
    item.abort.abort();
    return true;
  }

  private async run(): Promise<void> {
    await this.options.reconcileBeforePolling?.();
    while (!this.shutdown.signal.aborted) {
      if (this.active.size >= this.maxConcurrentJobs) {
        await Promise.race([...this.active.values()].map(item => item.promise));
        continue;
      }
      let lease: DurableJobLease | null;
      try {
        lease = await this.options.service.claim(this.workerId, this.leaseMs);
        this.pollHealthy = true;
        this.consecutivePollFailures = 0;
      } catch {
        this.pollHealthy = false;
        this.consecutivePollFailures += 1;
        await waitForPostgresWorkerPoll(
          Math.min(
            30_000,
            this.pollIntervalMs *
              2 ** Math.min(8, this.consecutivePollFailures - 1)
          ),
          this.shutdown.signal
        );
        continue;
      }
      if (!lease) {
        // A finishing job can commit an immediately claimable follow-up
        // (retry, lifecycle reconcile), so completions cut the poll wait.
        await Promise.race([
          waitForPostgresWorkerPoll(this.pollIntervalMs, this.shutdown.signal),
          ...[...this.active.values()].map(item => item.promise),
        ]);
        continue;
      }
      const abort = new AbortController();
      const promise = this.execute(lease, abort)
        .catch(error => {
          // execute() resolves its own failures; anything landing here would
          // otherwise be an unhandled rejection, so treat it as a loop
          // failure: unhealthy and shutting down.
          const failure =
            error instanceof Error
              ? error
              : new Error('PostgreSQL durable worker loop failed');
          this.loopError ??= failure;
          this.pollHealthy = false;
          this.shutdown.abort(failure);
        })
        .finally(() => {
          this.active.delete(lease.id);
        });
      this.active.set(lease.id, { lease, abort, promise });
    }
    // The loop only returns once every spawned handler has settled, so a
    // caller awaiting the loop cannot observe running work it does not know
    // about. Promises above never reject.
    await Promise.all([...this.active.values()].map(item => item.promise));
  }

  private async allowed(lease: DurableJobLease): Promise<void> {
    const before = await this.options.service.heartbeat(lease, this.leaseMs);
    if (!before.owned)
      throw new DurableJobError('lease-lost', 'The durable job lease was lost');
    if (before.cancellationRequested)
      throw new DurableJobError('cancelled', 'The durable job was cancelled');
    if (
      !(await this.options.isActorAuthorized(lease.actorUserId, lease.jobType))
    ) {
      throw new DurableJobExecutionError(
        false,
        'actor-revoked',
        'The durable job actor is no longer authorized'
      );
    }
    const after = await this.options.service.heartbeat(lease, this.leaseMs);
    if (!after.owned)
      throw new DurableJobError('lease-lost', 'The durable job lease was lost');
    if (after.cancellationRequested)
      throw new DurableJobError('cancelled', 'The durable job was cancelled');
  }

  private async reconcileTerminalLifecycleJob(
    lease: DurableJobLease,
    state: DurableJobState
  ): Promise<void> {
    if (
      (state !== 'cancelled' && state !== 'dead_letter') ||
      (lease.jobType !== RESOURCE_DELETE_JOB_TYPE &&
        lease.jobType !== OWNER_DELETE_CONTENT_JOB_TYPE)
    ) {
      return;
    }
    try {
      await this.options.service.reconcileDeletionLifecycleJob(lease.id);
    } catch {
      // The service retains the exact terminal ID for its next poll. The
      // terminal state has already committed, so this must not kill the
      // consumer loop or leave readiness falsely healthy with no poller.
    }
  }

  private async execute(
    lease: DurableJobLease,
    abort: AbortController
  ): Promise<void> {
    const handler = this.options.handlers.get(lease.jobType);
    if (!handler) {
      try {
        const state = await this.options.service.fail(lease, {
          retryable: false,
          errorCode: 'unsupported-job-type',
          errorSummary: 'No handler is registered for this durable job type',
          backoffMs: 0,
        });
        await this.reconcileTerminalLifecycleJob(lease, state);
      } catch (failure) {
        await this.resolveFailureAcknowledgement(lease, failure);
      }
      return;
    }
    const heartbeat = setInterval(
      () => {
        void this.options.service
          .heartbeat(lease, this.leaseMs)
          .then(result => {
            if (!result.owned || result.cancellationRequested) abort.abort();
          })
          .catch(() => abort.abort());
      },
      Math.max(250, Math.floor(this.leaseMs / 3))
    );
    heartbeat.unref?.();
    // Every side-effect assertion checks lease ownership and cancellation
    // through a read-only lookup. The full check, which also extends the
    // lease and revalidates actor authority, is throttled so streaming
    // handlers asserting per token batch do not pay two lease writes and an
    // authorization read each time. The heartbeat timer keeps the lease
    // alive independently.
    let lastAuthorityCheckAt = 0;
    const assertSideEffectAllowed = async (): Promise<void> => {
      const timestamp = Date.now();
      if (
        this.authorityRecheckIntervalMs === 0 ||
        timestamp - lastAuthorityCheckAt >= this.authorityRecheckIntervalMs
      ) {
        await this.allowed(lease);
        lastAuthorityCheckAt = timestamp;
        return;
      }
      const state = await this.options.service.inspectLease(lease);
      if (!state.owned) {
        throw new DurableJobError(
          'lease-lost',
          'The durable job lease was lost'
        );
      }
      if (state.cancellationRequested) {
        throw new DurableJobError('cancelled', 'The durable job was cancelled');
      }
    };
    try {
      await this.allowed(lease);
      lastAuthorityCheckAt = Date.now();
      const payload = await this.options.service.readPayload(lease);
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
          this.options.service.reportProgress(lease, progress),
        assertSideEffectAllowed,
      });
      await this.allowed(lease);
      try {
        await this.options.service.complete(lease, result?.resultReference);
        if (
          lease.jobType === RESOURCE_DELETE_JOB_TYPE ||
          lease.jobType === OWNER_DELETE_CONTENT_JOB_TYPE
        ) {
          const metadata = await this.options.service.getMetadata(lease.id);
          if (metadata) {
            await this.reconcileTerminalLifecycleJob(lease, metadata.state);
          }
        }
      } catch (completionFailure) {
        // COMMIT may have succeeded while the connection lost only the
        // acknowledgement. Resolve the durable terminal state before treating
        // a successful handler as failed; otherwise a succeeded job can be
        // spuriously retried and repeat its external effect.
        try {
          const metadata = await this.options.service.getMetadata(lease.id);
          if (
            metadata &&
            (metadata.state === 'succeeded' || metadata.state === 'cancelled')
          ) {
            if (metadata.state === 'cancelled') {
              await this.reconcileTerminalLifecycleJob(lease, metadata.state);
            }
            return;
          }
        } catch {
          // The outer failure path will leave an unavailable row to its
          // bounded lease/reclaim semantics without stopping the poll loop.
        }
        throw completionFailure;
      }
    } catch (error) {
      if (error instanceof DurableJobError && error.code === 'lease-lost')
        return;
      const safe =
        error instanceof DurableJobExecutionError
          ? error
          : error instanceof DurableJobError && error.code === 'cancelled'
            ? new DurableJobExecutionError(
                false,
                'cancelled',
                'The durable job was cancelled'
              )
            : new DurableJobExecutionError(
                true,
                'handler-failed',
                'The durable job handler failed'
              );
      try {
        const state = await this.options.service.fail(lease, {
          retryable: safe.retryable,
          errorCode: safe.safeCode,
          errorSummary: safe.safeSummary,
          backoffMs: safe.retryable
            ? Math.min(60_000, 1_000 * 2 ** Math.max(0, lease.attemptCount - 1))
            : 0,
        });
        await this.reconcileTerminalLifecycleJob(lease, state);
      } catch (failure) {
        await this.resolveFailureAcknowledgement(lease, failure);
      }
    } finally {
      clearInterval(heartbeat);
    }
  }

  private async resolveFailureAcknowledgement(
    lease: DurableJobLease,
    failure: unknown
  ): Promise<void> {
    if (failure instanceof DurableJobError && failure.code === 'lease-lost') {
      return;
    }
    // A retry/dead-letter transition may have committed before the connection
    // lost its acknowledgement. Never kill the poll loop or blindly repeat
    // it. SQL is authoritative; a still-running row is reclaimed after its
    // bounded lease expires.
    try {
      const metadata = await this.options.service.getMetadata(lease.id);
      if (metadata) {
        await this.reconcileTerminalLifecycleJob(lease, metadata.state);
      }
    } catch {
      // The transition may have committed while both acknowledgements were
      // lost. Queue the exact lifecycle ID even while PostgreSQL is down so a
      // healthy long-lived worker retries it on its next poll rather than
      // waiting for a process restart.
      if (
        lease.jobType === RESOURCE_DELETE_JOB_TYPE ||
        lease.jobType === OWNER_DELETE_CONTENT_JOB_TYPE
      ) {
        try {
          await this.options.service.reconcileDeletionLifecycleJob(lease.id);
        } catch {
          // The service retains the ID until a later claim can reconcile it.
        }
      }
    }
  }

  async stop(): Promise<{
    activeAtStop: number;
    abandoned: number;
    failed: number;
  }> {
    this.shutdown.abort();
    const activeAtStop = this.active.size;
    for (const item of this.active.values()) item.abort.abort();
    const drainPromises = [...this.active.values()].map(item => item.promise);
    if (drainPromises.length > 0) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        Promise.allSettled(drainPromises),
        new Promise<void>(resolve => {
          timer = setTimeout(resolve, this.shutdownTimeoutMs);
        }),
      ]);
      if (timer) clearTimeout(timer);
    }
    let abandoned = 0;
    let failed = this.loopError ? 1 : 0;
    // Anything still active ignored its abort within the timeout; release the
    // leases so another worker can reclaim immediately.
    for (const item of this.active.values()) {
      try {
        const state = await this.options.service.abandon(item.lease);
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
    if (this.loop) {
      const loopStopped = await Promise.race([
        this.loop.then(() => true),
        new Promise<boolean>(resolve => {
          const timer = setTimeout(
            () => resolve(false),
            this.shutdownTimeoutMs
          );
          timer.unref?.();
        }),
      ]);
      if (!loopStopped) failed = 1;
    }
    if (this.loopError) failed = 1;
    return { activeAtStop, abandoned, failed };
  }
}
