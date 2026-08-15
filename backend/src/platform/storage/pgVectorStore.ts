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

import type { PostgresDatabase } from '../../persistence/postgresDatabase.js';
import {
  MAX_VECTOR_RECORDS_PER_UPSERT,
  MAX_VECTOR_RESOURCE_INDEX_ENTRIES,
  OwnerOnlyVectorPrincipalResolver,
  VectorStoreError,
  type VectorActor,
  type VectorDeleteRequest,
  type VectorGrant,
  type VectorHit,
  type VectorQuery,
  type VectorResourceIndexProbe,
  type VectorPrincipalResolver,
  type VectorRecord,
  type VectorStore,
  type VectorUpsertRequest,
} from './vectorStore.js';

const MAX_IDENTIFIER_BYTES = 256;
const MAX_ATTRIBUTE_VALUE_BYTES = 2048;
const MAX_ATTRIBUTES = 32;
const MAX_GRANTS = 128;
const MAX_QUERY_LIMIT = 100;
// pgvector stores at most 16,000 float32 dimensions in its untyped vector.
const MAX_DIMENSIONS = 16_000;

interface PgVectorHitRow extends Record<string, unknown> {
  id: string;
  namespace: string;
  owner_user_id: string;
  resource_id: string;
  model: string;
  dimensions: number;
  embedding_version: string;
  source_revision: string;
  score: number | string;
  attributes: Record<string, unknown> | string;
}

export interface PgVectorIntegrityOptions {
  maxRecords?: number;
  maxComponents?: number;
}

export interface PgVectorIntegrityResult {
  records: number;
  components: number;
}

export interface PgVectorStoreOptions {
  database: PostgresDatabase;
  now?: () => number;
  principalResolver?: VectorPrincipalResolver;
}

const invalidInput = (message: string): VectorStoreError =>
  new VectorStoreError('invalid-input', message);

const validateString = (value: string, field: string): void => {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > MAX_IDENTIFIER_BYTES ||
    [...value].some(character => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || codePoint === 127;
    })
  ) {
    throw invalidInput(`Invalid vector ${field}`);
  }
};

const validateDimensions = (dimensions: number): void => {
  if (
    !Number.isSafeInteger(dimensions) ||
    dimensions <= 0 ||
    dimensions > MAX_DIMENSIONS
  ) {
    throw invalidInput(
      `PGVector dimensions must be between 1 and ${MAX_DIMENSIONS}`
    );
  }
};

const normalizeEmbedding = (
  embedding: readonly number[],
  dimensions: number
): readonly number[] => {
  validateDimensions(dimensions);
  if (!Array.isArray(embedding) || embedding.length !== dimensions) {
    throw invalidInput(
      `Embedding has ${embedding.length} values; expected ${dimensions}`
    );
  }
  let squaredNorm = 0;
  const normalized = new Array<number>(dimensions);
  for (let index = 0; index < dimensions; index += 1) {
    const value = Math.fround(embedding[index]);
    if (!Number.isFinite(value)) {
      throw invalidInput('Embedding contains a non-finite value');
    }
    normalized[index] = Object.is(value, -0) ? 0 : value;
    squaredNorm += value * value;
  }
  if (!Number.isFinite(squaredNorm) || squaredNorm === 0) {
    throw invalidInput('Embedding must have a finite, non-zero norm');
  }
  return normalized;
};

const vectorLiteral = (embedding: readonly number[]): string =>
  `[${embedding.join(',')}]`;

const validateActor = (actor: VectorActor): void => {
  validateString(actor.userId, 'actor user ID');
};

const validateResolvedGroups = (
  groupIds: readonly string[]
): readonly string[] => {
  const normalized = [...new Set(groupIds)];
  if (normalized.length > MAX_GRANTS) {
    throw invalidInput('Too many trusted vector actor groups');
  }
  for (const groupId of normalized) {
    validateString(groupId, 'trusted actor group ID');
  }
  return normalized;
};

const validateAttributes = (
  attributes: Readonly<Record<string, string>> | undefined
): Readonly<Record<string, string>> => {
  const entries = Object.entries(attributes ?? {});
  if (entries.length > MAX_ATTRIBUTES) {
    throw invalidInput('Too many vector attributes');
  }
  const normalized: Record<string, string> = {};
  for (const [key, value] of entries.sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    validateString(key, 'attribute key');
    if (
      typeof value !== 'string' ||
      Buffer.byteLength(value, 'utf8') > MAX_ATTRIBUTE_VALUE_BYTES ||
      value.includes('\u0000')
    ) {
      throw invalidInput(`Invalid vector attribute value: ${key}`);
    }
    normalized[key] = value;
  }
  return Object.freeze(normalized);
};

const validateGrants = (
  grants: readonly VectorGrant[] | undefined
): readonly VectorGrant[] => {
  const unique = new Map<string, VectorGrant>();
  for (const grant of grants ?? []) {
    if (grant.type !== 'user' && grant.type !== 'group') {
      throw invalidInput('Invalid vector grant type');
    }
    validateString(grant.id, 'grant principal');
    unique.set(`${grant.type}\u0000${grant.id}`, grant);
  }
  if (unique.size > MAX_GRANTS) throw invalidInput('Too many vector grants');
  return [...unique.values()].sort(
    (left, right) =>
      left.type.localeCompare(right.type) || left.id.localeCompare(right.id)
  );
};

const validateRecord = (
  actor: VectorActor,
  record: VectorRecord
): {
  embedding: readonly number[];
  attributes: Readonly<Record<string, string>>;
  grants: readonly VectorGrant[];
} => {
  validateString(record.namespace, 'namespace');
  validateString(record.id, 'ID');
  validateString(record.ownerUserId, 'owner user ID');
  validateString(record.resourceId, 'resource ID');
  validateString(record.model, 'model');
  validateString(record.version, 'version');
  validateString(record.sourceRevision, 'source revision');
  if (record.ownerUserId !== actor.userId) {
    throw new VectorStoreError(
      'forbidden',
      'Vector mutations may only target resources owned by the actor'
    );
  }
  if (
    record.createdAt !== undefined &&
    (!Number.isSafeInteger(record.createdAt) || record.createdAt < 0)
  ) {
    throw invalidInput('Invalid vector creation timestamp');
  }
  return {
    embedding: normalizeEmbedding(record.embedding, record.dimensions),
    attributes: validateAttributes(record.attributes),
    grants: validateGrants(record.grants),
  };
};

const mapPgError = (message: string, error: unknown): VectorStoreError => {
  if (error instanceof VectorStoreError) return error;
  return new VectorStoreError('unavailable', message, error);
};

const parseAttributes = (value: Record<string, unknown> | string) => {
  let candidate: unknown = value;
  if (typeof value === 'string') {
    try {
      candidate = JSON.parse(value) as unknown;
    } catch (error) {
      throw new VectorStoreError(
        'corrupt',
        'PGVector attributes contain invalid JSON',
        error
      );
    }
  }
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new VectorStoreError('corrupt', 'PGVector attributes are invalid');
  }
  const attributes: Record<string, string> = {};
  for (const [key, item] of Object.entries(candidate)) {
    if (typeof item !== 'string') {
      throw new VectorStoreError('corrupt', 'PGVector attributes are invalid');
    }
    attributes[key] = item;
  }
  return Object.freeze(attributes);
};

/**
 * PostgreSQL/pgvector implementation of the common retrieval contract.
 *
 * ACL, resource, model, dimension, version, and metadata predicates are in the
 * same SQL statement as nearest-neighbour ordering and LIMIT. Unauthorized
 * vectors therefore never become application candidates. The generic vector
 * column permits model migrations with different dimensions; exact pgvector
 * search is used so filtered results have deterministic perfect recall.
 */
export class PgVectorStore implements VectorStore {
  private readonly database: PostgresDatabase;
  private readonly now: () => number;
  private readonly principalResolver: VectorPrincipalResolver;

  constructor(options: PgVectorStoreOptions) {
    this.database = options.database;
    this.now = options.now ?? Date.now;
    this.principalResolver =
      options.principalResolver ?? new OwnerOnlyVectorPrincipalResolver();
  }

  async upsert(request: VectorUpsertRequest): Promise<void> {
    validateActor(request.actor);
    if (
      !Array.isArray(request.records) ||
      request.records.length === 0 ||
      request.records.length > MAX_VECTOR_RECORDS_PER_UPSERT
    ) {
      throw invalidInput(
        `Vector upsert must contain 1-${MAX_VECTOR_RECORDS_PER_UPSERT} records`
      );
    }
    const prepared = request.records.map(record => ({
      record,
      ...validateRecord(request.actor, record),
    }));
    try {
      await this.database.transaction(async client => {
        for (const item of prepared) {
          const { record } = item;
          const updatedAt = this.now();
          await client.query(
            `INSERT INTO platform_vector_entries (
               namespace, id, owner_user_id, resource_id, model, dimensions,
               embedding_version, source_revision, embedding, attributes,
               created_at, updated_at
             ) VALUES (
               $1, $2, $3, $4, $5, $6, $7, $8, $9::vector, $10::jsonb,
               $11, $12
             )
             ON CONFLICT (namespace, owner_user_id, id) DO UPDATE SET
               resource_id = EXCLUDED.resource_id,
               model = EXCLUDED.model,
               dimensions = EXCLUDED.dimensions,
               embedding_version = EXCLUDED.embedding_version,
               source_revision = EXCLUDED.source_revision,
               embedding = EXCLUDED.embedding,
               attributes = EXCLUDED.attributes,
               updated_at = EXCLUDED.updated_at`,
            [
              record.namespace,
              record.id,
              record.ownerUserId,
              record.resourceId,
              record.model,
              record.dimensions,
              record.version,
              record.sourceRevision,
              vectorLiteral(item.embedding),
              JSON.stringify(item.attributes),
              record.createdAt ?? updatedAt,
              updatedAt,
            ]
          );
          await client.query(
            `DELETE FROM platform_vector_acl
              WHERE namespace = $1 AND owner_user_id = $2 AND vector_id = $3`,
            [record.namespace, record.ownerUserId, record.id]
          );
          if (item.grants.length > 0) {
            await client.query(
              `INSERT INTO platform_vector_acl (
                 namespace, owner_user_id, vector_id,
                 principal_type, principal_id
               )
               SELECT $1, $2, $3, acl_grant.principal_type, acl_grant.principal_id
                 FROM jsonb_to_recordset($4::jsonb)
                   AS acl_grant(principal_type TEXT, principal_id TEXT)`,
              [
                record.namespace,
                record.ownerUserId,
                record.id,
                JSON.stringify(
                  item.grants.map(grant => ({
                    principal_type: grant.type,
                    principal_id: grant.id,
                  }))
                ),
              ]
            );
          }
        }
      });
    } catch (error) {
      throw mapPgError('Unable to write PGVector records', error);
    }
  }

  async query(request: VectorQuery): Promise<VectorHit[]> {
    validateActor(request.actor);
    const groupIds = validateResolvedGroups(
      await this.principalResolver.resolveGroupIds(request.actor.userId)
    );
    validateString(request.namespace, 'namespace');
    validateString(request.model, 'model');
    validateString(request.version, 'version');
    const queryEmbedding = normalizeEmbedding(
      request.embedding,
      request.dimensions
    );
    if (
      !Number.isSafeInteger(request.limit) ||
      request.limit <= 0 ||
      request.limit > MAX_QUERY_LIMIT
    ) {
      throw invalidInput(`Vector query limit must be 1-${MAX_QUERY_LIMIT}`);
    }
    if (
      request.minScore !== undefined &&
      (!Number.isFinite(request.minScore) ||
        request.minScore < -1 ||
        request.minScore > 1)
    ) {
      throw invalidInput('Vector minimum score must be between -1 and 1');
    }
    const resourceIds = [...new Set(request.resourceIds ?? [])];
    if (resourceIds.length > 100) {
      throw invalidInput('Too many vector resource filters');
    }
    for (const resourceId of resourceIds) {
      validateString(resourceId, 'resource filter');
    }
    const attributes = validateAttributes(request.attributes);

    try {
      const result = await this.database.query<PgVectorHitRow>(
        `SELECT e.id, e.namespace, e.owner_user_id, e.resource_id, e.model,
                e.dimensions, e.embedding_version, e.source_revision,
                1 - (e.embedding <=> $6::vector) AS score,
                e.attributes
           FROM platform_vector_entries e
          WHERE e.namespace = $1
            AND e.model = $2
            AND e.dimensions = $3
            AND e.embedding_version = $4
            AND (
              e.owner_user_id = $5
              OR EXISTS (
                SELECT 1
                  FROM platform_vector_acl acl
                 WHERE acl.namespace = e.namespace
                   AND acl.owner_user_id = e.owner_user_id
                   AND acl.vector_id = e.id
                   AND (
                     (acl.principal_type = 'user' AND acl.principal_id = $5)
                     OR (
                       acl.principal_type = 'group'
                       AND acl.principal_id = ANY($7::text[])
                     )
                   )
              )
            )
            AND (
              cardinality($8::text[]) = 0
              OR e.resource_id = ANY($8::text[])
            )
            AND e.attributes @> $9::jsonb
            AND (
              $10::double precision IS NULL
              OR 1 - (e.embedding <=> $6::vector) >= $10
            )
          ORDER BY e.embedding <=> $6::vector,
                   e.owner_user_id,
                   e.id
          LIMIT $11`,
        [
          request.namespace,
          request.model,
          request.dimensions,
          request.version,
          request.actor.userId,
          vectorLiteral(queryEmbedding),
          groupIds,
          resourceIds,
          JSON.stringify(attributes),
          request.minScore ?? null,
          request.limit,
        ]
      );
      return result.rows.map(row => {
        const score = Number(row.score);
        if (!Number.isFinite(score) || score < -1.000001 || score > 1.000001) {
          throw new VectorStoreError(
            'corrupt',
            'PGVector returned an invalid score'
          );
        }
        return {
          id: row.id,
          namespace: row.namespace,
          ownerUserId: row.owner_user_id,
          resourceId: row.resource_id,
          model: row.model,
          dimensions: row.dimensions,
          version: row.embedding_version,
          sourceRevision: row.source_revision,
          score: Math.max(-1, Math.min(1, score)),
          attributes: parseAttributes(row.attributes),
        };
      });
    } catch (error) {
      throw mapPgError('Unable to query PGVector records', error);
    }
  }

  async hasExactResourceIndex(
    request: VectorResourceIndexProbe
  ): Promise<boolean> {
    validateActor(request.actor);
    validateString(request.namespace, 'namespace');
    validateString(request.resourceId, 'resource ID');
    validateString(request.model, 'model');
    validateString(request.version, 'version');
    validateDimensions(request.dimensions);
    if (
      !Array.isArray(request.entries) ||
      request.entries.length === 0 ||
      request.entries.length > MAX_VECTOR_RESOURCE_INDEX_ENTRIES
    ) {
      throw invalidInput(
        `Vector index probes require 1-${MAX_VECTOR_RESOURCE_INDEX_ENTRIES} entries`
      );
    }
    const expected = new Map<string, string>();
    for (const entry of request.entries) {
      validateString(entry.id, 'ID');
      validateString(entry.sourceRevision, 'source revision');
      if (expected.has(entry.id)) {
        throw invalidInput('Vector index probe contains duplicate IDs');
      }
      expected.set(entry.id, entry.sourceRevision);
    }

    try {
      return await this.database.transaction(
        async client => {
          const aggregate = await client.query<{ count: string }>(
            `SELECT COUNT(*)::text AS count
               FROM platform_vector_entries
              WHERE namespace = $1 AND owner_user_id = $2 AND resource_id = $3`,
            [request.namespace, request.actor.userId, request.resourceId]
          );
          const count = Number(aggregate.rows[0]?.count ?? -1);
          if (!Number.isSafeInteger(count) || count !== expected.size) {
            return false;
          }

          let cursor: string | null = null;
          let seen = 0;
          while (seen < expected.size) {
            const rows: Array<{
              id: string;
              model: string;
              dimensions: number;
              embedding_version: string;
              source_revision: string;
            }> = (
              await client.query<{
                id: string;
                model: string;
                dimensions: number;
                embedding_version: string;
                source_revision: string;
              }>(
                `SELECT id, model, dimensions, embedding_version, source_revision
                 FROM platform_vector_entries
                WHERE namespace = $1 AND owner_user_id = $2
                  AND resource_id = $3
                  AND ($4::text IS NULL OR id > $4)
                ORDER BY id
                LIMIT $5`,
                [
                  request.namespace,
                  request.actor.userId,
                  request.resourceId,
                  cursor,
                  MAX_VECTOR_RECORDS_PER_UPSERT,
                ]
              )
            ).rows;
            if (rows.length === 0) return false;
            for (const row of rows) {
              if (
                row.model !== request.model ||
                row.dimensions !== request.dimensions ||
                row.embedding_version !== request.version ||
                expected.get(row.id) !== row.source_revision
              ) {
                return false;
              }
            }
            seen += rows.length;
            cursor = rows[rows.length - 1]!.id;
          }
          return seen === expected.size;
        },
        { isolationLevel: 'repeatable read', readOnly: true }
      );
    } catch (error) {
      throw mapPgError('Unable to inspect PGVector resource index', error);
    }
  }

  async delete(request: VectorDeleteRequest): Promise<number> {
    validateActor(request.actor);
    validateString(request.namespace, 'namespace');
    if (!request.resourceId && (request.ids?.length ?? 0) === 0) {
      throw invalidInput(
        'Vector deletion requires a resource ID or explicit vector IDs'
      );
    }
    if (request.resourceId) validateString(request.resourceId, 'resource ID');
    const ids = [...new Set(request.ids ?? [])];
    if (ids.length > MAX_VECTOR_RECORDS_PER_UPSERT) {
      throw invalidInput('Too many vector IDs to delete');
    }
    for (const id of ids) validateString(id, 'ID');
    try {
      const result = await this.database.query(
        `DELETE FROM platform_vector_entries
          WHERE namespace = $1
            AND owner_user_id = $2
            AND ($3::text IS NULL OR resource_id = $3)
            AND (cardinality($4::text[]) = 0 OR id = ANY($4::text[]))`,
        [
          request.namespace,
          request.actor.userId,
          request.resourceId ?? null,
          ids,
        ]
      );
      return result.rowCount ?? 0;
    } catch (error) {
      throw mapPgError('Unable to delete PGVector records', error);
    }
  }

  async deleteAllForOwner(actor: VectorActor): Promise<number> {
    validateActor(actor);
    try {
      const result = await this.database.query(
        'DELETE FROM platform_vector_entries WHERE owner_user_id = $1',
        [actor.userId]
      );
      return result.rowCount ?? 0;
    } catch (error) {
      throw mapPgError('Unable to delete owner PGVector records', error);
    }
  }

  async verifyIntegrity(
    options: PgVectorIntegrityOptions = {}
  ): Promise<PgVectorIntegrityResult> {
    const maxRecords = options.maxRecords ?? 10_000_000;
    const maxComponents = options.maxComponents ?? 10_000_000_000;
    if (!Number.isSafeInteger(maxRecords) || maxRecords <= 0) {
      throw invalidInput('Invalid PGVector integrity record limit');
    }
    if (!Number.isSafeInteger(maxComponents) || maxComponents <= 0) {
      throw invalidInput('Invalid PGVector integrity component limit');
    }
    try {
      const result = await this.database.query<{
        records: string | number;
        components: string | number;
        invalid_records: string | number;
      }>(
        `SELECT COUNT(*) AS records,
                COALESCE(SUM(dimensions), 0) AS components,
                COUNT(*) FILTER (
                  WHERE vector_dims(embedding) <> dimensions
                     OR vector_norm(embedding) = 0
                ) AS invalid_records
           FROM platform_vector_entries`
      );
      const records = Number(result.rows[0]?.records ?? 0);
      const components = Number(result.rows[0]?.components ?? 0);
      const invalidRecords = Number(result.rows[0]?.invalid_records ?? 0);
      if (
        !Number.isSafeInteger(records) ||
        records < 0 ||
        !Number.isSafeInteger(components) ||
        components < 0 ||
        !Number.isSafeInteger(invalidRecords) ||
        invalidRecords < 0
      ) {
        throw new VectorStoreError(
          'corrupt',
          'Invalid PGVector integrity totals'
        );
      }
      if (records > maxRecords || components > maxComponents) {
        throw new VectorStoreError(
          'verification-limit',
          'PGVector storage exceeds bounded integrity verification limits'
        );
      }
      if (invalidRecords > 0) {
        throw new VectorStoreError(
          'corrupt',
          'PGVector storage contains invalid embeddings'
        );
      }
      return { records, components };
    } catch (error) {
      throw mapPgError('Unable to verify PGVector storage', error);
    }
  }
}
