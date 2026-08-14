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
  /** App replicas in external mode expose enqueue/query without claiming work. */
  runWorker?: boolean;
}

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
    if (this.options.runWorker !== false) this.worker.start();
    this.started = true;
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
