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

/**
 * Scheduled verified recovery drills (RECOVERY-01).
 *
 * A drill proves the instance is actually recoverable, end to end, with the
 * same signed/encrypted pipeline operators use for real backups:
 *
 *   1. Stage a quiescent copy of the data directory (SQLite through the
 *      online backup API, blobs and files by physical copy).
 *   2. Create a signed, encrypted archive from the staged copy with
 *      ephemeral drill keys, running the full recovery inventory.
 *   3. Verify the archive, restore it into an isolated temporary target,
 *      and verify the restored environment again.
 *   4. Record measured timings — restore duration is the demonstrated RTO,
 *      and the spacing between successful drills bounds the achievable RPO
 *      of the current schedule — then delete every artifact.
 *
 * Drills are verification, not backups: nothing is retained. They run only
 * on the solo (SQLite) profile, under a coordinator lease so replicas and
 * overlapping ticks cannot double-run, and only while no other durable job
 * is mid-flight — the same quiescence rule the recovery inventory enforces.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  getPersistence,
  getSQLiteAdapterDatabase,
} from '../persistence/index.js';
import { encryptionService } from './encryptionService.js';
import { getCoordinator } from '../platform/coordination/service.js';
import { resolveDataDirectory } from '../utils/dataDirectory.js';
import {
  createBackupArchive,
  generateBackupKeys,
  restoreBackupArchive,
  verifyBackupArchive,
  verifyRestoredBackup,
} from '../platform/recovery/index.js';
import { createLogger } from '../utils/logger.js';
import type { StoredRecoveryDrillRecord } from '../persistence/resourceTypes.js';

const logger = createLogger('services:recovery-drill');

const LEASE_KEY = 'recovery-drill';
const LEASE_TTL_MS = 30 * 60 * 1000;
/** A running drill older than this was interrupted (crash/restart). */
const STALE_RUNNING_MS = 60 * 60 * 1000;
const DEFAULT_HISTORY_LIMIT = 60;
const LIST_LIMIT = 50;

const repositories = () =>
  getPersistence(encryptionService).repositories.resources;

export class RecoveryDrillError extends Error {
  constructor(
    message: string,
    public readonly statusCode = 400
  ) {
    super(message);
  }
}

export interface DrillReport {
  snapshotMs: number;
  archiveBytes: number;
  verifyMs: number;
  restoreMs: number;
  restoreVerifyMs: number;
}

export interface PublicRecoveryDrill {
  id: string;
  status: string;
  origin: string;
  startedAt: number;
  finishedAt: number | null;
  snapshotBytes: number | null;
  rpoSeconds: number | null;
  restoreMs: number | null;
  error: string | null;
  report: DrillReport | null;
}

const historyLimit = (): number => {
  const parsed = Number.parseInt(process.env.RECOVERY_DRILL_HISTORY || '', 10);
  return Number.isInteger(parsed) && parsed >= 5 && parsed <= 1000
    ? parsed
    : DEFAULT_HISTORY_LIMIT;
};

export const drillIntervalHours = (): number | null => {
  const parsed = Number.parseFloat(
    process.env.RECOVERY_DRILL_INTERVAL_HOURS || ''
  );
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : null;
};

/** Drills stage a filesystem snapshot; the team profile has its own CLI. */
export const drillsSupported = (): boolean => {
  const env = process.env;
  return !(
    env.LIBRE_PLATFORM_MODE?.trim().toLowerCase() === 'team' ||
    env.DATABASE_BACKEND?.trim().toLowerCase() === 'postgres' ||
    env.BLOB_STORE_BACKEND?.trim().toLowerCase() === 's3' ||
    env.VECTOR_STORE_BACKEND?.trim().toLowerCase() === 'pgvector'
  );
};

const decryptReport = (value: string | null): DrillReport | null => {
  if (!value) return null;
  try {
    return JSON.parse(
      encryptionService.decryptAuthenticated(value)
    ) as DrillReport;
  } catch {
    return null;
  }
};

const toPublic = (record: StoredRecoveryDrillRecord): PublicRecoveryDrill => ({
  id: record.id,
  status: record.status,
  origin: record.origin,
  startedAt: record.started_at,
  finishedAt: record.finished_at,
  snapshotBytes: record.snapshot_bytes,
  rpoSeconds: record.rpo_seconds,
  restoreMs: record.restore_ms,
  error: record.error,
  report: decryptReport(record.report),
});

export const listDrills = async (): Promise<PublicRecoveryDrill[]> =>
  (await repositories().recoveryDrills.list(LIST_LIMIT)).map(toPublic);

const notifyAdminsOfFailure = async (
  drillId: string,
  message: string
): Promise<void> => {
  try {
    const [{ userModel }, { notificationService }] = await Promise.all([
      import('../models/userModel.js'),
      import('./notificationService.js'),
    ]);
    const admins = (await userModel.getAllUsers()).filter(
      user => user.role === 'admin' && user.status === 'active'
    );
    for (const admin of admins) {
      await notificationService.publish({
        userId: admin.id,
        type: 'system',
        title: 'Recovery drill failed',
        body: message,
        href: '/system',
        sourceKey: `recovery-drill-failed:${drillId}`,
      });
    }
  } catch (error) {
    logger.warn('Recovery drill failure notification did not send', { error });
  }
};

/** Copy the data directory, leaving the live SQLite files for the backup API. */
const stageDataDirectory = async (
  dataDir: string,
  staging: string
): Promise<void> => {
  fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
  const skip = new Set(['data.sqlite', 'data.sqlite-wal', 'data.sqlite-shm']);
  for (const entry of fs.readdirSync(dataDir)) {
    if (skip.has(entry)) continue;
    fs.cpSync(path.join(dataDir, entry), path.join(staging, entry), {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
  }
  // The online backup API yields a consistent snapshot of a live database
  // without stopping writers — the reason drills need no downtime.
  await getSQLiteAdapterDatabase().backup(path.join(staging, 'data.sqlite'));
};

const runningDurableJobs = (): number => {
  // The drill runs outside the durable-job system precisely so its own
  // execution never appears here: any running row is real in-flight work
  // that would land mid-write in the snapshot. The archive's recovery
  // inventory re-checks this on the staged copy and remains authoritative.
  try {
    const row = getSQLiteAdapterDatabase()
      .prepare(
        "SELECT COUNT(*) AS count FROM platform_jobs WHERE state = 'running'"
      )
      .get() as { count: number };
    return row.count;
  } catch {
    return 0;
  }
};

export interface RunDrillOptions {
  origin: 'scheduled' | 'manual';
  createdBy?: string | null;
  /**
   * Scheduled drills skip quietly when the instance is busy and retry next
   * tick; manual drills record the refusal so the administrator sees it.
   */
  recordBusyAsFailure?: boolean;
}

/**
 * Run one full drill. Returns the recorded drill, or null when it was
 * skipped without recording (lease held elsewhere, or busy on a scheduled
 * run).
 */
export const runDrill = async (
  options: RunDrillOptions
): Promise<PublicRecoveryDrill | null> => {
  if (!drillsSupported()) {
    throw new RecoveryDrillError(
      'Recovery drills run on the solo (SQLite) profile; the team profile uses the coordinated backup CLI',
      501
    );
  }
  const lease = await getCoordinator().acquireLease(LEASE_KEY, LEASE_TTL_MS);
  if (!lease) {
    if (options.origin === 'manual') {
      throw new RecoveryDrillError('A recovery drill is already running', 409);
    }
    return null;
  }

  const now = Date.now();
  const drills = repositories().recoveryDrills;
  try {
    const running = await drills.findRunning();
    if (running) {
      if (now - running.started_at > STALE_RUNNING_MS) {
        await drills.update(running.id, {
          status: 'failed',
          finished_at: now,
          error: 'The drill was interrupted by a restart',
        });
      } else if (options.origin === 'manual') {
        throw new RecoveryDrillError(
          'A recovery drill is already running',
          409
        );
      } else {
        return null;
      }
    }

    const previous = await drills.findLatestFinished();
    const record: StoredRecoveryDrillRecord = {
      id: randomUUID(),
      status: 'running',
      origin: options.origin,
      started_at: now,
      finished_at: null,
      snapshot_bytes: null,
      rpo_seconds: null,
      restore_ms: null,
      error: null,
      report: null,
      created_by: options.createdBy ?? null,
      created_at: now,
    };
    await drills.insert(record);

    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'libre-drill-'));
    try {
      const busy = runningDurableJobs();
      if (busy > 0) {
        const message = `${busy} durable job(s) were running; the drill needs a quiet moment and will retry`;
        if (options.origin === 'scheduled' && !options.recordBusyAsFailure) {
          await drills.update(record.id, {
            status: 'failed',
            finished_at: Date.now(),
            error: message,
          });
          // Scheduled busy-skips are unremarkable: no admin alert, and the
          // interval clock restarts so the next tick can try again.
          return toPublic({
            ...record,
            status: 'failed',
            finished_at: Date.now(),
            error: message,
          });
        }
        throw new RecoveryDrillError(message, 409);
      }

      const dataDir = resolveDataDirectory();
      const staging = path.join(workDir, 'staging');
      const snapshotStarted = Date.now();
      await stageDataDirectory(dataDir, staging);

      const keys = generateBackupKeys(path.join(workDir, 'keys'));
      const archivePath = path.join(workDir, 'drill.lwbackup');
      await createBackupArchive({
        dataDir: staging,
        outputPath: archivePath,
        encryptionKeyPath: keys.encryptionKeyPath,
        signingPrivateKeyPath: keys.signingPrivateKeyPath,
        offline: true,
      });
      const snapshotMs = Date.now() - snapshotStarted;
      const archiveBytes = fs.statSync(archivePath).size;

      const verifyStarted = Date.now();
      const verification = verifyBackupArchive({
        archivePath,
        signingPublicKeyPath: keys.signingPublicKeyPath,
        encryptionKeyPath: keys.encryptionKeyPath,
      });
      if (!verification.signatureVerified || !verification.payloadVerified) {
        throw new Error('The drill archive failed verification');
      }
      const verifyMs = Date.now() - verifyStarted;

      const restoreStarted = Date.now();
      const restoreTarget = path.join(workDir, 'restore');
      await restoreBackupArchive({
        archivePath,
        signingPublicKeyPath: keys.signingPublicKeyPath,
        encryptionKeyPath: keys.encryptionKeyPath,
        targetDirectory: restoreTarget,
        apply: true,
      });
      const restoreMs = Date.now() - restoreStarted;

      const restoreVerifyStarted = Date.now();
      await verifyRestoredBackup(restoreTarget);
      const restoreVerifyMs = Date.now() - restoreVerifyStarted;

      const report: DrillReport = {
        snapshotMs,
        archiveBytes,
        verifyMs,
        restoreMs,
        restoreVerifyMs,
      };
      const finishedAt = Date.now();
      const rpoSeconds =
        previous?.status === 'passed'
          ? Math.round((now - previous.started_at) / 1000)
          : null;
      await drills.update(record.id, {
        status: 'passed',
        finished_at: finishedAt,
        snapshot_bytes: archiveBytes,
        rpo_seconds: rpoSeconds,
        restore_ms: restoreMs,
        report: encryptionService.encrypt(JSON.stringify(report)),
      });
      await drills.pruneToLimit(historyLimit());
      logger.info('Recovery drill passed', {
        drillId: record.id,
        restoreMs,
        archiveBytes,
      });
      return toPublic({
        ...record,
        status: 'passed',
        finished_at: finishedAt,
        snapshot_bytes: archiveBytes,
        rpo_seconds: rpoSeconds,
        restore_ms: restoreMs,
        report: encryptionService.encrypt(JSON.stringify(report)),
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Recovery drill failed';
      await drills.update(record.id, {
        status: 'failed',
        finished_at: Date.now(),
        error: message.slice(0, 500),
      });
      // Interactive refusals (busy, already running) answered the caller
      // directly; the bell alert is for drills failing unattended.
      if (!(error instanceof RecoveryDrillError)) {
        await notifyAdminsOfFailure(record.id, message.slice(0, 500));
      }
      logger.warn('Recovery drill failed', { drillId: record.id, message });
      if (error instanceof RecoveryDrillError) throw error;
      return toPublic({
        ...(await drills.findById(record.id))!,
      });
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  } finally {
    await lease.release().catch(() => false);
  }
};

let sweepInFlight = false;

/**
 * Scheduler-lease sweep: start a drill when the configured interval has
 * elapsed since the last one (any outcome, so a failing instance does not
 * hammer itself). Fire-and-forget; the drill lease serializes execution.
 */
export const sweepDrills = async (now: number): Promise<boolean> => {
  const interval = drillIntervalHours();
  if (!interval || !drillsSupported() || sweepInFlight) return false;
  const drills = repositories().recoveryDrills;
  const latest = await drills.list(1);
  const last = latest[0];
  if (last && now - last.started_at < interval * 60 * 60 * 1000) {
    return false;
  }
  sweepInFlight = true;
  void runDrill({ origin: 'scheduled' })
    .catch(error => {
      logger.warn('Scheduled recovery drill errored', { error });
    })
    .finally(() => {
      sweepInFlight = false;
    });
  return true;
};

export default {
  runDrill,
  sweepDrills,
  listDrills,
  drillsSupported,
  drillIntervalHours,
};
