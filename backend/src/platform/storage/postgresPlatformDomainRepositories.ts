/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import type { QueryResultRow } from 'pg';
import type {
  PostgresDatabase,
  PostgresQueryExecutor,
} from '../../persistence/postgresDatabase.js';
import type { Document } from '../../storageMappers.js';
import type {
  DocumentChunk,
  DocumentFileType,
  Persona,
  PersonaState,
} from '../../types/index.js';
import type { BlobReference } from './blobReferenceRepository.js';
import type {
  DocumentRepository,
  GalleryMetadataRecord,
  GalleryMetadataRepository,
  MediaGenerationJobRepository,
  MediaGenerationRecord,
  MediaGenerationStatus,
  PersonaMemoryRecord,
  PersonaMemoryRepository,
  PersonaMemoryStatistics,
  PersonaPatch,
  PersonaRepository,
  PersonaStateRepository,
  PlatformContentCipher,
  PlatformDomainRepositories,
  ResourceDeletionLifecycleRepository,
  StoredMemoryType,
  TransactionalDocumentIngestionEnqueuer,
  TransactionalResourceDeletionEnqueuer,
  TransactionalResourceDeletionInput,
  TransactionalVideoResumeEnqueuer,
  TransactionalVideoSubmissionEnqueuer,
} from './platformDomainRepositories.js';
import { resourceDeletionToken } from './resourceDeletionLifecycle.js';

const resourceTable = (
  resourceType: TransactionalResourceDeletionInput['resourceType']
): string => {
  switch (resourceType) {
    case 'document':
      return 'documents';
    case 'generated-media':
      return 'platform_generated_media';
    case 'persona':
      return 'personas';
  }
};

const lockResourceIdentifier = async (
  executor: PostgresQueryExecutor,
  resourceType: TransactionalResourceDeletionInput['resourceType'],
  resourceId: string
): Promise<void> => {
  await executor.query(
    'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
    [JSON.stringify(['libre-resource-v1', resourceType, resourceId])]
  );
};

const assertResourceIdentifierAvailable = async (
  executor: PostgresQueryExecutor,
  resourceType: TransactionalResourceDeletionInput['resourceType'],
  resourceId: string
): Promise<void> => {
  await lockResourceIdentifier(executor, resourceType, resourceId);
  const reserved = await executor.query(
    `SELECT 1 FROM platform_resource_deletion_tombstones
      WHERE resource_type = $1 AND resource_id = $2`,
    [resourceType, resourceId]
  );
  if (reserved.rowCount) {
    throw new Error('Resource identifier is permanently reserved by deletion');
  }
};

const recordResourceDeletion = async (
  executor: PostgresQueryExecutor,
  input: Omit<
    TransactionalResourceDeletionInput,
    'deletionToken' | 'deletionIncarnation'
  >
): Promise<TransactionalResourceDeletionInput> => {
  await assertResourceIdentifierAvailable(
    executor,
    input.resourceType,
    input.resourceId
  );
  const deletionIncarnation = 1;
  const deletionToken = resourceDeletionToken({
    ...input,
    deletionIncarnation,
  });
  await executor.query(
    `INSERT INTO platform_resource_deletion_tombstones
       (resource_type, resource_id, owner_user_id, deletion_incarnation,
        deletion_token, deleted_at, completed_at)
     VALUES ($1, $2, $3, $4, $5, $6, NULL)`,
    [
      input.resourceType,
      input.resourceId,
      input.ownerUserId,
      deletionIncarnation,
      deletionToken,
      Date.now(),
    ]
  );
  return { ...input, deletionIncarnation, deletionToken };
};

const safeInteger = (value: unknown, field: string): number => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`PostgreSQL returned an invalid ${field}`);
  }
  return parsed;
};

const decryptOptional = (
  cipher: PlatformContentCipher,
  value: string | null
): string | undefined =>
  value === null ? undefined : cipher.decryptAuthenticated(value);

const decryptJson = <T>(
  cipher: PlatformContentCipher,
  value: string | null
): T | undefined => {
  const plaintext = decryptOptional(cipher, value);
  return plaintext === undefined ? undefined : (JSON.parse(plaintext) as T);
};

interface PgDocumentRow extends QueryResultRow {
  id: string;
  user_id: string;
  filename: string;
  title: string | null;
  content: string | null;
  file_type: DocumentFileType | null;
  size: string | number | null;
  session_id: string | null;
  collection_id: string | null;
  metadata: string | null;
  uploaded_at: string | number;
  created_at: string | number;
}

interface PgDocumentChunkRow extends QueryResultRow {
  id: string;
  document_id: string;
  chunk_index: number;
  content: string;
  start_char: number | null;
  end_char: number | null;
}

class PostgresDocumentRepository implements DocumentRepository {
  constructor(
    private readonly database: PostgresDatabase,
    private readonly cipher: PlatformContentCipher
  ) {}

  private map(row: PgDocumentRow): Document {
    return {
      id: row.id,
      filename: row.filename,
      ...(row.title
        ? { title: this.cipher.decryptAuthenticated(row.title) }
        : {}),
      ...(row.content
        ? { content: this.cipher.decryptAuthenticated(row.content) }
        : {}),
      ...(row.file_type ? { fileType: row.file_type } : {}),
      ...(row.size === null
        ? {}
        : { size: safeInteger(row.size, 'document size') }),
      ...(row.session_id ? { sessionId: row.session_id } : {}),
      ...(row.collection_id ? { collectionId: row.collection_id } : {}),
      uploadedAt: safeInteger(row.uploaded_at, 'document upload time'),
      createdAt: safeInteger(row.created_at, 'document creation time'),
      ...(row.metadata
        ? {
            metadata: decryptJson<Record<string, unknown>>(
              this.cipher,
              row.metadata
            ),
          }
        : {}),
    };
  }

  async listByOwner(userId: string): Promise<Document[]> {
    const result = await this.database.query<PgDocumentRow>(
      'SELECT * FROM documents WHERE user_id = $1 ORDER BY uploaded_at DESC, id ASC',
      [userId]
    );
    return result.rows.map(row => this.map(row));
  }

  async findByOwner(
    documentId: string,
    userId: string
  ): Promise<Document | undefined> {
    const result = await this.database.query<PgDocumentRow>(
      'SELECT * FROM documents WHERE id = $1 AND user_id = $2',
      [documentId, userId]
    );
    return result.rows[0] ? this.map(result.rows[0]) : undefined;
  }

  async upsert(document: Document, userId: string): Promise<void> {
    await this.database.transaction(
      async client => {
        await assertResourceIdentifierAvailable(
          client,
          'document',
          document.id
        );
        const result = await this.upsertUsing(client, document, userId);
        if (result.rowCount === 0) {
          throw new Error('Document identifier belongs to another owner');
        }
      },
      { isolationLevel: 'serializable' }
    );
  }

  private upsertUsing(
    executor: import('../../persistence/postgresDatabase.js').PostgresQueryExecutor,
    document: Document,
    userId: string
  ) {
    const now = Date.now();
    return executor.query(
      `INSERT INTO documents
         (id, user_id, filename, title, content, file_type, size, session_id,
          collection_id, metadata, uploaded_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT(id) DO UPDATE SET
         filename = EXCLUDED.filename, title = EXCLUDED.title,
         content = EXCLUDED.content, file_type = EXCLUDED.file_type,
         size = EXCLUDED.size, session_id = EXCLUDED.session_id,
         collection_id = EXCLUDED.collection_id, metadata = EXCLUDED.metadata,
         uploaded_at = EXCLUDED.uploaded_at, updated_at = EXCLUDED.updated_at
       WHERE documents.user_id = EXCLUDED.user_id`,
      [
        document.id,
        userId,
        document.filename,
        document.title ? this.cipher.encrypt(document.title) : null,
        document.content ? this.cipher.encrypt(document.content) : null,
        document.fileType || null,
        document.size ?? null,
        document.sessionId || null,
        document.collectionId || null,
        document.metadata
          ? this.cipher.encrypt(JSON.stringify(document.metadata))
          : null,
        document.uploadedAt,
        document.createdAt || now,
        now,
      ]
    );
  }

  async upsertWithBlobAndEnqueue(
    document: Document,
    userId: string,
    reference: BlobReference,
    enqueuer: TransactionalDocumentIngestionEnqueuer
  ): Promise<void> {
    if (
      reference.ownerUserId !== userId ||
      reference.resourceType !== 'document' ||
      reference.resourceId !== document.id ||
      reference.purpose !== 'document.source'
    ) {
      throw new Error('Document ingestion blob reference is inconsistent');
    }
    await this.database.transaction(
      async client => {
        await assertResourceIdentifierAvailable(
          client,
          'document',
          document.id
        );
        const result = await this.upsertUsing(client, document, userId);
        if (result.rowCount === 0) {
          throw new Error('Document identifier belongs to another owner');
        }
        await client.query(
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
        await enqueuer.enqueuePostgres(client, {
          documentId: document.id,
          ownerUserId: userId,
        });
      },
      { isolationLevel: 'serializable' }
    );
  }

  async completeIngestion(
    document: Document,
    userId: string,
    chunks: readonly DocumentChunk[]
  ): Promise<boolean> {
    return this.database.transaction(
      async client => {
        const updated = await client.query(
          `UPDATE documents SET filename = $1, title = $2, content = $3,
                  file_type = $4, size = $5, session_id = $6,
                  collection_id = $7, metadata = $8, uploaded_at = $9,
                  updated_at = $10
            WHERE id = $11 AND user_id = $12`,
          [
            document.filename,
            document.title ? this.cipher.encrypt(document.title) : null,
            document.content ? this.cipher.encrypt(document.content) : null,
            document.fileType || null,
            document.size ?? null,
            document.sessionId || null,
            document.collectionId || null,
            document.metadata
              ? this.cipher.encrypt(JSON.stringify(document.metadata))
              : null,
            document.uploadedAt,
            Date.now(),
            document.id,
            userId,
          ]
        );
        if (updated.rowCount !== 1) return false;
        await this.replaceChunksUsing(client, document.id, chunks);
        return true;
      },
      { isolationLevel: 'serializable' }
    );
  }

  async publishEmbeddingIndex(
    documentId: string,
    userId: string,
    expectedSource: {
      content: string | null;
      fileType: DocumentFileType | null;
    },
    embeddingIndex: unknown,
    chunks: readonly DocumentChunk[]
  ): Promise<boolean> {
    if (
      !embeddingIndex ||
      typeof embeddingIndex !== 'object' ||
      Array.isArray(embeddingIndex)
    ) {
      throw new Error('Document embedding index metadata is invalid');
    }
    return this.database.transaction(
      async client => {
        const current = await client.query<{
          content: string | null;
          file_type: DocumentFileType | null;
          metadata: string | null;
        }>(
          `SELECT content, file_type, metadata FROM documents
            WHERE id = $1 AND user_id = $2
            FOR UPDATE`,
          [documentId, userId]
        );
        const row = current.rows[0];
        if (!row) return false;
        const currentContent = row.content
          ? this.cipher.decryptAuthenticated(row.content)
          : null;
        if (
          currentContent !== expectedSource.content ||
          row.file_type !== expectedSource.fileType
        ) {
          return false;
        }
        const currentMetadata =
          decryptJson<Record<string, unknown>>(this.cipher, row.metadata) ?? {};
        const updated = await client.query(
          `UPDATE documents SET metadata = $1, updated_at = $2
            WHERE id = $3 AND user_id = $4`,
          [
            this.cipher.encrypt(
              JSON.stringify({
                ...currentMetadata,
                embeddingIndex,
              })
            ),
            Date.now(),
            documentId,
            userId,
          ]
        );
        if (updated.rowCount !== 1) return false;
        await this.replaceChunksUsing(client, documentId, chunks);
        return true;
      },
      { isolationLevel: 'serializable' }
    );
  }

  async deleteByOwner(documentId: string, userId: string): Promise<boolean> {
    const result = await this.database.query(
      'DELETE FROM documents WHERE id = $1 AND user_id = $2',
      [documentId, userId]
    );
    return result.rowCount === 1;
  }

  async deleteAndEnqueue(
    documentId: string,
    userId: string,
    enqueuer: TransactionalResourceDeletionEnqueuer
  ): Promise<boolean> {
    return this.database.transaction(
      async client => {
        await lockResourceIdentifier(client, 'document', documentId);
        const existing = await client.query(
          'SELECT 1 FROM documents WHERE id = $1 AND user_id = $2 FOR UPDATE',
          [documentId, userId]
        );
        if (existing.rowCount !== 1) return false;
        const deletion = await recordResourceDeletion(client, {
          resourceType: 'document',
          resourceId: documentId,
          ownerUserId: userId,
        });
        const deleted = await client.query(
          'DELETE FROM documents WHERE id = $1 AND user_id = $2',
          [documentId, userId]
        );
        if (deleted.rowCount !== 1) {
          throw new Error('Document disappeared during deletion');
        }
        await enqueuer.enqueuePostgres(client, deletion);
        return true;
      },
      { isolationLevel: 'serializable' }
    );
  }

  async setCollection(
    documentId: string,
    collectionId: string | null,
    userId: string
  ): Promise<boolean> {
    const result = await this.database.query(
      `UPDATE documents SET collection_id = $1, updated_at = $2
        WHERE id = $3 AND user_id = $4`,
      [collectionId, Date.now(), documentId, userId]
    );
    return result.rowCount === 1;
  }

  async inspectLegacyChunkEmbeddings(
    _documentId: string,
    _userId: string
  ): Promise<{ present: boolean; authenticated: boolean }> {
    // Team-mode chunks deliberately do not expose inline vectors. Any legacy
    // SQLite source must pass the provenance gate before PostgreSQL import.
    return { present: false, authenticated: false };
  }

  async listChunks(documentId: string): Promise<DocumentChunk[]> {
    const result = await this.database.query<PgDocumentChunkRow>(
      `SELECT id, document_id, chunk_index, content, start_char, end_char
         FROM document_chunks WHERE document_id = $1
        ORDER BY chunk_index ASC, id ASC`,
      [documentId]
    );
    return result.rows.map(row => ({
      id: row.id,
      documentId: row.document_id,
      chunkIndex: row.chunk_index,
      content: this.cipher.decryptAuthenticated(row.content),
      startChar: row.start_char ?? 0,
      endChar: row.end_char ?? 0,
    }));
  }

  async replaceChunks(
    documentId: string,
    chunks: readonly DocumentChunk[]
  ): Promise<void> {
    await this.database.transaction(
      async client => {
        await this.replaceChunksUsing(client, documentId, chunks);
      },
      { isolationLevel: 'serializable' }
    );
  }

  private async replaceChunksUsing(
    executor: import('../../persistence/postgresDatabase.js').PostgresQueryExecutor,
    documentId: string,
    chunks: readonly DocumentChunk[]
  ): Promise<void> {
    await executor.query('DELETE FROM document_chunks WHERE document_id = $1', [
      documentId,
    ]);
    const now = Date.now();
    for (const chunk of chunks) {
      await executor.query(
        `INSERT INTO document_chunks
           (id, document_id, chunk_index, content, start_char, end_char,
            embedding, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, NULL, $7)`,
        [
          chunk.id,
          documentId,
          chunk.chunkIndex,
          this.cipher.encrypt(chunk.content),
          chunk.startChar ?? null,
          chunk.endChar ?? null,
          now,
        ]
      );
    }
  }

  async deleteChunks(documentId: string): Promise<boolean> {
    const result = await this.database.query(
      'DELETE FROM document_chunks WHERE document_id = $1',
      [documentId]
    );
    return (result.rowCount ?? 0) > 0;
  }
}

interface PgGalleryRow extends QueryResultRow {
  id: string;
  user_id: string;
  kind: GalleryMetadataRecord['kind'];
  encrypted_prompt: string;
  model: string;
  plugin_id: string | null;
  blob_id: string;
  mime_type: string;
  size_label: string | null;
  quality: string | null;
  encrypted_metadata: string | null;
  created_at: string | number;
}

class PostgresGalleryMetadataRepository implements GalleryMetadataRepository {
  constructor(
    private readonly database: PostgresDatabase,
    private readonly cipher: PlatformContentCipher
  ) {}

  private map(row: PgGalleryRow): GalleryMetadataRecord {
    return {
      id: row.id,
      userId: row.user_id,
      kind: row.kind,
      prompt: this.cipher.decryptAuthenticated(row.encrypted_prompt),
      model: row.model,
      ...(row.plugin_id ? { pluginId: row.plugin_id } : {}),
      mimeType: row.mime_type,
      ...(row.size_label ? { size: row.size_label } : {}),
      ...(row.quality ? { quality: row.quality } : {}),
      ...(row.encrypted_metadata
        ? {
            metadata: decryptJson<Record<string, unknown>>(
              this.cipher,
              row.encrypted_metadata
            ),
          }
        : {}),
      createdAt: safeInteger(row.created_at, 'gallery creation time'),
    };
  }

  async insert(
    record: GalleryMetadataRecord,
    reference: BlobReference
  ): Promise<void> {
    await this.database.transaction(
      async client => {
        await assertResourceIdentifierAvailable(
          client,
          'generated-media',
          record.id
        );
        await client.query(
          `INSERT INTO platform_generated_media
           (id, user_id, kind, encrypted_prompt, model, plugin_id, blob_id,
            mime_type, size_label, quality, encrypted_metadata, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [
            record.id,
            record.userId,
            record.kind,
            this.cipher.encrypt(record.prompt),
            record.model,
            record.pluginId || null,
            reference.blobId,
            record.mimeType,
            record.size || null,
            record.quality || null,
            record.metadata
              ? this.cipher.encrypt(JSON.stringify(record.metadata))
              : null,
            record.createdAt,
          ]
        );
        await client.query(
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
      },
      { isolationLevel: 'serializable' }
    );
  }

  async findByOwner(
    mediaId: string,
    userId: string
  ): Promise<GalleryMetadataRecord | undefined> {
    const result = await this.database.query<PgGalleryRow>(
      'SELECT * FROM platform_generated_media WHERE id = $1 AND user_id = $2',
      [mediaId, userId]
    );
    return result.rows[0] ? this.map(result.rows[0]) : undefined;
  }

  async listByOwner(
    userId: string,
    options: {
      limit: number;
      offset: number;
      kind?: GalleryMetadataRecord['kind'];
    }
  ): Promise<{ records: GalleryMetadataRecord[]; total: number }> {
    const parameters: unknown[] = [userId];
    let predicate = 'user_id = $1';
    if (options.kind) {
      parameters.push(options.kind);
      predicate += ' AND kind = $2';
    }
    const count = await this.database.query<{ count: string } & QueryResultRow>(
      `SELECT COUNT(*)::text AS count FROM platform_generated_media WHERE ${predicate}`,
      parameters
    );
    const offsetIndex = parameters.length + 1;
    parameters.push(options.limit, options.offset);
    const result = await this.database.query<PgGalleryRow>(
      `SELECT * FROM platform_generated_media WHERE ${predicate}
        ORDER BY created_at DESC, id ASC LIMIT $${offsetIndex} OFFSET $${offsetIndex + 1}`,
      parameters
    );
    return {
      records: result.rows.map(row => this.map(row)),
      total: safeInteger(count.rows[0]?.count ?? 0, 'gallery count'),
    };
  }

  async adoptLegacyBlob(): Promise<void> {
    throw new Error('PostgreSQL gallery has no inline legacy blob format');
  }

  async deleteByOwner(
    mediaId: string,
    userId: string
  ): Promise<BlobReference | undefined> {
    return this.database.transaction(
      async client => {
        const reference = await client.query<
          {
            blob_id: string;
            owner_user_id: string;
            resource_type: string;
            resource_id: string;
            purpose: string;
            created_at: string | number;
          } & QueryResultRow
        >(
          `SELECT blob_id, owner_user_id, resource_type, resource_id, purpose,
                created_at
           FROM platform_blob_references
          WHERE resource_type = 'generated-media' AND resource_id = $1
            AND purpose = 'gallery.media' AND owner_user_id = $2 FOR UPDATE`,
          [mediaId, userId]
        );
        const deleted = await client.query(
          'DELETE FROM platform_generated_media WHERE id = $1 AND user_id = $2',
          [mediaId, userId]
        );
        if (deleted.rowCount !== 1) return undefined;
        await client.query(
          `DELETE FROM platform_blob_references
          WHERE resource_type = 'generated-media' AND resource_id = $1
            AND purpose = 'gallery.media' AND owner_user_id = $2`,
          [mediaId, userId]
        );
        const row = reference.rows[0];
        return row
          ? {
              blobId: row.blob_id,
              ownerUserId: row.owner_user_id,
              resourceType: row.resource_type,
              resourceId: row.resource_id,
              purpose: row.purpose,
              createdAt: safeInteger(
                row.created_at,
                'blob reference creation time'
              ),
            }
          : undefined;
      },
      { isolationLevel: 'serializable' }
    );
  }

  async deleteAndEnqueue(
    mediaId: string,
    userId: string,
    enqueuer: TransactionalResourceDeletionEnqueuer
  ): Promise<boolean> {
    return this.database.transaction(
      async client => {
        await lockResourceIdentifier(client, 'generated-media', mediaId);
        const existing = await client.query(
          `SELECT 1 FROM platform_generated_media
            WHERE id = $1 AND user_id = $2 FOR UPDATE`,
          [mediaId, userId]
        );
        if (existing.rowCount !== 1) return false;
        const deletion = await recordResourceDeletion(client, {
          resourceType: 'generated-media',
          resourceId: mediaId,
          ownerUserId: userId,
        });
        await client.query(
          `UPDATE platform_media_generation_jobs
              SET status = 'failed',
                  encrypted_error = $1,
                  updated_at = $2
            WHERE id = $3 AND user_id = $4
              AND status IN ('pending', 'in_progress')`,
          [
            this.cipher.encrypt('Generated media was deleted'),
            Date.now(),
            mediaId,
            userId,
          ]
        );
        const deleted = await client.query(
          'DELETE FROM platform_generated_media WHERE id = $1 AND user_id = $2',
          [mediaId, userId]
        );
        if (deleted.rowCount !== 1) {
          throw new Error('Generated media disappeared during deletion');
        }
        await enqueuer.enqueuePostgres(client, deletion);
        return true;
      },
      { isolationLevel: 'serializable' }
    );
  }
}

interface PgMediaJobRow extends QueryResultRow {
  id: string;
  user_id: string;
  provider_job_id: string;
  plugin_id: string;
  model: string;
  encrypted_prompt: string;
  status: MediaGenerationStatus;
  encrypted_options: string | null;
  gallery_id: string | null;
  encrypted_error: string | null;
  created_at: string | number;
  updated_at: string | number;
}

class PostgresMediaGenerationJobRepository implements MediaGenerationJobRepository {
  constructor(
    private readonly database: PostgresDatabase,
    private readonly cipher: PlatformContentCipher
  ) {}

  private map(row: PgMediaJobRow): MediaGenerationRecord {
    return {
      id: row.id,
      userId: row.user_id,
      providerJobId: row.provider_job_id,
      pluginId: row.plugin_id,
      model: row.model,
      prompt: this.cipher.decryptAuthenticated(row.encrypted_prompt),
      status: row.status,
      options:
        decryptJson<Record<string, unknown>>(
          this.cipher,
          row.encrypted_options
        ) || {},
      ...(row.gallery_id ? { galleryId: row.gallery_id } : {}),
      ...(row.encrypted_error
        ? { error: this.cipher.decryptAuthenticated(row.encrypted_error) }
        : {}),
      createdAt: safeInteger(row.created_at, 'media job creation time'),
      updatedAt: safeInteger(row.updated_at, 'media job update time'),
    };
  }

  private async insert(
    executor: PostgresQueryExecutor,
    record: MediaGenerationRecord
  ): Promise<void> {
    await executor.query(
      `INSERT INTO platform_media_generation_jobs
         (id, user_id, provider_job_id, plugin_id, model, encrypted_prompt,
          status, encrypted_options, gallery_id, encrypted_error, created_at,
          updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        record.id,
        record.userId,
        record.providerJobId,
        record.pluginId,
        record.model,
        this.cipher.encrypt(record.prompt),
        record.status,
        this.cipher.encrypt(JSON.stringify(record.options)),
        record.galleryId || null,
        record.error ? this.cipher.encrypt(record.error) : null,
        record.createdAt,
        record.updatedAt,
      ]
    );
  }

  async create(record: MediaGenerationRecord): Promise<void> {
    await this.insert(this.database, record);
  }

  async createPreparedAndEnqueue(
    record: MediaGenerationRecord,
    enqueuer: TransactionalVideoSubmissionEnqueuer
  ): Promise<void> {
    await this.database.transaction(
      async executor => {
        await this.insert(executor, record);
        await enqueuer.enqueuePostgres(executor, {
          mediaJobId: record.id,
          ownerUserId: record.userId,
        });
      },
      { isolationLevel: 'serializable' }
    );
  }

  async acceptProviderAndEnqueueResume(
    id: string,
    userId: string,
    providerJobId: string,
    updatedAt: number,
    preparedProviderJobId: string,
    enqueuer: TransactionalVideoResumeEnqueuer
  ): Promise<boolean> {
    return this.database.transaction(
      async executor => {
        const current = await executor.query<
          { provider_job_id: string } & QueryResultRow
        >(
          `SELECT provider_job_id FROM platform_media_generation_jobs
            WHERE id = $1 AND user_id = $2 FOR UPDATE`,
          [id, userId]
        );
        const existing = current.rows[0]?.provider_job_id;
        if (!existing) return false;
        if (existing !== preparedProviderJobId && existing !== providerJobId) {
          throw new Error(
            'Media provider reconciliation returned a new job ID'
          );
        }
        await executor.query(
          `UPDATE platform_media_generation_jobs
              SET provider_job_id = $1, status = 'pending', updated_at = $2
            WHERE id = $3 AND user_id = $4`,
          [providerJobId, updatedAt, id, userId]
        );
        await enqueuer.enqueuePostgres(executor, {
          mediaJobId: id,
          ownerUserId: userId,
        });
        return true;
      },
      { isolationLevel: 'serializable' }
    );
  }

  async findByOwner(
    id: string,
    userId: string
  ): Promise<MediaGenerationRecord | undefined> {
    const result = await this.database.query<PgMediaJobRow>(
      'SELECT * FROM platform_media_generation_jobs WHERE id = $1 AND user_id = $2',
      [id, userId]
    );
    return result.rows[0] ? this.map(result.rows[0]) : undefined;
  }

  async listByOwner(
    userId: string,
    options: { limit: number; activeOnly: boolean }
  ): Promise<MediaGenerationRecord[]> {
    const result = await this.database.query<PgMediaJobRow>(
      `SELECT * FROM platform_media_generation_jobs WHERE user_id = $1
        ${options.activeOnly ? "AND status IN ('pending', 'in_progress')" : ''}
        ORDER BY updated_at DESC, id ASC LIMIT $2`,
      [userId, options.limit]
    );
    return result.rows.map(row => this.map(row));
  }

  async deleteByOwner(id: string, userId: string): Promise<boolean> {
    const result = await this.database.query(
      'DELETE FROM platform_media_generation_jobs WHERE id = $1 AND user_id = $2',
      [id, userId]
    );
    return result.rowCount === 1;
  }

  async updateStatus(
    id: string,
    userId: string,
    status: MediaGenerationStatus,
    fields: { galleryId?: string; error?: string },
    updatedAt: number
  ): Promise<boolean> {
    const result = await this.database.query(
      `UPDATE platform_media_generation_jobs
          SET status = $1, gallery_id = COALESCE($2, gallery_id),
              encrypted_error = COALESCE($3, encrypted_error), updated_at = $4
        WHERE id = $5 AND user_id = $6`,
      [
        status,
        fields.galleryId || null,
        fields.error ? this.cipher.encrypt(fields.error) : null,
        updatedAt,
        id,
        userId,
      ]
    );
    return result.rowCount === 1;
  }

  async completeIfUnclaimed(
    id: string,
    userId: string,
    galleryId: string,
    updatedAt: number
  ): Promise<boolean> {
    const result = await this.database.query(
      `UPDATE platform_media_generation_jobs
          SET status = 'completed', gallery_id = $1, encrypted_error = NULL,
              updated_at = $2
        WHERE id = $3 AND user_id = $4 AND gallery_id IS NULL`,
      [galleryId, updatedAt, id, userId]
    );
    return result.rowCount === 1;
  }

  async deleteTerminalBefore(cutoff: number): Promise<number> {
    const result = await this.database.query(
      `DELETE FROM platform_media_generation_jobs
        WHERE status IN ('completed', 'failed') AND updated_at < $1`,
      [cutoff]
    );
    return result.rowCount ?? 0;
  }
}

interface PgMemoryRow extends QueryResultRow {
  id: string;
  user_id: string;
  persona_id: string;
  encrypted_content: string;
  timestamp: string | number;
  encrypted_context: string | null;
  importance_score: string | number;
  memory_type: StoredMemoryType;
  access_count: string | number;
  last_accessed: string | number | null;
  decay_factor: string | number;
  encrypted_consolidated_from: string | null;
}

class PostgresPersonaMemoryRepository implements PersonaMemoryRepository {
  constructor(
    private readonly database: PostgresDatabase,
    private readonly cipher: PlatformContentCipher
  ) {}

  private map(row: PgMemoryRow): PersonaMemoryRecord {
    return {
      id: row.id,
      userId: row.user_id,
      personaId: row.persona_id,
      content: this.cipher.decryptAuthenticated(row.encrypted_content),
      timestamp: safeInteger(row.timestamp, 'memory timestamp'),
      ...(row.encrypted_context
        ? { context: this.cipher.decryptAuthenticated(row.encrypted_context) }
        : {}),
      importanceScore: Number(row.importance_score),
      memoryType: row.memory_type,
      accessCount: safeInteger(row.access_count, 'memory access count'),
      ...(row.last_accessed === null
        ? {}
        : {
            lastAccessed: safeInteger(row.last_accessed, 'memory access time'),
          }),
      decayFactor: Number(row.decay_factor),
      ...(row.encrypted_consolidated_from
        ? {
            consolidatedFrom: decryptJson<string[]>(
              this.cipher,
              row.encrypted_consolidated_from
            ),
          }
        : {}),
    };
  }

  async insert(record: PersonaMemoryRecord): Promise<void> {
    await this.database.query(
      `INSERT INTO platform_persona_memories
         (id, user_id, persona_id, encrypted_content, timestamp,
          encrypted_context, importance_score, memory_type, access_count,
          last_accessed, decay_factor, encrypted_consolidated_from)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        record.id,
        record.userId,
        record.personaId,
        this.cipher.encrypt(record.content),
        record.timestamp,
        record.context ? this.cipher.encrypt(record.context) : null,
        record.importanceScore,
        record.memoryType,
        record.accessCount,
        record.lastAccessed || null,
        record.decayFactor,
        record.consolidatedFrom
          ? this.cipher.encrypt(JSON.stringify(record.consolidatedFrom))
          : null,
      ]
    );
  }

  async findByOwner(
    memoryId: string,
    userId: string,
    personaId: string
  ): Promise<PersonaMemoryRecord | undefined> {
    const result = await this.database.query<PgMemoryRow>(
      `SELECT * FROM platform_persona_memories
        WHERE id = $1 AND user_id = $2 AND persona_id = $3`,
      [memoryId, userId, personaId]
    );
    return result.rows[0] ? this.map(result.rows[0]) : undefined;
  }

  async listByOwner(
    userId: string,
    personaId: string,
    options: {
      limit?: number;
      offset?: number;
      types?: readonly StoredMemoryType[];
      minimumImportance?: number;
    } = {}
  ): Promise<PersonaMemoryRecord[]> {
    const parameters: unknown[] = [userId, personaId];
    let predicate = 'user_id = $1 AND persona_id = $2';
    if (options.types?.length) {
      parameters.push([...options.types]);
      predicate += ` AND memory_type = ANY($${parameters.length}::text[])`;
    }
    if (options.minimumImportance !== undefined) {
      parameters.push(options.minimumImportance);
      predicate += ` AND importance_score >= $${parameters.length}`;
    }
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 10_000);
    const offset = Math.max(options.offset ?? 0, 0);
    parameters.push(limit, offset);
    const result = await this.database.query<PgMemoryRow>(
      `SELECT * FROM platform_persona_memories WHERE ${predicate}
        ORDER BY timestamp DESC, id ASC
        LIMIT $${parameters.length - 1} OFFSET $${parameters.length}`,
      parameters
    );
    return result.rows.map(row => this.map(row));
  }

  async countByOwner(userId: string, personaId: string): Promise<number> {
    const result = await this.database.query<
      { count: string } & QueryResultRow
    >(
      `SELECT COUNT(*)::text AS count FROM platform_persona_memories
        WHERE user_id = $1 AND persona_id = $2`,
      [userId, personaId]
    );
    return safeInteger(result.rows[0]?.count ?? 0, 'memory count');
  }

  async reinforce(
    memoryId: string,
    userId: string,
    personaId: string,
    accessedAt: number
  ): Promise<boolean> {
    const result = await this.database.query(
      `UPDATE platform_persona_memories
          SET access_count = access_count + 1, last_accessed = $1,
              importance_score = LEAST(1.0, importance_score + 0.05)
        WHERE id = $2 AND user_id = $3 AND persona_id = $4`,
      [accessedAt, memoryId, userId, personaId]
    );
    return result.rowCount === 1;
  }

  async markAccessed(
    ids: readonly string[],
    userId: string,
    personaId: string,
    accessedAt: number
  ): Promise<number> {
    if (ids.length === 0) return 0;
    const result = await this.database.query(
      `UPDATE platform_persona_memories
          SET access_count = access_count + 1, last_accessed = $1
        WHERE user_id = $2 AND persona_id = $3 AND id = ANY($4::text[])`,
      [accessedAt, userId, personaId, [...ids]]
    );
    return result.rowCount ?? 0;
  }

  async updateImportance(
    memoryId: string,
    userId: string,
    personaId: string,
    importanceScore: number,
    decayFactor?: number
  ): Promise<boolean> {
    const result = await this.database.query(
      `UPDATE platform_persona_memories
          SET importance_score = $1, decay_factor = COALESCE($2, decay_factor)
        WHERE id = $3 AND user_id = $4 AND persona_id = $5`,
      [importanceScore, decayFactor ?? null, memoryId, userId, personaId]
    );
    return result.rowCount === 1;
  }

  async deleteIds(
    ids: readonly string[],
    userId: string,
    personaId: string
  ): Promise<number> {
    if (ids.length === 0) return 0;
    const result = await this.database.query(
      `DELETE FROM platform_persona_memories
        WHERE user_id = $1 AND persona_id = $2 AND id = ANY($3::text[])`,
      [userId, personaId, [...ids]]
    );
    return result.rowCount ?? 0;
  }

  async deleteAllByOwner(userId: string, personaId: string): Promise<number> {
    const result = await this.database.query(
      'DELETE FROM platform_persona_memories WHERE user_id = $1 AND persona_id = $2',
      [userId, personaId]
    );
    return result.rowCount ?? 0;
  }

  async findOldLowImportanceIds(
    userId: string,
    personaId: string,
    cutoff: number,
    maximumImportance: number
  ): Promise<string[]> {
    const result = await this.database.query<{ id: string } & QueryResultRow>(
      `SELECT id FROM platform_persona_memories
        WHERE user_id = $1 AND persona_id = $2 AND timestamp < $3
          AND importance_score < $4
        ORDER BY timestamp, id`,
      [userId, personaId, cutoff, maximumImportance]
    );
    return result.rows.map(row => row.id);
  }

  async deleteOldLowImportance(
    userId: string,
    personaId: string,
    cutoff: number,
    maximumImportance: number
  ): Promise<string[]> {
    const result = await this.database.query<{ id: string } & QueryResultRow>(
      `DELETE FROM platform_persona_memories
        WHERE user_id = $1 AND persona_id = $2 AND timestamp < $3
          AND importance_score < $4 RETURNING id`,
      [userId, personaId, cutoff, maximumImportance]
    );
    return result.rows.map(row => row.id);
  }

  async statistics(
    userId: string,
    personaId: string
  ): Promise<PersonaMemoryStatistics> {
    const types = await this.database.query<
      {
        memory_type: string;
        count: string;
      } & QueryResultRow
    >(
      `SELECT memory_type, COUNT(*)::text AS count
         FROM platform_persona_memories
        WHERE user_id = $1 AND persona_id = $2 GROUP BY memory_type`,
      [userId, personaId]
    );
    const aggregate = await this.database.query<
      {
        total_count: string;
        avg_importance: string | null;
        oldest_memory: string | number | null;
        newest_memory: string | number | null;
        total_accesses: string;
      } & QueryResultRow
    >(
      `SELECT COUNT(*)::text AS total_count,
              AVG(importance_score)::text AS avg_importance,
              MIN(timestamp) AS oldest_memory, MAX(timestamp) AS newest_memory,
              COALESCE(SUM(access_count), 0)::text AS total_accesses
         FROM platform_persona_memories
        WHERE user_id = $1 AND persona_id = $2`,
      [userId, personaId]
    );
    const row = aggregate.rows[0];
    return {
      totalCount: safeInteger(row?.total_count ?? 0, 'memory count'),
      byType: Object.fromEntries(
        types.rows.map(item => [
          item.memory_type,
          safeInteger(item.count, 'memory type count'),
        ])
      ),
      averageImportance: row?.avg_importance ? Number(row.avg_importance) : 0.5,
      oldestMemory:
        row?.oldest_memory === null || row?.oldest_memory === undefined
          ? null
          : safeInteger(row.oldest_memory, 'oldest memory'),
      newestMemory:
        row?.newest_memory === null || row?.newest_memory === undefined
          ? null
          : safeInteger(row.newest_memory, 'newest memory'),
      totalAccesses: safeInteger(row?.total_accesses ?? 0, 'memory accesses'),
    };
  }
}

interface PgPersonaRow extends QueryResultRow {
  id: string;
  user_id: string;
  name: string;
  description: string | null;
  model: string;
  parameters: string;
  avatar: string | null;
  background: string | null;
  embedding_model: string | null;
  memory_settings: string | null;
  mutation_settings: string | null;
  bindings: string | null;
  created_at: string | number;
  updated_at: string | number;
}

class PostgresPersonaRepository implements PersonaRepository {
  constructor(
    private readonly database: PostgresDatabase,
    private readonly cipher: PlatformContentCipher
  ) {}

  private map(row: PgPersonaRow): Persona {
    const parse = <T>(value: string | null): T | undefined =>
      value
        ? (JSON.parse(this.cipher.decryptAuthenticated(value)) as T)
        : undefined;
    return {
      id: row.id,
      user_id: row.user_id,
      name: this.cipher.decryptAuthenticated(row.name),
      ...(row.description
        ? { description: this.cipher.decryptAuthenticated(row.description) }
        : {}),
      model: row.model,
      parameters: parse<Persona['parameters']>(row.parameters) || {},
      ...(row.avatar
        ? { avatar: this.cipher.decryptAuthenticated(row.avatar) }
        : {}),
      ...(row.background
        ? { background: this.cipher.decryptAuthenticated(row.background) }
        : {}),
      ...(row.embedding_model ? { embedding_model: row.embedding_model } : {}),
      ...(row.memory_settings
        ? {
            memory_settings: parse<Persona['memory_settings']>(
              row.memory_settings
            ),
          }
        : {}),
      ...(row.mutation_settings
        ? {
            mutation_settings: parse<Persona['mutation_settings']>(
              row.mutation_settings
            ),
          }
        : {}),
      ...(row.bindings
        ? { bindings: parse<Persona['bindings']>(row.bindings) }
        : {}),
      created_at: safeInteger(row.created_at, 'persona creation time'),
      updated_at: safeInteger(row.updated_at, 'persona update time'),
    };
  }

  async listByOwner(userId: string): Promise<Persona[]> {
    const result = await this.database.query<PgPersonaRow>(
      'SELECT * FROM personas WHERE user_id = $1 ORDER BY updated_at DESC, id ASC',
      [userId]
    );
    return result.rows.map(row => this.map(row));
  }

  async findByOwner(id: string, userId: string): Promise<Persona | undefined> {
    const result = await this.database.query<PgPersonaRow>(
      'SELECT * FROM personas WHERE id = $1 AND user_id = $2',
      [id, userId]
    );
    return result.rows[0] ? this.map(result.rows[0]) : undefined;
  }

  async insert(persona: Persona): Promise<void> {
    await this.database.transaction(
      async client => {
        await assertResourceIdentifierAvailable(client, 'persona', persona.id);
        await client.query(
          `INSERT INTO personas
             (id, user_id, name, description, model, parameters, avatar,
              background, embedding_model, memory_settings, mutation_settings,
              bindings, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
          [
            persona.id,
            persona.user_id,
            this.cipher.encrypt(persona.name),
            persona.description
              ? this.cipher.encrypt(persona.description)
              : null,
            persona.model,
            this.cipher.encrypt(JSON.stringify(persona.parameters)),
            persona.avatar ? this.cipher.encrypt(persona.avatar) : null,
            persona.background ? this.cipher.encrypt(persona.background) : null,
            persona.embedding_model || null,
            persona.memory_settings
              ? this.cipher.encrypt(JSON.stringify(persona.memory_settings))
              : null,
            persona.mutation_settings
              ? this.cipher.encrypt(JSON.stringify(persona.mutation_settings))
              : null,
            persona.bindings
              ? this.cipher.encrypt(JSON.stringify(persona.bindings))
              : null,
            persona.created_at,
            persona.updated_at,
          ]
        );
      },
      { isolationLevel: 'serializable' }
    );
  }

  async replace(persona: Persona): Promise<boolean> {
    const result = await this.database.query(
      `UPDATE personas SET name = $1, description = $2, model = $3,
              parameters = $4, avatar = $5, background = $6,
              embedding_model = $7, memory_settings = $8,
              mutation_settings = $9, bindings = $10, updated_at = $11
        WHERE id = $12 AND user_id = $13`,
      [
        this.cipher.encrypt(persona.name),
        persona.description ? this.cipher.encrypt(persona.description) : null,
        persona.model,
        this.cipher.encrypt(JSON.stringify(persona.parameters)),
        persona.avatar ? this.cipher.encrypt(persona.avatar) : null,
        persona.background ? this.cipher.encrypt(persona.background) : null,
        persona.embedding_model || null,
        persona.memory_settings
          ? this.cipher.encrypt(JSON.stringify(persona.memory_settings))
          : null,
        persona.mutation_settings
          ? this.cipher.encrypt(JSON.stringify(persona.mutation_settings))
          : null,
        persona.bindings
          ? this.cipher.encrypt(JSON.stringify(persona.bindings))
          : null,
        persona.updated_at,
        persona.id,
        persona.user_id,
      ]
    );
    return result.rowCount === 1;
  }

  async patchByOwner(
    id: string,
    userId: string,
    patch: PersonaPatch
  ): Promise<Persona | undefined> {
    const assignments: string[] = [];
    const values: Array<string | number | null> = [];
    const assign = (column: string, value: string | number | null): void => {
      values.push(value);
      assignments.push(`${column} = $${values.length}`);
    };
    if (patch.name !== undefined) {
      assign('name', this.cipher.encrypt(patch.name));
    }
    if (patch.description !== undefined) {
      assign(
        'description',
        patch.description === null
          ? null
          : this.cipher.encrypt(patch.description)
      );
    }
    if (patch.model !== undefined) assign('model', patch.model);
    if (patch.parameters !== undefined) {
      assign(
        'parameters',
        this.cipher.encrypt(JSON.stringify(patch.parameters))
      );
    }
    if (patch.avatar !== undefined) {
      assign(
        'avatar',
        patch.avatar === null ? null : this.cipher.encrypt(patch.avatar)
      );
    }
    if (patch.background !== undefined) {
      assign(
        'background',
        patch.background === null ? null : this.cipher.encrypt(patch.background)
      );
    }
    if (patch.embedding_model !== undefined) {
      assign('embedding_model', patch.embedding_model);
    }
    if (patch.memory_settings !== undefined) {
      assign(
        'memory_settings',
        patch.memory_settings === null
          ? null
          : this.cipher.encrypt(JSON.stringify(patch.memory_settings))
      );
    }
    if (patch.mutation_settings !== undefined) {
      assign(
        'mutation_settings',
        patch.mutation_settings === null
          ? null
          : this.cipher.encrypt(JSON.stringify(patch.mutation_settings))
      );
    }
    if (patch.bindings !== undefined) {
      assign(
        'bindings',
        patch.bindings === null
          ? null
          : this.cipher.encrypt(JSON.stringify(patch.bindings))
      );
    }
    assign('updated_at', patch.updated_at);
    values.push(id, userId);

    const result = await this.database.query<PgPersonaRow>(
      `UPDATE personas SET ${assignments.join(', ')}
        WHERE id = $${values.length - 1} AND user_id = $${values.length}
        RETURNING *`,
      values
    );
    return result.rows[0] ? this.map(result.rows[0]) : undefined;
  }

  async deleteByOwner(id: string, userId: string): Promise<boolean> {
    const result = await this.database.query(
      'DELETE FROM personas WHERE id = $1 AND user_id = $2',
      [id, userId]
    );
    return result.rowCount === 1;
  }

  async deleteAndEnqueue(
    id: string,
    userId: string,
    enqueuer: TransactionalResourceDeletionEnqueuer
  ): Promise<boolean> {
    return this.database.transaction(
      async client => {
        await lockResourceIdentifier(client, 'persona', id);
        const existing = await client.query(
          'SELECT 1 FROM personas WHERE id = $1 AND user_id = $2 FOR UPDATE',
          [id, userId]
        );
        if (existing.rowCount !== 1) return false;
        const deletion = await recordResourceDeletion(client, {
          resourceType: 'persona',
          resourceId: id,
          ownerUserId: userId,
        });
        const deleted = await client.query(
          'DELETE FROM personas WHERE id = $1 AND user_id = $2',
          [id, userId]
        );
        if (deleted.rowCount !== 1) {
          throw new Error('Persona disappeared during deletion');
        }
        await enqueuer.enqueuePostgres(client, deletion);
        return true;
      },
      { isolationLevel: 'serializable' }
    );
  }

  async countByOwner(userId: string): Promise<number> {
    const result = await this.database.query<
      { count: string } & QueryResultRow
    >('SELECT COUNT(*)::text AS count FROM personas WHERE user_id = $1', [
      userId,
    ]);
    return safeInteger(result.rows[0]?.count ?? 0, 'persona count');
  }
}

interface PgPersonaStateRow extends QueryResultRow {
  persona_id: string;
  user_id: string;
  encrypted_runtime_state: string;
  encrypted_mutation_log: string;
  last_updated: string | number;
  version: number;
}

class PostgresPersonaStateRepository implements PersonaStateRepository {
  constructor(
    private readonly database: PostgresDatabase,
    private readonly cipher: PlatformContentCipher
  ) {}

  async findByOwner(
    personaId: string,
    userId: string
  ): Promise<PersonaState | undefined> {
    const result = await this.database.query<PgPersonaStateRow>(
      `SELECT * FROM platform_persona_states
        WHERE persona_id = $1 AND user_id = $2`,
      [personaId, userId]
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      persona_id: row.persona_id,
      user_id: row.user_id,
      runtime_state: JSON.parse(
        this.cipher.decryptAuthenticated(row.encrypted_runtime_state)
      ) as Record<string, unknown>,
      mutation_log: JSON.parse(
        this.cipher.decryptAuthenticated(row.encrypted_mutation_log)
      ) as PersonaState['mutation_log'],
      last_updated: safeInteger(row.last_updated, 'persona state update time'),
      version: row.version,
    };
  }

  async upsert(state: PersonaState): Promise<void> {
    const result = await this.database.query(
      `INSERT INTO platform_persona_states
         (persona_id, user_id, encrypted_runtime_state,
          encrypted_mutation_log, last_updated, version)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT(persona_id) DO UPDATE SET
         encrypted_runtime_state = EXCLUDED.encrypted_runtime_state,
         encrypted_mutation_log = EXCLUDED.encrypted_mutation_log,
         last_updated = EXCLUDED.last_updated,
         version = EXCLUDED.version
       WHERE platform_persona_states.user_id = EXCLUDED.user_id`,
      [
        state.persona_id,
        state.user_id,
        this.cipher.encrypt(JSON.stringify(state.runtime_state)),
        this.cipher.encrypt(JSON.stringify(state.mutation_log)),
        state.last_updated,
        state.version,
      ]
    );
    if (result.rowCount === 0) {
      throw new Error('Persona state identifier belongs to another owner');
    }
  }

  async deleteByOwner(personaId: string, userId: string): Promise<boolean> {
    const result = await this.database.query(
      `DELETE FROM platform_persona_states
        WHERE persona_id = $1 AND user_id = $2`,
      [personaId, userId]
    );
    return result.rowCount === 1;
  }
}

class PostgresResourceDeletionLifecycleRepository implements ResourceDeletionLifecycleRepository {
  constructor(private readonly database: PostgresDatabase) {}

  private async cleanupAuthorizedUsing(
    executor: PostgresQueryExecutor,
    input: TransactionalResourceDeletionInput
  ): Promise<boolean> {
    const table = resourceTable(input.resourceType);
    const result = await executor.query(
      `SELECT 1
         FROM platform_resource_deletion_tombstones tombstone
        WHERE tombstone.resource_type = $1
          AND tombstone.resource_id = $2
          AND tombstone.owner_user_id = $3
          AND tombstone.deletion_incarnation = $4
          AND tombstone.deletion_token = $5
          AND NOT EXISTS (
            SELECT 1 FROM ${table} resource
             WHERE resource.id = tombstone.resource_id
               AND resource.user_id = tombstone.owner_user_id
          )`,
      [
        input.resourceType,
        input.resourceId,
        input.ownerUserId,
        input.deletionIncarnation,
        input.deletionToken,
      ]
    );
    return result.rowCount === 1;
  }

  async withAuthorizedCleanup<T>(
    input: TransactionalResourceDeletionInput,
    operation: () => Promise<T>
  ): Promise<{ authorized: false } | { authorized: true; value: T }> {
    return this.database.transaction(
      async client => {
        await lockResourceIdentifier(
          client,
          input.resourceType,
          input.resourceId
        );
        if (!(await this.cleanupAuthorizedUsing(client, input))) {
          return { authorized: false } as const;
        }
        return { authorized: true, value: await operation() } as const;
      },
      { isolationLevel: 'serializable' }
    );
  }

  async isReserved(
    resourceType: TransactionalResourceDeletionInput['resourceType'],
    resourceId: string
  ): Promise<boolean> {
    const result = await this.database.query(
      `SELECT 1 FROM platform_resource_deletion_tombstones
        WHERE resource_type = $1 AND resource_id = $2`,
      [resourceType, resourceId]
    );
    return result.rowCount === 1;
  }

  async isCleanupAuthorized(
    input: TransactionalResourceDeletionInput
  ): Promise<boolean> {
    return this.cleanupAuthorizedUsing(this.database, input);
  }

  async markCleanupCompleted(
    input: TransactionalResourceDeletionInput
  ): Promise<boolean> {
    const table = resourceTable(input.resourceType);
    const result = await this.database.query(
      `UPDATE platform_resource_deletion_tombstones
          SET completed_at = COALESCE(completed_at, $1)
        WHERE resource_type = $2 AND resource_id = $3 AND owner_user_id = $4
          AND deletion_incarnation = $5 AND deletion_token = $6
          AND NOT EXISTS (
            SELECT 1 FROM ${table} resource
             WHERE resource.id = platform_resource_deletion_tombstones.resource_id
               AND resource.user_id = platform_resource_deletion_tombstones.owner_user_id
          )`,
      [
        Date.now(),
        input.resourceType,
        input.resourceId,
        input.ownerUserId,
        input.deletionIncarnation,
        input.deletionToken,
      ]
    );
    return result.rowCount === 1;
  }
}

export const createPostgresPlatformDomainRepositories = (
  database: PostgresDatabase,
  cipher: PlatformContentCipher
): PlatformDomainRepositories => ({
  documents: new PostgresDocumentRepository(database, cipher),
  gallery: new PostgresGalleryMetadataRepository(database, cipher),
  mediaJobs: new PostgresMediaGenerationJobRepository(database, cipher),
  memories: new PostgresPersonaMemoryRepository(database, cipher),
  personas: new PostgresPersonaRepository(database, cipher),
  personaStates: new PostgresPersonaStateRepository(database, cipher),
  resourceDeletions: new PostgresResourceDeletionLifecycleRepository(database),
});
