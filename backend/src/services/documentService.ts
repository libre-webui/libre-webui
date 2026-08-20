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

import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { v4 as uuidv4 } from 'uuid';
import { DocumentChunk, DocumentFileType } from '../types/index.js';
import { Document } from '../storage.js';
import storageService from '../storage.js';
import {
  type BlobByteRange,
  type BlobReadResult,
  configurePlatformStorageRuntime,
  getPlatformStorageRuntime,
  type PlatformStorageRuntime,
} from '../platform/storage/index.js';
import type {
  VectorHit,
  VectorResourceIndexProbe,
} from '../platform/storage/vectorStore.js';
import {
  MAX_VECTOR_RECORDS_PER_UPSERT,
  MAX_VECTOR_RESOURCE_INDEX_ENTRIES,
} from '../platform/storage/vectorStore.js';
import {
  aggregateDocumentIndexRevision,
  createDocumentIndexMetadata,
  DOCUMENT_CHUNKER_VERSION,
  DOCUMENT_INDEX_METADATA_KEY,
  DOCUMENT_VECTOR_NAMESPACE,
  DOCUMENT_VECTOR_VERSION,
  documentChunkSourceRevision as sourceRevision,
  documentEmbeddingDimensions as embeddingDimensions,
  documentIndexMatchesSpec,
  embeddedDocumentChunks as embeddedChunks,
  readDocumentIndexMetadata as readDocumentIndexMetadataValue,
  type DocumentEmbeddingIndexMetadata,
} from '../platform/storage/documentVectorIndex.js';
import { getCoordinator } from '../platform/coordination/service.js';
import type { CoordinationLease } from '../platform/coordination/types.js';
import { DOCUMENT_INGEST_IDEMPOTENCY_SCOPE } from '../platform/jobs/domainJobContracts.js';
import { transactionalDocumentIngestionEnqueuer } from '../platform/jobs/documentIngestionEnqueuer.js';
import { getDurableJobRuntime } from '../platform/jobs/durableJobRuntime.js';
import { transactionalResourceDeletionEnqueuer } from '../platform/jobs/resourceDeletionEnqueuer.js';
import preferencesService from './preferencesService.js';
import { createLogger } from '../utils/logger.js';
import { throwIfChatGenerationCancelled } from '../utils/chatCancellation.js';
import {
  reciprocalRankFusion,
  scoreCandidatesBm25,
} from '../utils/hybridRetrieval.js';
import {
  extractDocumentContentByType,
  readDocumentSegments,
  resolveDocumentFileType,
  resolveSegmentLabel,
  type DocumentSegment,
} from '../utils/documentExtraction.js';

const logger = createLogger('documents');

const DOCUMENT_BLOB_PURPOSE = 'document.source';
const DOCUMENT_POST_VECTOR_FAULT_MARKER = 'LIBRE_DOCUMENT_POST_VECTOR_KILL';
const DOCUMENT_RESOURCE_LEASE_WAIT_MS = 15_000;
const MAX_VECTOR_RESOURCE_FILTERS = 100;

export interface EmbeddingExecutionSpec {
  enabled: boolean;
  model: string;
  version: string;
  chunkerVersion: string;
  chunkSize: number;
  chunkOverlap: number;
  similarityThreshold: number;
}

export interface DocumentEmbeddingRegenerationResult {
  documentsTotal: number;
  documentsRegenerated: number;
  documentsSkipped: number;
  chunksTotal: number;
  chunksEmbedded: number;
  model: string;
  version: string;
}

interface MaintainedDocumentResourceLease {
  assertHeld(): Promise<void>;
  release(): Promise<boolean>;
}

export class DocumentResourceBusyError extends Error {
  constructor() {
    super('Document indexing is already in progress; retry shortly');
    this.name = 'DocumentResourceBusyError';
  }
}

export class DocumentChunkLimitError extends Error {
  constructor(readonly chunks: number) {
    super(
      `Document produces ${chunks} chunks; the maximum is ${MAX_VECTOR_RESOURCE_INDEX_ENTRIES}. Increase the embedding chunk size or remove excessive paragraph breaks.`
    );
    this.name = 'DocumentChunkLimitError';
  }
}

class DocumentIndexSupersededError extends Error {
  constructor() {
    super('Document disappeared while its vector index was being published');
    this.name = 'DocumentIndexSupersededError';
  }
}

const resourceLeaseTtlMs = (): number => {
  const value = Number.parseInt(
    process.env.RESOURCE_LEASE_TTL_MS ?? '30000',
    10
  );
  if (!Number.isSafeInteger(value) || value < 5_000 || value > 300_000) {
    throw new Error(
      'RESOURCE_LEASE_TTL_MS must be between 5000 and 300000 milliseconds'
    );
  }
  return value;
};

const waitForLeaseRetry = (
  milliseconds: number,
  signal?: AbortSignal
): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('Document indexing was cancelled'));
      return;
    }
    let timer: NodeJS.Timeout;
    const abort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('Document indexing was cancelled'));
    };
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, milliseconds);
    signal?.addEventListener('abort', abort, { once: true });
  });

const acquireDocumentResourceLease = async (
  userId: string,
  documentId: string,
  signal?: AbortSignal,
  waitMs = DOCUMENT_RESOURCE_LEASE_WAIT_MS
): Promise<MaintainedDocumentResourceLease> => {
  const coordinator = getCoordinator();
  const ttlMs = resourceLeaseTtlMs();
  const deadline = Date.now() + waitMs;
  let lease: CoordinationLease | null = null;
  do {
    if (signal?.aborted) throw signal.reason;
    lease = await coordinator.acquireLease(
      `resource:${userId}:document:${documentId}`,
      ttlMs
    );
    if (lease) break;
    if (Date.now() >= deadline) throw new DocumentResourceBusyError();
    await waitForLeaseRetry(25, signal);
  } while (!lease);

  let closed = false;
  let lost = false;
  let renewal: NodeJS.Timeout | undefined;
  const scheduleRenewal = (): void => {
    if (closed || lost) return;
    renewal = setTimeout(
      async () => {
        try {
          if (!(await lease!.extend(ttlMs))) lost = true;
        } catch {
          lost = true;
        }
        scheduleRenewal();
      },
      Math.max(1_000, Math.floor(ttlMs / 3))
    );
    renewal.unref?.();
  };
  scheduleRenewal();

  return {
    async assertHeld(): Promise<void> {
      if (signal?.aborted) throw signal.reason;
      if (closed || lost) throw new DocumentResourceBusyError();
      try {
        if (await lease!.extend(ttlMs)) return;
      } catch {
        // Report the same safe error for expiry and coordinator outages.
      }
      lost = true;
      throw new DocumentResourceBusyError();
    },
    async release(): Promise<boolean> {
      if (closed) return false;
      closed = true;
      if (renewal) clearTimeout(renewal);
      return lease!.release();
    },
  };
};

const deterministicDocumentChunkId = (
  documentId: string,
  chunkIndex: number,
  content: string
): string => {
  const digest = crypto
    .createHash('sha256')
    .update('libre-document-chunk-v1\u0000')
    .update(documentId)
    .update('\u0000')
    .update(String(chunkIndex))
    .update('\u0000')
    .update(content, 'utf8')
    .digest();
  // Preserve the familiar UUID shape while deriving the identity from source
  // state. Retries therefore overwrite the same SQL/vector record.
  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

const readDocumentIndexMetadata = (
  document: Document
): DocumentEmbeddingIndexMetadata | undefined =>
  readDocumentIndexMetadataValue(document.metadata);

const hasValidDocumentIndexMetadata = (document: Document): boolean =>
  readDocumentIndexMetadata(document) !== undefined;

const exactLocalDocumentIndexProbe = (
  document: Document,
  chunks: readonly DocumentChunk[],
  userId: string,
  spec: Readonly<EmbeddingExecutionSpec>
): VectorResourceIndexProbe | undefined => {
  const metadata = readDocumentIndexMetadata(document);
  if (
    !documentIndexMatchesSpec(metadata, spec) ||
    metadata.dimensions === null
  ) {
    return undefined;
  }
  const embedded = embeddedChunks(chunks);
  if (embedded.length === 0 || embedded.length !== chunks.length) {
    return undefined;
  }
  if (
    embeddingDimensions(embedded) !== metadata.dimensions ||
    aggregateDocumentIndexRevision(embedded, spec) !==
      metadata.aggregateRevision
  ) {
    return undefined;
  }
  return {
    actor: { userId },
    namespace: DOCUMENT_VECTOR_NAMESPACE,
    resourceId: document.id,
    model: spec.model,
    dimensions: metadata.dimensions,
    version: spec.version,
    entries: embedded.map(chunk => ({
      id: chunk.id,
      sourceRevision: sourceRevision(chunk),
    })),
  };
};

const withDocumentIndexMetadata = (
  document: Document,
  chunks: readonly DocumentChunk[],
  spec: EmbeddingExecutionSpec
): Document => {
  const metadata = createDocumentIndexMetadata(chunks, spec);
  return {
    ...document,
    metadata: {
      ...(document.metadata ?? {}),
      [DOCUMENT_INDEX_METADATA_KEY]: metadata,
    },
  };
};

const delayAfterVectorUpsertForRecoveryDrill = async (
  document: Document,
  attemptCount: number,
  signal?: AbortSignal
): Promise<void> => {
  if (
    process.env.LIBRE_ENABLE_TEST_FAULT_INJECTION !== 'true' ||
    attemptCount !== 1 ||
    !document.content?.includes(DOCUMENT_POST_VECTOR_FAULT_MARKER)
  ) {
    return;
  }
  const delayMs = Number.parseInt(
    process.env.LIBRE_TEST_FAULT_DELAY_MS ?? '60000',
    10
  );
  if (!Number.isSafeInteger(delayMs) || delayMs < 1 || delayMs > 300_000) {
    throw new Error('Invalid recovery-drill fault delay');
  }
  await new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('Document ingestion was cancelled'));
      return;
    }
    let settled = false;
    let timer: NodeJS.Timeout;
    const finish = (error?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error === undefined) resolve();
      else reject(error);
    };
    const abort = (): void =>
      finish(signal?.reason ?? new Error('Document ingestion was cancelled'));
    timer = setTimeout(finish, delayMs);
    timer.unref?.();
    signal?.addEventListener('abort', abort, { once: true });
  });
};

/** Installed by team-mode bootstrap so all replicas share S3 and PGVector. */
export const configureDocumentPlatformStorage = (
  storage: PlatformStorageRuntime | undefined
): void => {
  configurePlatformStorageRuntime(storage);
};

// Lazy load pdfjs-dist legacy build for Node.js
let pdfjsLib: typeof import('pdfjs-dist/legacy/build/pdf.mjs') | null = null;
const getPdfjsLib = async () => {
  if (!pdfjsLib) {
    try {
      // Use the legacy build for Node.js compatibility
      const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
      pdfjsLib = pdfjs;
      logger.debug('Successfully loaded pdfjs-dist legacy build');
    } catch (error) {
      logger.error('Failed to load pdfjs-dist legacy:', error);
      throw new Error('PDF parsing is not available');
    }
  }
  return pdfjsLib;
};

/**
 * Segment maps above this length would bloat the encrypted metadata column;
 * a source under the extraction size cap never legitimately reaches it.
 */
const MAX_DOCUMENT_SEGMENTS = 5000;

const extractDocumentContent = async (
  fileName: string,
  fileBuffer: Buffer,
  mimeType: string,
  signal?: AbortSignal
): Promise<{
  content: string;
  fileType: DocumentFileType;
  segments: DocumentSegment[];
}> => {
  if (signal?.aborted) throw signal.reason;
  const fileType = resolveDocumentFileType(fileName, mimeType);
  if (!fileType) {
    throw new Error(`Unsupported file type: ${mimeType}`);
  }
  const extracted = await extractDocumentContentByType(fileBuffer, fileType, {
    signal,
    ...(fileType === 'pdf' ? { pdfLib: await getPdfjsLib() } : {}),
  });
  return {
    content: extracted.content,
    fileType,
    segments: extracted.segments.slice(0, MAX_DOCUMENT_SEGMENTS),
  };
};

const documentContentSha256 = (fileBuffer: Buffer): string =>
  crypto.createHash('sha256').update(fileBuffer).digest('hex');

export class DocumentService {
  private async captureEmbeddingExecutionSpec(
    userId: string
  ): Promise<Readonly<EmbeddingExecutionSpec>> {
    const settings = (await preferencesService.getPreferences(userId))
      .embeddingSettings;
    const model = settings.model.trim();
    if (!model || Buffer.byteLength(model, 'utf8') > 256) {
      throw new Error('Embedding model must contain 1-256 bytes');
    }
    if (
      !Number.isSafeInteger(settings.chunkSize) ||
      settings.chunkSize < 1 ||
      settings.chunkSize > 1_000_000
    ) {
      throw new Error('Embedding chunk size must be between 1 and 1000000');
    }
    if (
      !Number.isSafeInteger(settings.chunkOverlap) ||
      settings.chunkOverlap < 0 ||
      settings.chunkOverlap >= settings.chunkSize
    ) {
      throw new Error(
        'Embedding chunk overlap must be non-negative and smaller than the chunk size'
      );
    }
    if (
      !Number.isFinite(settings.similarityThreshold) ||
      settings.similarityThreshold < -1 ||
      settings.similarityThreshold > 1
    ) {
      throw new Error(
        'Embedding similarity threshold must be between -1 and 1'
      );
    }
    return Object.freeze({
      enabled: settings.enabled === true,
      model,
      version: DOCUMENT_VECTOR_VERSION,
      chunkerVersion: DOCUMENT_CHUNKER_VERSION,
      chunkSize: settings.chunkSize,
      chunkOverlap: settings.chunkOverlap,
      similarityThreshold: settings.similarityThreshold,
    });
  }

  private async assertDocumentIndexAuthoritative(
    documentId: string,
    userId: string,
    aggregateRevision?: string,
    expectedSource?: {
      content: string | null;
      fileType: DocumentFileType | null;
    }
  ): Promise<Document> {
    const platform = getPlatformStorageRuntime();
    const [document, reserved] = await Promise.all([
      platform.domains.documents.findByOwner(documentId, userId),
      platform.domains.resourceDeletions.isReserved('document', documentId),
    ]);
    if (!document || reserved) throw new DocumentIndexSupersededError();
    if (aggregateRevision) {
      const metadata = readDocumentIndexMetadata(document);
      if (metadata?.aggregateRevision !== aggregateRevision) {
        throw new DocumentIndexSupersededError();
      }
    }
    if (
      expectedSource &&
      ((document.content ?? null) !== expectedSource.content ||
        (document.fileType ?? null) !== expectedSource.fileType)
    ) {
      throw new DocumentIndexSupersededError();
    }
    return document;
  }

  /**
   * Persist the private source and publish extraction in the same SQL
   * transaction as the document placeholder. The object write is compensated
   * if the SQL transaction cannot commit.
   */
  async queueDocumentProcessing(
    fileName: string,
    fileBuffer: Buffer,
    mimeType: string,
    userId: string,
    sessionId?: string,
    signal?: AbortSignal
  ): Promise<{ document: Document; jobId: string; deduplicated?: boolean }> {
    const resolvedType = resolveDocumentFileType(fileName, mimeType);
    if (!resolvedType) {
      throw new Error(`Unsupported file type: ${mimeType}`);
    }
    if (signal?.aborted) throw signal.reason;
    const contentSha256 = documentContentSha256(fileBuffer);
    const duplicate = await this.findDuplicateDocument(
      userId,
      sessionId,
      contentSha256
    );
    if (duplicate) {
      const existingJob = await getDurableJobRuntime().service.getByIdempotency(
        userId,
        DOCUMENT_INGEST_IDEMPOTENCY_SCOPE,
        duplicate.id
      );
      if (existingJob) {
        return {
          document: duplicate,
          jobId: existingJob.id,
          deduplicated: true,
        };
      }
    }
    const documentId = uuidv4();
    const now = Date.now();
    const document: Document = {
      id: documentId,
      filename: fileName,
      content: '',
      fileType: resolvedType,
      size: fileBuffer.length,
      ...(sessionId ? { sessionId } : {}),
      uploadedAt: now,
      createdAt: now,
      metadata: { processingStatus: 'queued', contentSha256 },
    };
    const platform = getPlatformStorageRuntime();
    const sourceBlob = await platform.blobStore.put({
      ownerUserId: userId,
      purpose: DOCUMENT_BLOB_PURPOSE,
      contentType: mimeType,
      originalFilename: fileName,
      expectedSize: fileBuffer.length,
      metadata: { resourceType: 'document', resourceId: documentId },
      source: Readable.from(fileBuffer),
      ...(signal ? { signal } : {}),
    });
    try {
      await platform.domains.documents.upsertWithBlobAndEnqueue(
        document,
        userId,
        {
          blobId: sourceBlob.id,
          ownerUserId: userId,
          resourceType: 'document',
          resourceId: documentId,
          purpose: DOCUMENT_BLOB_PURPOSE,
          createdAt: Date.parse(sourceBlob.createdAt) || now,
        },
        transactionalDocumentIngestionEnqueuer
      );
    } catch (error) {
      // A PostgreSQL COMMIT can succeed even when its acknowledgement is
      // lost. Resolve that unknown outcome from authoritative state before
      // compensating the already-durable blob; deleting first would leave a
      // committed document/reference/job pointing at a missing object.
      try {
        const [publishedDocument, publishedReference, publishedJob] =
          await Promise.all([
            platform.domains.documents.findByOwner(documentId, userId),
            platform.blobReferences.find(
              'document',
              documentId,
              DOCUMENT_BLOB_PURPOSE
            ),
            getDurableJobRuntime().service.getByIdempotency(
              userId,
              DOCUMENT_INGEST_IDEMPOTENCY_SCOPE,
              documentId
            ),
          ]);
        const committed =
          publishedDocument !== undefined &&
          publishedReference?.blobId === sourceBlob.id &&
          publishedReference.ownerUserId === userId &&
          publishedJob != null;
        if (committed && publishedJob) {
          return { document, jobId: publishedJob.id };
        }
        const safelyAbsent =
          publishedDocument === undefined &&
          publishedReference === undefined &&
          publishedJob == null;
        if (!safelyAbsent) {
          throw new Error(
            'Document ingestion publish outcome is inconsistent; the source blob was retained for recovery'
          );
        }
      } catch (resolutionError) {
        logger.error(
          'Document ingestion publish failed and its outcome could not be resolved',
          error,
          resolutionError
        );
        throw new Error(
          'Could not resolve the document ingestion transaction outcome; the source blob was retained for recovery'
        );
      }
      await platform.blobStore
        .delete({ id: sourceBlob.id, ownerUserId: userId })
        .catch(cleanupError => {
          logger.warn(
            'Document source cleanup failed after a rolled-back publish; lifecycle reconciliation will retry it',
            cleanupError
          );
        });
      throw error;
    }
    const job = await getDurableJobRuntime().service.getByIdempotency(
      userId,
      DOCUMENT_INGEST_IDEMPOTENCY_SCOPE,
      documentId
    );
    if (!job) {
      throw new Error('Document ingestion transaction did not publish its job');
    }
    return { document, jobId: job.id };
  }

  async processDocument(
    fileName: string,
    fileBuffer: Buffer,
    mimeType: string,
    userId: string,
    sessionId?: string
  ): Promise<Document> {
    const documentId = uuidv4();
    try {
      const { content, fileType, segments } = await extractDocumentContent(
        fileName,
        fileBuffer,
        mimeType
      );

      let document: Document = {
        id: documentId,
        filename: fileName,
        content,
        fileType,
        size: fileBuffer.length,
        sessionId,
        uploadedAt: Date.now(),
        metadata: {
          contentSha256: documentContentSha256(fileBuffer),
          ...(segments.length > 0 ? { segments } : {}),
        },
      };

      const spec = await this.captureEmbeddingExecutionSpec(userId);

      // Process the document into chunks under one immutable execution spec.
      const chunks = this.chunkDocument(document, spec);

      // Generate embeddings for chunks if enabled
      const chunksWithEmbeddings = await this.generateEmbeddingsForChunks(
        chunks,
        userId,
        spec
      );
      document = withDocumentIndexMetadata(
        document,
        chunksWithEmbeddings,
        spec
      );

      const platform = getPlatformStorageRuntime();
      const sourceBlob = await platform.blobStore.put({
        ownerUserId: userId,
        purpose: DOCUMENT_BLOB_PURPOSE,
        contentType: mimeType,
        originalFilename: fileName,
        expectedSize: fileBuffer.length,
        metadata: { resourceType: 'document', resourceId: documentId },
        source: Readable.from(fileBuffer),
      });

      try {
        await storageService.saveDocument(document, userId);
        await storageService.saveDocumentChunks(
          documentId,
          chunksWithEmbeddings
        );
        await platform.blobReferences.attach({
          blobId: sourceBlob.id,
          ownerUserId: userId,
          resourceType: 'document',
          resourceId: documentId,
          purpose: DOCUMENT_BLOB_PURPOSE,
          createdAt: Date.now(),
        });
        await this.indexDocumentChunks(
          document,
          chunksWithEmbeddings,
          userId,
          spec
        );
      } catch (error) {
        await platform.vectorStore
          .delete({
            actor: { userId },
            namespace: DOCUMENT_VECTOR_NAMESPACE,
            resourceId: documentId,
          })
          .catch(() => undefined);
        await platform.blobReferences
          .detach('document', documentId, DOCUMENT_BLOB_PURPOSE)
          .catch(() => undefined);
        await platform.blobStore
          .delete({ id: sourceBlob.id, ownerUserId: userId })
          .catch(() => undefined);
        await storageService.deleteDocumentChunks(documentId);
        await storageService.deleteDocument(documentId, userId);
        throw error;
      }

      logger.debug(
        `Processed ${fileType.toUpperCase()} document: ${fileName} (${chunksWithEmbeddings.length} chunks)`
      );
      return document;
    } catch (error) {
      logger.error('Error processing document:', error);
      throw new Error(
        `Failed to process document: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  private chunkDocument(
    document: Document,
    spec: Readonly<EmbeddingExecutionSpec>
  ): DocumentChunk[] {
    const chunks: DocumentChunk[] = [];
    const appendChunk = (chunk: DocumentChunk): void => {
      if (chunks.length >= MAX_VECTOR_RESOURCE_INDEX_ENTRIES) {
        throw new DocumentChunkLimitError(chunks.length + 1);
      }
      chunks.push(chunk);
    };
    const chunkSize = spec.chunkSize;
    const overlap = spec.chunkOverlap;

    const text = document.content?.trim();
    if (!text) return chunks;

    // Helper function to calculate overlap word count based on character overlap
    const calculateOverlapWordCount = (
      overlapChars: number,
      averageWordLength: number = 5
    ): number => {
      return Math.floor(overlapChars / averageWordLength);
    };

    // Split by paragraphs first, then by sentences if needed
    const paragraphs = text.split(/\n\s*\n/).filter((p: string) => p.trim());

    let currentChunk = '';
    let chunkIndex = 0;
    let currentOffset = 0; // Track character position in original text

    for (const paragraph of paragraphs) {
      const paragraphText = paragraph.trim();

      // If adding this paragraph would exceed chunk size, save current chunk
      if (
        currentChunk &&
        currentChunk.length + paragraphText.length > chunkSize
      ) {
        if (currentChunk.trim()) {
          const chunkStart = currentOffset - currentChunk.length;
          const chunkEnd = currentOffset;

          const content = currentChunk.trim();
          appendChunk({
            id: deterministicDocumentChunkId(document.id, chunkIndex, content),
            documentId: document.id,
            content,
            chunkIndex: chunkIndex++,
            startChar: Math.max(0, chunkStart),
            endChar: chunkEnd,
          });
        }

        // Start new chunk with overlap from previous chunk
        const words = currentChunk.split(' ');
        const overlapWordCount = calculateOverlapWordCount(overlap);
        const overlapWords =
          overlapWordCount === 0 ? [] : words.slice(-overlapWordCount);
        currentChunk =
          overlapWords.length === 0
            ? paragraphText
            : `${overlapWords.join(' ')}\n\n${paragraphText}`;
        currentOffset += paragraphText.length + 2; // +2 for \n\n
      } else {
        // Add paragraph to current chunk
        if (currentChunk) {
          currentChunk += '\n\n' + paragraphText;
          currentOffset += paragraphText.length + 2; // +2 for \n\n
        } else {
          currentChunk = paragraphText;
          currentOffset += paragraphText.length;
        }
      }
    }

    // Add the final chunk
    if (currentChunk.trim()) {
      const chunkStart = currentOffset - currentChunk.length;
      const chunkEnd = currentOffset;

      const content = currentChunk.trim();
      appendChunk({
        id: deterministicDocumentChunkId(document.id, chunkIndex, content),
        documentId: document.id,
        content,
        chunkIndex: chunkIndex,
        startChar: Math.max(0, chunkStart),
        endChar: chunkEnd,
      });
    }

    return chunks;
  }

  private async generateEmbeddingForText(
    text: string,
    userId: string,
    spec: Readonly<EmbeddingExecutionSpec>,
    signal?: AbortSignal
  ): Promise<number[] | null> {
    try {
      if (!spec.enabled) return null;

      // Provider/plugin construction is stateful and must happen only after
      // the selected persistence backend has completed bootstrap.
      const { default: embeddingService } =
        await import('./embeddingService.js');
      const response = await embeddingService.generateEmbeddings(
        {
          model: spec.model,
          input: text,
        },
        userId,
        signal
      );

      return response.embeddings[0] || null;
    } catch (error) {
      if (signal?.aborted) throw error;
      logger.error('Failed to generate embedding:', error);
      return null;
    }
  }

  private async generateEmbeddingsForChunks(
    chunks: DocumentChunk[],
    userId: string,
    spec: Readonly<EmbeddingExecutionSpec>,
    signal?: AbortSignal,
    assertSideEffectAllowed?: () => Promise<void>
  ): Promise<DocumentChunk[]> {
    if (!spec.enabled) return chunks;

    logger.debug(`Generating embeddings for ${chunks.length} chunks...`);
    const chunksWithEmbeddings: DocumentChunk[] = [];

    for (const chunk of chunks) {
      await assertSideEffectAllowed?.();
      const embedding = await this.generateEmbeddingForText(
        chunk.content,
        userId,
        spec,
        signal
      );
      if (!embedding) {
        throw new Error('Embedding generation returned no vector');
      }
      chunksWithEmbeddings.push({
        ...chunk,
        embedding,
      });
    }

    embeddingDimensions(embeddedChunks(chunksWithEmbeddings));

    logger.debug(
      `Generated embeddings for ${chunksWithEmbeddings.filter(c => c.embedding).length} chunks`
    );
    return chunksWithEmbeddings;
  }

  /**
   * Older solo databases stored inline vectors without recording which model
   * produced them. Presence is therefore only an upgrade signal: rebuild the
   * authoritative document from text under today's immutable execution spec,
   * and never copy or relabel the legacy payload.
   */
  private async upgradeLegacyDocumentIndex(
    document: Document,
    userId: string,
    spec: Readonly<EmbeddingExecutionSpec>,
    signal?: AbortSignal
  ): Promise<{ document: Document; chunks: DocumentChunk[] } | undefined> {
    const platform = getPlatformStorageRuntime();
    if (
      platform.dialect !== 'sqlite' ||
      hasValidDocumentIndexMetadata(document) ||
      !document.content?.trim()
    ) {
      return undefined;
    }
    const legacy =
      await platform.domains.documents.inspectLegacyChunkEmbeddings(
        document.id,
        userId
      );
    if (!legacy.present) return undefined;

    let lease: MaintainedDocumentResourceLease | undefined;
    try {
      lease = await acquireDocumentResourceLease(
        userId,
        document.id,
        signal,
        0
      );
      await lease.assertHeld();
      const current = await this.assertDocumentIndexAuthoritative(
        document.id,
        userId
      );
      if (hasValidDocumentIndexMetadata(current)) {
        return {
          document: current,
          chunks: await this.loadDocumentChunks(current.id),
        };
      }
      if (!current.content?.trim()) return undefined;
      const currentLegacy =
        await platform.domains.documents.inspectLegacyChunkEmbeddings(
          current.id,
          userId
        );
      if (!currentLegacy.present) return undefined;
      if (!currentLegacy.authenticated) {
        logger.warn(
          `Legacy inline embeddings for document ${current.id} failed authentication; rebuilding from authoritative text`
        );
      }

      const chunks = this.chunkDocument(current, spec);
      if (chunks.length === 0) {
        logger.debug(
          `Legacy document ${current.id} has no authoritative text to reindex`
        );
        return undefined;
      }
      const embedded = await this.generateEmbeddingsForChunks(
        chunks,
        userId,
        spec,
        signal,
        () => lease!.assertHeld()
      );
      await lease.assertHeld();
      const latest = await this.assertDocumentIndexAuthoritative(
        current.id,
        userId,
        undefined,
        {
          content: current.content ?? null,
          fileType: current.fileType ?? null,
        }
      );
      if (hasValidDocumentIndexMetadata(latest)) {
        throw new DocumentIndexSupersededError();
      }
      const published = withDocumentIndexMetadata(latest, embedded, spec);
      const embeddingIndex = readDocumentIndexMetadata(published);
      if (!embeddingIndex) {
        throw new Error('Document embedding index metadata is invalid');
      }
      const completed = await platform.domains.documents.publishEmbeddingIndex(
        current.id,
        userId,
        {
          content: current.content ?? null,
          fileType: current.fileType ?? null,
        },
        embeddingIndex,
        embedded
      );
      if (!completed) throw new DocumentIndexSupersededError();

      await lease.assertHeld();
      const authoritative = await this.assertDocumentIndexAuthoritative(
        current.id,
        userId,
        embeddingIndex.aggregateRevision,
        {
          content: current.content ?? null,
          fileType: current.fileType ?? null,
        }
      );
      await this.indexDocumentChunks(
        authoritative,
        embedded,
        userId,
        spec,
        1,
        signal,
        () => lease!.assertHeld()
      );
      return { document: authoritative, chunks: embedded };
    } catch (error) {
      if (signal?.aborted) throw error;
      if (
        !(error instanceof DocumentResourceBusyError) &&
        !(error instanceof DocumentIndexSupersededError)
      ) {
        logger.warn(
          `Could not upgrade legacy document embeddings for ${document.id}; keyword fallback remains available`,
          error
        );
      }
      return undefined;
    } finally {
      await lease?.release().catch(() => false);
    }
  }

  /**
   * Rebuild every document under one immutable preference snapshot. Each
   * resource uses the same renewable coordinator lease as ingestion/deletion,
   * while the relational delete is still allowed to publish its tombstone.
   * The final authoritative check then removes any vector recreated after that
   * tombstone committed.
   */
  async regenerateAllEmbeddings(
    userId: string,
    signal?: AbortSignal
  ): Promise<DocumentEmbeddingRegenerationResult> {
    const spec = await this.captureEmbeddingExecutionSpec(userId);
    const documents = await storageService.getAllDocuments(userId);
    const result: DocumentEmbeddingRegenerationResult = {
      documentsTotal: documents.length,
      documentsRegenerated: 0,
      documentsSkipped: 0,
      chunksTotal: 0,
      chunksEmbedded: 0,
      model: spec.model,
      version: spec.version,
    };
    if (!spec.enabled) {
      result.documentsSkipped = documents.length;
      logger.debug('Embeddings are disabled, skipping regeneration');
      return result;
    }

    logger.debug('Starting to regenerate embeddings for all documents...');
    for (const listedDocument of documents) {
      if (signal?.aborted) throw signal.reason;
      let lease: MaintainedDocumentResourceLease;
      try {
        lease = await acquireDocumentResourceLease(
          userId,
          listedDocument.id,
          signal
        );
      } catch (error) {
        if (error instanceof DocumentResourceBusyError) {
          result.documentsSkipped += 1;
          continue;
        }
        throw error;
      }

      try {
        await lease.assertHeld();
        const current = await this.assertDocumentIndexAuthoritative(
          listedDocument.id,
          userId
        );
        const chunks = this.chunkDocument(current, spec);
        result.chunksTotal += chunks.length;
        const embedded = await this.generateEmbeddingsForChunks(
          chunks,
          userId,
          spec,
          signal,
          () => lease.assertHeld()
        );

        await lease.assertHeld();
        const latest = await this.assertDocumentIndexAuthoritative(
          current.id,
          userId
        );
        if (
          latest.content !== current.content ||
          latest.fileType !== current.fileType
        ) {
          throw new DocumentIndexSupersededError();
        }
        // Preserve routing/metadata changes published while embedding work was
        // in flight. The repository merges only embeddingIndex and chunks
        // under its row/write lock, so an acknowledged collection/session
        // change can never be replaced by this stale service snapshot.
        const published = withDocumentIndexMetadata(latest, embedded, spec);
        const embeddingIndex = readDocumentIndexMetadata(published);
        if (!embeddingIndex) {
          throw new Error('Document embedding index metadata is invalid');
        }
        const completed =
          await getPlatformStorageRuntime().domains.documents.publishEmbeddingIndex(
            current.id,
            userId,
            {
              content: current.content ?? null,
              fileType: current.fileType ?? null,
            },
            embeddingIndex,
            embedded
          );
        if (!completed) throw new DocumentIndexSupersededError();

        await lease.assertHeld();
        const authoritativePublished =
          await this.assertDocumentIndexAuthoritative(
            current.id,
            userId,
            embeddingIndex.aggregateRevision,
            {
              content: current.content ?? null,
              fileType: current.fileType ?? null,
            }
          );
        await this.indexDocumentChunks(
          authoritativePublished,
          embedded,
          userId,
          spec,
          1,
          signal,
          () => lease.assertHeld()
        );
        result.documentsRegenerated += 1;
        result.chunksEmbedded += embedded.length;
      } catch (error) {
        if (error instanceof DocumentIndexSupersededError) {
          result.documentsSkipped += 1;
          continue;
        }
        throw error;
      } finally {
        await lease.release().catch(() => false);
      }
    }

    logger.debug(
      `Regenerated embeddings for ${result.chunksEmbedded}/${result.chunksTotal} chunks`
    );
    return result;
  }

  /** Durable extraction/embedding handler entrypoint for an existing source. */
  async reprocessDocument(
    documentId: string,
    userId: string,
    signal?: AbortSignal,
    assertSideEffectAllowed?: () => Promise<void>,
    attemptCount = 1
  ): Promise<{ chunks: number; embedded: number }> {
    const spec = await this.captureEmbeddingExecutionSpec(userId);
    const current = await this.getDocument(documentId, userId);
    if (!current) throw new Error('Document not found');
    const source = await this.openDocumentSource(
      documentId,
      userId,
      undefined,
      signal
    );
    if (!source) throw new Error('Document source is unavailable');
    const buffers: Buffer[] = [];
    let size = 0;
    for await (const chunk of source.body) {
      if (signal?.aborted) throw signal.reason;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > 10 * 1024 * 1024) {
        throw new Error('Document source exceeds the extraction limit');
      }
      buffers.push(buffer);
    }
    const sourceBuffer = Buffer.concat(buffers, size);
    const extracted = await extractDocumentContent(
      source.descriptor.originalFilename ?? current.filename,
      sourceBuffer,
      source.descriptor.contentType,
      signal
    );
    let document: Document = {
      ...current,
      content: extracted.content,
      fileType: extracted.fileType,
      size,
    };
    const chunks = this.chunkDocument(document, spec);
    const embedded = await this.generateEmbeddingsForChunks(
      chunks,
      userId,
      spec,
      signal,
      assertSideEffectAllowed
    );
    document.metadata = {
      ...(document.metadata ?? {}),
      processingStatus: 'completed',
      processedAt: Date.now(),
      contentSha256: documentContentSha256(sourceBuffer),
      ...(extracted.segments.length > 0
        ? { segments: extracted.segments }
        : {}),
    };
    document = withDocumentIndexMetadata(document, embedded, spec);
    await assertSideEffectAllowed?.();
    const completed =
      await getPlatformStorageRuntime().domains.documents.completeIngestion(
        document,
        userId,
        embedded
      );
    if (!completed) throw new Error('Document was deleted during ingestion');
    await assertSideEffectAllowed?.();
    await this.indexDocumentChunks(
      document,
      embedded,
      userId,
      spec,
      attemptCount,
      signal,
      assertSideEffectAllowed
    );
    return {
      chunks: embedded.length,
      embedded: embedded.filter(chunk => chunk.embedding?.length).length,
    };
  }

  // Method to get embedding model information
  async getEmbeddingModelInfo(userId: string): Promise<{
    available: boolean;
    model: string;
    chunksWithEmbeddings: number;
    totalChunks: number;
  }> {
    const spec = await this.captureEmbeddingExecutionSpec(userId);
    let chunksWithEmbeddings = 0;
    let totalChunks = 0;

    for (const document of await storageService.getAllDocuments(userId)) {
      const chunks = await this.loadDocumentChunks(document.id);
      totalChunks += chunks.length;
      chunksWithEmbeddings += chunks.filter(c => c.embedding).length;
    }

    return {
      available: spec.enabled,
      model: spec.model,
      chunksWithEmbeddings,
      totalChunks,
    };
  }

  async getDocument(
    documentId: string,
    userId: string
  ): Promise<Document | undefined> {
    return storageService.getDocument(documentId, userId);
  }

  /**
   * Finds an existing live document with identical source bytes in the same
   * scope (the same session, or both standing). Upload deduplication only —
   * a match in another scope is not a duplicate because deleting one scope's
   * copy must never remove another's.
   */
  private async findDuplicateDocument(
    userId: string,
    sessionId: string | undefined,
    contentSha256: string
  ): Promise<Document | undefined> {
    const scope = sessionId ?? null;
    const platform = getPlatformStorageRuntime();
    const documents = await storageService.getAllDocuments(userId);
    for (const candidate of documents) {
      if ((candidate.sessionId ?? null) !== scope) continue;
      if (candidate.metadata?.contentSha256 !== contentSha256) continue;
      const reserved = await platform.domains.resourceDeletions.isReserved(
        'document',
        candidate.id
      );
      if (!reserved) return candidate;
    }
    return undefined;
  }

  /** Documents in a chat's searchable scope: session uploads, selected collections, and standing uploads. */
  async getDocumentsInScope(
    userId: string,
    sessionId?: string,
    collectionIds?: string[]
  ): Promise<Document[]> {
    return (await storageService.getAllDocuments(userId)).filter(document =>
      this.documentInScope(document, sessionId, collectionIds)
    );
  }

  async getDocuments(userId: string, sessionId?: string): Promise<Document[]> {
    const allDocs = await storageService.getAllDocuments(userId);
    if (sessionId) {
      return allDocs.filter(doc => doc.sessionId === sessionId);
    }
    return allDocs.sort((a, b) => b.uploadedAt - a.uploadedAt);
  }

  async getDocumentChunks(
    documentId: string,
    userId: string
  ): Promise<DocumentChunk[]> {
    if (!(await this.getDocument(documentId, userId))) return [];
    return this.loadDocumentChunks(documentId);
  }

  async openDocumentSource(
    documentId: string,
    userId: string,
    range?: BlobByteRange,
    signal?: AbortSignal
  ): Promise<BlobReadResult | undefined> {
    if (!(await this.getDocument(documentId, userId))) return undefined;
    const platform = getPlatformStorageRuntime();
    const reference = await platform.blobReferences.find(
      'document',
      documentId,
      DOCUMENT_BLOB_PURPOSE
    );
    if (!reference || reference.ownerUserId !== userId) return undefined;
    return platform.blobStore.open({
      id: reference.blobId,
      ownerUserId: userId,
      ...(range ? { range } : {}),
      ...(signal ? { signal } : {}),
    });
  }

  async deleteDocument(documentId: string, userId: string): Promise<boolean> {
    if (!(await this.getDocument(documentId, userId))) return false;
    const platform = getPlatformStorageRuntime();
    const relationalDeleted = await platform.domains.documents.deleteAndEnqueue(
      documentId,
      userId,
      transactionalResourceDeletionEnqueuer
    );
    if (!relationalDeleted) return false;
    return true;
  }

  /**
   * A document is searchable for a chat when it belongs to that session or
   * to one of the knowledge collections attached to it. With no scope at
   * all, every document is searchable.
   */
  private documentInScope(
    document: Document,
    sessionId?: string,
    collectionIds?: string[]
  ): boolean {
    const hasCollections = Boolean(collectionIds && collectionIds.length > 0);
    if (!sessionId && !hasCollections) return true;
    // User-scoped uploads (no session, no collection) are part of the
    // user's standing knowledge and join every chat's searchable scope —
    // previously they were unreachable from any session.
    if (!document.sessionId && !document.collectionId) return true;
    if (sessionId && document.sessionId === sessionId) return true;
    return Boolean(
      hasCollections &&
      document.collectionId &&
      collectionIds!.includes(document.collectionId)
    );
  }

  private async indexDocumentChunks(
    document: Document,
    chunks: readonly DocumentChunk[],
    userId: string,
    spec?: Readonly<EmbeddingExecutionSpec>,
    attemptCount = 1,
    signal?: AbortSignal,
    assertSideEffectAllowed?: () => Promise<void>
  ): Promise<void> {
    const executionSpec =
      spec ?? (await this.captureEmbeddingExecutionSpec(userId));
    const embedded = embeddedChunks(chunks);
    embeddingDimensions(embedded);
    const platform = getPlatformStorageRuntime();
    const revisions = embedded.map(sourceRevision);
    const aggregateRevision = aggregateDocumentIndexRevision(
      embedded,
      executionSpec
    );
    const publishedMetadata = readDocumentIndexMetadata(document);
    if (
      publishedMetadata &&
      publishedMetadata.aggregateRevision !== aggregateRevision
    ) {
      throw new Error('Document index metadata does not match its embeddings');
    }
    const expectedRevision = publishedMetadata?.aggregateRevision;
    const expectedSource = {
      content: document.content ?? null,
      fileType: document.fileType ?? null,
    };
    await assertSideEffectAllowed?.();
    await this.assertDocumentIndexAuthoritative(
      document.id,
      userId,
      expectedRevision,
      expectedSource
    );

    let mutated = false;
    try {
      // Replace the resource index rather than only upserting the latest IDs.
      // Deterministic chunk IDs make a crash after upsert retry-safe, while this
      // deletion removes records from older document revisions.
      await platform.vectorStore.delete({
        actor: { userId },
        namespace: DOCUMENT_VECTOR_NAMESPACE,
        resourceId: document.id,
      });
      mutated = true;
      await assertSideEffectAllowed?.();
      await this.assertDocumentIndexAuthoritative(
        document.id,
        userId,
        expectedRevision,
        expectedSource
      );
      for (
        let offset = 0;
        offset < embedded.length;
        offset += MAX_VECTOR_RECORDS_PER_UPSERT
      ) {
        await assertSideEffectAllowed?.();
        await this.assertDocumentIndexAuthoritative(
          document.id,
          userId,
          expectedRevision,
          expectedSource
        );
        const batch = embedded.slice(
          offset,
          offset + MAX_VECTOR_RECORDS_PER_UPSERT
        );
        await platform.vectorStore.upsert({
          actor: { userId },
          records: batch.map((chunk, index) => ({
            namespace: DOCUMENT_VECTOR_NAMESPACE,
            id: chunk.id,
            ownerUserId: userId,
            resourceId: document.id,
            model: executionSpec.model,
            dimensions: chunk.embedding.length,
            version: executionSpec.version,
            sourceRevision: revisions[offset + index],
            embedding: chunk.embedding,
            attributes: {
              chunkIndex: String(chunk.chunkIndex),
              ...(document.sessionId ? { sessionId: document.sessionId } : {}),
              ...(document.collectionId
                ? { collectionId: document.collectionId }
                : {}),
            },
          })),
        });
        await assertSideEffectAllowed?.();
        await this.assertDocumentIndexAuthoritative(
          document.id,
          userId,
          expectedRevision,
          expectedSource
        );
      }
      await delayAfterVectorUpsertForRecoveryDrill(
        document,
        attemptCount,
        signal
      );
      await assertSideEffectAllowed?.();
      await this.assertDocumentIndexAuthoritative(
        document.id,
        userId,
        expectedRevision,
        expectedSource
      );
    } catch (error) {
      if (mutated) {
        await platform.vectorStore
          .delete({
            actor: { userId },
            namespace: DOCUMENT_VECTOR_NAMESPACE,
            resourceId: document.id,
          })
          .catch(cleanupError => {
            logger.error(
              'Failed to compensate a superseded document vector publication',
              cleanupError
            );
            return 0;
          });
      }
      throw error;
    }
  }

  // Enhanced search with semantic similarity using embeddings
  async searchDocuments(
    query: string,
    userId: string,
    sessionId?: string,
    limit = 5,
    collectionIds?: string[],
    signal?: AbortSignal
  ): Promise<DocumentChunk[]> {
    const spec = await this.captureEmbeddingExecutionSpec(userId);

    // Use semantic search if embeddings are enabled
    if (spec.enabled) {
      return this.semanticSearchDocuments(
        query,
        userId,
        sessionId,
        limit,
        collectionIds,
        spec,
        signal
      );
    }

    // Fall back to keyword search
    return this.keywordSearchDocuments(
      query,
      userId,
      sessionId,
      limit,
      collectionIds,
      signal
    );
  }

  private async semanticSearchDocuments(
    query: string,
    userId: string,
    sessionId?: string,
    limit = 5,
    collectionIds?: string[],
    spec?: Readonly<EmbeddingExecutionSpec>,
    signal?: AbortSignal
  ): Promise<DocumentChunk[]> {
    try {
      const executionSpec =
        spec ?? (await this.captureEmbeddingExecutionSpec(userId));
      // Generate embedding for the query
      const queryEmbedding = await this.generateEmbeddingForText(
        query,
        userId,
        executionSpec,
        signal
      );
      if (!queryEmbedding) {
        logger.warn(
          'Failed to generate query embedding, falling back to keyword search'
        );
        return this.keywordSearchDocuments(
          query,
          userId,
          sessionId,
          limit,
          collectionIds,
          signal
        );
      }

      const documents = (await storageService.getAllDocuments(userId)).filter(
        document => this.documentInScope(document, sessionId, collectionIds)
      );
      const platform = getPlatformStorageRuntime();
      const chunksById = new Map<
        string,
        { chunk: DocumentChunk; document: Document }
      >();
      for (const document of documents) {
        throwIfChatGenerationCancelled(signal);
        let searchableDocument = document;
        let documentChunks = await this.loadDocumentChunks(document.id);
        throwIfChatGenerationCancelled(signal);

        if (
          platform.dialect === 'sqlite' &&
          !hasValidDocumentIndexMetadata(searchableDocument)
        ) {
          const upgraded = await this.upgradeLegacyDocumentIndex(
            searchableDocument,
            userId,
            executionSpec,
            signal
          );
          if (upgraded) {
            searchableDocument = upgraded.document;
            documentChunks = upgraded.chunks;
          } else {
            // A failed vector publication may still have durably published
            // current inline chunks. Reload so the exact-index repair below
            // can finish it in this same read; provider/busy failures retain
            // the original legacy chunks for keyword fallback.
            const latest = await platform.domains.documents.findByOwner(
              document.id,
              userId
            );
            if (!latest) continue;
            searchableDocument = latest;
            documentChunks = await this.loadDocumentChunks(latest.id);
          }
        }

        // SQLite may contain relationally published embeddings from a prior
        // process while its local vector table still needs publication. Only
        // publish a revision whose immutable model metadata proves it belongs
        // to this query spec, and serialize that mutation with regeneration
        // and deletion cleanup through the shared document resource lease.
        // PostgreSQL/team reads never mutate PGVector.
        const publishedIndex = readDocumentIndexMetadata(searchableDocument);
        const localIndexProbe =
          platform.dialect === 'sqlite'
            ? exactLocalDocumentIndexProbe(
                searchableDocument,
                documentChunks,
                userId,
                executionSpec
              )
            : undefined;
        let localIndexReady =
          localIndexProbe !== undefined &&
          (await platform.vectorStore.hasExactResourceIndex(localIndexProbe));
        const needsLazyPublication =
          localIndexProbe !== undefined && !localIndexReady;
        if (
          platform.dialect === 'sqlite' &&
          localIndexProbe !== undefined &&
          needsLazyPublication
        ) {
          let lease: MaintainedDocumentResourceLease | undefined;
          try {
            lease = await acquireDocumentResourceLease(
              userId,
              document.id,
              signal,
              0
            );
            await lease.assertHeld();
            const latest = await this.assertDocumentIndexAuthoritative(
              document.id,
              userId,
              publishedIndex!.aggregateRevision
            );
            const latestChunks = await this.loadDocumentChunks(document.id);
            const latestProbe = exactLocalDocumentIndexProbe(
              latest,
              latestChunks,
              userId,
              executionSpec
            );
            if (!latestProbe) throw new DocumentIndexSupersededError();
            const latestIndexReady =
              await platform.vectorStore.hasExactResourceIndex(latestProbe);
            if (!latestIndexReady) {
              await this.indexDocumentChunks(
                latest,
                latestChunks,
                userId,
                executionSpec,
                1,
                signal,
                () => lease!.assertHeld()
              );
            }
            localIndexReady = true;
            searchableDocument = latest;
            documentChunks = latestChunks;
          } catch (error) {
            if (
              !(error instanceof DocumentResourceBusyError) &&
              !(error instanceof DocumentIndexSupersededError)
            ) {
              throw error;
            }
            // A writer owns the resource or replaced/deleted this revision.
            // Skip the optional lazy publication; keyword fallback remains
            // available and the next query reloads authoritative state.
          } finally {
            await lease?.release().catch(() => false);
          }
        }

        for (const chunk of documentChunks) {
          // PostgreSQL deliberately keeps embeddings only in PGVector, so a
          // relational chunk without an `embedding` property can still be the
          // authoritative content for a vector hit. Every current relational
          // chunk joins the candidate set: vector hits hydrate from it and
          // the BM25 side of the hybrid ranking scores it, so chunks without
          // a current embedding stay reachable.
          chunksById.set(chunk.id, {
            chunk,
            document: searchableDocument,
          });
        }
      }

      const resourceIds = documents.map(document => document.id);
      const hits: VectorHit[] = [];
      for (
        let offset = 0;
        offset < resourceIds.length;
        offset += MAX_VECTOR_RESOURCE_FILTERS
      ) {
        throwIfChatGenerationCancelled(signal);
        hits.push(
          ...(await platform.vectorStore.query({
            actor: { userId },
            namespace: DOCUMENT_VECTOR_NAMESPACE,
            model: executionSpec.model,
            dimensions: queryEmbedding.length,
            version: executionSpec.version,
            embedding: queryEmbedding,
            limit,
            minScore: executionSpec.similarityThreshold,
            resourceIds: resourceIds.slice(
              offset,
              offset + MAX_VECTOR_RESOURCE_FILTERS
            ),
          }))
        );
        throwIfChatGenerationCancelled(signal);
      }
      hits.sort(
        (left, right) =>
          right.score - left.score ||
          left.ownerUserId.localeCompare(right.ownerUserId) ||
          left.id.localeCompare(right.id)
      );
      // Hybrid assembly: fuse the vector ranking with an in-process BM25
      // ranking over every in-scope chunk. The lexical side keeps chunks
      // without current embeddings reachable and lets an exact term match
      // outrank a semantically weak neighbor; fusion means neither ranking
      // silently dominates the other.
      const semanticRanked: string[] = [];
      const semanticScores = new Map<string, number>();
      for (const hit of hits) {
        const match = chunksById.get(hit.id);
        if (
          !match ||
          match.document.id !== hit.resourceId ||
          sourceRevision(match.chunk) !== hit.sourceRevision ||
          semanticScores.has(match.chunk.id)
        ) {
          continue;
        }
        semanticRanked.push(match.chunk.id);
        semanticScores.set(match.chunk.id, hit.score);
      }
      const lexicalScored = this.scoreChunksByKeywords(query, [
        ...chunksById.values(),
      ]);
      const fused = reciprocalRankFusion([
        semanticRanked,
        lexicalScored.map(entry => entry.chunk.id),
      ]);
      const top: DocumentChunk[] = [];
      for (const { id, score } of fused) {
        if (top.length >= limit) break;
        const match = chunksById.get(id);
        if (!match) continue;
        top.push(
          this.hydrateRetrievedChunk(match.chunk, match.document, score)
        );
      }
      if (top.length > 0) return top;

      // Nothing cleared the similarity threshold: keyword search is a
      // better answer than an empty context.
      return this.keywordSearchDocuments(
        query,
        userId,
        sessionId,
        limit,
        collectionIds,
        signal
      );
    } catch (error) {
      if (signal?.aborted) throw error;
      logger.error(
        'Semantic search failed, falling back to keyword search:',
        error
      );
      return this.keywordSearchDocuments(
        query,
        userId,
        sessionId,
        limit,
        collectionIds,
        signal
      );
    }
  }

  /** BM25 scores for a set of chunks, best first. */
  private scoreChunksByKeywords(
    query: string,
    entries: { chunk: DocumentChunk; document: Document }[]
  ): { chunk: DocumentChunk; score: number; document: Document }[] {
    const byId = new Map(entries.map(entry => [entry.chunk.id, entry]));
    return scoreCandidatesBm25(
      query,
      entries.map(entry => ({ id: entry.chunk.id, text: entry.chunk.content })),
      { requireQueryWordMatch: true }
    ).map(({ id, score }) => {
      const entry = byId.get(id)!;
      return { chunk: entry.chunk, score, document: entry.document };
    });
  }

  private async keywordSearchDocuments(
    query: string,
    userId: string,
    sessionId?: string,
    limit = 5,
    collectionIds?: string[],
    signal?: AbortSignal
  ): Promise<DocumentChunk[]> {
    const candidates: { chunk: DocumentChunk; document: Document }[] = [];

    throwIfChatGenerationCancelled(signal);
    for (const document of await storageService.getAllDocuments(userId)) {
      throwIfChatGenerationCancelled(signal);
      const documentChunks = await this.loadDocumentChunks(document.id);
      throwIfChatGenerationCancelled(signal);

      if (!this.documentInScope(document, sessionId, collectionIds)) continue;

      for (const chunk of documentChunks) {
        candidates.push({ chunk, document });
      }
    }
    throwIfChatGenerationCancelled(signal);
    const results = this.scoreChunksByKeywords(query, candidates);

    return results
      .slice(0, limit)
      .map(result =>
        this.hydrateRetrievedChunk(result.chunk, result.document, result.score)
      );
  }

  /** Attaches filename, score, and source location to a retrieval result. */
  private hydrateRetrievedChunk(
    chunk: DocumentChunk,
    document: Document,
    score?: number
  ): DocumentChunk {
    const location = resolveSegmentLabel(
      readDocumentSegments(document.metadata),
      chunk.startChar,
      chunk.endChar
    );
    return {
      ...chunk,
      filename: document.filename,
      ...(score !== undefined ? { score } : {}),
      ...(location ? { location } : {}),
    };
  }

  // Get relevant context for RAG
  async getRelevantContext(
    query: string,
    userId: string,
    sessionId?: string
  ): Promise<string[]> {
    const relevantChunks = await this.searchDocuments(
      query,
      userId,
      sessionId,
      3
    );
    return relevantChunks.map(
      (chunk: DocumentChunk & { filename?: string }) => {
        const filename = chunk.filename || 'Unknown';
        return `[From: ${filename}]\n${chunk.content}`;
      }
    );
  }

  // Restore a document from import (used during data import)
  async restoreDocument(document: Document, userId: string): Promise<void> {
    try {
      // Save to storage
      await storageService.saveDocument(document, userId);

      // If there are any chunks with this document, they'll be handled separately
      logger.debug(`Restored document: ${document.filename} (${document.id})`);
    } catch (error) {
      logger.error('Error restoring document:', error);
      throw new Error(
        `Failed to restore document: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  private async loadDocumentChunks(
    documentId: string
  ): Promise<DocumentChunk[]> {
    // Relational storage is authoritative. In team mode another replica's
    // durable worker can complete or replace chunks after this process first
    // observes a queued document; caching [] (or an older revision) forever
    // makes that completion invisible and can drive a stale vector backfill.
    return storageService.getDocumentChunks(documentId);
  }
}

export default new DocumentService();
