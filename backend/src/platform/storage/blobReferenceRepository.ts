/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import type Database from 'better-sqlite3';
import type { PostgresQueryExecutor } from '../../persistence/postgresDatabase.js';

export interface BlobReference {
  blobId: string;
  ownerUserId: string;
  resourceType: string;
  resourceId: string;
  purpose: string;
  createdAt: number;
}

export interface BlobReferenceRepository {
  attach(reference: BlobReference): Promise<void>;
  find(
    resourceType: string,
    resourceId: string,
    purpose: string
  ): Promise<BlobReference | undefined>;
  detach(
    resourceType: string,
    resourceId: string,
    purpose: string
  ): Promise<BlobReference | undefined>;
  listByOwner(ownerUserId: string, limit?: number): Promise<BlobReference[]>;
  isReferenced(blobId: string): Promise<boolean>;
}

interface ReferenceRow extends Record<string, unknown> {
  blob_id: string;
  owner_user_id: string;
  resource_type: string;
  resource_id: string;
  purpose: string;
  created_at: number | string;
}

const mapReference = (row: ReferenceRow): BlobReference => ({
  blobId: row.blob_id,
  ownerUserId: row.owner_user_id,
  resourceType: row.resource_type,
  resourceId: row.resource_id,
  purpose: row.purpose,
  createdAt: Number(row.created_at),
});

export class SQLiteBlobReferenceRepository implements BlobReferenceRepository {
  constructor(private readonly database: Database.Database) {}

  async attach(reference: BlobReference): Promise<void> {
    this.database
      .prepare(
        `INSERT INTO platform_blob_references (
           blob_id, owner_user_id, resource_type, resource_id, purpose, created_at
         ) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(resource_type, resource_id, purpose) DO UPDATE SET
           blob_id = excluded.blob_id,
           owner_user_id = excluded.owner_user_id,
           created_at = excluded.created_at`
      )
      .run(
        reference.blobId,
        reference.ownerUserId,
        reference.resourceType,
        reference.resourceId,
        reference.purpose,
        reference.createdAt
      );
  }

  async find(
    resourceType: string,
    resourceId: string,
    purpose: string
  ): Promise<BlobReference | undefined> {
    const row = this.database
      .prepare(
        `SELECT blob_id, owner_user_id, resource_type, resource_id, purpose,
                created_at
           FROM platform_blob_references
          WHERE resource_type = ? AND resource_id = ? AND purpose = ?`
      )
      .get(resourceType, resourceId, purpose) as ReferenceRow | undefined;
    return row ? mapReference(row) : undefined;
  }

  async detach(
    resourceType: string,
    resourceId: string,
    purpose: string
  ): Promise<BlobReference | undefined> {
    const existing = await this.find(resourceType, resourceId, purpose);
    if (!existing) return undefined;
    this.database
      .prepare(
        `DELETE FROM platform_blob_references
          WHERE resource_type = ? AND resource_id = ? AND purpose = ?`
      )
      .run(resourceType, resourceId, purpose);
    return existing;
  }

  async isReferenced(blobId: string): Promise<boolean> {
    return Boolean(
      this.database
        .prepare('SELECT 1 FROM platform_blob_references WHERE blob_id = ?')
        .get(blobId)
    );
  }

  async listByOwner(
    ownerUserId: string,
    limit = 10_000
  ): Promise<BlobReference[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100_000) {
      throw new Error('Invalid blob reference inventory limit');
    }
    const rows = this.database
      .prepare(
        `SELECT blob_id, owner_user_id, resource_type, resource_id, purpose,
                created_at
           FROM platform_blob_references
          WHERE owner_user_id = ? ORDER BY created_at, blob_id LIMIT ?`
      )
      .all(ownerUserId, limit) as ReferenceRow[];
    return rows.map(mapReference);
  }
}

export class PostgresBlobReferenceRepository implements BlobReferenceRepository {
  constructor(private readonly database: PostgresQueryExecutor) {}

  async attach(reference: BlobReference): Promise<void> {
    await this.database.query(
      `INSERT INTO platform_blob_references (
         blob_id, owner_user_id, resource_type, resource_id, purpose, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT(resource_type, resource_id, purpose) DO UPDATE SET
         blob_id = EXCLUDED.blob_id,
         owner_user_id = EXCLUDED.owner_user_id,
         created_at = EXCLUDED.created_at`,
      [
        reference.blobId,
        reference.ownerUserId,
        reference.resourceType,
        reference.resourceId,
        reference.purpose,
        reference.createdAt,
      ]
    );
  }

  async find(
    resourceType: string,
    resourceId: string,
    purpose: string
  ): Promise<BlobReference | undefined> {
    const result = await this.database.query<ReferenceRow>(
      `SELECT blob_id, owner_user_id, resource_type, resource_id, purpose,
              created_at
         FROM platform_blob_references
        WHERE resource_type = $1 AND resource_id = $2 AND purpose = $3`,
      [resourceType, resourceId, purpose]
    );
    return result.rows[0] ? mapReference(result.rows[0]) : undefined;
  }

  async detach(
    resourceType: string,
    resourceId: string,
    purpose: string
  ): Promise<BlobReference | undefined> {
    const result = await this.database.query<ReferenceRow>(
      `DELETE FROM platform_blob_references
        WHERE resource_type = $1 AND resource_id = $2 AND purpose = $3
      RETURNING blob_id, owner_user_id, resource_type, resource_id, purpose,
                created_at`,
      [resourceType, resourceId, purpose]
    );
    return result.rows[0] ? mapReference(result.rows[0]) : undefined;
  }

  async isReferenced(blobId: string): Promise<boolean> {
    const result = await this.database.query<{ present: boolean }>(
      `SELECT EXISTS(
         SELECT 1 FROM platform_blob_references WHERE blob_id = $1
       ) AS present`,
      [blobId]
    );
    return result.rows[0]?.present === true;
  }

  async listByOwner(
    ownerUserId: string,
    limit = 10_000
  ): Promise<BlobReference[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100_000) {
      throw new Error('Invalid blob reference inventory limit');
    }
    const result = await this.database.query<ReferenceRow>(
      `SELECT blob_id, owner_user_id, resource_type, resource_id, purpose,
              created_at
         FROM platform_blob_references
        WHERE owner_user_id = $1 ORDER BY created_at, blob_id LIMIT $2`,
      [ownerUserId, limit]
    );
    return result.rows.map(mapReference);
  }
}
