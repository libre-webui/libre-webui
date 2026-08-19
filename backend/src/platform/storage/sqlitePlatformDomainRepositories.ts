/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import type Database from 'better-sqlite3';
import { createSQLiteSyncExecutor } from '../../persistence/sqliteSyncExecutor.js';
import type {
  DocumentChunk,
  Persona,
  PersonaState,
} from '../../types/index.js';
import type {
  Document,
  DocumentChunkRow,
  DocumentRow,
} from '../../storageMappers.js';
import type { BlobReference } from './blobReferenceRepository.js';
import type {
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
import { embeddingBufferToArray } from '../../services/memoryUtils.js';
import { resourceDeletionToken } from './resourceDeletionLifecycle.js';
import { MAX_VECTOR_RESOURCE_INDEX_ENTRIES } from './vectorStore.js';

const resourceTable = (
  resourceType: TransactionalResourceDeletionInput['resourceType']
): string => {
  switch (resourceType) {
    case 'document':
      return 'documents';
    case 'generated-media':
      return 'generated_images';
    case 'persona':
      return 'personas';
  }
};

const assertResourceIdentifierAvailable = (
  database: Database.Database,
  resourceType: TransactionalResourceDeletionInput['resourceType'],
  resourceId: string
): void => {
  const reserved = database
    .prepare(
      `SELECT 1 FROM platform_resource_deletion_tombstones
        WHERE resource_type = ? AND resource_id = ?`
    )
    .get(resourceType, resourceId);
  if (reserved) {
    throw new Error('Resource identifier is permanently reserved by deletion');
  }
};

const recordResourceDeletion = (
  database: Database.Database,
  input: Omit<
    TransactionalResourceDeletionInput,
    'deletionToken' | 'deletionIncarnation'
  >
): TransactionalResourceDeletionInput => {
  assertResourceIdentifierAvailable(
    database,
    input.resourceType,
    input.resourceId
  );
  const deletionIncarnation = 1;
  const deletionToken = resourceDeletionToken({
    ...input,
    deletionIncarnation,
  });
  database
    .prepare(
      `INSERT INTO platform_resource_deletion_tombstones
         (resource_type, resource_id, owner_user_id, deletion_incarnation,
          deletion_token, deleted_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL)`
    )
    .run(
      input.resourceType,
      input.resourceId,
      input.ownerUserId,
      deletionIncarnation,
      deletionToken,
      Date.now()
    );
  return { ...input, deletionIncarnation, deletionToken };
};

const decryptLegacyCompatible = (
  cipher: PlatformContentCipher,
  value: string
): string =>
  cipher.isEncrypted(value) ? cipher.decryptAuthenticated(value) : value;

const decryptLegacyJson = <T>(
  cipher: PlatformContentCipher,
  value: string | null
): T | undefined => {
  if (!value) return undefined;
  try {
    return JSON.parse(decryptLegacyCompatible(cipher, value)) as T;
  } catch {
    return undefined;
  }
};

/**
 * Keep platform repository composition free of the legacy storage mapper
 * singleton.  The application injects the selected content cipher explicitly;
 * importing storage primitives must never initialize encryption or a database.
 */
const mapDocumentRow = (
  cipher: PlatformContentCipher,
  row: DocumentRow
): Document => ({
  id: row.id,
  filename: row.filename,
  ...(row.title ? { title: decryptLegacyCompatible(cipher, row.title) } : {}),
  ...(row.content
    ? { content: decryptLegacyCompatible(cipher, row.content) }
    : {}),
  ...(row.file_type ? { fileType: row.file_type as 'pdf' | 'txt' } : {}),
  ...(row.size === undefined ? {} : { size: row.size }),
  ...(row.session_id ? { sessionId: row.session_id } : {}),
  ...(row.collection_id ? { collectionId: row.collection_id } : {}),
  uploadedAt: row.uploaded_at,
  ...(row.created_at === undefined ? {} : { createdAt: row.created_at }),
  ...(row.metadata
    ? {
        metadata: decryptLegacyJson<Record<string, unknown>>(
          cipher,
          row.metadata
        ),
      }
    : {}),
});

const mapDocumentChunkRow = (
  cipher: PlatformContentCipher,
  row: DocumentChunkRow
): DocumentChunk => ({
  id: row.id,
  documentId: row.document_id,
  content: decryptLegacyCompatible(cipher, row.content),
  ...(row.embedding
    ? { embedding: decryptLegacyJson<number[]>(cipher, row.embedding) }
    : {}),
  chunkIndex: row.chunk_index,
  startChar: row.start_char,
  endChar: row.end_char,
});

const referenceFromRow = (row: {
  blob_id: string;
  owner_user_id: string;
  resource_type: string;
  resource_id: string;
  purpose: string;
  created_at: number;
}): BlobReference => ({
  blobId: row.blob_id,
  ownerUserId: row.owner_user_id,
  resourceType: row.resource_type,
  resourceId: row.resource_id,
  purpose: row.purpose,
  createdAt: row.created_at,
});

class SQLiteDocumentRepository {
  constructor(
    private readonly database: Database.Database,
    private readonly cipher: PlatformContentCipher
  ) {}

  async listByOwner(userId: string): Promise<Document[]> {
    const rows = this.database
      .prepare(
        'SELECT * FROM documents WHERE user_id = ? ORDER BY uploaded_at DESC'
      )
      .all(userId) as DocumentRow[];
    return rows.map(row => mapDocumentRow(this.cipher, row));
  }

  async findByOwner(
    documentId: string,
    userId: string
  ): Promise<Document | undefined> {
    const row = this.database
      .prepare('SELECT * FROM documents WHERE id = ? AND user_id = ?')
      .get(documentId, userId) as DocumentRow | undefined;
    return row ? mapDocumentRow(this.cipher, row) : undefined;
  }

  async upsert(document: Document, userId: string): Promise<void> {
    const save = this.database.transaction(() => {
      assertResourceIdentifierAvailable(this.database, 'document', document.id);
      this.upsertSync(document, userId);
    });
    save.immediate();
  }

  private upsertSync(document: Document, userId: string): void {
    const now = Date.now();
    this.database
      .prepare(
        `INSERT INTO documents
           (id, user_id, filename, title, content, file_type, size, session_id,
            collection_id, metadata, uploaded_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           filename = excluded.filename, title = excluded.title,
           content = excluded.content, file_type = excluded.file_type,
           size = excluded.size, session_id = excluded.session_id,
           collection_id = excluded.collection_id, metadata = excluded.metadata,
           uploaded_at = excluded.uploaded_at, updated_at = excluded.updated_at
         WHERE documents.user_id = excluded.user_id`
      )
      .run(
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
        now
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
    const publish = this.database.transaction(() => {
      assertResourceIdentifierAvailable(this.database, 'document', document.id);
      this.upsertSync(document, userId);
      this.database
        .prepare(
          `INSERT INTO platform_blob_references
             (blob_id, owner_user_id, resource_type, resource_id, purpose, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(
          reference.blobId,
          reference.ownerUserId,
          reference.resourceType,
          reference.resourceId,
          reference.purpose,
          reference.createdAt
        );
      enqueuer.enqueueSQLite(createSQLiteSyncExecutor(this.database), {
        documentId: document.id,
        ownerUserId: userId,
      });
    });
    publish.immediate();
  }

  async completeIngestion(
    document: Document,
    userId: string,
    chunks: readonly DocumentChunk[]
  ): Promise<boolean> {
    const complete = this.database.transaction(() => {
      const updated = this.database
        .prepare(
          `UPDATE documents SET filename = ?, title = ?, content = ?,
                  file_type = ?, size = ?, session_id = ?, collection_id = ?,
                  metadata = ?, uploaded_at = ?, updated_at = ?
            WHERE id = ? AND user_id = ?`
        )
        .run(
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
          userId
        );
      if (updated.changes !== 1) return false;
      this.replaceChunksSync(document.id, chunks);
      return true;
    });
    return complete.immediate();
  }

  async publishEmbeddingIndex(
    documentId: string,
    userId: string,
    expectedSource: {
      content: string | null;
      fileType: 'pdf' | 'txt' | null;
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
    const publish = this.database.transaction(() => {
      const row = this.database
        .prepare(
          `SELECT content, file_type, metadata FROM documents
            WHERE id = ? AND user_id = ?`
        )
        .get(documentId, userId) as
        | {
            content: string | null;
            file_type: 'pdf' | 'txt' | null;
            metadata: string | null;
          }
        | undefined;
      if (!row) return false;
      const currentContent = row.content
        ? decryptLegacyCompatible(this.cipher, row.content)
        : null;
      if (
        currentContent !== expectedSource.content ||
        row.file_type !== expectedSource.fileType
      ) {
        return false;
      }
      const currentMetadata =
        decryptLegacyJson<Record<string, unknown>>(this.cipher, row.metadata) ??
        {};
      const metadata = this.cipher.encrypt(
        JSON.stringify({
          ...currentMetadata,
          embeddingIndex,
        })
      );
      const updated = this.database
        .prepare(
          `UPDATE documents SET metadata = ?, updated_at = ?
            WHERE id = ? AND user_id = ?`
        )
        .run(metadata, Date.now(), documentId, userId);
      if (updated.changes !== 1) return false;
      this.replaceChunksSync(documentId, chunks);
      return true;
    });
    return publish.immediate();
  }

  async deleteByOwner(documentId: string, userId: string): Promise<boolean> {
    return (
      this.database
        .prepare('DELETE FROM documents WHERE id = ? AND user_id = ?')
        .run(documentId, userId).changes > 0
    );
  }

  async deleteAndEnqueue(
    documentId: string,
    userId: string,
    enqueuer: TransactionalResourceDeletionEnqueuer
  ): Promise<boolean> {
    const remove = this.database.transaction(() => {
      const existing = this.database
        .prepare('SELECT 1 FROM documents WHERE id = ? AND user_id = ?')
        .get(documentId, userId);
      if (!existing) return false;
      const deletion = recordResourceDeletion(this.database, {
        resourceType: 'document',
        resourceId: documentId,
        ownerUserId: userId,
      });
      const deleted = this.database
        .prepare('DELETE FROM documents WHERE id = ? AND user_id = ?')
        .run(documentId, userId);
      if (deleted.changes !== 1) {
        throw new Error('Document disappeared while deletion was serialized');
      }
      enqueuer.enqueueSQLite(createSQLiteSyncExecutor(this.database), deletion);
      return true;
    });
    return remove.immediate();
  }

  async setCollection(
    documentId: string,
    collectionId: string | null,
    userId: string
  ): Promise<boolean> {
    return (
      this.database
        .prepare(
          'UPDATE documents SET collection_id = ? WHERE id = ? AND user_id = ?'
        )
        .run(collectionId, documentId, userId).changes > 0
    );
  }

  async inspectLegacyChunkEmbeddings(
    documentId: string,
    userId: string
  ): Promise<{ present: boolean; authenticated: boolean }> {
    const rows = this.database
      .prepare(
        `SELECT c.embedding
           FROM document_chunks c
           JOIN documents d ON d.id = c.document_id
          WHERE c.document_id = ? AND d.user_id = ?
            AND c.embedding IS NOT NULL
          ORDER BY c.chunk_index, c.id`
      )
      .iterate(documentId, userId) as Iterable<{ embedding: string }>;
    let present = false;
    let rowCount = 0;
    let ciphertextBytes = 0;
    for (const row of rows) {
      present = true;
      rowCount += 1;
      const rowBytes =
        typeof row.embedding === 'string'
          ? Buffer.byteLength(row.embedding, 'utf8')
          : 0;
      ciphertextBytes += rowBytes;
      if (
        rowCount > MAX_VECTOR_RESOURCE_INDEX_ENTRIES ||
        ciphertextBytes > 64 * 1024 * 1024 ||
        typeof row.embedding !== 'string' ||
        rowBytes > 4 * 1024 * 1024 ||
        !this.cipher.isEncrypted(row.embedding)
      ) {
        return { present: true, authenticated: false };
      }
      try {
        const plaintext = this.cipher.decryptAuthenticated(row.embedding);
        if (Buffer.byteLength(plaintext, 'utf8') > 2 * 1024 * 1024) {
          return { present: true, authenticated: false };
        }
        const embedding = JSON.parse(plaintext) as unknown;
        if (
          !Array.isArray(embedding) ||
          embedding.length < 1 ||
          embedding.length > 16_000 ||
          !embedding.every(
            component =>
              typeof component === 'number' && Number.isFinite(component)
          )
        ) {
          return { present: true, authenticated: false };
        }
      } catch {
        return { present: true, authenticated: false };
      }
    }
    return { present, authenticated: present };
  }

  async listChunks(documentId: string): Promise<DocumentChunk[]> {
    const rows = this.database
      .prepare(
        'SELECT * FROM document_chunks WHERE document_id = ? ORDER BY chunk_index ASC'
      )
      .all(documentId) as DocumentChunkRow[];
    return rows.map(row => mapDocumentChunkRow(this.cipher, row));
  }

  async replaceChunks(
    documentId: string,
    chunks: readonly DocumentChunk[]
  ): Promise<void> {
    const replace = this.database.transaction(() =>
      this.replaceChunksSync(documentId, chunks)
    );
    replace();
  }

  private replaceChunksSync(
    documentId: string,
    chunks: readonly DocumentChunk[]
  ): void {
    this.database
      .prepare('DELETE FROM document_chunks WHERE document_id = ?')
      .run(documentId);
    const insert = this.database.prepare(
      `INSERT INTO document_chunks
         (id, document_id, chunk_index, content, start_char, end_char,
          embedding, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const now = Date.now();
    for (const chunk of chunks) {
      insert.run(
        chunk.id,
        documentId,
        chunk.chunkIndex,
        this.cipher.encrypt(chunk.content),
        chunk.startChar ?? null,
        chunk.endChar ?? null,
        chunk.embedding
          ? this.cipher.encrypt(JSON.stringify(chunk.embedding))
          : null,
        now
      );
    }
  }

  async deleteChunks(documentId: string): Promise<boolean> {
    return (
      this.database
        .prepare('DELETE FROM document_chunks WHERE document_id = ?')
        .run(documentId).changes > 0
    );
  }
}

interface SQLiteGalleryRow {
  id: string;
  user_id: string;
  kind: GalleryMetadataRecord['kind'];
  prompt: string;
  model: string;
  plugin_id: string | null;
  image_data: string;
  mime_type: string;
  size: string | null;
  quality: string | null;
  metadata: string | null;
  created_at: number;
}

class SQLiteGalleryMetadataRepository implements GalleryMetadataRepository {
  constructor(
    private readonly database: Database.Database,
    private readonly cipher: PlatformContentCipher
  ) {}

  private map(row: SQLiteGalleryRow): GalleryMetadataRecord {
    const metadata = decryptLegacyJson<Record<string, unknown>>(
      this.cipher,
      row.metadata
    );
    return {
      id: row.id,
      userId: row.user_id,
      kind: row.kind,
      prompt: decryptLegacyCompatible(this.cipher, row.prompt),
      model: row.model,
      ...(row.plugin_id ? { pluginId: row.plugin_id } : {}),
      mimeType: row.mime_type,
      ...(row.size ? { size: row.size } : {}),
      ...(row.quality ? { quality: row.quality } : {}),
      ...(metadata ? { metadata } : {}),
      createdAt: row.created_at,
      ...(row.image_data
        ? {
            legacyMediaData: decryptLegacyCompatible(
              this.cipher,
              row.image_data
            ),
          }
        : {}),
    };
  }

  async insert(
    record: GalleryMetadataRecord,
    reference: BlobReference
  ): Promise<void> {
    const insert = this.database.transaction(() => {
      assertResourceIdentifierAvailable(
        this.database,
        'generated-media',
        record.id
      );
      this.database
        .prepare(
          `INSERT INTO generated_images
             (id, user_id, kind, prompt, model, plugin_id, image_data,
              mime_type, size, quality, metadata, created_at)
           VALUES (?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?)`
        )
        .run(
          record.id,
          record.userId,
          record.kind,
          this.cipher.encrypt(record.prompt),
          record.model,
          record.pluginId || null,
          record.mimeType,
          record.size || null,
          record.quality || null,
          record.metadata
            ? this.cipher.encrypt(JSON.stringify(record.metadata))
            : null,
          record.createdAt
        );
      this.database
        .prepare(
          `INSERT INTO platform_blob_references
             (blob_id, owner_user_id, resource_type, resource_id, purpose, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(
          reference.blobId,
          reference.ownerUserId,
          reference.resourceType,
          reference.resourceId,
          reference.purpose,
          reference.createdAt
        );
    });
    insert();
  }

  async findByOwner(
    mediaId: string,
    userId: string
  ): Promise<GalleryMetadataRecord | undefined> {
    const row = this.database
      .prepare('SELECT * FROM generated_images WHERE id = ? AND user_id = ?')
      .get(mediaId, userId) as SQLiteGalleryRow | undefined;
    return row ? this.map(row) : undefined;
  }

  async listByOwner(
    userId: string,
    options: {
      limit: number;
      offset: number;
      kind?: GalleryMetadataRecord['kind'];
    }
  ): Promise<{ records: GalleryMetadataRecord[]; total: number }> {
    const predicate = options.kind ? 'user_id = ? AND kind = ?' : 'user_id = ?';
    const values = options.kind ? [userId, options.kind] : [userId];
    const count = this.database
      .prepare(
        `SELECT COUNT(*) AS count FROM generated_images WHERE ${predicate}`
      )
      .get(...values) as { count: number };
    const rows = this.database
      .prepare(
        `SELECT * FROM generated_images WHERE ${predicate}
          ORDER BY created_at DESC, id ASC LIMIT ? OFFSET ?`
      )
      .all(...values, options.limit, options.offset) as SQLiteGalleryRow[];
    return { records: rows.map(row => this.map(row)), total: count.count };
  }

  async adoptLegacyBlob(reference: BlobReference): Promise<void> {
    const adopt = this.database.transaction(() => {
      assertResourceIdentifierAvailable(
        this.database,
        'generated-media',
        reference.resourceId
      );
      const current = this.database
        .prepare(
          `SELECT image_data FROM generated_images
            WHERE id = ? AND user_id = ?`
        )
        .get(reference.resourceId, reference.ownerUserId) as
        { image_data: string } | undefined;
      if (!current) {
        throw new Error('Generated media was deleted during legacy adoption');
      }
      this.database
        .prepare(
          `INSERT INTO platform_blob_references
             (blob_id, owner_user_id, resource_type, resource_id, purpose, created_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(resource_type, resource_id, purpose) DO NOTHING`
        )
        .run(
          reference.blobId,
          reference.ownerUserId,
          reference.resourceType,
          reference.resourceId,
          reference.purpose,
          reference.createdAt
        );
      this.database
        .prepare(
          `UPDATE generated_images SET image_data = ''
            WHERE id = ? AND user_id = ? AND image_data <> ''`
        )
        .run(reference.resourceId, reference.ownerUserId);
    });
    adopt();
  }

  async deleteByOwner(
    mediaId: string,
    userId: string
  ): Promise<BlobReference | undefined> {
    const remove = this.database.transaction(() => {
      const reference = this.database
        .prepare(
          `SELECT blob_id, owner_user_id, resource_type, resource_id, purpose,
                  created_at
             FROM platform_blob_references
            WHERE resource_type = 'generated-media' AND resource_id = ?
              AND purpose = 'gallery.media' AND owner_user_id = ?`
        )
        .get(mediaId, userId) as
        Parameters<typeof referenceFromRow>[0] | undefined;
      const deleted = this.database
        .prepare('DELETE FROM generated_images WHERE id = ? AND user_id = ?')
        .run(mediaId, userId);
      if (deleted.changes === 0) return undefined;
      this.database
        .prepare(
          `DELETE FROM platform_blob_references
            WHERE resource_type = 'generated-media' AND resource_id = ?
              AND purpose = 'gallery.media' AND owner_user_id = ?`
        )
        .run(mediaId, userId);
      return reference ? referenceFromRow(reference) : undefined;
    });
    return remove();
  }

  async deleteAndEnqueue(
    mediaId: string,
    userId: string,
    enqueuer: TransactionalResourceDeletionEnqueuer
  ): Promise<boolean> {
    const remove = this.database.transaction(() => {
      const existing = this.database
        .prepare('SELECT 1 FROM generated_images WHERE id = ? AND user_id = ?')
        .get(mediaId, userId);
      if (!existing) return false;
      const deletion = recordResourceDeletion(this.database, {
        resourceType: 'generated-media',
        resourceId: mediaId,
        ownerUserId: userId,
      });
      this.database
        .prepare(
          `UPDATE media_generation_jobs
              SET status = 'failed', error = ?, updated_at = ?
            WHERE id = ? AND user_id = ?
              AND status IN ('pending', 'in_progress')`
        )
        .run(
          this.cipher.encrypt('Generated media was deleted'),
          Date.now(),
          mediaId,
          userId
        );
      const deleted = this.database
        .prepare('DELETE FROM generated_images WHERE id = ? AND user_id = ?')
        .run(mediaId, userId);
      if (deleted.changes !== 1) {
        throw new Error('Generated media disappeared during deletion');
      }
      enqueuer.enqueueSQLite(createSQLiteSyncExecutor(this.database), deletion);
      return true;
    });
    return remove.immediate();
  }
}

interface SQLiteMediaJobRow {
  id: string;
  user_id: string;
  provider_job_id: string;
  plugin_id: string;
  model: string;
  prompt: string;
  status: MediaGenerationStatus;
  options_json: string | null;
  gallery_id: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

class SQLiteMediaGenerationJobRepository implements MediaGenerationJobRepository {
  constructor(
    private readonly database: Database.Database,
    private readonly cipher: PlatformContentCipher
  ) {}

  private map(row: SQLiteMediaJobRow): MediaGenerationRecord {
    return {
      id: row.id,
      userId: row.user_id,
      providerJobId: row.provider_job_id,
      pluginId: row.plugin_id,
      model: row.model,
      prompt: decryptLegacyCompatible(this.cipher, row.prompt),
      status: row.status,
      options:
        decryptLegacyJson<Record<string, unknown>>(
          this.cipher,
          row.options_json
        ) || {},
      ...(row.gallery_id ? { galleryId: row.gallery_id } : {}),
      ...(row.error
        ? { error: decryptLegacyCompatible(this.cipher, row.error) }
        : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private insert(record: MediaGenerationRecord): void {
    this.database
      .prepare(
        `INSERT INTO media_generation_jobs
           (id, user_id, provider_job_id, plugin_id, model, prompt, status,
            options_json, gallery_id, error, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
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
        record.updatedAt
      );
  }

  async create(record: MediaGenerationRecord): Promise<void> {
    this.insert(record);
  }

  async createPreparedAndEnqueue(
    record: MediaGenerationRecord,
    enqueuer: TransactionalVideoSubmissionEnqueuer
  ): Promise<void> {
    this.database
      .transaction(() => {
        this.insert(record);
        enqueuer.enqueueSQLite(createSQLiteSyncExecutor(this.database), {
          mediaJobId: record.id,
          ownerUserId: record.userId,
        });
      })
      .immediate();
  }

  async acceptProviderAndEnqueueResume(
    id: string,
    userId: string,
    providerJobId: string,
    updatedAt: number,
    preparedProviderJobId: string,
    enqueuer: TransactionalVideoResumeEnqueuer
  ): Promise<boolean> {
    return this.database
      .transaction(() => {
        const current = this.database
          .prepare(
            'SELECT provider_job_id FROM media_generation_jobs WHERE id = ? AND user_id = ?'
          )
          .get(id, userId) as { provider_job_id: string } | undefined;
        if (!current) return false;
        if (
          current.provider_job_id !== preparedProviderJobId &&
          current.provider_job_id !== providerJobId
        ) {
          throw new Error(
            'Media provider reconciliation returned a new job ID'
          );
        }
        this.database
          .prepare(
            `UPDATE media_generation_jobs
                SET provider_job_id = ?, status = 'pending', updated_at = ?
              WHERE id = ? AND user_id = ?`
          )
          .run(providerJobId, updatedAt, id, userId);
        enqueuer.enqueueSQLite(createSQLiteSyncExecutor(this.database), {
          mediaJobId: id,
          ownerUserId: userId,
        });
        return true;
      })
      .immediate();
  }

  async findByOwner(
    id: string,
    userId: string
  ): Promise<MediaGenerationRecord | undefined> {
    const row = this.database
      .prepare(
        'SELECT * FROM media_generation_jobs WHERE id = ? AND user_id = ?'
      )
      .get(id, userId) as SQLiteMediaJobRow | undefined;
    return row ? this.map(row) : undefined;
  }

  async listByOwner(
    userId: string,
    options: { limit: number; activeOnly: boolean }
  ): Promise<MediaGenerationRecord[]> {
    const rows = this.database
      .prepare(
        `SELECT * FROM media_generation_jobs WHERE user_id = ?
          ${options.activeOnly ? "AND status IN ('pending', 'in_progress')" : ''}
          ORDER BY updated_at DESC, id ASC LIMIT ?`
      )
      .all(userId, options.limit) as SQLiteMediaJobRow[];
    return rows.map(row => this.map(row));
  }

  async deleteByOwner(id: string, userId: string): Promise<boolean> {
    return (
      this.database
        .prepare(
          'DELETE FROM media_generation_jobs WHERE id = ? AND user_id = ?'
        )
        .run(id, userId).changes > 0
    );
  }

  async updateStatus(
    id: string,
    userId: string,
    status: MediaGenerationStatus,
    fields: { galleryId?: string; error?: string },
    updatedAt: number
  ): Promise<boolean> {
    return (
      this.database
        .prepare(
          `UPDATE media_generation_jobs
              SET status = ?, gallery_id = COALESCE(?, gallery_id),
                  error = COALESCE(?, error), updated_at = ?
            WHERE id = ? AND user_id = ?`
        )
        .run(
          status,
          fields.galleryId || null,
          fields.error ? this.cipher.encrypt(fields.error) : null,
          updatedAt,
          id,
          userId
        ).changes > 0
    );
  }

  async completeIfUnclaimed(
    id: string,
    userId: string,
    galleryId: string,
    updatedAt: number
  ): Promise<boolean> {
    return (
      this.database
        .prepare(
          `UPDATE media_generation_jobs
              SET status = 'completed', gallery_id = ?, error = NULL, updated_at = ?
            WHERE id = ? AND user_id = ? AND gallery_id IS NULL`
        )
        .run(galleryId, updatedAt, id, userId).changes > 0
    );
  }

  async deleteTerminalBefore(cutoff: number): Promise<number> {
    return this.database
      .prepare(
        `DELETE FROM media_generation_jobs
          WHERE status IN ('completed', 'failed') AND updated_at < ?`
      )
      .run(cutoff).changes;
  }
}

interface SQLiteMemoryRow {
  id: string;
  user_id: string;
  persona_id: string;
  content: string;
  embedding: Buffer | null;
  timestamp: number;
  context: string | null;
  importance_score: number;
  memory_type: StoredMemoryType | null;
  access_count: number | null;
  last_accessed: number | null;
  decay_factor: number | null;
  consolidated_from: string | null;
}

class SQLitePersonaMemoryRepository implements PersonaMemoryRepository {
  constructor(
    private readonly database: Database.Database,
    private readonly cipher: PlatformContentCipher
  ) {}

  private map(row: SQLiteMemoryRow): PersonaMemoryRecord {
    let consolidatedFrom: string[] | undefined;
    try {
      const parsed = row.consolidated_from
        ? (JSON.parse(
            decryptLegacyCompatible(this.cipher, row.consolidated_from)
          ) as unknown)
        : undefined;
      if (
        Array.isArray(parsed) &&
        parsed.every(value => typeof value === 'string')
      ) {
        consolidatedFrom = parsed;
      }
    } catch {
      consolidatedFrom = undefined;
    }
    return {
      id: row.id,
      userId: row.user_id,
      personaId: row.persona_id,
      content: decryptLegacyCompatible(this.cipher, row.content),
      timestamp: row.timestamp,
      ...(row.context
        ? { context: decryptLegacyCompatible(this.cipher, row.context) }
        : {}),
      importanceScore: row.importance_score,
      memoryType: row.memory_type || 'general',
      accessCount: row.access_count || 0,
      ...(row.last_accessed ? { lastAccessed: row.last_accessed } : {}),
      decayFactor: row.decay_factor ?? 1,
      ...(consolidatedFrom ? { consolidatedFrom } : {}),
      ...(row.embedding
        ? { legacyEmbedding: embeddingBufferToArray(row.embedding) }
        : {}),
    };
  }

  async insert(record: PersonaMemoryRecord): Promise<void> {
    this.database
      .prepare(
        `INSERT INTO persona_memories
           (id, user_id, persona_id, content, embedding, timestamp, context,
            importance_score, memory_type, access_count, last_accessed,
            decay_factor, consolidated_from)
         VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
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
          : null
      );
  }

  async findByOwner(
    memoryId: string,
    userId: string,
    personaId: string
  ): Promise<PersonaMemoryRecord | undefined> {
    const row = this.database
      .prepare(
        `SELECT * FROM persona_memories
          WHERE id = ? AND user_id = ? AND persona_id = ?`
      )
      .get(memoryId, userId, personaId) as SQLiteMemoryRow | undefined;
    return row ? this.map(row) : undefined;
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
    const parameters: Array<string | number> = [userId, personaId];
    let predicate = 'user_id = ? AND persona_id = ?';
    if (options.types?.length) {
      predicate += ` AND memory_type IN (${options.types.map(() => '?').join(',')})`;
      parameters.push(...options.types);
    }
    if (options.minimumImportance !== undefined) {
      predicate += ' AND importance_score >= ?';
      parameters.push(options.minimumImportance);
    }
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 10_000);
    const offset = Math.max(options.offset ?? 0, 0);
    const rows = this.database
      .prepare(
        `SELECT * FROM persona_memories WHERE ${predicate}
          ORDER BY timestamp DESC, id ASC LIMIT ? OFFSET ?`
      )
      .all(...parameters, limit, offset) as SQLiteMemoryRow[];
    return rows.map(row => this.map(row));
  }

  async countByOwner(userId: string, personaId: string): Promise<number> {
    const row = this.database
      .prepare(
        'SELECT COUNT(*) AS count FROM persona_memories WHERE user_id = ? AND persona_id = ?'
      )
      .get(userId, personaId) as { count: number };
    return row.count;
  }

  async reinforce(
    memoryId: string,
    userId: string,
    personaId: string,
    accessedAt: number
  ): Promise<boolean> {
    return (
      this.database
        .prepare(
          `UPDATE persona_memories
              SET access_count = COALESCE(access_count, 0) + 1,
                  last_accessed = ?,
                  importance_score = MIN(1.0, COALESCE(importance_score, 0.5) + 0.05)
            WHERE id = ? AND user_id = ? AND persona_id = ?`
        )
        .run(accessedAt, memoryId, userId, personaId).changes > 0
    );
  }

  async markAccessed(
    ids: readonly string[],
    userId: string,
    personaId: string,
    accessedAt: number
  ): Promise<number> {
    if (ids.length === 0) return 0;
    return this.database
      .prepare(
        `UPDATE persona_memories
            SET access_count = COALESCE(access_count, 0) + 1, last_accessed = ?
          WHERE user_id = ? AND persona_id = ?
            AND id IN (${ids.map(() => '?').join(',')})`
      )
      .run(accessedAt, userId, personaId, ...ids).changes;
  }

  async updateImportance(
    memoryId: string,
    userId: string,
    personaId: string,
    importanceScore: number,
    decayFactor?: number
  ): Promise<boolean> {
    return (
      this.database
        .prepare(
          `UPDATE persona_memories
              SET importance_score = ?, decay_factor = COALESCE(?, decay_factor)
            WHERE id = ? AND user_id = ? AND persona_id = ?`
        )
        .run(importanceScore, decayFactor ?? null, memoryId, userId, personaId)
        .changes > 0
    );
  }

  async deleteIds(
    ids: readonly string[],
    userId: string,
    personaId: string
  ): Promise<number> {
    if (ids.length === 0) return 0;
    return this.database
      .prepare(
        `DELETE FROM persona_memories WHERE user_id = ? AND persona_id = ?
          AND id IN (${ids.map(() => '?').join(',')})`
      )
      .run(userId, personaId, ...ids).changes;
  }

  async deleteAllByOwner(userId: string, personaId: string): Promise<number> {
    return this.database
      .prepare(
        'DELETE FROM persona_memories WHERE user_id = ? AND persona_id = ?'
      )
      .run(userId, personaId).changes;
  }

  async findOldLowImportanceIds(
    userId: string,
    personaId: string,
    cutoff: number,
    maximumImportance: number
  ): Promise<string[]> {
    const rows = this.database
      .prepare(
        `SELECT id FROM persona_memories
          WHERE user_id = ? AND persona_id = ? AND timestamp < ?
            AND importance_score < ?
          ORDER BY timestamp, id`
      )
      .all(userId, personaId, cutoff, maximumImportance) as Array<{
      id: string;
    }>;
    return rows.map(row => row.id);
  }

  async deleteOldLowImportance(
    userId: string,
    personaId: string,
    cutoff: number,
    maximumImportance: number
  ): Promise<string[]> {
    const remove = this.database.transaction(() => {
      const rows = this.database
        .prepare(
          `SELECT id FROM persona_memories
            WHERE user_id = ? AND persona_id = ? AND timestamp < ?
              AND importance_score < ?`
        )
        .all(userId, personaId, cutoff, maximumImportance) as Array<{
        id: string;
      }>;
      if (rows.length) {
        this.database
          .prepare(
            `DELETE FROM persona_memories WHERE user_id = ? AND persona_id = ?
              AND id IN (${rows.map(() => '?').join(',')})`
          )
          .run(userId, personaId, ...rows.map(row => row.id));
      }
      return rows.map(row => row.id);
    });
    return remove();
  }

  async statistics(
    userId: string,
    personaId: string
  ): Promise<PersonaMemoryStatistics> {
    const types = this.database
      .prepare(
        `SELECT COALESCE(memory_type, 'general') AS memory_type, COUNT(*) AS count
           FROM persona_memories WHERE user_id = ? AND persona_id = ?
          GROUP BY COALESCE(memory_type, 'general')`
      )
      .all(userId, personaId) as Array<{ memory_type: string; count: number }>;
    const aggregate = this.database
      .prepare(
        `SELECT COUNT(*) AS total_count, AVG(importance_score) AS avg_importance,
                MIN(timestamp) AS oldest_memory, MAX(timestamp) AS newest_memory,
                SUM(COALESCE(access_count, 0)) AS total_accesses
           FROM persona_memories WHERE user_id = ? AND persona_id = ?`
      )
      .get(userId, personaId) as {
      total_count: number;
      avg_importance: number | null;
      oldest_memory: number | null;
      newest_memory: number | null;
      total_accesses: number | null;
    };
    return {
      totalCount: aggregate.total_count,
      byType: Object.fromEntries(
        types.map(row => [row.memory_type, row.count])
      ),
      averageImportance: aggregate.avg_importance ?? 0.5,
      oldestMemory: aggregate.oldest_memory,
      newestMemory: aggregate.newest_memory,
      totalAccesses: aggregate.total_accesses ?? 0,
    };
  }
}

interface SQLitePersonaRow {
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
  created_at: number;
  updated_at: number;
}

class SQLitePersonaRepository implements PersonaRepository {
  constructor(
    private readonly database: Database.Database,
    private readonly cipher: PlatformContentCipher
  ) {}

  private map(row: SQLitePersonaRow): Persona {
    const parse = <T>(value: string | null): T | undefined =>
      value
        ? (JSON.parse(decryptLegacyCompatible(this.cipher, value)) as T)
        : undefined;
    return {
      id: row.id,
      user_id: row.user_id,
      name: decryptLegacyCompatible(this.cipher, row.name),
      ...(row.description
        ? { description: decryptLegacyCompatible(this.cipher, row.description) }
        : {}),
      model: row.model,
      parameters: parse<Persona['parameters']>(row.parameters) || {},
      ...(row.avatar
        ? { avatar: decryptLegacyCompatible(this.cipher, row.avatar) }
        : {}),
      ...(row.background
        ? { background: decryptLegacyCompatible(this.cipher, row.background) }
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
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  async listByOwner(userId: string): Promise<Persona[]> {
    const rows = this.database
      .prepare(
        'SELECT * FROM personas WHERE user_id = ? ORDER BY updated_at DESC, id ASC'
      )
      .all(userId) as SQLitePersonaRow[];
    return rows.map(row => this.map(row));
  }

  async findByOwner(id: string, userId: string): Promise<Persona | undefined> {
    const row = this.database
      .prepare('SELECT * FROM personas WHERE id = ? AND user_id = ?')
      .get(id, userId) as SQLitePersonaRow | undefined;
    return row ? this.map(row) : undefined;
  }

  private values(persona: Persona): unknown[] {
    return [
      persona.id,
      persona.user_id,
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
      persona.created_at,
      persona.updated_at,
    ];
  }

  async insert(persona: Persona): Promise<void> {
    const insert = this.database.transaction(() => {
      assertResourceIdentifierAvailable(this.database, 'persona', persona.id);
      this.database
        .prepare(
          `INSERT INTO personas
             (id, user_id, name, description, model, parameters, avatar,
              background, embedding_model, memory_settings, mutation_settings,
              bindings, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(...this.values(persona));
    });
    insert.immediate();
  }

  async replace(persona: Persona): Promise<boolean> {
    const result = this.database
      .prepare(
        `UPDATE personas SET name = ?, description = ?, model = ?,
                parameters = ?, avatar = ?, background = ?, embedding_model = ?,
                memory_settings = ?, mutation_settings = ?, bindings = ?,
                updated_at = ?
          WHERE id = ? AND user_id = ?`
      )
      .run(
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
        persona.user_id
      );
    return result.changes === 1;
  }

  async patchByOwner(
    id: string,
    userId: string,
    patch: PersonaPatch
  ): Promise<Persona | undefined> {
    const update = this.database.transaction(() => {
      const assignments: string[] = [];
      const values: Array<string | number | null> = [];
      const assign = (column: string, value: string | number | null): void => {
        assignments.push(`${column} = ?`);
        values.push(value);
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
          patch.background === null
            ? null
            : this.cipher.encrypt(patch.background)
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

      const result = this.database
        .prepare(
          `UPDATE personas SET ${assignments.join(', ')}
            WHERE id = ? AND user_id = ?`
        )
        .run(...values, id, userId);
      if (result.changes !== 1) return undefined;
      const row = this.database
        .prepare('SELECT * FROM personas WHERE id = ? AND user_id = ?')
        .get(id, userId) as SQLitePersonaRow;
      return this.map(row);
    });
    return update.immediate();
  }

  async deleteByOwner(id: string, userId: string): Promise<boolean> {
    return (
      this.database
        .prepare('DELETE FROM personas WHERE id = ? AND user_id = ?')
        .run(id, userId).changes === 1
    );
  }

  async deleteAndEnqueue(
    id: string,
    userId: string,
    enqueuer: TransactionalResourceDeletionEnqueuer
  ): Promise<boolean> {
    const remove = this.database.transaction(() => {
      const existing = this.database
        .prepare('SELECT 1 FROM personas WHERE id = ? AND user_id = ?')
        .get(id, userId);
      if (!existing) return false;
      const deletion = recordResourceDeletion(this.database, {
        resourceType: 'persona',
        resourceId: id,
        ownerUserId: userId,
      });
      const deleted = this.database
        .prepare('DELETE FROM personas WHERE id = ? AND user_id = ?')
        .run(id, userId);
      if (deleted.changes !== 1) {
        throw new Error('Persona disappeared during deletion');
      }
      enqueuer.enqueueSQLite(createSQLiteSyncExecutor(this.database), deletion);
      return true;
    });
    return remove.immediate();
  }

  async countByOwner(userId: string): Promise<number> {
    const row = this.database
      .prepare('SELECT COUNT(*) AS count FROM personas WHERE user_id = ?')
      .get(userId) as { count: number };
    return row.count;
  }
}

interface SQLitePersonaStateRow {
  persona_id: string;
  user_id: string;
  runtime_state: string;
  mutation_log: string;
  last_updated: number;
  version: number;
}

class SQLitePersonaStateRepository implements PersonaStateRepository {
  constructor(
    private readonly database: Database.Database,
    private readonly cipher: PlatformContentCipher
  ) {}

  async findByOwner(
    personaId: string,
    userId: string
  ): Promise<PersonaState | undefined> {
    const row = this.database
      .prepare(
        'SELECT * FROM persona_states WHERE persona_id = ? AND user_id = ?'
      )
      .get(personaId, userId) as SQLitePersonaStateRow | undefined;
    if (!row) return undefined;
    return {
      persona_id: row.persona_id,
      user_id: row.user_id,
      runtime_state: JSON.parse(
        decryptLegacyCompatible(this.cipher, row.runtime_state)
      ) as Record<string, unknown>,
      mutation_log: JSON.parse(
        decryptLegacyCompatible(this.cipher, row.mutation_log)
      ) as PersonaState['mutation_log'],
      last_updated: row.last_updated,
      version: row.version,
    };
  }

  async upsert(state: PersonaState): Promise<void> {
    this.database
      .prepare(
        `INSERT INTO persona_states
           (persona_id, user_id, runtime_state, mutation_log, last_updated, version)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(persona_id) DO UPDATE SET
           runtime_state = excluded.runtime_state,
           mutation_log = excluded.mutation_log,
           last_updated = excluded.last_updated,
           version = excluded.version
         WHERE persona_states.user_id = excluded.user_id`
      )
      .run(
        state.persona_id,
        state.user_id,
        this.cipher.encrypt(JSON.stringify(state.runtime_state)),
        this.cipher.encrypt(JSON.stringify(state.mutation_log)),
        state.last_updated,
        state.version
      );
  }

  async deleteByOwner(personaId: string, userId: string): Promise<boolean> {
    return (
      this.database
        .prepare(
          'DELETE FROM persona_states WHERE persona_id = ? AND user_id = ?'
        )
        .run(personaId, userId).changes === 1
    );
  }
}

class SQLiteResourceDeletionLifecycleRepository implements ResourceDeletionLifecycleRepository {
  constructor(private readonly database: Database.Database) {}

  private cleanupAuthorizedSync(
    input: TransactionalResourceDeletionInput
  ): boolean {
    const table = resourceTable(input.resourceType);
    const row = this.database
      .prepare(
        `SELECT 1
           FROM platform_resource_deletion_tombstones tombstone
          WHERE tombstone.resource_type = ?
            AND tombstone.resource_id = ?
            AND tombstone.owner_user_id = ?
            AND tombstone.deletion_incarnation = ?
            AND tombstone.deletion_token = ?
            AND NOT EXISTS (
              SELECT 1 FROM ${table} resource
               WHERE resource.id = tombstone.resource_id
                 AND resource.user_id = tombstone.owner_user_id
            )`
      )
      .get(
        input.resourceType,
        input.resourceId,
        input.ownerUserId,
        input.deletionIncarnation,
        input.deletionToken
      );
    return Boolean(row);
  }

  async withAuthorizedCleanup<T>(
    input: TransactionalResourceDeletionInput,
    operation: () => Promise<T>
  ): Promise<{ authorized: false } | { authorized: true; value: T }> {
    // better-sqlite3 transactions cannot span an async external operation.
    // Safety instead comes from the permanent tombstone: every same-ID
    // creator, archive restore, and legacy adoption rejects it before write.
    if (!this.cleanupAuthorizedSync(input)) return { authorized: false };
    return { authorized: true, value: await operation() };
  }

  async isReserved(
    resourceType: TransactionalResourceDeletionInput['resourceType'],
    resourceId: string
  ): Promise<boolean> {
    return Boolean(
      this.database
        .prepare(
          `SELECT 1 FROM platform_resource_deletion_tombstones
            WHERE resource_type = ? AND resource_id = ?`
        )
        .get(resourceType, resourceId)
    );
  }

  async isCleanupAuthorized(
    input: TransactionalResourceDeletionInput
  ): Promise<boolean> {
    return this.cleanupAuthorizedSync(input);
  }

  async markCleanupCompleted(
    input: TransactionalResourceDeletionInput
  ): Promise<boolean> {
    const table = resourceTable(input.resourceType);
    const result = this.database
      .prepare(
        `UPDATE platform_resource_deletion_tombstones
            SET completed_at = COALESCE(completed_at, ?)
          WHERE resource_type = ? AND resource_id = ? AND owner_user_id = ?
            AND deletion_incarnation = ? AND deletion_token = ?
            AND NOT EXISTS (
              SELECT 1 FROM ${table} resource
               WHERE resource.id = platform_resource_deletion_tombstones.resource_id
                 AND resource.user_id = platform_resource_deletion_tombstones.owner_user_id
            )`
      )
      .run(
        Date.now(),
        input.resourceType,
        input.resourceId,
        input.ownerUserId,
        input.deletionIncarnation,
        input.deletionToken
      );
    return result.changes === 1;
  }
}

export const createSQLitePlatformDomainRepositories = (
  database: Database.Database,
  cipher: PlatformContentCipher
): PlatformDomainRepositories => ({
  documents: new SQLiteDocumentRepository(database, cipher),
  gallery: new SQLiteGalleryMetadataRepository(database, cipher),
  mediaJobs: new SQLiteMediaGenerationJobRepository(database, cipher),
  memories: new SQLitePersonaMemoryRepository(database, cipher),
  personas: new SQLitePersonaRepository(database, cipher),
  personaStates: new SQLitePersonaStateRepository(database, cipher),
  resourceDeletions: new SQLiteResourceDeletionLifecycleRepository(database),
});
