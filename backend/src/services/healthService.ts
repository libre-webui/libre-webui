/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';

import type Database from 'better-sqlite3';

import {
  getInitializedPersistence,
  getSQLiteHealthDatabase,
  type Persistence,
} from '../persistence/index.js';
import { inspectSQLiteSchema } from '../persistence/sqliteMigrations.js';
import { loadAppPackage } from '../utils/packagePaths.js';
import { resolveDataDirectory } from '../utils/dataDirectory.js';

export type HealthDepth = 'ready' | 'deep';
export type HealthCheckStatus = 'pass' | 'warn' | 'fail';

export interface HealthCheckResult {
  id: string;
  status: HealthCheckStatus;
  required: boolean;
  latencyMs: number;
  message?: string;
  details?: Record<string, unknown>;
}

export interface HealthReport {
  status: 'ready' | 'not_ready';
  timestamp: string;
  version: string;
  checks: HealthCheckResult[];
}

export interface PublicHealthReport {
  status: 'ready' | 'not_ready';
  timestamp: string;
  version: string;
  checks: Array<
    Pick<HealthCheckResult, 'id' | 'status' | 'required' | 'latencyMs'>
  >;
}

export interface HealthDependencyCheck {
  id: string;
  required: boolean;
  check: (
    depth: HealthDepth
  ) => Promise<Omit<HealthCheckResult, 'id' | 'required' | 'latencyMs'>>;
}

export interface HealthServiceDependencies {
  getDatabase: () => Database.Database | null;
  getPersistence: () => Persistence | undefined;
  getDataDir: () => string;
  now: () => Date;
}

const defaultDependencies: HealthServiceDependencies = {
  getDatabase: () => getSQLiteHealthDatabase(),
  getPersistence: () => getInitializedPersistence(),
  getDataDir: () => resolveDataDirectory(),
  now: () => new Date(),
};

const elapsedMs = (started: bigint): number =>
  Number(process.hrtime.bigint() - started) / 1_000_000;

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const READINESS_CACHE_MS = 2_000;
const HEALTH_CHECK_TIMEOUT_MS = 3_000;
const SQLITE_INTEGRITY_TIMEOUT_MS = 2_500;
const betterSqlite3ModulePath = createRequire(import.meta.url).resolve(
  'better-sqlite3'
);

interface SQLiteIntegrityResult {
  healthy: boolean;
  foreignKeyViolations: number;
}

// Keep the potentially expensive integrity scan off the HTTP event loop. The
// worker is evaluated as CommonJS so it works from both tsx development and
// the compiled ESM application without a second build/runtime entrypoint.
const SQLITE_INTEGRITY_WORKER_SOURCE = String.raw`
  const { parentPort, workerData } = require('node:worker_threads');
  const Database = require(workerData.betterSqlite3ModulePath);
  let database;
  try {
    database = new Database(workerData.databasePath, {
      readonly: true,
      fileMustExist: true,
    });
    database.pragma('query_only = ON');
    const quickCheck = database.pragma('quick_check(1)');
    const messages = quickCheck.flatMap(row =>
      Object.values(row).map(value => String(value))
    );
    // One row is enough to fail the check. Do not materialize every violation
    // from a damaged database inside the worker.
    const foreignKeyViolations = database
      .prepare('PRAGMA foreign_key_check')
      .get()
      ? 1
      : 0;
    parentPort.postMessage({
      ok: true,
      result: {
        healthy:
          messages.length === 1 &&
          messages[0].toLowerCase() === 'ok' &&
          foreignKeyViolations === 0,
        foreignKeyViolations,
      },
    });
  } catch {
    parentPort.postMessage({ ok: false });
  } finally {
    database?.close();
  }
`;

const runSQLiteIntegrityCheck = (
  databasePath: string
): Promise<SQLiteIntegrityResult> =>
  new Promise((resolve, reject) => {
    const worker = new Worker(SQLITE_INTEGRITY_WORKER_SOURCE, {
      eval: true,
      workerData: { databasePath, betterSqlite3ModulePath },
    });
    let settled = false;
    const finish = (callback: () => void, terminate = true): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.removeAllListeners();
      if (terminate) void worker.terminate();
      callback();
    };
    const timer = setTimeout(() => {
      finish(() => reject(new Error('SQLite integrity check timed out.')));
    }, SQLITE_INTEGRITY_TIMEOUT_MS);
    timer.unref?.();
    worker.once(
      'message',
      (message: { ok?: boolean; result?: SQLiteIntegrityResult }): void => {
        const result = message.result;
        if (message.ok && result) {
          finish(() => resolve(result));
          return;
        }
        finish(() => reject(new Error('SQLite integrity check failed.')));
      }
    );
    worker.once('error', () => {
      finish(() => reject(new Error('SQLite integrity check failed.')));
    });
    worker.once('exit', code => {
      if (code !== 0) {
        finish(
          () => reject(new Error('SQLite integrity worker exited early.')),
          false
        );
      }
    });
  });

/**
 * Required dependencies can register a check without coupling this service to
 * a specific coordination, job, blob, or database implementation. A team-mode
 * Redis adapter, for example, can register a required check at startup while
 * solo mode keeps only the built-in SQLite and local-storage checks.
 */
export class HealthService {
  private readonly dependencies: HealthServiceDependencies;
  private readonly registeredChecks = new Map<string, HealthDependencyCheck>();
  private readonly version: string;
  private readyCache?: {
    expiresAt: number;
    report: Promise<HealthReport>;
  };

  constructor(dependencies: Partial<HealthServiceDependencies> = {}) {
    this.dependencies = {
      ...defaultDependencies,
      ...dependencies,
      // Unit tests that inject a synthetic SQLite handle must not accidentally
      // observe the process-global persistence singleton.
      ...(dependencies.getDatabase && !dependencies.getPersistence
        ? { getPersistence: () => undefined }
        : {}),
    };
    this.version = loadAppPackage(import.meta.url).version || '0.0.0';
  }

  registerDependencyCheck(check: HealthDependencyCheck): () => void {
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(check.id)) {
      throw new Error(`Invalid health dependency identifier: ${check.id}`);
    }
    if (this.registeredChecks.has(check.id)) {
      throw new Error(`Health dependency is already registered: ${check.id}`);
    }
    this.registeredChecks.set(check.id, check);
    this.readyCache = undefined;
    return () => {
      if (this.registeredChecks.get(check.id) === check) {
        this.registeredChecks.delete(check.id);
        this.readyCache = undefined;
      }
    };
  }

  liveness(): {
    status: 'alive';
    timestamp: string;
    version: string;
  } {
    return {
      status: 'alive',
      timestamp: this.dependencies.now().toISOString(),
      version: this.version,
    };
  }

  async readiness(depth: HealthDepth = 'ready'): Promise<HealthReport> {
    if (depth === 'deep') return this.collectReadiness(depth);
    const now = Date.now();
    if (this.readyCache && this.readyCache.expiresAt > now) {
      return this.readyCache.report;
    }
    const report = this.collectReadiness(depth);
    this.readyCache = { expiresAt: now + READINESS_CACHE_MS, report };
    return report;
  }

  private async collectReadiness(depth: HealthDepth): Promise<HealthReport> {
    const builtInChecks: HealthDependencyCheck[] = [
      {
        id: 'database',
        required: true,
        check: requestedDepth => this.checkDatabase(requestedDepth),
      },
      {
        id: 'schema',
        required: true,
        check: () => this.checkSchema(),
      },
      {
        id: 'data_storage',
        required: true,
        check: () => this.checkDataStorage(),
      },
    ];
    const checks = await Promise.all(
      [...builtInChecks, ...this.registeredChecks.values()].map(check =>
        this.runCheck(check, depth)
      )
    );
    return {
      status: checks.some(check => check.required && check.status === 'fail')
        ? 'not_ready'
        : 'ready',
      timestamp: this.dependencies.now().toISOString(),
      version: this.version,
      checks,
    };
  }

  toPublicReport(report: HealthReport): PublicHealthReport {
    return {
      status: report.status,
      timestamp: report.timestamp,
      version: report.version,
      checks: report.checks.map(({ id, status, required, latencyMs }) => ({
        id,
        status,
        required,
        latencyMs,
      })),
    };
  }

  private async runCheck(
    dependency: HealthDependencyCheck,
    depth: HealthDepth
  ): Promise<HealthCheckResult> {
    const started = process.hrtime.bigint();
    let timer: NodeJS.Timeout | undefined;
    try {
      const result = await Promise.race([
        dependency.check(depth),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Health dependency check timed out.')),
            HEALTH_CHECK_TIMEOUT_MS
          );
          timer.unref?.();
        }),
      ]);
      return {
        id: dependency.id,
        required: dependency.required,
        ...result,
        latencyMs: elapsedMs(started),
      };
    } catch (error) {
      return {
        id: dependency.id,
        required: dependency.required,
        status: dependency.required ? 'fail' : 'warn',
        latencyMs: elapsedMs(started),
        message: errorMessage(error),
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async checkDatabase(
    depth: HealthDepth
  ): Promise<Omit<HealthCheckResult, 'id' | 'required' | 'latencyMs'>> {
    const database = this.dependencies.getDatabase();
    if (!database) {
      const persistence = this.dependencies.getPersistence();
      if (!persistence) {
        return {
          status: 'fail',
          message: 'The application database is unavailable.',
        };
      }
      const health = await persistence.health();
      return {
        status: health.ready ? 'pass' : 'fail',
        ...(health.message ? { message: health.message } : {}),
        details: {
          engine: health.dialect,
          ...(health.pool ? { pool: health.pool } : {}),
        },
      };
    }
    database.prepare('SELECT 1 AS healthy').get();
    if (depth !== 'deep') {
      return { status: 'pass' };
    }

    const databaseList = database.pragma('database_list') as Array<{
      name?: unknown;
      file?: unknown;
    }>;
    const databasePath = databaseList.find(row => row.name === 'main')?.file;
    if (typeof databasePath !== 'string' || databasePath.length === 0) {
      return {
        status: 'fail',
        message: 'SQLite integrity checks require a file-backed database.',
      };
    }
    const { healthy, foreignKeyViolations } =
      await runSQLiteIntegrityCheck(databasePath);
    return {
      status: healthy ? 'pass' : 'fail',
      ...(healthy
        ? {}
        : { message: 'SQLite integrity or foreign-key validation failed.' }),
      details: {
        engine: 'sqlite',
        quickCheck: healthy ? 'ok' : 'failed',
        foreignKeyViolations,
      },
    };
  }

  private async checkSchema(): Promise<
    Omit<HealthCheckResult, 'id' | 'required' | 'latencyMs'>
  > {
    const database = this.dependencies.getDatabase();
    if (!database) {
      const persistence = this.dependencies.getPersistence();
      if (!persistence) {
        return {
          status: 'fail',
          message: 'The application database is unavailable.',
        };
      }
      const health = await persistence.health();
      return {
        status: health.ready ? 'pass' : 'fail',
        ...(health.message ? { message: health.message } : {}),
        details: {
          dialect: health.dialect,
          status: health.ready ? 'compatible' : 'incompatible',
        },
      };
    }
    const schema = inspectSQLiteSchema(database);
    return {
      status: schema.compatible ? 'pass' : 'fail',
      ...(!schema.compatible
        ? {
            message:
              schema.reason || 'Required application schema is incompatible.',
          }
        : {}),
      details: {
        dialect: schema.dialect,
        status: schema.status,
        currentVersion: schema.currentVersion,
        targetVersion: schema.targetVersion,
        minimumSupportedVersion: schema.minimumSupportedVersion,
        ledgerPresent: schema.ledgerPresent,
        missing: schema.missing,
        appliedMigrations: schema.appliedMigrations.map(migration => ({
          version: migration.version,
          name: migration.name,
          checksumMatches: migration.checksumMatches,
        })),
      },
    };
  }

  private async checkDataStorage(): Promise<
    Omit<HealthCheckResult, 'id' | 'required' | 'latencyMs'>
  > {
    const dataDir = this.dependencies.getDataDir();
    try {
      const stat = await fs.promises.stat(dataDir);
      if (!stat.isDirectory()) {
        return {
          status: 'fail',
          message: 'The configured data storage path is not a directory.',
        };
      }
      await fs.promises.access(
        dataDir,
        fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK
      );
      const probePath = path.join(
        dataDir,
        `.libre-health-${process.pid}-${randomUUID()}`
      );
      let probe: fs.promises.FileHandle | undefined;
      try {
        probe = await fs.promises.open(probePath, 'wx', 0o600);
        await probe.writeFile('ready');
        await probe.sync();
      } finally {
        await probe?.close().catch(() => undefined);
        await fs.promises.unlink(probePath).catch(() => undefined);
      }
      return {
        status: 'pass',
        details: { storage: 'local', writable: true },
      };
    } catch {
      return {
        status: 'fail',
        message:
          'The configured data storage directory is unavailable or not writable.',
        details: { storage: 'local', writable: false },
      };
    }
  }
}

export const healthService = new HealthService();
export default healthService;
