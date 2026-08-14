/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import {
  getInitializedPersistence,
  getPostgresAdapterDatabase,
  getSQLiteAdapterDatabase,
} from '../../persistence/index.js';
import { createStorageKeyringFromEnvironment } from '../storage/index.js';
import { DurableJobService } from './durableJobService.js';
import {
  EmbeddedDurableJobWorker,
  type DurableJobHandler,
  type EmbeddedDurableJobWorkerStopResult,
} from './embeddedDurableJobWorker.js';
import { SQLiteDurableJobRepository } from './sqliteDurableJobRepository.js';
import { PostgresDurableJobRepository } from './postgresDurableJobRepository.js';
import { PostgresDurableJobService } from './postgresDurableJobService.js';
import { PostgresDurableJobWorker } from './postgresDurableJobWorker.js';
import { OWNER_DELETE_CONTENT_JOB_TYPE } from './domainJobContracts.js';

export type DurableWorkerRole = 'embedded' | 'external';

export interface DurableJobRuntimeOptions {
  role: DurableWorkerRole;
  handlers: ReadonlyMap<string, DurableJobHandler>;
  database?: Database.Database;
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

export type DurableJobRuntimeService =
  DurableJobService | PostgresDurableJobService;

type RuntimeWorker = EmbeddedDurableJobWorker | PostgresDurableJobWorker;

/**
 * Operational owner for a durable-job service and one worker loop. HTTP and
 * standalone worker processes use the same bootstrap and shutdown path.
 */
export class DurableJobRuntime {
  readonly service: DurableJobRuntimeService;
  private readonly worker: RuntimeWorker;
  private started = false;

  constructor(private readonly options: DurableJobRuntimeOptions) {
    const selected = getInitializedPersistence();
    const dialect = options.database ? 'sqlite' : selected?.dialect;
    if (!dialect) {
      throw new Error(
        'Durable job runtime requires initialized platform persistence.'
      );
    }
    const keyring = createStorageKeyringFromEnvironment(
      options.env ?? process.env
    );
    const workerId =
      options.workerId ?? `${options.role}-${process.pid}-${randomUUID()}`;

    if (dialect === 'postgres') {
      const database = getPostgresAdapterDatabase();
      const service = new PostgresDurableJobService(
        new PostgresDurableJobRepository(database),
        keyring
      );
      this.service = service;
      this.worker = new PostgresDurableJobWorker({
        service,
        handlers: options.handlers,
        workerId,
        reconcileBeforePolling: () => service.reconcileDeletionLifecycleJobs(),
        isActorAuthorized:
          options.isActorAuthorized ??
          (async (actorUserId, jobType) => {
            const result = await database.query<{ account_status: string }>(
              'SELECT account_status FROM users WHERE id = $1',
              [actorUserId]
            );
            const status = result.rows[0]?.account_status;
            return (
              status === 'active' ||
              (status === 'retiring' &&
                jobType === OWNER_DELETE_CONTENT_JOB_TYPE)
            );
          }),
      });
      return;
    }

    const database = options.database ?? getSQLiteAdapterDatabase();
    const service = new DurableJobService(
      new SQLiteDurableJobRepository(database),
      keyring
    );
    this.service = service;
    this.worker = new EmbeddedDurableJobWorker({
      service,
      handlers: options.handlers,
      workerId,
      reconcileBeforePolling: () => service.reconcileDeletionLifecycleJobs(),
      isActorAuthorized:
        options.isActorAuthorized ??
        (async (actorUserId, jobType) => {
          const row = database
            .prepare('SELECT account_status FROM users WHERE id = ?')
            .get(actorUserId) as { account_status: string } | undefined;
          return (
            row?.account_status === 'active' ||
            (row?.account_status === 'retiring' &&
              jobType === OWNER_DELETE_CONTENT_JOB_TYPE)
          );
        }),
    });
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
