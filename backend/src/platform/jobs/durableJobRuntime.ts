/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import { getInitializedPersistence } from '../../persistence/index.js';
import {
  type DurableJobHandler,
  type EmbeddedDurableJobWorkerStopResult,
} from './embeddedDurableJobWorker.js';
import {
  createDurableJobRuntimeBackend,
  type DurableJobRuntimeService,
  type DurableJobRuntimeWorker,
  type DurableWorkerRole,
} from './durableJobRuntimeBackend.js';

export type { DurableJobRuntimeService, DurableWorkerRole };

export interface DurableJobRuntimeOptions {
  role: DurableWorkerRole;
  handlers: ReadonlyMap<string, DurableJobHandler>;
  env?: NodeJS.ProcessEnv;
  isActorAuthorized?: (
    actorUserId: string,
    jobType: string
  ) => Promise<boolean>;
  workerId?: string;
  maxConcurrentJobs?: number;
  /** Aged-history retention windows; omitted disables the sweep. */
  retention?: {
    chatStreamEventMs: number;
    eventMs: number;
    jobMs: number;
  };
  /** App replicas in external mode expose enqueue/query without claiming work. */
  runWorker?: boolean;
}

const PRUNE_INITIAL_DELAY_MS = 30_000;
const PRUNE_INTERVAL_MS = 60 * 60_000;
const PRUNE_PASS_LIMIT = 5_000;
const PRUNE_MAX_PASSES_PER_SWEEP = 10;

export interface DurableJobRuntimeStatus {
  started: boolean;
  role: DurableWorkerRole;
  workerId: string | null;
  registeredJobTypes: string[];
  workerHealthy: boolean;
}

/**
 * Operational owner for a durable-job service and one worker loop. HTTP and
 * standalone worker processes use the same bootstrap and shutdown path.
 */
export class DurableJobRuntime {
  readonly service: DurableJobRuntimeService;
  private readonly worker: DurableJobRuntimeWorker;
  private started = false;
  private pruneTimers: NodeJS.Timeout[] = [];
  private pruning = false;

  constructor(private readonly options: DurableJobRuntimeOptions) {
    const selected = getInitializedPersistence();
    if (!selected) {
      throw new Error(
        'Durable job runtime requires initialized platform persistence.'
      );
    }
    const backend = createDurableJobRuntimeBackend(selected, options);
    this.service = backend.service;
    this.worker = backend.worker;
  }

  start(): void {
    if (this.started) return;
    if (this.options.runWorker !== false) {
      this.worker.start();
      this.scheduleHistoryPruning();
    }
    this.started = true;
  }

  /**
   * Hourly bounded sweep of aged events and terminal jobs, plus one early
   * pass shortly after start so a backlogged instance begins draining without
   * waiting a full interval. Only the worker role prunes, so team replicas
   * never race the external worker.
   */
  private scheduleHistoryPruning(): void {
    const retention = this.options.retention;
    if (!retention) return;
    const sweep = (): void => {
      if (this.pruning) return;
      this.pruning = true;
      void (async () => {
        try {
          for (let pass = 0; pass < PRUNE_MAX_PASSES_PER_SWEEP; pass += 1) {
            const now = Date.now();
            const removed = await this.service.pruneHistory({
              chatStreamEventCutoff: now - retention.chatStreamEventMs,
              eventCutoff: now - retention.eventMs,
              jobCutoff: now - retention.jobMs,
              limit: PRUNE_PASS_LIMIT,
            });
            if (
              removed.chatStreamEvents < PRUNE_PASS_LIMIT &&
              removed.events < PRUNE_PASS_LIMIT &&
              removed.jobs < PRUNE_PASS_LIMIT
            ) {
              break;
            }
          }
        } catch {
          // Retention is best effort; the next sweep retries.
        } finally {
          this.pruning = false;
        }
      })();
    };
    const initial = setTimeout(sweep, PRUNE_INITIAL_DELAY_MS);
    initial.unref?.();
    const interval = setInterval(sweep, PRUNE_INTERVAL_MS);
    interval.unref?.();
    this.pruneTimers = [initial, interval];
  }

  status(): DurableJobRuntimeStatus {
    return {
      started: this.started,
      role: this.options.role,
      workerId:
        this.started && this.options.runWorker !== false
          ? this.worker.workerId
          : null,
      registeredJobTypes: [...this.options.handlers.keys()].sort(),
      workerHealthy:
        this.options.runWorker === false || this.worker.isOperational(),
    };
  }

  async stop(): Promise<EmbeddedDurableJobWorkerStopResult> {
    for (const timer of this.pruneTimers) clearTimeout(timer);
    this.pruneTimers = [];
    if (!this.started || this.options.runWorker === false) {
      this.started = false;
      return { activeAtStop: 0, abandoned: 0, failed: 0 };
    }
    this.started = false;
    return this.worker.stop();
  }
}

let runtime: DurableJobRuntime | undefined;

export const initializeDurableJobRuntime = (
  options: DurableJobRuntimeOptions
): DurableJobRuntime => {
  if (runtime) throw new Error('Durable job runtime is already initialized.');
  runtime = new DurableJobRuntime(options);
  runtime.start();
  return runtime;
};

export const getDurableJobRuntime = (): DurableJobRuntime => {
  if (!runtime) throw new Error('Durable job runtime is not initialized.');
  return runtime;
};

export const closeDurableJobRuntime =
  async (): Promise<EmbeddedDurableJobWorkerStopResult> => {
    const current = runtime;
    runtime = undefined;
    return current?.stop() ?? { activeAtStop: 0, abandoned: 0, failed: 0 };
  };
