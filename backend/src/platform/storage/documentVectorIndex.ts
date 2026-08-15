/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import crypto from 'node:crypto';
import type { DocumentChunk } from '../../types/index.js';

export const DOCUMENT_VECTOR_NAMESPACE = 'document-chunk';
export const DOCUMENT_VECTOR_VERSION = 'v1';
export const DOCUMENT_CHUNKER_VERSION = 'v1';
export const DOCUMENT_INDEX_METADATA_KEY = 'embeddingIndex';

export interface DocumentVectorExecutionSpec {
  model: string;
  version: string;
  chunkerVersion: string;
  chunkSize: number;
  chunkOverlap: number;
  similarityThreshold: number;
}

export interface DocumentEmbeddingIndexMetadata {
  model: string;
  version: string;
  chunkerVersion: string;
  chunkSize: number;
  chunkOverlap: number;
  similarityThreshold: number;
  dimensions: number | null;
  aggregateRevision: string;
  indexedAt: number;
}

export type EmbeddedDocumentChunk = DocumentChunk & { embedding: number[] };

export const documentChunkSourceRevision = (
  chunk: Pick<DocumentChunk, 'content'>
): string =>
  crypto.createHash('sha256').update(chunk.content, 'utf8').digest('hex');

export const embeddedDocumentChunks = (
  chunks: readonly DocumentChunk[]
): EmbeddedDocumentChunk[] =>
  chunks.filter(
    (chunk): chunk is EmbeddedDocumentChunk =>
      Array.isArray(chunk.embedding) && chunk.embedding.length > 0
  );

export const documentEmbeddingDimensions = (
  chunks: readonly EmbeddedDocumentChunk[]
): number | null => {
  const dimensions = new Set(chunks.map(chunk => chunk.embedding.length));
  if (dimensions.size > 1) {
    throw new Error('Embedding model returned inconsistent vector dimensions');
  }
  return dimensions.values().next().value ?? null;
};

/**
 * Content-addressed publication revision shared by online indexing and the
 * SQLite-to-team provenance gate. Keep this independent from provider state.
 */
export const aggregateDocumentIndexRevision = (
  chunks: readonly EmbeddedDocumentChunk[],
  spec: Readonly<DocumentVectorExecutionSpec>
): string =>
  aggregateDocumentIndexRevisionFromEntries(
    chunks.map(chunk => ({
      id: chunk.id,
      sourceRevision: documentChunkSourceRevision(chunk),
      dimensions: chunk.embedding.length,
    })),
    spec
  );

export const aggregateDocumentIndexRevisionFromEntries = (
  entries: readonly {
    id: string;
    sourceRevision: string;
    dimensions: number;
  }[],
  spec: Readonly<DocumentVectorExecutionSpec>
): string => {
  const hash = crypto
    .createHash('sha256')
    .update('libre-document-index-v1\u0000')
    .update(spec.model)
    .update('\u0000')
    .update(spec.version)
    .update('\u0000')
    .update(spec.chunkerVersion)
    .update('\u0000')
    .update(String(spec.chunkSize))
    .update('\u0000')
    .update(String(spec.chunkOverlap));
  for (const entry of entries) {
    hash
      .update('\u0000')
      .update(entry.id)
      .update('\u0000')
      .update(entry.sourceRevision)
      .update('\u0000')
      .update(String(entry.dimensions));
  }
  return hash.digest('hex');
};

export const readDocumentIndexMetadata = (
  metadata: Record<string, unknown> | undefined
): DocumentEmbeddingIndexMetadata | undefined => {
  const value = metadata?.[DOCUMENT_INDEX_METADATA_KEY];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.model !== 'string' ||
    Buffer.byteLength(record.model, 'utf8') < 1 ||
    Buffer.byteLength(record.model, 'utf8') > 256 ||
    typeof record.version !== 'string' ||
    Buffer.byteLength(record.version, 'utf8') < 1 ||
    Buffer.byteLength(record.version, 'utf8') > 256 ||
    typeof record.chunkerVersion !== 'string' ||
    Buffer.byteLength(record.chunkerVersion, 'utf8') < 1 ||
    Buffer.byteLength(record.chunkerVersion, 'utf8') > 256 ||
    !Number.isSafeInteger(record.chunkSize) ||
    (record.chunkSize as number) < 1 ||
    (record.chunkSize as number) > 1_000_000 ||
    !Number.isSafeInteger(record.chunkOverlap) ||
    (record.chunkOverlap as number) < 0 ||
    (record.chunkOverlap as number) >= (record.chunkSize as number) ||
    typeof record.similarityThreshold !== 'number' ||
    !Number.isFinite(record.similarityThreshold) ||
    record.similarityThreshold < -1 ||
    record.similarityThreshold > 1 ||
    (record.dimensions !== null &&
      (!Number.isSafeInteger(record.dimensions) ||
        (record.dimensions as number) < 1 ||
        (record.dimensions as number) > 65_536)) ||
    typeof record.aggregateRevision !== 'string' ||
    !/^[0-9a-f]{64}$/.test(record.aggregateRevision) ||
    !Number.isSafeInteger(record.indexedAt) ||
    (record.indexedAt as number) < 0
  ) {
    return undefined;
  }
  return record as unknown as DocumentEmbeddingIndexMetadata;
};

export const documentIndexMatchesSpec = (
  metadata: DocumentEmbeddingIndexMetadata | undefined,
  spec: Readonly<DocumentVectorExecutionSpec>
): metadata is DocumentEmbeddingIndexMetadata =>
  metadata !== undefined &&
  metadata.model === spec.model &&
  metadata.version === spec.version &&
  metadata.chunkerVersion === spec.chunkerVersion &&
  metadata.chunkSize === spec.chunkSize &&
  metadata.chunkOverlap === spec.chunkOverlap;

export const createDocumentIndexMetadata = (
  chunks: readonly DocumentChunk[],
  spec: Readonly<DocumentVectorExecutionSpec>,
  indexedAt = Date.now()
): DocumentEmbeddingIndexMetadata => {
  const embedded = embeddedDocumentChunks(chunks);
  return {
    model: spec.model,
    version: spec.version,
    chunkerVersion: spec.chunkerVersion,
    chunkSize: spec.chunkSize,
    chunkOverlap: spec.chunkOverlap,
    similarityThreshold: spec.similarityThreshold,
    dimensions: documentEmbeddingDimensions(embedded),
    aggregateRevision: aggregateDocumentIndexRevision(embedded, spec),
    indexedAt,
  };
};
