/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import type Database from 'better-sqlite3';
import type { PostgresQueryExecutor } from '../../persistence/postgresDatabase.js';
import type { Document } from '../../storageMappers.js';
import type {
  DocumentChunk,
  GeneratedMediaKind,
  Persona,
  PersonaState,
} from '../../types/index.js';
import type { BlobReference } from './blobReferenceRepository.js';

export type DeletablePlatformResourceType =
  'document' | 'generated-media' | 'persona';

export interface TransactionalResourceDeletionInput {
  resourceType: DeletablePlatformResourceType;
  resourceId: string;
  ownerUserId: string;
  /** Stable, retained deletion occurrence identity. */
  deletionToken: string;
  deletionIncarnation: number;
}

/**
 * Durable deletion outbox seam. Repositories invoke exactly one dialect
 * method inside the same transaction that removes the relational resource.
 */
export interface TransactionalResourceDeletionEnqueuer {
  enqueueSQLite(
    database: Database.Database,
    input: TransactionalResourceDeletionInput
  ): void;
  enqueuePostgres(
    executor: PostgresQueryExecutor,
    input: TransactionalResourceDeletionInput
  ): Promise<void>;
}

export interface ResourceDeletionLifecycleRepository {
  /** True forever after the first committed deletion of this identifier. */
  isReserved(
    resourceType: DeletablePlatformResourceType,
    resourceId: string
  ): Promise<boolean>;
  /**
   * Runs cleanup only when the exact retained occurrence is authoritative and
   * the relational resource remains absent. PostgreSQL holds its advisory
   * identifier fence across the async operation. SQLite cannot hold a
   * better-sqlite3 transaction across async external I/O, so its safety relies
   * on the permanent tombstone being synchronously checked by every same-ID
   * producer before write.
   */
  withAuthorizedCleanup<T>(
    input: TransactionalResourceDeletionInput,
    operation: () => Promise<T>
  ): Promise<{ authorized: false } | { authorized: true; value: T }>;
  isCleanupAuthorized(
    input: TransactionalResourceDeletionInput
  ): Promise<boolean>;
  markCleanupCompleted(
    input: TransactionalResourceDeletionInput
  ): Promise<boolean>;
}

export interface TransactionalDocumentIngestionInput {
  documentId: string;
  ownerUserId: string;
}

export interface TransactionalDocumentIngestionEnqueuer {
  enqueueSQLite(
    database: Database.Database,
    input: TransactionalDocumentIngestionInput
  ): void;
  enqueuePostgres(
    executor: PostgresQueryExecutor,
    input: TransactionalDocumentIngestionInput
  ): Promise<void>;
}

export interface TransactionalVideoJobInput {
  mediaJobId: string;
  ownerUserId: string;
}

export interface TransactionalVideoSubmissionEnqueuer {
  enqueueSQLite(
    database: Database.Database,
    input: TransactionalVideoJobInput
  ): void;
  enqueuePostgres(
    executor: PostgresQueryExecutor,
    input: TransactionalVideoJobInput
  ): Promise<void>;
}

export type TransactionalVideoResumeEnqueuer =
  TransactionalVideoSubmissionEnqueuer;

/** Application encryption boundary used by both relational implementations. */
export interface PlatformContentCipher {
  encrypt(plaintext: string): string;
  decrypt(ciphertext: string): string;
  decryptAuthenticated(ciphertext: string): string;
  isEncrypted(value: string): boolean;
}

export interface DocumentRepository {
  listByOwner(userId: string): Promise<Document[]>;
  findByOwner(
    documentId: string,
    userId: string
  ): Promise<Document | undefined>;
  upsert(document: Document, userId: string): Promise<void>;
  upsertWithBlobAndEnqueue(
    document: Document,
    userId: string,
    reference: BlobReference,
    enqueuer: TransactionalDocumentIngestionEnqueuer
  ): Promise<void>;
  /** Finalizes extraction only while the owned placeholder still exists. */
  completeIngestion(
    document: Document,
    userId: string,
    chunks: readonly DocumentChunk[]
  ): Promise<boolean>;
  /**
   * Replaces only the embedding-index metadata and chunks for regeneration.
   * Routing and source fields are read and preserved inside the transaction.
   */
  publishEmbeddingIndex(
    documentId: string,
    userId: string,
    expectedSource: {
      content: string | null;
      fileType: 'pdf' | 'txt' | null;
    },
    embeddingIndex: unknown,
    chunks: readonly DocumentChunk[]
  ): Promise<boolean>;
  deleteByOwner(documentId: string, userId: string): Promise<boolean>;
  deleteAndEnqueue(
    documentId: string,
    userId: string,
    enqueuer: TransactionalResourceDeletionEnqueuer
  ): Promise<boolean>;
  setCollection(
    documentId: string,
    collectionId: string | null,
    userId: string
  ): Promise<boolean>;
  /**
   * Inspects legacy inline-vector presence without treating its unknown model
   * as provenance. Corrupt/partial ciphertext remains `present` so repair and
   * migration cannot silently mistake it for an unembedded document.
   */
  inspectLegacyChunkEmbeddings(
    documentId: string,
    userId: string
  ): Promise<{ present: boolean; authenticated: boolean }>;
  listChunks(documentId: string): Promise<DocumentChunk[]>;
  replaceChunks(
    documentId: string,
    chunks: readonly DocumentChunk[]
  ): Promise<void>;
  deleteChunks(documentId: string): Promise<boolean>;
}

export interface GalleryMetadataRecord {
  id: string;
  userId: string;
  kind: GeneratedMediaKind;
  prompt: string;
  model: string;
  pluginId?: string;
  mimeType: string;
  size?: string;
  quality?: string;
  metadata?: Record<string, unknown>;
  createdAt: number;
  /** Present only while adopting an older inline SQLite row. */
  legacyMediaData?: string;
}

export interface GalleryMetadataRepository {
  insert(
    record: GalleryMetadataRecord,
    reference: BlobReference
  ): Promise<void>;
  findByOwner(
    mediaId: string,
    userId: string
  ): Promise<GalleryMetadataRecord | undefined>;
  listByOwner(
    userId: string,
    options: { limit: number; offset: number; kind?: GeneratedMediaKind }
  ): Promise<{ records: GalleryMetadataRecord[]; total: number }>;
  /** Atomically publishes a migrated blob reference and clears inline bytes. */
  adoptLegacyBlob(reference: BlobReference): Promise<void>;
  /** Atomically deletes metadata/reference and returns the physical blob link. */
  deleteByOwner(
    mediaId: string,
    userId: string
  ): Promise<BlobReference | undefined>;
  /** Deletes metadata but retains the blob reference for retriable cleanup. */
  deleteAndEnqueue(
    mediaId: string,
    userId: string,
    enqueuer: TransactionalResourceDeletionEnqueuer
  ): Promise<boolean>;
}

export type MediaGenerationStatus =
  'pending' | 'in_progress' | 'completed' | 'failed';

export interface MediaGenerationRecord {
  id: string;
  userId: string;
  providerJobId: string;
  pluginId: string;
  model: string;
  prompt: string;
  status: MediaGenerationStatus;
  options: Record<string, unknown>;
  galleryId?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export interface MediaGenerationJobRepository {
  create(record: MediaGenerationRecord): Promise<void>;
  createPreparedAndEnqueue(
    record: MediaGenerationRecord,
    enqueuer: TransactionalVideoSubmissionEnqueuer
  ): Promise<void>;
  /** Stores the reconciled provider handle and publishes polling atomically. */
  acceptProviderAndEnqueueResume(
    id: string,
    userId: string,
    providerJobId: string,
    updatedAt: number,
    preparedProviderJobId: string,
    enqueuer: TransactionalVideoResumeEnqueuer
  ): Promise<boolean>;
  findByOwner(
    id: string,
    userId: string
  ): Promise<MediaGenerationRecord | undefined>;
  listByOwner(
    userId: string,
    options: { limit: number; activeOnly: boolean }
  ): Promise<MediaGenerationRecord[]>;
  deleteByOwner(id: string, userId: string): Promise<boolean>;
  updateStatus(
    id: string,
    userId: string,
    status: MediaGenerationStatus,
    fields: { galleryId?: string; error?: string },
    updatedAt: number
  ): Promise<boolean>;
  completeIfUnclaimed(
    id: string,
    userId: string,
    galleryId: string,
    updatedAt: number
  ): Promise<boolean>;
  deleteTerminalBefore(cutoff: number): Promise<number>;
}

export type StoredMemoryType =
  | 'fact'
  | 'preference'
  | 'experience'
  | 'emotional'
  | 'context'
  | 'instruction'
  | 'general';

export interface PersonaMemoryRecord {
  id: string;
  userId: string;
  personaId: string;
  content: string;
  timestamp: number;
  context?: string;
  importanceScore: number;
  memoryType: StoredMemoryType;
  accessCount: number;
  lastAccessed?: number;
  decayFactor: number;
  consolidatedFrom?: string[];
  /** Upgrade-only value from the historical SQLite BLOB column. */
  legacyEmbedding?: number[];
}

export interface PersonaMemoryStatistics {
  totalCount: number;
  byType: Record<string, number>;
  averageImportance: number;
  oldestMemory: number | null;
  newestMemory: number | null;
  totalAccesses: number;
}

export interface PersonaMemoryRepository {
  insert(record: PersonaMemoryRecord): Promise<void>;
  findByOwner(
    memoryId: string,
    userId: string,
    personaId: string
  ): Promise<PersonaMemoryRecord | undefined>;
  listByOwner(
    userId: string,
    personaId: string,
    options?: {
      limit?: number;
      offset?: number;
      types?: readonly StoredMemoryType[];
      minimumImportance?: number;
    }
  ): Promise<PersonaMemoryRecord[]>;
  countByOwner(userId: string, personaId: string): Promise<number>;
  reinforce(
    memoryId: string,
    userId: string,
    personaId: string,
    accessedAt: number
  ): Promise<boolean>;
  markAccessed(
    ids: readonly string[],
    userId: string,
    personaId: string,
    accessedAt: number
  ): Promise<number>;
  updateImportance(
    memoryId: string,
    userId: string,
    personaId: string,
    importanceScore: number,
    decayFactor?: number
  ): Promise<boolean>;
  deleteIds(
    ids: readonly string[],
    userId: string,
    personaId: string
  ): Promise<number>;
  deleteAllByOwner(userId: string, personaId: string): Promise<number>;
  findOldLowImportanceIds(
    userId: string,
    personaId: string,
    cutoff: number,
    maximumImportance: number
  ): Promise<string[]>;
  deleteOldLowImportance(
    userId: string,
    personaId: string,
    cutoff: number,
    maximumImportance: number
  ): Promise<string[]>;
  statistics(
    userId: string,
    personaId: string
  ): Promise<PersonaMemoryStatistics>;
}

export interface PersonaRepository {
  listByOwner(userId: string): Promise<Persona[]>;
  findByOwner(id: string, userId: string): Promise<Persona | undefined>;
  insert(persona: Persona): Promise<void>;
  replace(persona: Persona): Promise<boolean>;
  patchByOwner(
    id: string,
    userId: string,
    patch: PersonaPatch
  ): Promise<Persona | undefined>;
  deleteByOwner(id: string, userId: string): Promise<boolean>;
  deleteAndEnqueue(
    id: string,
    userId: string,
    enqueuer: TransactionalResourceDeletionEnqueuer
  ): Promise<boolean>;
  countByOwner(userId: string): Promise<number>;
}

export interface PersonaPatch {
  name?: string;
  description?: string | null;
  model?: string;
  parameters?: Persona['parameters'];
  avatar?: string | null;
  background?: string | null;
  embedding_model?: string | null;
  memory_settings?: Persona['memory_settings'] | null;
  mutation_settings?: Persona['mutation_settings'] | null;
  updated_at: number;
}

export interface PersonaStateRepository {
  findByOwner(
    personaId: string,
    userId: string
  ): Promise<PersonaState | undefined>;
  upsert(state: PersonaState): Promise<void>;
  deleteByOwner(personaId: string, userId: string): Promise<boolean>;
}

export interface PlatformDomainRepositories {
  documents: DocumentRepository;
  gallery: GalleryMetadataRepository;
  mediaJobs: MediaGenerationJobRepository;
  memories: PersonaMemoryRepository;
  personas: PersonaRepository;
  personaStates: PersonaStateRepository;
  resourceDeletions: ResourceDeletionLifecycleRepository;
}
