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

import type Database from 'better-sqlite3';
import { assertPlatformVectorMigrationReady } from '../../persistence/sqliteMigrations.js';
import {
  Aes256GcmKeyring,
  parseAesGcmEnvelope,
  StorageEncryptionError,
} from './aesGcmKeyring.js';
import {
  VectorStoreError,
  type VectorActor,
  type VectorDeleteRequest,
  type VectorGrant,
  type VectorHit,
  type VectorQuery,
  type VectorRecord,
  type VectorStore,
  type VectorUpsertRequest,
} from './vectorStore.js';

const MAX_IDENTIFIER_BYTES = 256;
const MAX_ATTRIBUTE_VALUE_BYTES = 2048;
const MAX_ATTRIBUTES = 32;
const MAX_GRANTS = 128;
const MAX_RECORDS_PER_UPSERT = 1000;
const MAX_QUERY_LIMIT = 100;
const DEFAULT_MAX_CANDIDATES = 50_000;
const DEFAULT_MAX_CANDIDATE_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_SCORING_COMPONENTS = 16_000_000;
const MAX_DIMENSIONS = 65_536;
const DEFAULT_MAX_INTEGRITY_RECORDS = 250_000;
const DEFAULT_MAX_INTEGRITY_ENCRYPTED_BYTES = 4 * 1024 * 1024 * 1024;
const DEFAULT_MAX_INTEGRITY_COMPONENTS = 500_000_000;
const MAX_SERIALIZED_EMBEDDING_BYTES =
  4 * Math.ceil((MAX_DIMENSIONS * 4) / 3) + 1024;

interface VectorRow {
  namespace: string;
  id: string;
  owner_user_id: string;
  resource_id: string;
  model: string;
  dimensions: number;
  embedding_version: string;
  source_revision: string;
  embedding: Buffer;
}

interface VectorIntegrityRow extends VectorRow {
  created_at: number;
  updated_at: number;
}

export interface SqliteEncryptedVectorStoreOptions {
  database: Database.Database;
  keyring: Aes256GcmKeyring;
  maxCandidates?: number;
  /** Maximum aggregate encrypted payload selected by one authorized query. */
  maxCandidateBytes?: number;
  /** Maximum candidate-count times dimensions scored by one query. */
  maxScoringComponents?: number;
  now?: () => number;
}

export interface VectorIntegrityVerificationOptions {
  /** Fail closed instead of materializing an unexpectedly large row set. */
  maxRecords?: number;
  /** Maximum aggregate serialized ciphertext bytes authenticated. */
  maxEncryptedBytes?: number;
  /** Maximum aggregate float components decoded and checked. */
  maxComponents?: number;
}

export interface VectorIntegrityVerificationResult {
  records: number;
  encryptedBytes: number;
  components: number;
}

const invalidInput = (message: string): VectorStoreError =>
  new VectorStoreError('invalid-input', message);

const validateIntegrityLimit = (value: number, description: string): void => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw invalidInput(`Invalid ${description}`);
  }
};

const validateString = (value: string, field: string): void => {
  if (
    typeof value !== 'string' ||
    !value ||
    Buffer.byteLength(value, 'utf8') > MAX_IDENTIFIER_BYTES ||
    [...value].some(character => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || codePoint === 127;
    })
  ) {
    throw invalidInput(`Invalid vector ${field}`);
  }
};

const validateActor = (actor: VectorActor): readonly string[] => {
  validateString(actor.userId, 'actor user ID');
  const groupIds = [...new Set(actor.groupIds ?? [])];
  if (groupIds.length > MAX_GRANTS) {
    throw invalidInput('Too many vector actor groups');
  }
  for (const groupId of groupIds) validateString(groupId, 'actor group ID');
  return groupIds;
};

const validateDimensions = (dimensions: number): void => {
  if (
    !Number.isSafeInteger(dimensions) ||
    dimensions <= 0 ||
    dimensions > MAX_DIMENSIONS
  ) {
    throw invalidInput('Invalid vector dimensions');
  }
};

const normalizeEmbedding = (
  embedding: readonly number[],
  dimensions: number
): readonly number[] => {
  validateDimensions(dimensions);
  if (embedding.length !== dimensions) {
    throw invalidInput(
      `Embedding has ${embedding.length} values; expected ${dimensions}`
    );
  }

  let squaredNorm = 0;
  const normalized = new Array<number>(embedding.length);
  for (let index = 0; index < embedding.length; index += 1) {
    const value = Math.fround(embedding[index]);
    if (!Number.isFinite(value)) {
      throw invalidInput('Embedding contains a non-finite value');
    }
    normalized[index] = value;
    squaredNorm += value * value;
  }
  if (!Number.isFinite(squaredNorm) || squaredNorm === 0) {
    throw invalidInput('Embedding must have a finite, non-zero norm');
  }
  return normalized;
};

const encodeEmbedding = (embedding: readonly number[]): Buffer => {
  const output = Buffer.allocUnsafe(embedding.length * 4);
  for (let index = 0; index < embedding.length; index += 1) {
    output.writeFloatLE(embedding[index], index * 4);
  }
  return output;
};

const decodeEmbedding = (value: Buffer, dimensions: number): number[] => {
  if (value.length !== dimensions * 4) {
    throw new VectorStoreError('corrupt', 'Invalid encrypted vector length');
  }
  const embedding = new Array<number>(dimensions);
  for (let index = 0; index < dimensions; index += 1) {
    const component = value.readFloatLE(index * 4);
    if (!Number.isFinite(component)) {
      throw new VectorStoreError(
        'corrupt',
        'Encrypted vector contains a non-finite value'
      );
    }
    embedding[index] = component;
  }
  return embedding;
};

const validateEmbeddingPlaintext = (
  value: Buffer,
  dimensions: number
): void => {
  if (value.length !== dimensions * 4) {
    throw new VectorStoreError('corrupt', 'Invalid encrypted vector length');
  }
  let squaredNorm = 0;
  for (let index = 0; index < dimensions; index += 1) {
    const component = value.readFloatLE(index * 4);
    if (!Number.isFinite(component)) {
      throw new VectorStoreError(
        'corrupt',
        'Encrypted vector contains a non-finite value'
      );
    }
    squaredNorm += component * component;
  }
  if (!Number.isFinite(squaredNorm) || squaredNorm === 0) {
    throw new VectorStoreError('corrupt', 'Invalid stored vector norm');
  }
};

const vectorAad = (
  record: Pick<
    VectorRecord,
    | 'namespace'
    | 'id'
    | 'ownerUserId'
    | 'resourceId'
    | 'model'
    | 'dimensions'
    | 'version'
    | 'sourceRevision'
  >
): Buffer =>
  Buffer.from(
    JSON.stringify([
      'libre-vector',
      1,
      record.namespace,
      record.id,
      record.ownerUserId,
      record.resourceId,
      record.model,
      record.dimensions,
      record.version,
      record.sourceRevision,
    ]),
    'utf8'
  );

const serializeEnvelope = (
  envelope: ReturnType<Aes256GcmKeyring['encrypt']>
): Buffer => Buffer.from(JSON.stringify(envelope), 'utf8');

const deserializeEnvelope = (value: Buffer) => {
  try {
    return parseAesGcmEnvelope(JSON.parse(value.toString('utf8')) as unknown);
  } catch (error) {
    if (error instanceof StorageEncryptionError) throw error;
    throw new StorageEncryptionError('Invalid encrypted vector envelope');
  }
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
      throw invalidInput(`Invalid vector attribute: ${key}`);
    }
    normalized[key] = value;
  }
  return Object.freeze(normalized);
};

const validateGrants = (
  grants: readonly VectorGrant[] | undefined
): readonly VectorGrant[] => {
  if ((grants?.length ?? 0) > MAX_GRANTS) {
    throw invalidInput('Too many vector grants');
  }
  const normalized = new Map<string, VectorGrant>();
  for (const grant of grants ?? []) {
    if (grant.type !== 'user' && grant.type !== 'group') {
      throw invalidInput('Invalid vector grant type');
    }
    validateString(grant.id, 'grant ID');
    normalized.set(`${grant.type}\u0000${grant.id}`, {
      type: grant.type,
      id: grant.id,
    });
  }
  return [...normalized.values()];
};

const cosineSimilarity = (
  left: readonly number[],
  right: readonly number[]
): number => {
  let dotProduct = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dotProduct += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }
  const denominator = Math.sqrt(leftNorm) * Math.sqrt(rightNorm);
  if (!Number.isFinite(denominator) || denominator === 0) {
    throw new VectorStoreError('corrupt', 'Invalid stored vector norm');
  }
  return Math.max(-1, Math.min(1, dotProduct / denominator));
};

const rowRecord = (row: VectorRow): Omit<VectorRecord, 'embedding'> => ({
  namespace: row.namespace,
  id: row.id,
  ownerUserId: row.owner_user_id,
  resourceId: row.resource_id,
  model: row.model,
  dimensions: row.dimensions,
  version: row.embedding_version,
  sourceRevision: row.source_revision,
});

/**
 * Encrypted embedded vector index for solo deployments.
 *
 * SQLite applies owner/grant, model, version, resource, and attribute filters
 * before encrypted embeddings leave the database. Only the authorized
 * candidate set is decrypted and scored in the application process.
 */
export class SqliteEncryptedVectorStore implements VectorStore {
  private readonly database: Database.Database;
  private readonly keyring: Aes256GcmKeyring;
  private readonly maxCandidates: number;
  private readonly maxCandidateBytes: number;
  private readonly maxScoringComponents: number;
  private readonly now: () => number;

  constructor(options: SqliteEncryptedVectorStoreOptions) {
    if (
      !Number.isSafeInteger(options.maxCandidates ?? DEFAULT_MAX_CANDIDATES) ||
      (options.maxCandidates ?? DEFAULT_MAX_CANDIDATES) <= 0
    ) {
      throw invalidInput('Invalid maximum vector candidate count');
    }
    if (
      !Number.isSafeInteger(
        options.maxCandidateBytes ?? DEFAULT_MAX_CANDIDATE_BYTES
      ) ||
      (options.maxCandidateBytes ?? DEFAULT_MAX_CANDIDATE_BYTES) <= 0
    ) {
      throw invalidInput('Invalid maximum encrypted vector candidate bytes');
    }
    if (
      !Number.isSafeInteger(
        options.maxScoringComponents ?? DEFAULT_MAX_SCORING_COMPONENTS
      ) ||
      (options.maxScoringComponents ?? DEFAULT_MAX_SCORING_COMPONENTS) <= 0
    ) {
      throw invalidInput('Invalid maximum vector scoring work');
    }
    this.database = options.database;
    this.keyring = options.keyring;
    this.maxCandidates = options.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
    this.maxCandidateBytes =
      options.maxCandidateBytes ?? DEFAULT_MAX_CANDIDATE_BYTES;
    this.maxScoringComponents =
      options.maxScoringComponents ?? DEFAULT_MAX_SCORING_COMPONENTS;
    this.now = options.now ?? Date.now;
    this.validateSchema();
  }

  private validateSchema(): void {
    try {
      assertPlatformVectorMigrationReady(this.database);
    } catch (error) {
      throw new VectorStoreError(
        'unavailable',
        `Embedded vector storage requires checksummed migration v2: ${error instanceof Error ? error.message : 'schema is incompatible'}`
      );
    }
  }

  private validateRecord(
    actor: VectorActor,
    record: VectorRecord
  ): {
    embedding: readonly number[];
    attributes: Readonly<Record<string, string>>;
    grants: readonly VectorGrant[];
  } {
    if (record.ownerUserId !== actor.userId) {
      throw new VectorStoreError(
        'forbidden',
        'Vector owner must match the authenticated actor'
      );
    }
    validateString(record.namespace, 'namespace');
    validateString(record.id, 'ID');
    validateString(record.ownerUserId, 'owner user ID');
    validateString(record.resourceId, 'resource ID');
    validateString(record.model, 'model');
    validateString(record.version, 'version');
    validateString(record.sourceRevision, 'source revision');
    if (
      record.createdAt !== undefined &&
      (!Number.isSafeInteger(record.createdAt) || record.createdAt < 0)
    ) {
      throw invalidInput('Invalid vector creation time');
    }
    return {
      embedding: normalizeEmbedding(record.embedding, record.dimensions),
      attributes: validateAttributes(record.attributes),
      grants: validateGrants(record.grants),
    };
  }

  async upsert(request: VectorUpsertRequest): Promise<void> {
    validateActor(request.actor);
    if (
      request.records.length <= 0 ||
      request.records.length > MAX_RECORDS_PER_UPSERT
    ) {
      throw invalidInput(
        `Vector upserts require 1-${MAX_RECORDS_PER_UPSERT} records`
      );
    }

    const prepared = request.records.map(record => ({
      record,
      ...this.validateRecord(request.actor, record),
    }));
    const insertEntry = this.database.prepare(`
      INSERT INTO platform_vector_entries (
        namespace, id, owner_user_id, resource_id, model, dimensions,
        embedding_version, source_revision, embedding, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(namespace, owner_user_id, id) DO UPDATE SET
        resource_id = excluded.resource_id,
        model = excluded.model,
        dimensions = excluded.dimensions,
        embedding_version = excluded.embedding_version,
        source_revision = excluded.source_revision,
        embedding = excluded.embedding,
        updated_at = excluded.updated_at
    `);
    const deleteAcl = this.database.prepare(
      'DELETE FROM platform_vector_acl WHERE namespace = ? AND owner_user_id = ? AND vector_id = ?'
    );
    const insertAcl = this.database.prepare(`
      INSERT INTO platform_vector_acl (
        namespace, owner_user_id, vector_id, principal_type, principal_id
      ) VALUES (?, ?, ?, ?, ?)
    `);
    const deleteAttributes = this.database.prepare(
      'DELETE FROM platform_vector_attributes WHERE namespace = ? AND owner_user_id = ? AND vector_id = ?'
    );
    const insertAttribute = this.database.prepare(`
      INSERT INTO platform_vector_attributes (
        namespace, owner_user_id, vector_id, attribute_key, attribute_value
      ) VALUES (?, ?, ?, ?, ?)
    `);

    const transaction = this.database.transaction(() => {
      const updatedAt = this.now();
      for (const item of prepared) {
        const { record } = item;
        const envelope = this.keyring.encrypt(
          encodeEmbedding(item.embedding),
          vectorAad(record)
        );
        insertEntry.run(
          record.namespace,
          record.id,
          record.ownerUserId,
          record.resourceId,
          record.model,
          record.dimensions,
          record.version,
          record.sourceRevision,
          serializeEnvelope(envelope),
          record.createdAt ?? updatedAt,
          updatedAt
        );
        deleteAcl.run(record.namespace, record.ownerUserId, record.id);
        for (const grant of item.grants) {
          insertAcl.run(
            record.namespace,
            record.ownerUserId,
            record.id,
            grant.type,
            grant.id
          );
        }
        deleteAttributes.run(record.namespace, record.ownerUserId, record.id);
        for (const [key, value] of Object.entries(item.attributes)) {
          insertAttribute.run(
            record.namespace,
            record.ownerUserId,
            record.id,
            key,
            value
          );
        }
      }
    });
    transaction();
  }

  private queryRows(request: VectorQuery): VectorRow[] {
    const groupIds = validateActor(request.actor);
    validateString(request.namespace, 'namespace');
    validateString(request.model, 'model');
    validateString(request.version, 'version');
    validateDimensions(request.dimensions);
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

    const parameters: Array<string | number> = [
      request.namespace,
      request.model,
      request.dimensions,
      request.version,
      request.actor.userId,
      request.actor.userId,
    ];
    const groupPredicate =
      groupIds.length > 0
        ? ` OR (a.principal_type = 'group' AND a.principal_id IN (${groupIds
            .map(() => '?')
            .join(', ')}))`
        : '';
    parameters.push(...groupIds);

    let predicateSql = `
      WHERE e.namespace = ?
        AND e.model = ?
        AND e.dimensions = ?
        AND e.embedding_version = ?
        AND (
          e.owner_user_id = ?
          OR EXISTS (
            SELECT 1
            FROM platform_vector_acl a
            WHERE a.namespace = e.namespace
              AND a.owner_user_id = e.owner_user_id
              AND a.vector_id = e.id
              AND (
                (a.principal_type = 'user' AND a.principal_id = ?)
                ${groupPredicate}
              )
          )
        )
    `;

    if (resourceIds.length > 0) {
      predicateSql += ` AND e.resource_id IN (${resourceIds.map(() => '?').join(', ')})`;
      parameters.push(...resourceIds);
    }
    let attributeIndex = 0;
    for (const [key, value] of Object.entries(attributes)) {
      const alias = `filter_${attributeIndex}`;
      predicateSql += `
        AND EXISTS (
          SELECT 1
          FROM platform_vector_attributes ${alias}
          WHERE ${alias}.namespace = e.namespace
            AND ${alias}.owner_user_id = e.owner_user_id
            AND ${alias}.vector_id = e.id
            AND ${alias}.attribute_key = ?
            AND ${alias}.attribute_value = ?
        )
      `;
      parameters.push(key, value);
      attributeIndex += 1;
    }

    const sql = `
      SELECT
        e.namespace,
        e.id,
        e.owner_user_id,
        e.resource_id,
        e.model,
        e.dimensions,
        e.embedding_version,
        e.source_revision,
        e.embedding
      FROM platform_vector_entries e
      ${predicateSql}
      ORDER BY e.namespace, e.owner_user_id, e.id
      LIMIT ?
    `;
    // Pin both statements to one SQLite read snapshot. This prevents another
    // connection from growing or replacing the candidate set after it passed
    // its budget but before ciphertext is materialized in Node.
    const readAuthorizedCandidates = this.database.transaction(
      (): VectorRow[] => {
        // Aggregate the authorized and fully filtered set first. Count alone
        // is insufficient: high-dimensional rows can otherwise cause
        // multi-GiB allocation and scoring work.
        const budget = this.database
          .prepare(
            `SELECT COUNT(*) AS candidate_count,
                    COALESCE(SUM(LENGTH(e.embedding)), 0) AS encrypted_bytes
             FROM platform_vector_entries e
             ${predicateSql}`
          )
          .get(...parameters) as
          { candidate_count: number; encrypted_bytes: number } | undefined;
        const candidateCount = Number(budget?.candidate_count ?? 0);
        const encryptedBytes = Number(budget?.encrypted_bytes ?? 0);
        if (
          !Number.isSafeInteger(candidateCount) ||
          candidateCount < 0 ||
          !Number.isSafeInteger(encryptedBytes) ||
          encryptedBytes < 0
        ) {
          throw new VectorStoreError(
            'corrupt',
            'Invalid encrypted vector candidate accounting'
          );
        }
        if (candidateCount > this.maxCandidates) {
          throw new VectorStoreError(
            'candidate-limit',
            `Authorized vector candidate count exceeds ${this.maxCandidates}; narrow the query scope`
          );
        }
        if (encryptedBytes > this.maxCandidateBytes) {
          throw new VectorStoreError(
            'candidate-limit',
            `Authorized encrypted vector candidates exceed ${this.maxCandidateBytes} bytes; narrow the query scope`
          );
        }
        if (
          candidateCount >
          Math.floor(this.maxScoringComponents / request.dimensions)
        ) {
          throw new VectorStoreError(
            'candidate-limit',
            `Authorized vector scoring work exceeds ${this.maxScoringComponents} components; narrow the query scope`
          );
        }

        return this.database
          .prepare(sql)
          .all(...parameters, this.maxCandidates + 1) as VectorRow[];
      }
    );
    return readAuthorizedCandidates();
  }

  async query(request: VectorQuery): Promise<VectorHit[]> {
    const queryEmbedding = normalizeEmbedding(
      request.embedding,
      request.dimensions
    );
    const rows = this.queryRows(request);
    const getAttributes = this.database.prepare(`
      SELECT attribute_key, attribute_value
      FROM platform_vector_attributes
      WHERE namespace = ? AND owner_user_id = ? AND vector_id = ?
      ORDER BY attribute_key
    `);
    const hits: VectorHit[] = [];

    for (const row of rows) {
      try {
        const record = rowRecord(row);
        const embeddingPlaintext = this.keyring.decrypt(
          deserializeEnvelope(row.embedding),
          vectorAad(record)
        );
        const storedEmbedding = decodeEmbedding(
          embeddingPlaintext,
          row.dimensions
        );
        const score = cosineSimilarity(queryEmbedding, storedEmbedding);
        if (request.minScore !== undefined && score < request.minScore)
          continue;

        const attributeRows = getAttributes.all(
          row.namespace,
          row.owner_user_id,
          row.id
        ) as Array<{
          attribute_key: string;
          attribute_value: string;
        }>;
        hits.push({
          id: row.id,
          namespace: row.namespace,
          ownerUserId: row.owner_user_id,
          resourceId: row.resource_id,
          model: row.model,
          dimensions: row.dimensions,
          version: row.embedding_version,
          sourceRevision: row.source_revision,
          score,
          attributes: Object.freeze(
            Object.fromEntries(
              attributeRows.map(attribute => [
                attribute.attribute_key,
                attribute.attribute_value,
              ])
            )
          ),
        });
      } catch (error) {
        if (error instanceof VectorStoreError) throw error;
        if (error instanceof StorageEncryptionError) {
          throw new VectorStoreError(
            'corrupt',
            'Encrypted vector authentication failed',
            error
          );
        }
        throw error;
      }
    }

    return hits
      .sort(
        (left, right) =>
          right.score - left.score ||
          left.ownerUserId.localeCompare(right.ownerUserId) ||
          left.id.localeCompare(right.id)
      )
      .slice(0, request.limit);
  }

  /**
   * Authenticates every platform-vector envelope from one SQLite read
   * snapshot. Aggregate limits are checked before `.iterate()` exposes any
   * ciphertext to Node, and each plaintext vector is released before the next
   * row is stepped.
   */
  verifyIntegrity(
    options: VectorIntegrityVerificationOptions = {}
  ): VectorIntegrityVerificationResult {
    const maxRecords = options.maxRecords ?? DEFAULT_MAX_INTEGRITY_RECORDS;
    const maxEncryptedBytes =
      options.maxEncryptedBytes ?? DEFAULT_MAX_INTEGRITY_ENCRYPTED_BYTES;
    const maxComponents =
      options.maxComponents ?? DEFAULT_MAX_INTEGRITY_COMPONENTS;
    validateIntegrityLimit(maxRecords, 'vector integrity record limit');
    validateIntegrityLimit(
      maxEncryptedBytes,
      'vector integrity encrypted-byte limit'
    );
    validateIntegrityLimit(maxComponents, 'vector integrity component limit');

    const verifySnapshot = this.database.transaction(
      (): VectorIntegrityVerificationResult => {
        const aggregate = this.database
          .prepare(
            `SELECT COUNT(*) AS records,
                    COALESCE(SUM(LENGTH(embedding)), 0) AS encrypted_bytes,
                    COALESCE(SUM(dimensions), 0) AS components
             FROM platform_vector_entries`
          )
          .get() as
          | { records: number; encrypted_bytes: number; components: number }
          | undefined;
        const records = Number(aggregate?.records ?? 0);
        const encryptedBytes = Number(aggregate?.encrypted_bytes ?? 0);
        const components = Number(aggregate?.components ?? 0);
        if (
          !Number.isSafeInteger(records) ||
          records < 0 ||
          !Number.isSafeInteger(encryptedBytes) ||
          encryptedBytes < 0 ||
          !Number.isSafeInteger(components) ||
          components < 0
        ) {
          throw new VectorStoreError(
            'corrupt',
            'Invalid encrypted vector integrity accounting'
          );
        }
        if (
          records > maxRecords ||
          encryptedBytes > maxEncryptedBytes ||
          components > maxComponents
        ) {
          throw new VectorStoreError(
            'verification-limit',
            'Embedded vector storage exceeds bounded integrity verification limits'
          );
        }

        const rows = this.database
          .prepare(
            `SELECT namespace, id, owner_user_id, resource_id, model,
                    dimensions, embedding_version, source_revision, embedding,
                    created_at, updated_at
             FROM platform_vector_entries
             ORDER BY namespace, owner_user_id, id`
          )
          .iterate() as IterableIterator<VectorIntegrityRow>;
        let verifiedRecords = 0;
        let verifiedEncryptedBytes = 0;
        let verifiedComponents = 0;
        for (const row of rows) {
          verifiedRecords += 1;
          let plaintext: Buffer | undefined;
          try {
            try {
              validateString(row.namespace, 'namespace');
              validateString(row.id, 'ID');
              validateString(row.owner_user_id, 'owner user ID');
              validateString(row.resource_id, 'resource ID');
              validateString(row.model, 'model');
              validateString(row.embedding_version, 'version');
              validateString(row.source_revision, 'source revision');
              validateDimensions(row.dimensions);
            } catch (error) {
              throw new VectorStoreError(
                'corrupt',
                'Invalid encrypted vector record metadata',
                error
              );
            }
            if (
              !Number.isSafeInteger(row.created_at) ||
              row.created_at < 0 ||
              !Number.isSafeInteger(row.updated_at) ||
              row.updated_at < 0 ||
              !Buffer.isBuffer(row.embedding) ||
              row.embedding.length <= 0 ||
              row.embedding.length > MAX_SERIALIZED_EMBEDDING_BYTES
            ) {
              throw new VectorStoreError(
                'corrupt',
                'Invalid encrypted vector record'
              );
            }

            verifiedEncryptedBytes += row.embedding.length;
            verifiedComponents += row.dimensions;
            plaintext = this.keyring.decrypt(
              deserializeEnvelope(row.embedding),
              vectorAad(rowRecord(row))
            );
            validateEmbeddingPlaintext(plaintext, row.dimensions);
          } catch (error) {
            if (error instanceof VectorStoreError) throw error;
            if (error instanceof StorageEncryptionError) {
              throw new VectorStoreError(
                'corrupt',
                'Encrypted vector authentication failed',
                error
              );
            }
            throw new VectorStoreError(
              'corrupt',
              'Unable to verify encrypted vector storage',
              error
            );
          } finally {
            plaintext?.fill(0);
          }
        }

        if (
          verifiedRecords !== records ||
          verifiedEncryptedBytes !== encryptedBytes ||
          verifiedComponents !== components
        ) {
          throw new VectorStoreError(
            'corrupt',
            'Encrypted vector storage changed during integrity verification'
          );
        }
        return { records, encryptedBytes, components };
      }
    );
    return verifySnapshot();
  }

  async delete(request: VectorDeleteRequest): Promise<number> {
    validateActor(request.actor);
    validateString(request.namespace, 'namespace');
    if (!request.resourceId && (request.ids?.length ?? 0) === 0) {
      throw invalidInput(
        'Vector deletion requires a resource ID or explicit vector IDs'
      );
    }
    const ids = [...new Set(request.ids ?? [])];
    if (ids.length > MAX_RECORDS_PER_UPSERT) {
      throw invalidInput('Too many vector IDs to delete');
    }
    for (const id of ids) validateString(id, 'ID');
    if (request.resourceId) validateString(request.resourceId, 'resource ID');

    const parameters: string[] = [request.namespace, request.actor.userId];
    let sql = `
      DELETE FROM platform_vector_entries
      WHERE namespace = ? AND owner_user_id = ?
    `;
    if (request.resourceId) {
      sql += ' AND resource_id = ?';
      parameters.push(request.resourceId);
    }
    if (ids.length > 0) {
      sql += ` AND id IN (${ids.map(() => '?').join(', ')})`;
      parameters.push(...ids);
    }
    return this.database.prepare(sql).run(...parameters).changes;
  }

  async deleteAllForOwner(actor: VectorActor): Promise<number> {
    validateActor(actor);
    return this.database
      .prepare('DELETE FROM platform_vector_entries WHERE owner_user_id = ?')
      .run(actor.userId).changes;
  }
}
