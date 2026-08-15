/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import type {
  PostgresDatabase,
  PostgresQueryExecutor,
} from '../../persistence/postgresDatabase.js';
import {
  BlobQuotaExceededError,
  BlobStoreError,
  type BlobDescriptor,
  type BlobQuotaPolicy,
  type BlobQuotaReservation,
  type TransactionalBlobQuotaReservation,
  type TransactionalBlobQuotaPolicy,
} from './blobStore.js';

const DEFAULT_BYTES_PER_OWNER = 10 * 1024 * 1024 * 1024;
const DEFAULT_RESERVATION_TTL_MS = 60 * 60 * 1000;

export interface DurableBlobQuotaOptions {
  maximumBytesPerOwner?: number;
  reservationTtlMs?: number;
  now?: () => number;
}

export interface BlobQuotaReconciliationResult {
  releasedReservations: number;
  releasedBytes: number;
}

export interface BlobQuotaObjectReconciliationResult {
  releasedObjects: number;
  releasedBytes: number;
  inspectedObjects: number;
}

export interface ReconciledBlobQuotaPolicy extends BlobQuotaPolicy {
  reconcileExpiredReservations(
    now?: number
  ): Promise<BlobQuotaReconciliationResult>;
  reconcileMissingStoredObjects(
    isStored: (object: { id: string; ownerUserId: string }) => Promise<boolean>,
    maximumObjects?: number
  ): Promise<BlobQuotaObjectReconciliationResult>;
  listStoredObjectIdsByOwner(
    ownerUserId: string,
    limit?: number
  ): Promise<string[]>;
}

interface QuotaReservationRow {
  id: string;
  owner_user_id: string;
  purpose: string;
  reserved_bytes: number | string;
  consumed_bytes: number | string;
}

const safeInteger = (value: unknown, description: string): number => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new BlobStoreError('corrupt', `Invalid blob quota ${description}`);
  }
  return parsed;
};

const validateOptions = (options: DurableBlobQuotaOptions) => {
  const maximumBytesPerOwner =
    options.maximumBytesPerOwner ?? DEFAULT_BYTES_PER_OWNER;
  const reservationTtlMs =
    options.reservationTtlMs ?? DEFAULT_RESERVATION_TTL_MS;
  if (
    !Number.isSafeInteger(maximumBytesPerOwner) ||
    maximumBytesPerOwner <= 0
  ) {
    throw new BlobStoreError('invalid-input', 'Invalid per-owner blob quota');
  }
  if (!Number.isSafeInteger(reservationTtlMs) || reservationTtlMs < 60_000) {
    throw new BlobStoreError('invalid-input', 'Invalid blob reservation TTL');
  }
  return {
    maximumBytesPerOwner,
    reservationTtlMs,
    now: options.now ?? Date.now,
  };
};

const validateExpectedSize = (expectedSize: number | undefined): number => {
  if (expectedSize === undefined) return 0;
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 0) {
    throw new BlobStoreError('invalid-input', 'Invalid expected blob size');
  }
  return expectedSize;
};

const validateConsumedBytes = (bytes: number): void => {
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    throw new BlobStoreError('invalid-input', 'Invalid blob quota byte count');
  }
};

const assertDescriptor = (
  descriptor: BlobDescriptor,
  row: QuotaReservationRow
): void => {
  if (
    descriptor.ownerUserId !== row.owner_user_id ||
    descriptor.purpose !== row.purpose ||
    descriptor.size !== safeInteger(row.consumed_bytes, 'consumed bytes')
  ) {
    throw new BlobStoreError(
      'corrupt',
      'Blob quota reservation does not match the committed descriptor'
    );
  }
};

/**
 * SQLite quota accounting uses IMMEDIATE transactions. Every growing stream
 * atomically checks stored + all reserved bytes, so concurrent writers and
 * multiple processes cannot both spend the same remaining allowance.
 */
export class SQLiteDurableBlobQuotaPolicy implements ReconciledBlobQuotaPolicy {
  private readonly maximumBytesPerOwner: number;
  private readonly reservationTtlMs: number;
  private readonly now: () => number;

  constructor(
    private readonly database: Database.Database,
    options: DurableBlobQuotaOptions = {}
  ) {
    const validated = validateOptions(options);
    this.maximumBytesPerOwner = validated.maximumBytesPerOwner;
    this.reservationTtlMs = validated.reservationTtlMs;
    this.now = validated.now;
  }

  async reserve(request: {
    ownerUserId: string;
    purpose: string;
    expectedSize?: number;
  }): Promise<BlobQuotaReservation> {
    await this.reconcileExpiredReservations();
    const reservationId = crypto.randomUUID();
    const reservedBytes = validateExpectedSize(request.expectedSize);
    const now = this.now();
    const reserve = this.database.transaction(() => {
      this.database
        .prepare(
          `INSERT OR IGNORE INTO platform_blob_quota_usage
             (owner_user_id, stored_bytes, reserved_bytes, updated_at)
           VALUES (?, 0, 0, ?)`
        )
        .run(request.ownerUserId, now);
      const usage = this.database
        .prepare(
          `SELECT stored_bytes, reserved_bytes
             FROM platform_blob_quota_usage WHERE owner_user_id = ?`
        )
        .get(request.ownerUserId) as {
        stored_bytes: number;
        reserved_bytes: number;
      };
      if (
        usage.stored_bytes + usage.reserved_bytes + reservedBytes >
        this.maximumBytesPerOwner
      ) {
        throw new BlobQuotaExceededError();
      }
      this.database
        .prepare(
          `UPDATE platform_blob_quota_usage
              SET reserved_bytes = reserved_bytes + ?, updated_at = ?
            WHERE owner_user_id = ?`
        )
        .run(reservedBytes, now, request.ownerUserId);
      this.database
        .prepare(
          `INSERT INTO platform_blob_quota_reservations
             (id, owner_user_id, purpose, reserved_bytes, consumed_bytes,
              expires_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, 0, ?, ?, ?)`
        )
        .run(
          reservationId,
          request.ownerUserId,
          request.purpose,
          reservedBytes,
          now + this.reservationTtlMs,
          now,
          now
        );
    });
    reserve.immediate();

    let settled = false;
    const reservation: TransactionalBlobQuotaReservation = {
      consume: async bytes => {
        if (settled)
          throw new BlobStoreError(
            'corrupt',
            'Blob quota reservation is settled'
          );
        validateConsumedBytes(bytes);
        const consumedAt = this.now();
        const consume = this.database.transaction(() => {
          const row = this.database
            .prepare(
              `SELECT id, owner_user_id, purpose, reserved_bytes, consumed_bytes
                 FROM platform_blob_quota_reservations WHERE id = ?`
            )
            .get(reservationId) as QuotaReservationRow | undefined;
          if (!row)
            throw new BlobStoreError(
              'unavailable',
              'Blob quota reservation expired'
            );
          const consumed = safeInteger(row.consumed_bytes, 'consumed bytes');
          const reserved = safeInteger(row.reserved_bytes, 'reserved bytes');
          const nextConsumed = consumed + bytes;
          if (!Number.isSafeInteger(nextConsumed)) {
            throw new BlobQuotaExceededError();
          }
          const nextReserved = Math.max(reserved, nextConsumed);
          const additional = nextReserved - reserved;
          if (additional > 0) {
            const usage = this.database
              .prepare(
                `SELECT stored_bytes, reserved_bytes
                   FROM platform_blob_quota_usage WHERE owner_user_id = ?`
              )
              .get(row.owner_user_id) as {
              stored_bytes: number;
              reserved_bytes: number;
            };
            if (
              usage.stored_bytes + usage.reserved_bytes + additional >
              this.maximumBytesPerOwner
            ) {
              throw new BlobQuotaExceededError();
            }
            this.database
              .prepare(
                `UPDATE platform_blob_quota_usage
                    SET reserved_bytes = reserved_bytes + ?, updated_at = ?
                  WHERE owner_user_id = ?`
              )
              .run(additional, consumedAt, row.owner_user_id);
          }
          this.database
            .prepare(
              `UPDATE platform_blob_quota_reservations
                  SET consumed_bytes = ?, reserved_bytes = ?, expires_at = ?,
                      updated_at = ?
                WHERE id = ?`
            )
            .run(
              nextConsumed,
              nextReserved,
              consumedAt + this.reservationTtlMs,
              consumedAt,
              reservationId
            );
        });
        consume.immediate();
      },
      commit: async descriptor => {
        if (settled) {
          const existing = this.database
            .prepare(
              'SELECT 1 FROM platform_blob_quota_objects WHERE blob_id = ?'
            )
            .get(descriptor.id);
          if (existing) return;
          throw new BlobStoreError(
            'corrupt',
            'Blob quota reservation is settled'
          );
        }
        const committedAt = this.now();
        const commit = this.database.transaction(() => {
          const row = this.database
            .prepare(
              `SELECT id, owner_user_id, purpose, reserved_bytes, consumed_bytes
                 FROM platform_blob_quota_reservations WHERE id = ?`
            )
            .get(reservationId) as QuotaReservationRow | undefined;
          if (!row)
            throw new BlobStoreError(
              'unavailable',
              'Blob quota reservation expired'
            );
          assertDescriptor(descriptor, row);
          const reserved = safeInteger(row.reserved_bytes, 'reserved bytes');
          this.database
            .prepare(
              `INSERT INTO platform_blob_quota_objects
                 (blob_id, owner_user_id, purpose, stored_bytes, created_at)
               VALUES (?, ?, ?, ?, ?)`
            )
            .run(
              descriptor.id,
              descriptor.ownerUserId,
              descriptor.purpose,
              descriptor.size,
              committedAt
            );
          this.database
            .prepare(
              `UPDATE platform_blob_quota_usage
                  SET stored_bytes = stored_bytes + ?,
                      reserved_bytes = reserved_bytes - ?, updated_at = ?
                WHERE owner_user_id = ?`
            )
            .run(descriptor.size, reserved, committedAt, row.owner_user_id);
          this.database
            .prepare(
              'DELETE FROM platform_blob_quota_reservations WHERE id = ?'
            )
            .run(reservationId);
        });
        commit.immediate();
        settled = true;
      },
      release: async () => {
        if (settled) return;
        const releasedAt = this.now();
        const release = this.database.transaction(() => {
          const row = this.database
            .prepare(
              `SELECT id, owner_user_id, purpose, reserved_bytes, consumed_bytes
                 FROM platform_blob_quota_reservations WHERE id = ?`
            )
            .get(reservationId) as QuotaReservationRow | undefined;
          if (!row) return;
          this.database
            .prepare(
              `UPDATE platform_blob_quota_usage
                  SET reserved_bytes = reserved_bytes - ?, updated_at = ?
                WHERE owner_user_id = ?`
            )
            .run(
              safeInteger(row.reserved_bytes, 'reserved bytes'),
              releasedAt,
              row.owner_user_id
            );
          this.database
            .prepare(
              'DELETE FROM platform_blob_quota_reservations WHERE id = ?'
            )
            .run(reservationId);
        });
        release.immediate();
        settled = true;
      },
    };
    return reservation;
  }

  async releaseStored(request: {
    id: string;
    ownerUserId: string;
  }): Promise<void> {
    const releasedAt = this.now();
    const release = this.database.transaction(() => {
      const row = this.database
        .prepare(
          `SELECT stored_bytes FROM platform_blob_quota_objects
            WHERE blob_id = ? AND owner_user_id = ?`
        )
        .get(request.id, request.ownerUserId) as
        { stored_bytes: number } | undefined;
      if (!row) return;
      this.database
        .prepare(
          `UPDATE platform_blob_quota_usage
              SET stored_bytes = stored_bytes - ?, updated_at = ?
            WHERE owner_user_id = ?`
        )
        .run(row.stored_bytes, releasedAt, request.ownerUserId);
      this.database
        .prepare(
          `DELETE FROM platform_blob_quota_objects
            WHERE blob_id = ? AND owner_user_id = ?`
        )
        .run(request.id, request.ownerUserId);
    });
    release.immediate();
  }

  async reconcileExpiredReservations(
    now = this.now()
  ): Promise<BlobQuotaReconciliationResult> {
    const reconcile = this.database.transaction(() => {
      const rows = this.database
        .prepare(
          `SELECT id, owner_user_id, purpose, reserved_bytes, consumed_bytes
             FROM platform_blob_quota_reservations WHERE expires_at <= ?
             ORDER BY expires_at, id`
        )
        .all(now) as QuotaReservationRow[];
      let releasedBytes = 0;
      for (const row of rows) {
        const reserved = safeInteger(row.reserved_bytes, 'reserved bytes');
        releasedBytes += reserved;
        this.database
          .prepare(
            `UPDATE platform_blob_quota_usage
                SET reserved_bytes = reserved_bytes - ?, updated_at = ?
              WHERE owner_user_id = ?`
          )
          .run(reserved, now, row.owner_user_id);
      }
      this.database
        .prepare(
          'DELETE FROM platform_blob_quota_reservations WHERE expires_at <= ?'
        )
        .run(now);
      return { releasedReservations: rows.length, releasedBytes };
    });
    return reconcile.immediate();
  }

  async reconcileMissingStoredObjects(
    isStored: (object: { id: string; ownerUserId: string }) => Promise<boolean>,
    maximumObjects = 10_000
  ): Promise<BlobQuotaObjectReconciliationResult> {
    if (!Number.isSafeInteger(maximumObjects) || maximumObjects <= 0) {
      throw new BlobStoreError(
        'invalid-input',
        'Invalid quota reconciliation limit'
      );
    }
    const rows = this.database
      .prepare(
        `SELECT blob_id, owner_user_id, stored_bytes
           FROM platform_blob_quota_objects ORDER BY blob_id LIMIT ?`
      )
      .all(maximumObjects) as Array<{
      blob_id: string;
      owner_user_id: string;
      stored_bytes: number;
    }>;
    let releasedObjects = 0;
    let releasedBytes = 0;
    for (const row of rows) {
      if (await isStored({ id: row.blob_id, ownerUserId: row.owner_user_id })) {
        continue;
      }
      await this.releaseStored({
        id: row.blob_id,
        ownerUserId: row.owner_user_id,
      });
      releasedObjects += 1;
      releasedBytes += safeInteger(row.stored_bytes, 'stored bytes');
    }
    return { releasedObjects, releasedBytes, inspectedObjects: rows.length };
  }

  async listStoredObjectIdsByOwner(
    ownerUserId: string,
    limit = 10_000
  ): Promise<string[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100_000) {
      throw new BlobStoreError(
        'invalid-input',
        'Invalid quota inventory limit'
      );
    }
    const rows = this.database
      .prepare(
        `SELECT blob_id FROM platform_blob_quota_objects
          WHERE owner_user_id = ? ORDER BY created_at, blob_id LIMIT ?`
      )
      .all(ownerUserId, limit) as Array<{ blob_id: string }>;
    return rows.map(row => row.blob_id);
  }
}

/** Same accounting contract using row locks and serializable transactions. */
export class PostgresDurableBlobQuotaPolicy
  implements ReconciledBlobQuotaPolicy, TransactionalBlobQuotaPolicy
{
  private readonly maximumBytesPerOwner: number;
  private readonly reservationTtlMs: number;
  private readonly now: () => number;

  constructor(
    private readonly database: PostgresDatabase,
    options: DurableBlobQuotaOptions = {}
  ) {
    const validated = validateOptions(options);
    this.maximumBytesPerOwner = validated.maximumBytesPerOwner;
    this.reservationTtlMs = validated.reservationTtlMs;
    this.now = validated.now;
  }

  private async lockUsage(
    executor: PostgresQueryExecutor,
    ownerUserId: string,
    now: number
  ): Promise<{ stored: number; reserved: number }> {
    await executor.query(
      `INSERT INTO platform_blob_quota_usage
         (owner_user_id, stored_bytes, reserved_bytes, updated_at)
       VALUES ($1, 0, 0, $2) ON CONFLICT(owner_user_id) DO NOTHING`,
      [ownerUserId, now]
    );
    const usage = await executor.query<{
      stored_bytes: string | number;
      reserved_bytes: string | number;
    }>(
      `SELECT stored_bytes, reserved_bytes
         FROM platform_blob_quota_usage
        WHERE owner_user_id = $1 FOR UPDATE`,
      [ownerUserId]
    );
    return {
      stored: safeInteger(usage.rows[0]?.stored_bytes, 'stored bytes'),
      reserved: safeInteger(usage.rows[0]?.reserved_bytes, 'reserved bytes'),
    };
  }

  async reserve(request: {
    ownerUserId: string;
    purpose: string;
    expectedSize?: number;
  }): Promise<BlobQuotaReservation> {
    await this.reconcileExpiredReservations();
    const reservationId = crypto.randomUUID();
    const reservedBytes = validateExpectedSize(request.expectedSize);
    const now = this.now();
    await this.database.transaction(
      async client => {
        const usage = await this.lockUsage(client, request.ownerUserId, now);
        if (
          usage.stored + usage.reserved + reservedBytes >
          this.maximumBytesPerOwner
        ) {
          throw new BlobQuotaExceededError();
        }
        await client.query(
          `UPDATE platform_blob_quota_usage
            SET reserved_bytes = reserved_bytes + $1, updated_at = $2
          WHERE owner_user_id = $3`,
          [reservedBytes, now, request.ownerUserId]
        );
        await client.query(
          `INSERT INTO platform_blob_quota_reservations
           (id, owner_user_id, purpose, reserved_bytes, consumed_bytes,
            expires_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 0, $5, $6, $6)`,
          [
            reservationId,
            request.ownerUserId,
            request.purpose,
            reservedBytes,
            now + this.reservationTtlMs,
            now,
          ]
        );
      },
      { isolationLevel: 'serializable' }
    );

    let settled = false;
    const reservation: TransactionalBlobQuotaReservation = {
      consume: async bytes => {
        if (settled)
          throw new BlobStoreError(
            'corrupt',
            'Blob quota reservation is settled'
          );
        validateConsumedBytes(bytes);
        const consumedAt = this.now();
        await this.database.transaction(
          async client => {
            const result = await client.query<
              QuotaReservationRow & Record<string, unknown>
            >(
              `SELECT id, owner_user_id, purpose, reserved_bytes, consumed_bytes
               FROM platform_blob_quota_reservations
              WHERE id = $1 FOR UPDATE`,
              [reservationId]
            );
            const row = result.rows[0];
            if (!row)
              throw new BlobStoreError(
                'unavailable',
                'Blob quota reservation expired'
              );
            const consumed = safeInteger(row.consumed_bytes, 'consumed bytes');
            const reserved = safeInteger(row.reserved_bytes, 'reserved bytes');
            const nextConsumed = consumed + bytes;
            if (!Number.isSafeInteger(nextConsumed))
              throw new BlobQuotaExceededError();
            const nextReserved = Math.max(reserved, nextConsumed);
            const additional = nextReserved - reserved;
            if (additional > 0) {
              const usage = await this.lockUsage(
                client,
                row.owner_user_id,
                consumedAt
              );
              if (
                usage.stored + usage.reserved + additional >
                this.maximumBytesPerOwner
              ) {
                throw new BlobQuotaExceededError();
              }
              await client.query(
                `UPDATE platform_blob_quota_usage
                  SET reserved_bytes = reserved_bytes + $1, updated_at = $2
                WHERE owner_user_id = $3`,
                [additional, consumedAt, row.owner_user_id]
              );
            }
            await client.query(
              `UPDATE platform_blob_quota_reservations
                SET consumed_bytes = $1, reserved_bytes = $2, expires_at = $3,
                    updated_at = $4
              WHERE id = $5`,
              [
                nextConsumed,
                nextReserved,
                consumedAt + this.reservationTtlMs,
                consumedAt,
                reservationId,
              ]
            );
          },
          { isolationLevel: 'serializable' }
        );
      },
      commit: async descriptor => {
        if (settled) {
          const existing = await this.database.query(
            'SELECT 1 FROM platform_blob_quota_objects WHERE blob_id = $1',
            [descriptor.id]
          );
          if (existing.rowCount === 1) return;
          throw new BlobStoreError(
            'corrupt',
            'Blob quota reservation is settled'
          );
        }
        const committedAt = this.now();
        await this.database.transaction(
          async client => {
            const result = await client.query<
              QuotaReservationRow & Record<string, unknown>
            >(
              `SELECT id, owner_user_id, purpose, reserved_bytes, consumed_bytes
               FROM platform_blob_quota_reservations
              WHERE id = $1 FOR UPDATE`,
              [reservationId]
            );
            const row = result.rows[0];
            if (!row)
              throw new BlobStoreError(
                'unavailable',
                'Blob quota reservation expired'
              );
            assertDescriptor(descriptor, row);
            const reserved = safeInteger(row.reserved_bytes, 'reserved bytes');
            await this.lockUsage(client, row.owner_user_id, committedAt);
            await client.query(
              `INSERT INTO platform_blob_quota_objects
               (blob_id, owner_user_id, purpose, stored_bytes, created_at)
             VALUES ($1, $2, $3, $4, $5)`,
              [
                descriptor.id,
                descriptor.ownerUserId,
                descriptor.purpose,
                descriptor.size,
                committedAt,
              ]
            );
            await client.query(
              `UPDATE platform_blob_quota_usage
                SET stored_bytes = stored_bytes + $1,
                    reserved_bytes = reserved_bytes - $2, updated_at = $3
              WHERE owner_user_id = $4`,
              [descriptor.size, reserved, committedAt, row.owner_user_id]
            );
            await client.query(
              'DELETE FROM platform_blob_quota_reservations WHERE id = $1',
              [reservationId]
            );
          },
          { isolationLevel: 'serializable' }
        );
        settled = true;
      },
      release: async () => {
        if (settled) return;
        const releasedAt = this.now();
        await this.database.transaction(
          async client => {
            const result = await client.query<
              QuotaReservationRow & Record<string, unknown>
            >(
              `SELECT id, owner_user_id, purpose, reserved_bytes, consumed_bytes
               FROM platform_blob_quota_reservations
              WHERE id = $1 FOR UPDATE`,
              [reservationId]
            );
            const row = result.rows[0];
            if (!row) return;
            await this.lockUsage(client, row.owner_user_id, releasedAt);
            await client.query(
              `UPDATE platform_blob_quota_usage
                SET reserved_bytes = reserved_bytes - $1, updated_at = $2
              WHERE owner_user_id = $3`,
              [
                safeInteger(row.reserved_bytes, 'reserved bytes'),
                releasedAt,
                row.owner_user_id,
              ]
            );
            await client.query(
              'DELETE FROM platform_blob_quota_reservations WHERE id = $1',
              [reservationId]
            );
          },
          { isolationLevel: 'serializable' }
        );
        settled = true;
      },
    };
    reservation.commitWithMetadata = async (descriptor, operation) => {
      if (settled) {
        throw new BlobStoreError(
          'corrupt',
          'Blob quota reservation is settled'
        );
      }
      const committedAt = this.now();
      await this.database.transaction(
        async client => {
          const result = await client.query<
            QuotaReservationRow & Record<string, unknown>
          >(
            `SELECT id, owner_user_id, purpose, reserved_bytes, consumed_bytes
             FROM platform_blob_quota_reservations
            WHERE id = $1 FOR UPDATE`,
            [reservationId]
          );
          const row = result.rows[0];
          if (!row) {
            throw new BlobStoreError(
              'unavailable',
              'Blob quota reservation expired'
            );
          }
          assertDescriptor(descriptor, row);
          const reserved = safeInteger(row.reserved_bytes, 'reserved bytes');
          await this.lockUsage(client, row.owner_user_id, committedAt);
          await operation(client);
          await client.query(
            `INSERT INTO platform_blob_quota_objects
             (blob_id, owner_user_id, purpose, stored_bytes, created_at)
           VALUES ($1, $2, $3, $4, $5)`,
            [
              descriptor.id,
              descriptor.ownerUserId,
              descriptor.purpose,
              descriptor.size,
              committedAt,
            ]
          );
          await client.query(
            `UPDATE platform_blob_quota_usage
              SET stored_bytes = stored_bytes + $1,
                  reserved_bytes = reserved_bytes - $2, updated_at = $3
            WHERE owner_user_id = $4`,
            [descriptor.size, reserved, committedAt, row.owner_user_id]
          );
          await client.query(
            'DELETE FROM platform_blob_quota_reservations WHERE id = $1',
            [reservationId]
          );
        },
        { isolationLevel: 'serializable' }
      );
      settled = true;
    };
    return reservation;
  }

  async releaseStored(request: {
    id: string;
    ownerUserId: string;
  }): Promise<void> {
    const releasedAt = this.now();
    await this.database.transaction(
      async client => {
        const object = await client.query<
          {
            stored_bytes: string | number;
          } & Record<string, unknown>
        >(
          `SELECT stored_bytes FROM platform_blob_quota_objects
          WHERE blob_id = $1 AND owner_user_id = $2 FOR UPDATE`,
          [request.id, request.ownerUserId]
        );
        const row = object.rows[0];
        if (!row) return;
        await this.lockUsage(client, request.ownerUserId, releasedAt);
        await client.query(
          `UPDATE platform_blob_quota_usage
            SET stored_bytes = stored_bytes - $1, updated_at = $2
          WHERE owner_user_id = $3`,
          [
            safeInteger(row.stored_bytes, 'stored bytes'),
            releasedAt,
            request.ownerUserId,
          ]
        );
        await client.query(
          `DELETE FROM platform_blob_quota_objects
          WHERE blob_id = $1 AND owner_user_id = $2`,
          [request.id, request.ownerUserId]
        );
      },
      { isolationLevel: 'serializable' }
    );
  }

  async releaseStoredWithMetadata(
    request: { id: string; ownerUserId: string },
    operation: (executor: unknown) => Promise<void>
  ): Promise<void> {
    const releasedAt = this.now();
    await this.database.transaction(
      async client => {
        const object = await client.query<
          {
            stored_bytes: string | number;
          } & Record<string, unknown>
        >(
          `SELECT stored_bytes FROM platform_blob_quota_objects
          WHERE blob_id = $1 AND owner_user_id = $2 FOR UPDATE`,
          [request.id, request.ownerUserId]
        );
        const row = object.rows[0];
        await operation(client);
        if (!row) return;
        await this.lockUsage(client, request.ownerUserId, releasedAt);
        await client.query(
          `UPDATE platform_blob_quota_usage
            SET stored_bytes = stored_bytes - $1, updated_at = $2
          WHERE owner_user_id = $3`,
          [
            safeInteger(row.stored_bytes, 'stored bytes'),
            releasedAt,
            request.ownerUserId,
          ]
        );
        await client.query(
          `DELETE FROM platform_blob_quota_objects
          WHERE blob_id = $1 AND owner_user_id = $2`,
          [request.id, request.ownerUserId]
        );
      },
      { isolationLevel: 'serializable' }
    );
  }

  async reconcileExpiredReservations(
    now = this.now()
  ): Promise<BlobQuotaReconciliationResult> {
    return this.database.transaction(
      async client => {
        const expired = await client.query<
          QuotaReservationRow & Record<string, unknown>
        >(
          `SELECT id, owner_user_id, purpose, reserved_bytes, consumed_bytes
           FROM platform_blob_quota_reservations
          WHERE expires_at <= $1 ORDER BY expires_at, id FOR UPDATE`,
          [now]
        );
        let releasedBytes = 0;
        for (const row of expired.rows) {
          const reserved = safeInteger(row.reserved_bytes, 'reserved bytes');
          releasedBytes += reserved;
          await this.lockUsage(client, row.owner_user_id, now);
          await client.query(
            `UPDATE platform_blob_quota_usage
              SET reserved_bytes = reserved_bytes - $1, updated_at = $2
            WHERE owner_user_id = $3`,
            [reserved, now, row.owner_user_id]
          );
        }
        await client.query(
          'DELETE FROM platform_blob_quota_reservations WHERE expires_at <= $1',
          [now]
        );
        return {
          releasedReservations: expired.rows.length,
          releasedBytes,
        };
      },
      { isolationLevel: 'serializable' }
    );
  }

  async reconcileMissingStoredObjects(
    isStored: (object: { id: string; ownerUserId: string }) => Promise<boolean>,
    maximumObjects = 10_000
  ): Promise<BlobQuotaObjectReconciliationResult> {
    if (!Number.isSafeInteger(maximumObjects) || maximumObjects <= 0) {
      throw new BlobStoreError(
        'invalid-input',
        'Invalid quota reconciliation limit'
      );
    }
    const result = await this.database.query<
      {
        blob_id: string;
        owner_user_id: string;
        stored_bytes: string | number;
      } & Record<string, unknown>
    >(
      `SELECT blob_id, owner_user_id, stored_bytes
         FROM platform_blob_quota_objects ORDER BY blob_id LIMIT $1`,
      [maximumObjects]
    );
    let releasedObjects = 0;
    let releasedBytes = 0;
    for (const row of result.rows) {
      if (await isStored({ id: row.blob_id, ownerUserId: row.owner_user_id })) {
        continue;
      }
      await this.releaseStored({
        id: row.blob_id,
        ownerUserId: row.owner_user_id,
      });
      releasedObjects += 1;
      releasedBytes += safeInteger(row.stored_bytes, 'stored bytes');
    }
    return {
      releasedObjects,
      releasedBytes,
      inspectedObjects: result.rows.length,
    };
  }

  async listStoredObjectIdsByOwner(
    ownerUserId: string,
    limit = 10_000
  ): Promise<string[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100_000) {
      throw new BlobStoreError(
        'invalid-input',
        'Invalid quota inventory limit'
      );
    }
    const result = await this.database.query<
      {
        blob_id: string;
      } & Record<string, unknown>
    >(
      `SELECT blob_id FROM platform_blob_quota_objects
        WHERE owner_user_id = $1 ORDER BY created_at, blob_id LIMIT $2`,
      [ownerUserId, limit]
    );
    return result.rows.map(row => row.blob_id);
  }
}

export const resolveBlobQuotaOptions = (
  env: NodeJS.ProcessEnv = process.env
): DurableBlobQuotaOptions => {
  const parse = (name: string, fallback: number): number => {
    const raw = env[name]?.trim();
    if (!raw) return fallback;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new BlobStoreError(
        'invalid-input',
        `${name} must be a positive integer`
      );
    }
    return value;
  };
  return {
    maximumBytesPerOwner: parse(
      'BLOB_QUOTA_BYTES_PER_USER',
      DEFAULT_BYTES_PER_OWNER
    ),
    reservationTtlMs: parse(
      'BLOB_QUOTA_RESERVATION_TTL_MS',
      DEFAULT_RESERVATION_TTL_MS
    ),
  };
};
