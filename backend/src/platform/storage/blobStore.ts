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

import type { Readable } from 'node:stream';

export type BlobSource = AsyncIterable<Uint8Array>;

export interface BlobDescriptor {
  id: string;
  ownerUserId: string;
  purpose: string;
  contentType: string;
  originalFilename?: string;
  metadata: Readonly<Record<string, string>>;
  size: number;
  sha256: string;
  createdAt: string;
  encryptionKeyId: string;
  formatVersion: number;
}

export interface BlobPutRequest {
  ownerUserId: string;
  purpose: string;
  contentType: string;
  source: BlobSource;
  expectedSize?: number;
  originalFilename?: string;
  metadata?: Readonly<Record<string, string>>;
  signal?: AbortSignal;
}

export interface BlobByteRange {
  start: number;
  /** Inclusive. An omitted end reads through the final byte. */
  end?: number;
}

export interface BlobReadRequest {
  id: string;
  ownerUserId: string;
  range?: BlobByteRange;
  signal?: AbortSignal;
}

export interface BlobContentRange {
  start: number;
  end: number;
  total: number;
  length: number;
}

export interface BlobReadResult {
  descriptor: BlobDescriptor;
  range: BlobContentRange | null;
  body: Readable;
}

export interface BlobDeleteRequest {
  id: string;
  ownerUserId: string;
  signal?: AbortSignal;
}

/**
 * BlobStore is deliberately owner-scoped. Resource services must resolve
 * sharing ACLs before invoking it and must never expose physical object keys.
 */
export interface BlobStore {
  put(request: BlobPutRequest): Promise<BlobDescriptor>;
  stat(id: string, ownerUserId: string): Promise<BlobDescriptor>;
  open(request: BlobReadRequest): Promise<BlobReadResult>;
  /** Missing objects are an idempotent success; cross-owner access is hidden. */
  delete(request: BlobDeleteRequest): Promise<boolean>;
}

export interface BlobQuotaReservation {
  /** Called incrementally while plaintext bytes arrive. */
  consume(bytes: number): Promise<void>;
  /** Commits the reservation only after the object is atomically visible. */
  commit(descriptor: BlobDescriptor): Promise<void>;
  /** Must be idempotent and safe after a failed commit. */
  release(): Promise<void>;
}

export interface BlobQuotaPolicy {
  /**
   * Implementations must reserve expected bytes atomically across writers.
   * `consume` reports the actual stream size; it refines the same reservation
   * and must not count `expectedSize` a second time. Stored-usage release stays
   * in the caller's relational resource transaction, independently of physical
   * object garbage collection.
   */
  reserve(request: {
    ownerUserId: string;
    purpose: string;
    expectedSize?: number;
  }): Promise<BlobQuotaReservation>;
}

/** Optional atomic hook when metadata and quota use the same SQL transaction. */
export interface TransactionalBlobQuotaReservation extends BlobQuotaReservation {
  commitWithMetadata?(
    descriptor: BlobDescriptor,
    operation: (executor: unknown) => Promise<void>
  ): Promise<void>;
}

export interface TransactionalBlobQuotaPolicy extends BlobQuotaPolicy {
  releaseStoredWithMetadata?(
    request: { id: string; ownerUserId: string },
    operation: (executor: unknown) => Promise<void>
  ): Promise<void>;
}

export class NoopBlobQuotaPolicy implements BlobQuotaPolicy {
  async reserve(): Promise<BlobQuotaReservation> {
    return {
      consume: async () => undefined,
      commit: async () => undefined,
      release: async () => undefined,
    };
  }
}

export type BlobStoreErrorCode =
  | 'aborted'
  | 'corrupt'
  | 'invalid-input'
  | 'invalid-range'
  | 'not-found'
  | 'quota-exceeded'
  | 'unavailable'
  | 'verification-limit';

export class BlobStoreError extends Error {
  constructor(
    readonly code: BlobStoreErrorCode,
    message: string,
    readonly cause?: unknown
  ) {
    super(message);
    this.name = 'BlobStoreError';
  }
}

export class BlobNotFoundError extends BlobStoreError {
  constructor() {
    super('not-found', 'Blob not found');
    this.name = 'BlobNotFoundError';
  }
}

export class BlobQuotaExceededError extends BlobStoreError {
  constructor(message = 'Blob quota exceeded') {
    super('quota-exceeded', message);
    this.name = 'BlobQuotaExceededError';
  }
}
