/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { S3Client } from '@aws-sdk/client-s3';
import type Database from 'better-sqlite3';
import type {
  SQLiteToPostgresMigrationPhase,
  SQLiteToPostgresMigrationPhaseAnalysis,
  SQLiteToPostgresMigrationPhaseContext,
} from '../../persistence/sqliteToPostgresMigration.js';
import type { PostgresQueryExecutor } from '../../persistence/postgresDatabase.js';
import {
  POSTGRES_SQLITE_IMPORT_SCHEMA_SQL,
  SQLITE_STORAGE_IMPORT_TABLE,
} from '../../persistence/postgresImportState.js';
import { Aes256GcmKeyring } from './aesGcmKeyring.js';
import type {
  BlobDescriptor,
  BlobPutRequest,
  BlobQuotaPolicy,
  BlobQuotaReservation,
  TransactionalBlobQuotaPolicy,
  TransactionalBlobQuotaReservation,
} from './blobStore.js';
import { LocalEncryptedBlobStore } from './localEncryptedBlobStore.js';
import type { PlatformContentCipher } from './platformDomainRepositories.js';
import {
  resolveS3BlobConfiguration,
  S3EncryptedBlobStore,
  type S3BlobEnvironment,
} from './s3EncryptedBlobStore.js';
import { SqliteEncryptedVectorStore } from './sqliteEncryptedVectorStore.js';
import {
  MAX_VECTOR_RESOURCE_INDEX_ENTRIES,
  type VectorGrant,
  type VectorRecord,
} from './vectorStore.js';
import {
  aggregateDocumentIndexRevisionFromEntries,
  documentChunkSourceRevision,
  readDocumentIndexMetadata,
} from './documentVectorIndex.js';

const PHASE_NAME = 'platform-storage';
const ITEM_TABLE = SQLITE_STORAGE_IMPORT_TABLE;
const MAX_ITEMS = 500_000;
const MAX_INLINE_BLOB_BYTES = 512 * 1024 * 1024;
const MAX_PGVECTOR_DIMENSIONS = 16_000;
const BLOB_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type ItemType = 'blob' | 'vector' | 'gallery' | 'reference';

interface SourceBlobItem {
  type: 'blob';
  sourceId: string;
  checksum: string;
  targetId: string;
  descriptor: BlobDescriptor;
  source: 'local' | 'gallery-inline';
  mediaId?: string;
}

interface SourceVectorItem {
  type: 'vector';
  sourceId: string;
  checksum: string;
  targetId: string;
  identity: {
    namespace: string;
    ownerUserId: string;
    id: string;
  };
}

interface SourceGalleryItem {
  type: 'gallery';
  sourceId: string;
  checksum: string;
  targetId: string;
  mediaId: string;
  blobId: string;
  semantic: GallerySemantic;
}

interface SourceReferenceItem {
  type: 'reference';
  sourceId: string;
  checksum: string;
  targetId: string;
  reference: SourceReference;
}

type SourceItem =
  SourceBlobItem | SourceVectorItem | SourceGalleryItem | SourceReferenceItem;

interface SourceReference {
  blobId: string;
  ownerUserId: string;
  resourceType: string;
  resourceId: string;
  purpose: string;
  createdAt: number;
}

interface GallerySemantic {
  id: string;
  userId: string;
  kind: 'image' | 'audio' | 'video';
  prompt: string;
  model: string;
  pluginId: string | null;
  mimeType: string;
  sizeLabel: string | null;
  quality: string | null;
  metadataJson: string | null;
  createdAt: number;
}

interface SourceGalleryRow {
  id: string;
  user_id: string;
  kind: 'image' | 'audio' | 'video';
  prompt: string;
  model: string;
  plugin_id: string | null;
  image_data: string;
  mime_type: string;
  size: string | null;
  quality: string | null;
  metadata: string | null;
  created_at: number | bigint;
}

interface SourceDocumentChunkRow {
  document_id: string;
  user_id: string;
  metadata: string | null;
  chunk_id: string;
  chunk_index: number;
  content: string;
  embedding: string | null;
}

interface DocumentVectorProof {
  id: string;
  model: string;
  dimensions: number;
  version: string;
  sourceRevision: string;
  embeddingDigest: string;
}

type DocumentVectorProofs = Map<string, Map<string, DocumentVectorProof>>;

interface PhaseInventory {
  sourcePath: string;
  blobRoot: string;
  items: SourceItem[];
  blobs: SourceBlobItem[];
  vectors: SourceVectorItem[];
  gallery: SourceGalleryItem[];
  references: SourceReferenceItem[];
  checksum: string;
  warnings: string[];
  blockers: string[];
}

interface JournalRow extends Record<string, unknown> {
  item_type: ItemType;
  source_id: string;
  source_checksum: string;
  target_id: string;
}

export interface SQLiteToTeamStorageMigrationOptions {
  env?: S3BlobEnvironment;
  keyring: Aes256GcmKeyring;
  cipher: PlatformContentCipher;
  sourceBlobRoot?: string;
  maxItems?: number;
  maxInlineBlobBytes?: number;
  /** Deterministic fault-injection seam for crash/resume integration tests. */
  afterItemCommitted?: (item: {
    type: ItemType;
    sourceId: string;
    targetId: string;
  }) => Promise<void> | void;
  /** Deterministic post-COMMIT acknowledgement-loss seam for real tests. */
  afterBlobMetadataCommitted?: (
    descriptor: BlobDescriptor
  ) => Promise<void> | void;
}

const hashJson = (value: unknown): string =>
  crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

const safeNumber = (value: unknown, field: string): number => {
  const parsed = typeof value === 'bigint' ? Number(value) : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid SQLite platform storage ${field}`);
  }
  return parsed;
};

const itemSourceId = (type: ItemType, identity: unknown): string =>
  hashJson([PHASE_NAME, type, identity]);

const canonicalDescriptor = (descriptor: BlobDescriptor): unknown => ({
  id: descriptor.id,
  ownerUserId: descriptor.ownerUserId,
  purpose: descriptor.purpose,
  contentType: descriptor.contentType,
  originalFilename: descriptor.originalFilename ?? null,
  metadata: Object.fromEntries(Object.entries(descriptor.metadata).sort()),
  size: descriptor.size,
  sha256: descriptor.sha256,
  createdAt: descriptor.createdAt,
  formatVersion: descriptor.formatVersion,
});

const canonicalReference = (reference: SourceReference): unknown => ({
  blobId: reference.blobId,
  ownerUserId: reference.ownerUserId,
  resourceType: reference.resourceType,
  resourceId: reference.resourceId,
  purpose: reference.purpose,
  createdAt: reference.createdAt,
});

const vectorIdentity = (
  record: Pick<VectorRecord, 'namespace' | 'ownerUserId' | 'id'>
): SourceVectorItem['identity'] => ({
  namespace: record.namespace,
  ownerUserId: record.ownerUserId,
  id: record.id,
});

const vectorIdentityKey = (
  record: Pick<VectorRecord, 'namespace' | 'ownerUserId' | 'id'>
): string => `${record.namespace}\u0000${record.ownerUserId}\u0000${record.id}`;

const decodeLegacyEmbedding = (value: Buffer, memoryId: string): number[] => {
  if (
    value.byteLength === 0 ||
    value.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0
  ) {
    throw new Error(
      `Legacy persona memory ${memoryId} has an invalid embedding byte length`
    );
  }
  const embedding: number[] = [];
  for (let offset = 0; offset < value.byteLength; offset += 4) {
    const component = value.readFloatLE(offset);
    if (!Number.isFinite(component)) {
      throw new Error(
        `Legacy persona memory ${memoryId} has a non-finite embedding`
      );
    }
    embedding.push(component);
  }
  return embedding;
};

const canonicalVectorChecksum = (record: VectorRecord): string => {
  const hash = crypto.createHash('sha256');
  hash.update(
    JSON.stringify({
      namespace: record.namespace,
      id: record.id,
      ownerUserId: record.ownerUserId,
      resourceId: record.resourceId,
      model: record.model,
      dimensions: record.dimensions,
      version: record.version,
      sourceRevision: record.sourceRevision,
      attributes: Object.fromEntries(
        Object.entries(record.attributes ?? {}).sort(([left], [right]) =>
          left.localeCompare(right)
        )
      ),
      grants: [...(record.grants ?? [])].sort(
        (left, right) =>
          left.type.localeCompare(right.type) || left.id.localeCompare(right.id)
      ),
      createdAt: record.createdAt ?? null,
    })
  );
  const embedding = Buffer.allocUnsafe(record.embedding.length * 4);
  try {
    for (let index = 0; index < record.embedding.length; index += 1) {
      const component = Math.fround(record.embedding[index]);
      embedding.writeFloatLE(
        Object.is(component, -0) ? 0 : component,
        index * 4
      );
    }
    hash.update(embedding);
    return hash.digest('hex');
  } finally {
    embedding.fill(0);
  }
};

const deterministicUuid = (identity: unknown): string => {
  const bytes = crypto
    .createHash('sha256')
    .update(JSON.stringify([PHASE_NAME, identity]))
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

const decryptLegacyText = (
  cipher: PlatformContentCipher,
  value: string
): string =>
  cipher.isEncrypted(value) ? cipher.decryptAuthenticated(value) : value;

const documentResourceKey = (ownerUserId: string, documentId: string): string =>
  `${ownerUserId}\u0000${documentId}`;

const float32EmbeddingDigest = (embedding: readonly number[]): string => {
  const bytes = Buffer.allocUnsafe(embedding.length * 4);
  try {
    for (let index = 0; index < embedding.length; index += 1) {
      const component = Math.fround(embedding[index]!);
      bytes.writeFloatLE(Object.is(component, -0) ? 0 : component, index * 4);
    }
    return crypto.createHash('sha256').update(bytes).digest('hex');
  } finally {
    bytes.fill(0);
  }
};

const legacyDocumentCandidateKeys = (
  database: Database.Database
): Set<string> => {
  const candidates = new Set<string>();
  const rows = database
    .prepare(
      `SELECT d.id AS document_id, d.user_id
         FROM documents d
        WHERE EXISTS (
          SELECT 1 FROM document_chunks legacy
           WHERE legacy.document_id = d.id AND legacy.embedding IS NOT NULL
        )
        ORDER BY d.user_id, d.id`
    )
    .iterate() as Iterable<{ document_id: string; user_id: string }>;
  for (const row of rows) {
    candidates.add(documentResourceKey(row.user_id, row.document_id));
  }
  return candidates;
};

const legacyDocumentVectorCoverageBlocker = (
  database: Database.Database,
  cipher: PlatformContentCipher,
  vectorProofs: DocumentVectorProofs
): string | undefined => {
  const rows = database
    .prepare(
      `SELECT d.id AS document_id, d.user_id, d.metadata,
              c.id AS chunk_id, c.chunk_index, c.content, c.embedding
         FROM documents d
         JOIN document_chunks c ON c.document_id = d.id
        WHERE EXISTS (
          SELECT 1 FROM document_chunks legacy
           WHERE legacy.document_id = d.id AND legacy.embedding IS NOT NULL
        )
        ORDER BY d.user_id, d.id, c.chunk_index, c.id`
    )
    .iterate() as Iterable<SourceDocumentChunkRow>;
  const affected = new Map<string, Set<string>>();
  const reasonCounts = new Map<string, number>();
  const reject = (row: SourceDocumentChunkRow, reason: string): void => {
    const documents = affected.get(row.user_id) ?? new Set<string>();
    documents.add(row.document_id);
    affected.set(row.user_id, documents);
    reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
  };
  type IndexMetadata = NonNullable<
    ReturnType<typeof readDocumentIndexMetadata>
  >;
  interface DocumentState {
    first: SourceDocumentChunkRow;
    rowCount: number;
    ciphertextBytes: number;
    reasons: Set<string>;
    indexMetadata?: IndexMetadata;
    chunks: Array<{
      id: string;
      sourceRevision: string;
      dimensions: number;
      embeddingDigest: string;
    }>;
  }
  const startDocument = (row: SourceDocumentChunkRow): DocumentState => {
    const state: DocumentState = {
      first: row,
      rowCount: 0,
      ciphertextBytes: 0,
      reasons: new Set<string>(),
      chunks: [],
    };
    if (!row.metadata || !cipher.isEncrypted(row.metadata)) {
      state.reasons.add('missing authenticated embeddingIndex metadata');
      return state;
    }
    try {
      const parsed = JSON.parse(
        cipher.decryptAuthenticated(row.metadata)
      ) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        state.reasons.add('invalid authenticated embeddingIndex metadata');
      } else {
        const metadata = readDocumentIndexMetadata(
          parsed as Record<string, unknown>
        );
        if (!metadata || metadata.dimensions === null) {
          state.reasons.add('invalid authenticated embeddingIndex metadata');
        } else {
          state.indexMetadata = metadata;
        }
      }
    } catch {
      state.reasons.add('invalid authenticated embeddingIndex metadata');
    }
    return state;
  };
  const addChunk = (
    state: DocumentState,
    row: SourceDocumentChunkRow
  ): void => {
    state.rowCount += 1;
    const contentBytes = Buffer.byteLength(row.content, 'utf8');
    const embeddingBytes = row.embedding
      ? Buffer.byteLength(row.embedding, 'utf8')
      : 0;
    state.ciphertextBytes += contentBytes + embeddingBytes;
    if (
      state.rowCount > MAX_VECTOR_RESOURCE_INDEX_ENTRIES ||
      state.ciphertextBytes > 80 * 1024 * 1024 ||
      contentBytes > 12 * 1024 * 1024 ||
      embeddingBytes > 4 * 1024 * 1024
    ) {
      state.reasons.add(
        'document vector proof exceeds bounded migration limits'
      );
      return;
    }
    let content: string | undefined;
    if (!cipher.isEncrypted(row.content)) {
      state.reasons.add('unauthenticated legacy chunk content');
    } else {
      try {
        content = cipher.decryptAuthenticated(row.content);
      } catch {
        state.reasons.add('invalid authenticated chunk content');
      }
    }
    let embedding: number[] | undefined;
    if (!row.embedding) {
      state.reasons.add('partial inline embedding coverage');
    } else if (!cipher.isEncrypted(row.embedding)) {
      state.reasons.add('unauthenticated inline embedding');
    } else {
      try {
        const parsed = JSON.parse(
          cipher.decryptAuthenticated(row.embedding)
        ) as unknown;
        if (
          !Array.isArray(parsed) ||
          parsed.length < 1 ||
          parsed.length > MAX_PGVECTOR_DIMENSIONS ||
          !parsed.every(
            component =>
              typeof component === 'number' && Number.isFinite(component)
          )
        ) {
          state.reasons.add('invalid authenticated inline embedding');
        } else {
          embedding = parsed;
        }
      } catch {
        state.reasons.add('invalid authenticated inline embedding');
      }
    }
    if (content !== undefined && embedding) {
      state.chunks.push({
        id: row.chunk_id,
        sourceRevision: documentChunkSourceRevision({ content }),
        dimensions: embedding.length,
        embeddingDigest: float32EmbeddingDigest(embedding),
      });
    }
  };
  const finishDocument = (state: DocumentState): void => {
    const { first, indexMetadata, chunks, reasons } = state;
    const proofs =
      vectorProofs.get(documentResourceKey(first.user_id, first.document_id)) ??
      new Map<string, DocumentVectorProof>();
    if (
      !indexMetadata ||
      chunks.length !== state.rowCount ||
      state.rowCount > MAX_VECTOR_RESOURCE_INDEX_ENTRIES
    ) {
      if (reasons.size === 0) reasons.add('incomplete modern vector coverage');
    } else {
      if (proofs.size !== chunks.length) {
        reasons.add('incomplete or extra platform vector coverage');
      }
      for (const chunk of chunks) {
        const proof = proofs.get(chunk.id);
        if (
          !proof ||
          proof.model !== indexMetadata.model ||
          proof.version !== indexMetadata.version ||
          proof.dimensions !== indexMetadata.dimensions ||
          chunk.dimensions !== indexMetadata.dimensions ||
          proof.sourceRevision !== chunk.sourceRevision ||
          proof.embeddingDigest !== chunk.embeddingDigest
        ) {
          reasons.add('platform vector payload does not match inline index');
          break;
        }
      }
      if (
        aggregateDocumentIndexRevisionFromEntries(chunks, indexMetadata) !==
        indexMetadata.aggregateRevision
      ) {
        reasons.add('embeddingIndex aggregate revision mismatch');
      }
    }
    for (const reason of reasons) reject(first, reason);
  };

  let state: DocumentState | undefined;
  let stateKey: string | undefined;
  for (const row of rows) {
    const key = documentResourceKey(row.user_id, row.document_id);
    if (state && key !== stateKey) finishDocument(state);
    if (!state || key !== stateKey) {
      state = startDocument(row);
      stateKey = key;
    }
    addChunk(state, row);
  }
  if (state) finishDocument(state);

  if (affected.size === 0) return undefined;
  const documentIds = [...affected.values()].flatMap(ids => [...ids]);
  const reasons = [...reasonCounts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([reason, count]) => `${reason}: ${count}`)
    .join('; ');
  const examples = documentIds.slice(0, 8).join(', ');
  return (
    `${documentIds.length} legacy document index(es) across ${affected.size} owner(s) lack fully authenticated modern vector coverage (${reasons}). ` +
    `Affected document IDs${documentIds.length > 8 ? ' (first 8)' : ''}: ${examples}. ` +
    'Start this Libre WebUI release in solo/SQLite mode with the same DATA_DIR and ENCRYPTION_KEY used for migration, enable and select the desired embedding model, then use Settings -> Documents -> Regenerate embeddings for every affected owner. Rerun the migration dry-run afterward; current preferences do not prove which model created legacy inline vectors.'
  );
};

const parseDataUrl = (
  cipher: PlatformContentCipher,
  row: SourceGalleryRow,
  maximumBytes: number
): { bytes: Buffer; mimeType: string } => {
  const value = decryptLegacyText(cipher, row.image_data);
  const match =
    /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+);base64,([a-z0-9+/]+={0,2})$/i.exec(
      value
    );
  if (!match) {
    throw new Error(
      `Gallery item ${row.id} contains a provider URL or invalid inline payload; download it through the current solo release before migration`
    );
  }
  const mimeType = match[1].toLowerCase();
  if (mimeType !== row.mime_type.toLowerCase()) {
    throw new Error(`Gallery item ${row.id} has inconsistent MIME metadata`);
  }
  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.length > maximumBytes || bytes.toString('base64') !== match[2]) {
    bytes.fill(0);
    throw new Error(
      `Gallery item ${row.id} has an invalid or oversized payload`
    );
  }
  return { bytes, mimeType };
};

const gallerySemantic = (
  cipher: PlatformContentCipher,
  row: SourceGalleryRow
): GallerySemantic => ({
  id: row.id,
  userId: row.user_id,
  kind: row.kind,
  prompt: decryptLegacyText(cipher, row.prompt),
  model: row.model,
  pluginId: row.plugin_id,
  mimeType: row.mime_type,
  sizeLabel: row.size,
  quality: row.quality,
  metadataJson: row.metadata ? decryptLegacyText(cipher, row.metadata) : null,
  createdAt: safeNumber(row.created_at, 'gallery creation time'),
});

const sourceReferences = (database: Database.Database): SourceReference[] =>
  (
    database
      .prepare(
        `SELECT blob_id, owner_user_id, resource_type, resource_id, purpose,
                CAST(created_at AS REAL) AS created_at
           FROM platform_blob_references
          ORDER BY resource_type, resource_id, purpose`
      )
      .all() as Array<{
      blob_id: string;
      owner_user_id: string;
      resource_type: string;
      resource_id: string;
      purpose: string;
      created_at: number;
    }>
  ).map(row => ({
    blobId: row.blob_id,
    ownerUserId: row.owner_user_id,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    purpose: row.purpose,
    createdAt: safeNumber(row.created_at, 'blob reference creation time'),
  }));

const sourceGalleryRows = (database: Database.Database): SourceGalleryRow[] =>
  database
    .prepare(
      `SELECT id, user_id, kind, prompt, model, plugin_id, image_data,
              mime_type, size, quality, metadata,
              CAST(created_at AS REAL) AS created_at
         FROM generated_images ORDER BY id`
    )
    .all() as SourceGalleryRow[];

const scanLocalBlobIds = (blobRoot: string): string[] => {
  if (!fs.existsSync(blobRoot)) return [];
  const rootStat = fs.lstatSync(blobRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('SQLite blob migration root must be a physical directory');
  }
  const objectsRoot = path.join(blobRoot, 'objects');
  if (!fs.existsSync(objectsRoot)) return [];
  const ids: string[] = [];
  for (const first of fs.readdirSync(objectsRoot, { withFileTypes: true })) {
    if (
      !first.isDirectory() ||
      first.isSymbolicLink() ||
      !/^[0-9a-f]{2}$/.test(first.name)
    ) {
      throw new Error(
        'SQLite blob storage contains a non-canonical first shard'
      );
    }
    const firstPath = path.join(objectsRoot, first.name);
    for (const second of fs.readdirSync(firstPath, { withFileTypes: true })) {
      if (
        !second.isDirectory() ||
        second.isSymbolicLink() ||
        !/^[0-9a-f]{2}$/.test(second.name)
      ) {
        throw new Error(
          'SQLite blob storage contains a non-canonical second shard'
        );
      }
      const secondPath = path.join(firstPath, second.name);
      for (const entry of fs.readdirSync(secondPath, { withFileTypes: true })) {
        const match = /^([0-9a-f-]{36})\.blob$/.exec(entry.name);
        if (
          !entry.isFile() ||
          entry.isSymbolicLink() ||
          !match ||
          !BLOB_ID_PATTERN.test(match[1])
        ) {
          throw new Error(
            'SQLite blob storage contains a non-canonical object'
          );
        }
        const id = match[1];
        if (id.slice(0, 2) !== first.name || id.slice(2, 4) !== second.name) {
          throw new Error('SQLite blob object is stored in the wrong shard');
        }
        ids.push(id);
      }
    }
  }
  return ids.sort();
};

const countStagingFiles = (blobRoot: string): number => {
  const staging = path.join(blobRoot, 'staging');
  if (!fs.existsSync(staging)) return 0;
  const stat = fs.lstatSync(staging);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('SQLite blob staging path is not a physical directory');
  }
  return fs
    .readdirSync(staging, { withFileTypes: true })
    .filter(entry => entry.isFile()).length;
};

const consumeAndHash = async (
  body: AsyncIterable<Uint8Array>
): Promise<string> => {
  const hash = crypto.createHash('sha256');
  for await (const chunk of body) hash.update(chunk);
  return hash.digest('hex');
};

class MigrationQuotaPolicy
  implements BlobQuotaPolicy, TransactionalBlobQuotaPolicy
{
  constructor(
    private readonly target: PostgresQueryExecutor,
    private readonly afterMetadataCommitted?: (
      descriptor: BlobDescriptor
    ) => Promise<void> | void
  ) {}

  async reserve(request: {
    ownerUserId: string;
    purpose: string;
    expectedSize?: number;
  }): Promise<BlobQuotaReservation> {
    let consumed = 0;
    let settled = false;
    const reservation: TransactionalBlobQuotaReservation = {
      consume: async bytes => {
        if (settled || !Number.isSafeInteger(bytes) || bytes < 0) {
          throw new Error('Invalid storage migration quota reservation');
        }
        consumed += bytes;
        if (!Number.isSafeInteger(consumed)) {
          throw new Error('Storage migration blob size exceeds integer bounds');
        }
      },
      commit: async descriptor => {
        await reservation.commitWithMetadata?.(
          descriptor,
          async () => undefined
        );
      },
      release: async () => {
        settled = true;
      },
    };
    reservation.commitWithMetadata = async (descriptor, operation) => {
      if (
        settled ||
        descriptor.ownerUserId !== request.ownerUserId ||
        descriptor.purpose !== request.purpose ||
        descriptor.size !== consumed
      ) {
        throw new Error('Storage migration blob accounting mismatch');
      }
      await this.target.query('BEGIN');
      try {
        await operation(this.target);
        await this.target.query(
          `INSERT INTO platform_blob_quota_objects
             (blob_id, owner_user_id, purpose, stored_bytes, created_at)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            descriptor.id,
            descriptor.ownerUserId,
            descriptor.purpose,
            descriptor.size,
            Date.parse(descriptor.createdAt),
          ]
        );
        await this.target.query(
          `INSERT INTO platform_blob_quota_usage
             (owner_user_id, stored_bytes, reserved_bytes, updated_at)
           VALUES ($1, $2, 0, $3)
           ON CONFLICT(owner_user_id) DO UPDATE SET
             stored_bytes = platform_blob_quota_usage.stored_bytes + EXCLUDED.stored_bytes,
             updated_at = EXCLUDED.updated_at`,
          [descriptor.ownerUserId, descriptor.size, Date.now()]
        );
        await this.target.query('COMMIT');
        settled = true;
      } catch (error) {
        await this.target.query('ROLLBACK').catch(() => undefined);
        throw error;
      }
      await this.afterMetadataCommitted?.(descriptor);
    };
    return reservation;
  }

  async releaseStoredWithMetadata(
    request: { id: string; ownerUserId: string },
    operation: (executor: unknown) => Promise<void>
  ): Promise<void> {
    await this.target.query('BEGIN');
    try {
      const existing = await this.target.query<
        { stored_bytes: string | number } & Record<string, unknown>
      >(
        `SELECT stored_bytes FROM platform_blob_quota_objects
          WHERE blob_id = $1 AND owner_user_id = $2 FOR UPDATE`,
        [request.id, request.ownerUserId]
      );
      await operation(this.target);
      const storedBytes = existing.rows[0]
        ? safeNumber(existing.rows[0].stored_bytes, 'target quota bytes')
        : 0;
      if (storedBytes > 0) {
        await this.target.query(
          `UPDATE platform_blob_quota_usage
              SET stored_bytes = stored_bytes - $1, updated_at = $2
            WHERE owner_user_id = $3`,
          [storedBytes, Date.now(), request.ownerUserId]
        );
      }
      await this.target.query(
        `DELETE FROM platform_blob_quota_objects
          WHERE blob_id = $1 AND owner_user_id = $2`,
        [request.id, request.ownerUserId]
      );
      await this.target.query('COMMIT');
    } catch (error) {
      await this.target.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  }
}

class SQLiteToTeamStorageMigrationPhase implements SQLiteToPostgresMigrationPhase {
  private readonly env: S3BlobEnvironment;
  private readonly maxItems: number;
  private readonly maxInlineBlobBytes: number;
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly keyPrefix: string;
  private inventory: PhaseInventory | undefined;

  constructor(private readonly options: SQLiteToTeamStorageMigrationOptions) {
    this.env = options.env ?? process.env;
    this.maxItems = options.maxItems ?? MAX_ITEMS;
    this.maxInlineBlobBytes =
      options.maxInlineBlobBytes ?? MAX_INLINE_BLOB_BYTES;
    if (!Number.isSafeInteger(this.maxItems) || this.maxItems < 1) {
      throw new Error('Invalid platform storage migration item limit');
    }
    if (
      !Number.isSafeInteger(this.maxInlineBlobBytes) ||
      this.maxInlineBlobBytes < 1
    ) {
      throw new Error('Invalid platform storage migration blob limit');
    }
    const resolved = resolveS3BlobConfiguration(this.env);
    this.client = new S3Client(resolved.clientConfig);
    this.bucket = resolved.bucket;
    this.keyPrefix = resolved.keyPrefix;
  }

  private localStore(blobRoot: string): LocalEncryptedBlobStore {
    return new LocalEncryptedBlobStore({
      rootDirectory: blobRoot,
      keyring: this.options.keyring,
      readOnly: true,
    });
  }

  private targetStore(target: PostgresQueryExecutor): S3EncryptedBlobStore {
    return new S3EncryptedBlobStore({
      database: target,
      client: this.client,
      bucket: this.bucket,
      keyPrefix: this.keyPrefix,
      keyring: this.options.keyring,
      quotaPolicy: new MigrationQuotaPolicy(
        target,
        this.options.afterBlobMetadataCommitted
      ),
    });
  }

  private async *sourceVectorRecords(
    database: Database.Database
  ): AsyncGenerator<VectorRecord> {
    database.defaultSafeIntegers(false);
    const store = new SqliteEncryptedVectorStore({
      database,
      keyring: this.options.keyring,
    });
    const identities = new Set<string>();
    for await (const record of store.exportAuthenticatedRecords()) {
      identities.add(vectorIdentityKey(record));
      yield record;
    }

    const legacyRows = database
      .prepare(
        `SELECT m.id, m.user_id, m.persona_id, m.content, m.embedding,
                m.timestamp, COALESCE(m.memory_type, 'general') AS memory_type,
                COALESCE(NULLIF(p.embedding_model, ''), 'legacy-import') AS model
           FROM persona_memories m
           JOIN personas p ON p.id = m.persona_id AND p.user_id = m.user_id
          WHERE m.embedding IS NOT NULL
          ORDER BY m.user_id, m.id`
      )
      .iterate() as Iterable<{
      id: string;
      user_id: string;
      persona_id: string;
      content: string;
      embedding: Buffer;
      timestamp: number;
      memory_type: string;
      model: string;
    }>;
    for (const row of legacyRows) {
      const identity = {
        namespace: 'persona-memory',
        ownerUserId: row.user_id,
        id: row.id,
      };
      if (identities.has(vectorIdentityKey(identity))) continue;
      const embedding = decodeLegacyEmbedding(row.embedding, row.id);
      if (embedding.length > MAX_PGVECTOR_DIMENSIONS) {
        throw new Error(
          `Legacy persona memory ${row.id} has ${embedding.length} dimensions; PGVector supports at most ${MAX_PGVECTOR_DIMENSIONS}`
        );
      }
      const content = decryptLegacyText(this.options.cipher, row.content);
      yield {
        ...identity,
        resourceId: row.persona_id,
        model: row.model,
        dimensions: embedding.length,
        version: 'v1',
        sourceRevision: crypto
          .createHash('sha256')
          .update(content, 'utf8')
          .digest('hex'),
        embedding,
        attributes: { memoryType: row.memory_type },
        grants: [],
        createdAt: safeNumber(row.timestamp, 'legacy memory timestamp'),
      };
    }
  }

  private async buildInventory(
    database: Database.Database,
    sourcePath: string
  ): Promise<PhaseInventory> {
    // The relational migrator reads manifest integers as bigint. Storage
    // adapters deliberately validate ordinary safe JS integers, so switch the
    // private migration snapshot back before authenticating storage records.
    database.defaultSafeIntegers(false);
    const blobRoot = path.resolve(
      this.options.sourceBlobRoot ??
        path.join(path.dirname(sourcePath), 'blobs')
    );
    const warnings: string[] = [];
    const blockers: string[] = [];
    const references = sourceReferences(database);
    const referenceByResource = new Map(
      references.map(reference => [
        `${reference.resourceType}\u0000${reference.resourceId}\u0000${reference.purpose}`,
        reference,
      ])
    );
    const physicalIds = scanLocalBlobIds(blobRoot);
    const physicalSet = new Set(physicalIds);
    const metadataOwners = new Map<string, Set<string>>();
    for (const reference of references) {
      const owners = metadataOwners.get(reference.blobId) ?? new Set<string>();
      owners.add(reference.ownerUserId);
      metadataOwners.set(reference.blobId, owners);
      if (!physicalSet.has(reference.blobId)) {
        blockers.push(
          `Blob reference ${reference.resourceType}/${reference.resourceId} points to missing object ${reference.blobId}`
        );
      }
    }
    const quotaRows = database
      .prepare(
        `SELECT blob_id, owner_user_id FROM platform_blob_quota_objects
          ORDER BY blob_id`
      )
      .all() as Array<{ blob_id: string; owner_user_id: string }>;
    for (const row of quotaRows) {
      const owners = metadataOwners.get(row.blob_id) ?? new Set<string>();
      owners.add(row.owner_user_id);
      metadataOwners.set(row.blob_id, owners);
      if (!physicalSet.has(row.blob_id)) {
        blockers.push(
          `Blob quota metadata points to missing object ${row.blob_id}`
        );
      }
    }
    const reservationCount = safeNumber(
      (
        database
          .prepare(
            `SELECT CAST(COUNT(*) AS REAL) AS count
               FROM platform_blob_quota_reservations`
          )
          .get() as { count: number }
      ).count,
      'reservation count'
    );
    if (reservationCount > 0) {
      warnings.push(
        `${reservationCount} abandoned/in-flight blob quota reservation(s) are not copied; target usage is reconstructed from authenticated objects.`
      );
    }
    const stagingFiles = countStagingFiles(blobRoot);
    if (stagingFiles > 0) {
      warnings.push(
        `${stagingFiles} private staging blob file(s) are excluded; only atomically published objects are migrated.`
      );
    }

    const blobs: SourceBlobItem[] = [];
    if (physicalIds.length > 0) {
      const store = this.localStore(blobRoot);
      for (const id of physicalIds) {
        const descriptor = await store.inspectAuthenticated(id);
        const digest = await consumeAndHash(
          (await store.open({ id, ownerUserId: descriptor.ownerUserId })).body
        );
        if (digest !== descriptor.sha256) {
          throw new Error(
            `Local blob ${id} failed plaintext checksum verification`
          );
        }
        const owners = metadataOwners.get(id);
        if (
          owners &&
          (owners.size !== 1 || !owners.has(descriptor.ownerUserId))
        ) {
          blockers.push(
            `Blob ${id} owner metadata does not match its authenticated descriptor`
          );
        }
        const checksum = hashJson(canonicalDescriptor(descriptor));
        blobs.push({
          type: 'blob',
          sourceId: itemSourceId('blob', id),
          checksum,
          targetId: id,
          descriptor,
          source: 'local',
        });
      }
    }

    const gallery: SourceGalleryItem[] = [];
    const allReferences = [...references];
    for (const row of sourceGalleryRows(database)) {
      const semantic = gallerySemantic(this.options.cipher, row);
      const referenceKey = `generated-media\u0000${row.id}\u0000gallery.media`;
      let reference = referenceByResource.get(referenceKey);
      if (!reference) {
        try {
          const parsed = parseDataUrl(
            this.options.cipher,
            row,
            this.maxInlineBlobBytes
          );
          try {
            const targetId = deterministicUuid(['gallery-inline', row.id]);
            const descriptor: BlobDescriptor = {
              id: targetId,
              ownerUserId: row.user_id,
              purpose: 'gallery.media',
              contentType: parsed.mimeType,
              metadata: Object.freeze({
                resourceType: 'generated-media',
                resourceId: row.id,
              }),
              size: parsed.bytes.length,
              sha256: crypto
                .createHash('sha256')
                .update(parsed.bytes)
                .digest('hex'),
              createdAt: new Date(semantic.createdAt).toISOString(),
              encryptionKeyId: this.options.keyring.activeKeyId,
              formatVersion: 1,
            };
            blobs.push({
              type: 'blob',
              sourceId: itemSourceId('blob', ['gallery-inline', row.id]),
              checksum: hashJson(canonicalDescriptor(descriptor)),
              targetId,
              descriptor,
              source: 'gallery-inline',
              mediaId: row.id,
            });
            reference = {
              blobId: targetId,
              ownerUserId: row.user_id,
              resourceType: 'generated-media',
              resourceId: row.id,
              purpose: 'gallery.media',
              createdAt: semantic.createdAt,
            };
            allReferences.push(reference);
            referenceByResource.set(referenceKey, reference);
          } finally {
            parsed.bytes.fill(0);
          }
        } catch (error) {
          blockers.push(
            error instanceof Error
              ? error.message
              : `Gallery item ${row.id} is not migratable`
          );
          continue;
        }
      }
      if (reference.ownerUserId !== row.user_id) {
        blockers.push(
          `Gallery item ${row.id} has a cross-owner blob reference`
        );
        continue;
      }
      const blob = blobs.find(item => item.targetId === reference!.blobId);
      if (!blob) {
        blockers.push(
          `Gallery item ${row.id} references unavailable blob ${reference.blobId}`
        );
        continue;
      }
      const checksum = hashJson({ ...semantic, blobId: reference.blobId });
      gallery.push({
        type: 'gallery',
        sourceId: itemSourceId('gallery', row.id),
        checksum,
        targetId: row.id,
        mediaId: row.id,
        blobId: reference.blobId,
        semantic,
      });
    }

    const referenceItems = allReferences
      .map(reference => ({
        type: 'reference' as const,
        sourceId: itemSourceId('reference', [
          reference.resourceType,
          reference.resourceId,
          reference.purpose,
        ]),
        checksum: hashJson(canonicalReference(reference)),
        targetId: reference.blobId,
        reference,
      }))
      .sort((left, right) => left.sourceId.localeCompare(right.sourceId));

    const vectors: SourceVectorItem[] = [];
    const legacyDocumentCandidates = legacyDocumentCandidateKeys(database);
    const documentVectorProofs: DocumentVectorProofs = new Map();
    try {
      for await (const record of this.sourceVectorRecords(database)) {
        if (record.namespace === 'document-chunk') {
          const key = documentResourceKey(
            record.ownerUserId,
            record.resourceId
          );
          if (legacyDocumentCandidates.has(key)) {
            const proofs =
              documentVectorProofs.get(key) ??
              new Map<string, DocumentVectorProof>();
            proofs.set(record.id, {
              id: record.id,
              model: record.model,
              dimensions: record.dimensions,
              version: record.version,
              sourceRevision: record.sourceRevision,
              embeddingDigest: float32EmbeddingDigest(record.embedding),
            });
            documentVectorProofs.set(key, proofs);
          }
        }
        if (record.dimensions > MAX_PGVECTOR_DIMENSIONS) {
          blockers.push(
            `Vector ${record.namespace}/${record.id} has ${record.dimensions} dimensions; PGVector supports at most ${MAX_PGVECTOR_DIMENSIONS}`
          );
        }
        const identity = vectorIdentity(record);
        vectors.push({
          type: 'vector',
          sourceId: itemSourceId('vector', identity),
          checksum: canonicalVectorChecksum(record),
          targetId: record.id,
          identity,
        });
      }
    } catch (error) {
      blockers.push(
        `Platform vector authentication failed: ${error instanceof Error ? error.message : 'invalid vector record'}`
      );
    }
    const legacyDocumentBlocker = legacyDocumentVectorCoverageBlocker(
      database,
      this.options.cipher,
      documentVectorProofs
    );
    if (legacyDocumentBlocker) blockers.push(legacyDocumentBlocker);
    vectors.sort((left, right) => left.sourceId.localeCompare(right.sourceId));
    blobs.sort((left, right) => left.sourceId.localeCompare(right.sourceId));
    gallery.sort((left, right) => left.sourceId.localeCompare(right.sourceId));
    const items: SourceItem[] = [
      ...blobs,
      ...vectors,
      ...gallery,
      ...referenceItems,
    ];
    if (items.length > this.maxItems) {
      blockers.push(
        `Platform storage migration has ${items.length} items, exceeding the configured limit of ${this.maxItems}`
      );
    }
    const checksum = hashJson(
      items.map(item => [
        item.type,
        item.sourceId,
        item.checksum,
        item.targetId,
      ])
    );
    return {
      sourcePath,
      blobRoot,
      items,
      blobs,
      vectors,
      gallery,
      references: referenceItems,
      checksum,
      warnings,
      blockers: [...new Set(blockers)],
    };
  }

  private async inventoryFor(
    database: Database.Database,
    sourcePath: string
  ): Promise<PhaseInventory> {
    if (this.inventory?.sourcePath === sourcePath && this.inventory.checksum) {
      return this.inventory;
    }
    this.inventory = await this.buildInventory(database, sourcePath);
    return this.inventory;
  }

  async analyze(input: {
    sourceDatabase: Database.Database;
    sourcePath: string;
  }): Promise<SQLiteToPostgresMigrationPhaseAnalysis> {
    const inventory = await this.inventoryFor(
      input.sourceDatabase,
      input.sourcePath
    );
    return {
      name: PHASE_NAME,
      items: inventory.items.length,
      checksum: inventory.checksum,
      warnings: [...inventory.warnings],
      blockers: [...inventory.blockers],
    };
  }

  private async ensureJournal(target: PostgresQueryExecutor): Promise<void> {
    await target.query(POSTGRES_SQLITE_IMPORT_SCHEMA_SQL);
  }

  private async journalRow(
    target: PostgresQueryExecutor,
    fingerprint: string,
    item: SourceItem
  ): Promise<JournalRow | undefined> {
    const result = await target.query<JournalRow>(
      `SELECT item_type, source_id, source_checksum, target_id
         FROM ${ITEM_TABLE}
        WHERE source_fingerprint = $1 AND item_type = $2 AND source_id = $3`,
      [fingerprint, item.type, item.sourceId]
    );
    return result.rows[0];
  }

  private assertJournal(row: JournalRow, item: SourceItem): void {
    if (
      row.item_type !== item.type ||
      row.source_id !== item.sourceId ||
      row.source_checksum !== item.checksum ||
      row.target_id !== item.targetId
    ) {
      throw new Error(
        `Platform storage import journal mismatch for ${item.type}`
      );
    }
  }

  private async recordJournal(
    target: PostgresQueryExecutor,
    fingerprint: string,
    item: SourceItem
  ): Promise<void> {
    await target.query(
      `INSERT INTO ${ITEM_TABLE}
         (source_fingerprint, item_type, source_id, source_checksum, target_id,
          status, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'complete', $6)
       ON CONFLICT(source_fingerprint, item_type, source_id) DO NOTHING`,
      [
        fingerprint,
        item.type,
        item.sourceId,
        item.checksum,
        item.targetId,
        Date.now(),
      ]
    );
    const row = await this.journalRow(target, fingerprint, item);
    if (!row) throw new Error('Platform storage import journal write was lost');
    this.assertJournal(row, item);
    await this.options.afterItemCommitted?.({
      type: item.type,
      sourceId: item.sourceId,
      targetId: item.targetId,
    });
  }

  private async verifyTargetBlob(
    store: S3EncryptedBlobStore,
    item: SourceBlobItem
  ): Promise<void> {
    const descriptor = await store.stat(
      item.targetId,
      item.descriptor.ownerUserId
    );
    if (hashJson(canonicalDescriptor(descriptor)) !== item.checksum) {
      throw new Error(
        `Migrated blob ${item.targetId} metadata checksum mismatch`
      );
    }
    const digest = await consumeAndHash(
      (
        await store.open({
          id: item.targetId,
          ownerUserId: item.descriptor.ownerUserId,
        })
      ).body
    );
    if (digest !== item.descriptor.sha256) {
      throw new Error(`Migrated blob ${item.targetId} body checksum mismatch`);
    }
  }

  private async targetBlobExists(
    target: PostgresQueryExecutor,
    item: SourceBlobItem
  ): Promise<boolean> {
    const result = await target.query(
      `SELECT 1 FROM platform_blob_objects
        WHERE id = $1 AND owner_user_id = $2`,
      [item.targetId, item.descriptor.ownerUserId]
    );
    return result.rowCount === 1;
  }

  private async applyBlob(
    input: SQLiteToPostgresMigrationPhaseContext,
    inventory: PhaseInventory,
    item: SourceBlobItem,
    store: S3EncryptedBlobStore
  ): Promise<void> {
    const journal = await this.journalRow(
      input.target,
      input.sourceFingerprint,
      item
    );
    if (journal) {
      this.assertJournal(journal, item);
      await this.verifyTargetBlob(store, item);
      return;
    }
    if (await this.targetBlobExists(input.target, item)) {
      await this.verifyTargetBlob(store, item);
      await this.recordJournal(input.target, input.sourceFingerprint, item);
      return;
    }

    if (item.source === 'local') {
      const sourceStore = this.localStore(inventory.blobRoot);
      const request: BlobPutRequest = {
        ownerUserId: item.descriptor.ownerUserId,
        purpose: item.descriptor.purpose,
        contentType: item.descriptor.contentType,
        expectedSize: item.descriptor.size,
        ...(item.descriptor.originalFilename
          ? { originalFilename: item.descriptor.originalFilename }
          : {}),
        metadata: item.descriptor.metadata,
        source: (
          await sourceStore.open({
            id: item.descriptor.id,
            ownerUserId: item.descriptor.ownerUserId,
          })
        ).body,
      };
      const descriptor = await store.putWithId(
        request,
        item.targetId,
        item.descriptor.createdAt
      );
      if (hashJson(canonicalDescriptor(descriptor)) !== item.checksum) {
        await store.delete({
          id: item.targetId,
          ownerUserId: item.descriptor.ownerUserId,
        });
        throw new Error(
          `Migrated blob ${item.targetId} changed semantic metadata`
        );
      }
    } else {
      const row = sourceGalleryRows(input.sourceDatabase).find(
        candidate => candidate.id === item.mediaId
      );
      if (!row) throw new Error(`Gallery source ${item.mediaId} disappeared`);
      const parsed = parseDataUrl(
        this.options.cipher,
        row,
        this.maxInlineBlobBytes
      );
      try {
        const descriptor = await store.putWithId(
          {
            ownerUserId: item.descriptor.ownerUserId,
            purpose: item.descriptor.purpose,
            contentType: parsed.mimeType,
            expectedSize: parsed.bytes.length,
            metadata: item.descriptor.metadata,
            source: Readable.from(parsed.bytes),
          },
          item.targetId,
          item.descriptor.createdAt
        );
        if (hashJson(canonicalDescriptor(descriptor)) !== item.checksum) {
          await store.delete({
            id: item.targetId,
            ownerUserId: item.descriptor.ownerUserId,
          });
          throw new Error(
            `Migrated blob ${item.targetId} changed semantic metadata`
          );
        }
      } finally {
        parsed.bytes.fill(0);
      }
    }
    await this.recordJournal(input.target, input.sourceFingerprint, item);
  }

  private async targetVectorRecord(
    target: PostgresQueryExecutor,
    identity: SourceVectorItem['identity']
  ): Promise<VectorRecord | undefined> {
    const result = await target.query<
      {
        namespace: string;
        id: string;
        owner_user_id: string;
        resource_id: string;
        model: string;
        dimensions: number;
        embedding_version: string;
        source_revision: string;
        embedding_text: string;
        attributes: Record<string, string> | string;
        created_at: string | number;
      } & Record<string, unknown>
    >(
      `SELECT namespace, id, owner_user_id, resource_id, model, dimensions,
              embedding_version, source_revision, embedding::text AS embedding_text,
              attributes, created_at
         FROM platform_vector_entries
        WHERE namespace = $1 AND owner_user_id = $2 AND id = $3`,
      [identity.namespace, identity.ownerUserId, identity.id]
    );
    const row = result.rows[0];
    if (!row) return undefined;
    const acl = await target.query<
      { principal_type: 'user' | 'group'; principal_id: string } & Record<
        string,
        unknown
      >
    >(
      `SELECT principal_type, principal_id FROM platform_vector_acl
        WHERE namespace = $1 AND owner_user_id = $2 AND vector_id = $3
        ORDER BY principal_type, principal_id`,
      [identity.namespace, identity.ownerUserId, identity.id]
    );
    const attributes =
      typeof row.attributes === 'string'
        ? (JSON.parse(row.attributes) as Record<string, string>)
        : row.attributes;
    return {
      namespace: row.namespace,
      id: row.id,
      ownerUserId: row.owner_user_id,
      resourceId: row.resource_id,
      model: row.model,
      dimensions: safeNumber(row.dimensions, 'target vector dimensions'),
      version: row.embedding_version,
      sourceRevision: row.source_revision,
      embedding: JSON.parse(row.embedding_text) as number[],
      attributes,
      grants: acl.rows.map(item => ({
        type: item.principal_type,
        id: item.principal_id,
      })),
      createdAt: safeNumber(row.created_at, 'target vector creation time'),
    };
  }

  private async verifyTargetVector(
    target: PostgresQueryExecutor,
    item: SourceVectorItem
  ): Promise<void> {
    const record = await this.targetVectorRecord(target, item.identity);
    if (!record || canonicalVectorChecksum(record) !== item.checksum) {
      throw new Error(
        `Migrated vector ${item.identity.namespace}/${item.identity.id} checksum mismatch`
      );
    }
  }

  private async applyVector(
    input: SQLiteToPostgresMigrationPhaseContext,
    item: SourceVectorItem,
    record: VectorRecord
  ): Promise<void> {
    if (canonicalVectorChecksum(record) !== item.checksum) {
      throw new Error('SQLite vector changed after migration analysis');
    }
    const journal = await this.journalRow(
      input.target,
      input.sourceFingerprint,
      item
    );
    if (journal) {
      this.assertJournal(journal, item);
      await this.verifyTargetVector(input.target, item);
      return;
    }
    if (await this.targetVectorRecord(input.target, item.identity)) {
      await this.verifyTargetVector(input.target, item);
      await this.recordJournal(input.target, input.sourceFingerprint, item);
      return;
    }
    await input.target.query('BEGIN');
    try {
      await input.target.query(
        `INSERT INTO platform_vector_entries
           (namespace, id, owner_user_id, resource_id, model, dimensions,
            embedding_version, source_revision, embedding, attributes,
            created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::vector, $10::jsonb,
                 $11, $12)`,
        [
          record.namespace,
          record.id,
          record.ownerUserId,
          record.resourceId,
          record.model,
          record.dimensions,
          record.version,
          record.sourceRevision,
          `[${record.embedding.map(value => Math.fround(value)).join(',')}]`,
          JSON.stringify(record.attributes ?? {}),
          record.createdAt ?? Date.now(),
          Date.now(),
        ]
      );
      const grants = [...(record.grants ?? [])] as VectorGrant[];
      for (const grant of grants) {
        await input.target.query(
          `INSERT INTO platform_vector_acl
             (namespace, owner_user_id, vector_id, principal_type, principal_id)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            record.namespace,
            record.ownerUserId,
            record.id,
            grant.type,
            grant.id,
          ]
        );
      }
      await this.recordJournal(input.target, input.sourceFingerprint, item);
      await input.target.query('COMMIT');
    } catch (error) {
      await input.target.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  }

  private async verifyGallery(
    target: PostgresQueryExecutor,
    item: SourceGalleryItem
  ): Promise<void> {
    const result = await target.query<
      {
        id: string;
        user_id: string;
        kind: 'image' | 'audio' | 'video';
        encrypted_prompt: string;
        model: string;
        plugin_id: string | null;
        blob_id: string;
        mime_type: string;
        size_label: string | null;
        quality: string | null;
        encrypted_metadata: string | null;
        created_at: string | number;
      } & Record<string, unknown>
    >('SELECT * FROM platform_generated_media WHERE id = $1', [item.mediaId]);
    const row = result.rows[0];
    if (!row)
      throw new Error(`Migrated gallery item ${item.mediaId} is missing`);
    const semantic: GallerySemantic = {
      id: row.id,
      userId: row.user_id,
      kind: row.kind,
      prompt: this.options.cipher.decryptAuthenticated(row.encrypted_prompt),
      model: row.model,
      pluginId: row.plugin_id,
      mimeType: row.mime_type,
      sizeLabel: row.size_label,
      quality: row.quality,
      metadataJson: row.encrypted_metadata
        ? this.options.cipher.decryptAuthenticated(row.encrypted_metadata)
        : null,
      createdAt: safeNumber(row.created_at, 'target gallery creation time'),
    };
    if (hashJson({ ...semantic, blobId: row.blob_id }) !== item.checksum) {
      throw new Error(
        `Migrated gallery item ${item.mediaId} checksum mismatch`
      );
    }
  }

  private async applyGallery(
    input: SQLiteToPostgresMigrationPhaseContext,
    item: SourceGalleryItem
  ): Promise<void> {
    const journal = await this.journalRow(
      input.target,
      input.sourceFingerprint,
      item
    );
    if (journal) {
      this.assertJournal(journal, item);
      await this.verifyGallery(input.target, item);
      return;
    }
    const existing = await input.target.query(
      'SELECT 1 FROM platform_generated_media WHERE id = $1',
      [item.mediaId]
    );
    if (existing.rowCount === 1) {
      await this.verifyGallery(input.target, item);
      await this.recordJournal(input.target, input.sourceFingerprint, item);
      return;
    }
    await input.target.query('BEGIN');
    try {
      const semantic = item.semantic;
      await input.target.query(
        `INSERT INTO platform_generated_media
           (id, user_id, kind, encrypted_prompt, model, plugin_id, blob_id,
            mime_type, size_label, quality, encrypted_metadata, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          semantic.id,
          semantic.userId,
          semantic.kind,
          this.options.cipher.encrypt(semantic.prompt),
          semantic.model,
          semantic.pluginId,
          item.blobId,
          semantic.mimeType,
          semantic.sizeLabel,
          semantic.quality,
          semantic.metadataJson
            ? this.options.cipher.encrypt(semantic.metadataJson)
            : null,
          semantic.createdAt,
        ]
      );
      await this.recordJournal(input.target, input.sourceFingerprint, item);
      await input.target.query('COMMIT');
    } catch (error) {
      await input.target.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  }

  private async verifyReference(
    target: PostgresQueryExecutor,
    item: SourceReferenceItem
  ): Promise<void> {
    const result = await target.query<
      {
        blob_id: string;
        owner_user_id: string;
        resource_type: string;
        resource_id: string;
        purpose: string;
        created_at: string | number;
      } & Record<string, unknown>
    >(
      `SELECT blob_id, owner_user_id, resource_type, resource_id, purpose,
              created_at
         FROM platform_blob_references
        WHERE resource_type = $1 AND resource_id = $2 AND purpose = $3`,
      [
        item.reference.resourceType,
        item.reference.resourceId,
        item.reference.purpose,
      ]
    );
    const row = result.rows[0];
    if (!row) throw new Error('Migrated blob reference is missing');
    const reference: SourceReference = {
      blobId: row.blob_id,
      ownerUserId: row.owner_user_id,
      resourceType: row.resource_type,
      resourceId: row.resource_id,
      purpose: row.purpose,
      createdAt: safeNumber(row.created_at, 'target reference creation time'),
    };
    if (hashJson(canonicalReference(reference)) !== item.checksum) {
      throw new Error('Migrated blob reference checksum mismatch');
    }
  }

  private async applyReference(
    input: SQLiteToPostgresMigrationPhaseContext,
    item: SourceReferenceItem
  ): Promise<void> {
    const journal = await this.journalRow(
      input.target,
      input.sourceFingerprint,
      item
    );
    if (journal) {
      this.assertJournal(journal, item);
      await this.verifyReference(input.target, item);
      return;
    }
    const existing = await input.target.query(
      `SELECT 1 FROM platform_blob_references
        WHERE resource_type = $1 AND resource_id = $2 AND purpose = $3`,
      [
        item.reference.resourceType,
        item.reference.resourceId,
        item.reference.purpose,
      ]
    );
    if (existing.rowCount === 1) {
      await this.verifyReference(input.target, item);
      await this.recordJournal(input.target, input.sourceFingerprint, item);
      return;
    }
    await input.target.query('BEGIN');
    try {
      const reference = item.reference;
      await input.target.query(
        `INSERT INTO platform_blob_references
           (blob_id, owner_user_id, resource_type, resource_id, purpose, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          reference.blobId,
          reference.ownerUserId,
          reference.resourceType,
          reference.resourceId,
          reference.purpose,
          reference.createdAt,
        ]
      );
      await this.recordJournal(input.target, input.sourceFingerprint, item);
      await input.target.query('COMMIT');
    } catch (error) {
      await input.target.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  }

  async apply(
    input: SQLiteToPostgresMigrationPhaseContext & { resume: boolean }
  ): Promise<void> {
    const inventory = await this.inventoryFor(
      input.sourceDatabase,
      input.sourcePath
    );
    if (inventory.blockers.length > 0) {
      throw new Error('Platform storage source is not migratable');
    }
    await this.ensureJournal(input.target);
    const store = this.targetStore(input.target);
    for (const item of inventory.blobs) {
      await this.applyBlob(input, inventory, item, store);
    }
    const expectedVectors = new Map(
      inventory.vectors.map(item => [item.sourceId, item])
    );
    for await (const record of this.sourceVectorRecords(input.sourceDatabase)) {
      const item = expectedVectors.get(
        itemSourceId('vector', vectorIdentity(record))
      );
      if (!item)
        throw new Error('SQLite vector manifest changed during import');
      await this.applyVector(input, item, record);
      expectedVectors.delete(item.sourceId);
    }
    if (expectedVectors.size > 0) {
      throw new Error('SQLite vector manifest is incomplete during import');
    }
    for (const item of inventory.gallery) await this.applyGallery(input, item);
    for (const item of inventory.references) {
      await this.applyReference(input, item);
    }
  }

  async validate(input: SQLiteToPostgresMigrationPhaseContext): Promise<void> {
    const inventory = await this.inventoryFor(
      input.sourceDatabase,
      input.sourcePath
    );
    await this.ensureJournal(input.target);
    const rows = await input.target.query<JournalRow>(
      `SELECT item_type, source_id, source_checksum, target_id
         FROM ${ITEM_TABLE}
        WHERE source_fingerprint = $1
        ORDER BY item_type, source_id`,
      [input.sourceFingerprint]
    );
    if (rows.rows.length !== inventory.items.length) {
      throw new Error('Platform storage import journal is incomplete');
    }
    const store = this.targetStore(input.target);
    for (const item of inventory.items) {
      const row = rows.rows.find(
        candidate =>
          candidate.item_type === item.type &&
          candidate.source_id === item.sourceId
      );
      if (!row) throw new Error('Platform storage import item is missing');
      this.assertJournal(row, item);
      if (item.type === 'blob') await this.verifyTargetBlob(store, item);
      else if (item.type === 'vector') {
        await this.verifyTargetVector(input.target, item);
      } else if (item.type === 'gallery') {
        await this.verifyGallery(input.target, item);
      } else {
        await this.verifyReference(input.target, item);
      }
    }
  }

  async rollback(input: SQLiteToPostgresMigrationPhaseContext): Promise<void> {
    const inventory = await this.inventoryFor(
      input.sourceDatabase,
      input.sourcePath
    );
    await this.ensureJournal(input.target);
    for (const item of [...inventory.gallery].reverse()) {
      await input.target.query(
        'DELETE FROM platform_generated_media WHERE id = $1',
        [item.mediaId]
      );
    }
    for (const item of [...inventory.references].reverse()) {
      await input.target.query(
        `DELETE FROM platform_blob_references
          WHERE resource_type = $1 AND resource_id = $2 AND purpose = $3`,
        [
          item.reference.resourceType,
          item.reference.resourceId,
          item.reference.purpose,
        ]
      );
    }
    for (const item of [...inventory.vectors].reverse()) {
      await input.target.query(
        `DELETE FROM platform_vector_entries
          WHERE namespace = $1 AND owner_user_id = $2 AND id = $3`,
        [item.identity.namespace, item.identity.ownerUserId, item.identity.id]
      );
    }
    const store = this.targetStore(input.target);
    for (const item of [...inventory.blobs].reverse()) {
      const deleted = await store.delete({
        id: item.targetId,
        ownerUserId: item.descriptor.ownerUserId,
      });
      if (!deleted) {
        await store.purgeUntrackedObject(item.targetId);
        await input.target.query(
          'DELETE FROM platform_blob_quota_objects WHERE blob_id = $1',
          [item.targetId]
        );
      }
    }
    await input.target.query(
      `DELETE FROM ${ITEM_TABLE} WHERE source_fingerprint = $1`,
      [input.sourceFingerprint]
    );
  }

  async close(): Promise<void> {
    this.client.destroy();
    this.inventory = undefined;
  }
}

export const createSQLiteToTeamStorageMigrationPhase = (
  options: SQLiteToTeamStorageMigrationOptions
): SQLiteToPostgresMigrationPhase =>
  new SQLiteToTeamStorageMigrationPhase(options);
