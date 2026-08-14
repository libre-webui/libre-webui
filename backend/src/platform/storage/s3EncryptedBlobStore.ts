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
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand,
  S3Client,
  type GetObjectCommandOutput,
  type ListObjectVersionsCommandOutput,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import type { PostgresQueryExecutor } from '../../persistence/postgresDatabase.js';
import {
  Aes256GcmKeyring,
  parseAesGcmEnvelope,
  StorageEncryptionError,
  type AesGcmEnvelope,
} from './aesGcmKeyring.js';
import {
  BlobNotFoundError,
  BlobStoreError,
  NoopBlobQuotaPolicy,
  type BlobContentRange,
  type BlobDescriptor,
  type BlobPutRequest,
  type BlobQuotaPolicy,
  type BlobQuotaReservation,
  type TransactionalBlobQuotaPolicy,
  type TransactionalBlobQuotaReservation,
  type BlobReadRequest,
  type BlobReadResult,
  type BlobStore,
} from './blobStore.js';

const FORMAT_VERSION = 1;
const AUTH_TAG_BYTES = 16;
const BODY_NONCE_BYTES = 8;
const METADATA_IV_BYTES = 12;
const DEFAULT_CHUNK_BYTES = 1024 * 1024;
const DEFAULT_MAX_OBJECT_BYTES = 512 * 1024 * 1024;
const MIN_CHUNK_BYTES = 64 * 1024;
const MAX_CHUNK_BYTES = 8 * 1024 * 1024;
const MAX_METADATA_BYTES = 64 * 1024;
const MAX_RECORDS_PER_RECONCILIATION = 10_000;
const MAX_OBJECT_VERSIONS_PER_PURGE = 10_000;
const OBJECT_VERSION_PAGE_SIZE = 1_000;
const REQUIRED_EMPTY_VERSION_LISTS = 2;
const OBJECT_LIFECYCLE_LOCK_NAMESPACE = 'libre-s3-blob-lifecycle-v1';
const BLOB_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PURPOSE_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,63}$/;
const METADATA_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const PREFIX_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/;

interface StoredS3BlobMetadata extends BlobDescriptor {
  objectKey: string;
  chunkBytes: number;
  chunkCount: number;
  bodyNonce: string;
  encryptedBytes: number;
  ciphertextSha256: string;
}

interface BlobObjectRow extends Record<string, unknown> {
  id: string;
  owner_user_id: string;
  purpose: string;
  object_key: string;
  encrypted_bytes: string | number;
  plaintext_bytes: string | number;
  plaintext_sha256: string;
  ciphertext_sha256: string;
  wrapped_data_key: AesGcmEnvelope | string;
  metadata_iv: Buffer;
  metadata_tag: Buffer;
  encrypted_metadata: Buffer;
  state: 'ready' | 'deleting';
  created_at: string | number;
  updated_at: string | number;
}

interface BlobQuotaObjectRow extends Record<string, unknown> {
  blob_id: string;
  owner_user_id: string;
  purpose: string;
  stored_bytes: string | number;
}

interface AdvisoryUnlockRow extends Record<string, unknown> {
  released: boolean;
}

interface ClientOwningPostgresExecutor extends PostgresQueryExecutor {
  withClient<T>(
    operation: (client: PostgresQueryExecutor) => Promise<T>
  ): Promise<T>;
}

interface PinnedPostgresExecutor extends PostgresQueryExecutor {
  release(error?: Error): void;
}

interface S3ReconciliationCursor {
  version: 1;
  afterKey: string;
}

interface ExactObjectVersion {
  key: string;
  versionId?: string;
  lastModified?: Date;
}

export interface S3EncryptedBlobStoreOptions {
  database: PostgresQueryExecutor;
  client: S3Client;
  bucket: string;
  keyPrefix?: string;
  keyring: Aes256GcmKeyring;
  quotaPolicy?: BlobQuotaPolicy;
  chunkBytes?: number;
  maxObjectBytes?: number;
  multipartPartBytes?: number;
  multipartConcurrency?: number;
  now?: () => Date;
}

export interface S3BlobReconciliationOptions {
  olderThan: Date;
  maxObjects?: number;
  /** Opaque S3 cursor returned by a previous bounded reconciliation pass. */
  continuationToken?: string;
  signal?: AbortSignal;
}

export interface S3BlobReconciliationResult {
  deletedOrphans: number;
  resumedDeletes: number;
  inspectedObjects: number;
  /** True when this pass reached the end of the managed prefix. */
  complete: boolean;
  /** Resume cursor when more managed objects remain after this bounded pass. */
  continuationToken?: string;
}

export interface S3BlobIntegrityOptions {
  maxObjects?: number;
  maxEncryptedBytes?: number;
  maxPlaintextBytes?: number;
  signal?: AbortSignal;
}

export interface S3BlobIntegrityResult {
  objects: number;
  encryptedBytes: number;
  plaintextBytes: number;
}

export interface S3BlobEnvironment extends NodeJS.ProcessEnv {
  S3_BUCKET?: string;
  S3_REGION?: string;
  S3_ENDPOINT?: string;
  S3_ACCESS_KEY_ID?: string;
  S3_SECRET_ACCESS_KEY?: string;
  S3_SESSION_TOKEN?: string;
  S3_FORCE_PATH_STYLE?: string;
  S3_BLOB_PREFIX?: string;
}

export interface ResolvedS3BlobConfiguration {
  bucket: string;
  keyPrefix: string;
  clientConfig: S3ClientConfig;
}

const blobError = (
  code: ConstructorParameters<typeof BlobStoreError>[0],
  message: string,
  cause?: unknown
): BlobStoreError => new BlobStoreError(code, message, cause);

const throwIfAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) {
    throw blobError('aborted', 'Blob operation was aborted', signal.reason);
  }
};

const hasClientOwnership = (
  executor: PostgresQueryExecutor
): executor is ClientOwningPostgresExecutor =>
  'withClient' in executor &&
  typeof (executor as { withClient?: unknown }).withClient === 'function';

const isPinnedClient = (
  executor: PostgresQueryExecutor
): executor is PinnedPostgresExecutor =>
  'release' in executor &&
  typeof (executor as { release?: unknown }).release === 'function';

const encodeReconciliationCursor = (cursor: S3ReconciliationCursor): string =>
  Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');

const decodeReconciliationCursor = (
  value: string | undefined
): S3ReconciliationCursor | undefined => {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(
      Buffer.from(value, 'base64url').toString('utf8')
    ) as Partial<S3ReconciliationCursor>;
    if (
      parsed.version !== 1 ||
      typeof parsed.afterKey !== 'string' ||
      parsed.afterKey.length === 0 ||
      Buffer.byteLength(parsed.afterKey, 'utf8') > 1024
    ) {
      throw new Error('invalid cursor');
    }
    return { version: 1, afterKey: parsed.afterKey };
  } catch {
    throw blobError('invalid-input', 'Invalid S3 reconciliation cursor');
  }
};

const validateString = (
  value: string,
  field: string,
  maximumBytes: number
): void => {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > maximumBytes ||
    [...value].some(character => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || codePoint === 127;
    })
  ) {
    throw blobError('invalid-input', `Invalid blob ${field}`);
  }
};

const validateBlobId = (id: string): void => {
  if (!BLOB_ID_PATTERN.test(id)) throw new BlobNotFoundError();
};

const normalizeMetadata = (
  metadata: Readonly<Record<string, string>> | undefined
): Readonly<Record<string, string>> => {
  const entries = Object.entries(metadata ?? {});
  if (entries.length > 32) {
    throw blobError('invalid-input', 'Blob metadata has too many fields');
  }
  const normalized: Record<string, string> = {};
  for (const [key, value] of entries.sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    if (!METADATA_KEY_PATTERN.test(key)) {
      throw blobError('invalid-input', `Invalid blob metadata key: ${key}`);
    }
    if (
      typeof value !== 'string' ||
      Buffer.byteLength(value, 'utf8') > 4096 ||
      value.includes('\u0000')
    ) {
      throw blobError('invalid-input', `Invalid blob metadata value: ${key}`);
    }
    normalized[key] = value;
  }
  return Object.freeze(normalized);
};

const validatePutRequest = (
  request: BlobPutRequest,
  maxObjectBytes: number
): Readonly<Record<string, string>> => {
  validateString(request.ownerUserId, 'owner', 256);
  if (!PURPOSE_PATTERN.test(request.purpose)) {
    throw blobError('invalid-input', 'Invalid blob purpose');
  }
  validateString(request.contentType, 'content type', 255);
  if (request.originalFilename !== undefined) {
    validateString(request.originalFilename, 'filename', 255);
  }
  if (
    request.expectedSize !== undefined &&
    (!Number.isSafeInteger(request.expectedSize) ||
      request.expectedSize < 0 ||
      request.expectedSize > maxObjectBytes)
  ) {
    throw blobError('invalid-input', 'Invalid expected blob size');
  }
  return normalizeMetadata(request.metadata);
};

const keyAad = (id: string): Buffer =>
  Buffer.from(
    JSON.stringify(['libre-s3-blob-key', FORMAT_VERSION, id]),
    'utf8'
  );

const metadataAad = (id: string, objectKey: string): Buffer =>
  Buffer.from(
    JSON.stringify(['libre-s3-blob-metadata', FORMAT_VERSION, id, objectKey]),
    'utf8'
  );

const chunkAad = (
  metadata: Pick<StoredS3BlobMetadata, 'id' | 'ownerUserId' | 'purpose'>,
  chunkIndex: number,
  plaintextBytes: number
): Buffer =>
  Buffer.from(
    JSON.stringify([
      'libre-blob-chunk',
      FORMAT_VERSION,
      metadata.id,
      metadata.ownerUserId,
      metadata.purpose,
      chunkIndex,
      plaintextBytes,
    ]),
    'utf8'
  );

const createChunkIv = (nonce: Buffer, index: number): Buffer => {
  if (nonce.length !== BODY_NONCE_BYTES || index < 0 || index > 0xffffffff) {
    throw blobError('corrupt', 'Invalid encrypted blob chunk nonce');
  }
  const iv = Buffer.allocUnsafe(12);
  nonce.copy(iv, 0);
  iv.writeUInt32BE(index, BODY_NONCE_BYTES);
  return iv;
};

const fixedChunks = async function* (
  source: AsyncIterable<Uint8Array>,
  chunkBytes: number,
  signal?: AbortSignal
): AsyncGenerator<Buffer> {
  let carry = Buffer.alloc(0);
  for await (const value of source) {
    throwIfAborted(signal);
    let input = Buffer.isBuffer(value)
      ? value
      : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    if (carry.length > 0) {
      const needed = chunkBytes - carry.length;
      if (input.length < needed) {
        carry = Buffer.concat([carry, input], carry.length + input.length);
        continue;
      }
      yield Buffer.concat([carry, input.subarray(0, needed)], chunkBytes);
      carry = Buffer.alloc(0);
      input = input.subarray(needed);
    }
    while (input.length >= chunkBytes) {
      yield input.subarray(0, chunkBytes);
      input = input.subarray(chunkBytes);
    }
    if (input.length > 0) carry = Buffer.from(input);
  }
  throwIfAborted(signal);
  if (carry.length > 0) yield carry;
};

const safeInteger = (value: string | number, description: string): number => {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw blobError('corrupt', `Invalid S3 blob ${description}`);
  }
  return parsed;
};

const isNotFound = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as {
    name?: string;
    Code?: string;
    $metadata?: { httpStatusCode?: number };
  };
  return (
    candidate.name === 'NoSuchKey' ||
    candidate.name === 'NotFound' ||
    candidate.Code === 'NoSuchKey' ||
    candidate.$metadata?.httpStatusCode === 404
  );
};

const publicDescriptor = (metadata: StoredS3BlobMetadata): BlobDescriptor => ({
  id: metadata.id,
  ownerUserId: metadata.ownerUserId,
  purpose: metadata.purpose,
  contentType: metadata.contentType,
  ...(metadata.originalFilename
    ? { originalFilename: metadata.originalFilename }
    : {}),
  metadata: Object.freeze({ ...metadata.metadata }),
  size: metadata.size,
  sha256: metadata.sha256,
  createdAt: metadata.createdAt,
  encryptionKeyId: metadata.encryptionKeyId,
  formatVersion: metadata.formatVersion,
});

const isStoredMetadata = (value: unknown): value is StoredS3BlobMetadata => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Partial<StoredS3BlobMetadata>;
  return (
    typeof item.id === 'string' &&
    BLOB_ID_PATTERN.test(item.id) &&
    typeof item.ownerUserId === 'string' &&
    item.ownerUserId.length > 0 &&
    typeof item.purpose === 'string' &&
    PURPOSE_PATTERN.test(item.purpose) &&
    typeof item.contentType === 'string' &&
    typeof item.objectKey === 'string' &&
    typeof item.size === 'number' &&
    Number.isSafeInteger(item.size) &&
    item.size >= 0 &&
    typeof item.sha256 === 'string' &&
    /^[0-9a-f]{64}$/.test(item.sha256) &&
    typeof item.ciphertextSha256 === 'string' &&
    /^[0-9a-f]{64}$/.test(item.ciphertextSha256) &&
    typeof item.encryptedBytes === 'number' &&
    Number.isSafeInteger(item.encryptedBytes) &&
    item.encryptedBytes >= 0 &&
    typeof item.chunkBytes === 'number' &&
    Number.isSafeInteger(item.chunkBytes) &&
    item.chunkBytes >= MIN_CHUNK_BYTES &&
    item.chunkBytes <= MAX_CHUNK_BYTES &&
    typeof item.chunkCount === 'number' &&
    Number.isSafeInteger(item.chunkCount) &&
    item.chunkCount >= 0 &&
    typeof item.bodyNonce === 'string' &&
    typeof item.createdAt === 'string' &&
    Number.isFinite(Date.parse(item.createdAt)) &&
    typeof item.encryptionKeyId === 'string' &&
    item.formatVersion === FORMAT_VERSION &&
    Boolean(item.metadata) &&
    typeof item.metadata === 'object' &&
    !Array.isArray(item.metadata)
  );
};

const asyncIterableBody = (body: unknown): AsyncIterable<Uint8Array> => {
  if (
    !body ||
    typeof body !== 'object' ||
    !(Symbol.asyncIterator in body) ||
    typeof (body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] !==
      'function'
  ) {
    throw blobError('unavailable', 'S3 returned a non-streaming object body');
  }
  return body as AsyncIterable<Uint8Array>;
};

class AsyncByteReader {
  private readonly iterator: AsyncIterator<Uint8Array>;
  private carry = Buffer.alloc(0);
  private ended = false;

  constructor(source: AsyncIterable<Uint8Array>) {
    this.iterator = source[Symbol.asyncIterator]();
  }

  async readExactly(length: number): Promise<Buffer> {
    while (this.carry.length < length && !this.ended) {
      const next = await this.iterator.next();
      if (next.done) {
        this.ended = true;
        break;
      }
      const chunk = Buffer.from(
        next.value.buffer,
        next.value.byteOffset,
        next.value.byteLength
      );
      if (chunk.length > 0) {
        this.carry = Buffer.concat(
          [this.carry, chunk],
          this.carry.length + chunk.length
        );
      }
    }
    if (this.carry.length < length) {
      throw blobError('corrupt', 'Encrypted S3 blob is truncated');
    }
    const output = this.carry.subarray(0, length);
    this.carry = Buffer.from(this.carry.subarray(length));
    return output;
  }

  async assertEnd(): Promise<void> {
    if (this.carry.length > 0) {
      throw blobError('corrupt', 'Encrypted S3 blob has trailing bytes');
    }
    if (!this.ended) {
      const next = await this.iterator.next();
      if (!next.done && next.value.byteLength > 0) {
        throw blobError('corrupt', 'Encrypted S3 blob has trailing bytes');
      }
      this.ended = Boolean(next.done);
    }
  }

  async close(): Promise<void> {
    await this.iterator.return?.();
  }
}

export const resolveS3BlobConfiguration = (
  env: S3BlobEnvironment = process.env
): ResolvedS3BlobConfiguration => {
  const bucket = env.S3_BUCKET?.trim();
  const region = env.S3_REGION?.trim();
  if (!bucket || bucket.length > 255) {
    throw blobError(
      'invalid-input',
      'S3_BUCKET is required and must be at most 255 characters'
    );
  }
  if (!region || !/^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/.test(region)) {
    throw blobError('invalid-input', 'S3_REGION is required and invalid');
  }
  const keyPrefix = (env.S3_BLOB_PREFIX?.trim() || 'libre/blobs').replace(
    /\/+$/,
    ''
  );
  if (!PREFIX_PATTERN.test(keyPrefix) || keyPrefix.includes('..')) {
    throw blobError('invalid-input', 'S3_BLOB_PREFIX is invalid');
  }

  let endpoint: string | undefined;
  if (env.S3_ENDPOINT?.trim()) {
    let parsed: URL;
    try {
      parsed = new URL(env.S3_ENDPOINT.trim());
    } catch {
      throw blobError('invalid-input', 'S3_ENDPOINT must be an absolute URL');
    }
    if (
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    ) {
      throw blobError(
        'invalid-input',
        'S3_ENDPOINT must be an HTTP(S) URL without credentials, query, or fragment'
      );
    }
    endpoint = parsed.toString();
  }

  const accessKeyId = env.S3_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.S3_SECRET_ACCESS_KEY?.trim();
  if (Boolean(accessKeyId) !== Boolean(secretAccessKey)) {
    throw blobError(
      'invalid-input',
      'S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY must be configured together'
    );
  }
  if (env.S3_SESSION_TOKEN?.trim() && !accessKeyId) {
    throw blobError(
      'invalid-input',
      'S3_SESSION_TOKEN requires explicit S3 access credentials'
    );
  }
  const rawPathStyle = env.S3_FORCE_PATH_STYLE?.trim().toLowerCase();
  if (rawPathStyle && rawPathStyle !== 'true' && rawPathStyle !== 'false') {
    throw blobError(
      'invalid-input',
      'S3_FORCE_PATH_STYLE must be true or false'
    );
  }

  return {
    bucket,
    keyPrefix,
    clientConfig: {
      region,
      ...(endpoint ? { endpoint } : {}),
      forcePathStyle: rawPathStyle === 'true',
      ...(accessKeyId && secretAccessKey
        ? {
            credentials: {
              accessKeyId,
              secretAccessKey,
              ...(env.S3_SESSION_TOKEN?.trim()
                ? { sessionToken: env.S3_SESSION_TOKEN.trim() }
                : {}),
            },
          }
        : {}),
    },
  };
};

/**
 * Private S3-compatible blob storage with application-owned envelope
 * encryption. S3 receives opaque keys and ciphertext only. Metadata is
 * authenticated and encrypted in PostgreSQL; no provider URL is persisted.
 */
export class S3EncryptedBlobStore implements BlobStore {
  private readonly database: PostgresQueryExecutor;
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly keyPrefix: string;
  private readonly keyring: Aes256GcmKeyring;
  private readonly quotaPolicy: BlobQuotaPolicy;
  private readonly chunkBytes: number;
  private readonly maxObjectBytes: number;
  private readonly multipartPartBytes: number;
  private readonly multipartConcurrency: number;
  private readonly now: () => Date;
  /** Prevent this process's just-published objects from racing reconciliation. */
  private readonly activeObjectKeys = new Set<string>();

  constructor(options: S3EncryptedBlobStoreOptions) {
    validateString(options.bucket, 'S3 bucket', 255);
    const keyPrefix = (options.keyPrefix ?? 'libre/blobs').replace(/\/+$/, '');
    if (!PREFIX_PATTERN.test(keyPrefix) || keyPrefix.includes('..')) {
      throw blobError('invalid-input', 'Invalid S3 blob key prefix');
    }
    const chunkBytes = options.chunkBytes ?? DEFAULT_CHUNK_BYTES;
    if (
      !Number.isSafeInteger(chunkBytes) ||
      chunkBytes < MIN_CHUNK_BYTES ||
      chunkBytes > MAX_CHUNK_BYTES
    ) {
      throw blobError(
        'invalid-input',
        'Blob chunk size must be between 64 KiB and 8 MiB'
      );
    }
    const maxObjectBytes = options.maxObjectBytes ?? DEFAULT_MAX_OBJECT_BYTES;
    if (!Number.isSafeInteger(maxObjectBytes) || maxObjectBytes <= 0) {
      throw blobError('invalid-input', 'Invalid maximum S3 blob size');
    }
    const partBytes = options.multipartPartBytes ?? 8 * 1024 * 1024;
    if (!Number.isSafeInteger(partBytes) || partBytes < 5 * 1024 * 1024) {
      throw blobError(
        'invalid-input',
        'S3 multipart part size must be at least 5 MiB'
      );
    }
    const concurrency = options.multipartConcurrency ?? 2;
    if (
      !Number.isSafeInteger(concurrency) ||
      concurrency < 1 ||
      concurrency > 8
    ) {
      throw blobError(
        'invalid-input',
        'S3 multipart concurrency must be between 1 and 8'
      );
    }

    this.database = options.database;
    this.client = options.client;
    this.bucket = options.bucket;
    this.keyPrefix = keyPrefix;
    this.keyring = options.keyring;
    this.quotaPolicy = options.quotaPolicy ?? new NoopBlobQuotaPolicy();
    this.chunkBytes = chunkBytes;
    this.maxObjectBytes = maxObjectBytes;
    this.multipartPartBytes = partBytes;
    this.multipartConcurrency = concurrency;
    this.now = options.now ?? (() => new Date());
  }

  private objectKey(id: string): string {
    validateBlobId(id);
    return `${this.keyPrefix}/v1/${id.slice(0, 2)}/${id.slice(2, 4)}/${id}.blob`;
  }

  /**
   * Serialize every mutation of one deterministic object key across replicas.
   * Random-ID writes do not normally contend, but using the same lock there
   * also fences cleanup of a failed write from a concurrent import/retry.
   */
  private async withObjectLifecycleLock<T>(
    objectKey: string,
    operation: (executor: PostgresQueryExecutor) => Promise<T>,
    ownerUserId?: string
  ): Promise<T> {
    const withPinnedClient = async (
      client: PostgresQueryExecutor
    ): Promise<T> => {
      const lockNames = [
        `${OBJECT_LIFECYCLE_LOCK_NAMESPACE}:object:${objectKey}`,
        ...(ownerUserId
          ? [`${OBJECT_LIFECYCLE_LOCK_NAMESPACE}:owner:${ownerUserId}`]
          : []),
      ].sort();
      const acquired: string[] = [];
      let result: T | undefined;
      let primaryError: unknown;
      try {
        for (const lockName of lockNames) {
          await client.query(
            'SELECT pg_advisory_lock(hashtextextended($1, 0))',
            [lockName]
          );
          acquired.push(lockName);
        }
        result = await operation(client);
      } catch (error) {
        primaryError = error;
      }
      for (const lockName of acquired.reverse()) {
        try {
          const unlocked = await client.query<AdvisoryUnlockRow>(
            'SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS released',
            [lockName]
          );
          if (unlocked.rows[0]?.released !== true) {
            throw new Error('S3 blob lifecycle lock was not held');
          }
        } catch (unlockError) {
          if (!primaryError) primaryError = unlockError;
        }
      }
      if (primaryError) throw primaryError;
      return result as T;
    };
    if (hasClientOwnership(this.database)) {
      return this.database.withClient(withPinnedClient);
    }
    if (isPinnedClient(this.database)) {
      return withPinnedClient(this.database);
    }
    throw blobError(
      'unavailable',
      'S3 blob lifecycle requires a PostgreSQL database or pinned client'
    );
  }

  private async listExactObjectVersions(
    objectKey: string,
    signal?: AbortSignal
  ): Promise<ExactObjectVersion[]> {
    let keyMarker: string | undefined;
    let versionIdMarker: string | undefined;
    const versions: ExactObjectVersion[] = [];
    let inspectedEntries = 0;
    for (;;) {
      throwIfAborted(signal);
      let page: ListObjectVersionsCommandOutput;
      try {
        page = await this.client.send(
          new ListObjectVersionsCommand({
            Bucket: this.bucket,
            Prefix: objectKey,
            MaxKeys: OBJECT_VERSION_PAGE_SIZE,
            ...(keyMarker ? { KeyMarker: keyMarker } : {}),
            ...(versionIdMarker ? { VersionIdMarker: versionIdMarker } : {}),
          }),
          { abortSignal: signal }
        );
      } catch (error) {
        if (signal?.aborted) throwIfAborted(signal);
        throw blobError(
          'unavailable',
          'Unable to enumerate S3 blob object versions',
          error
        );
      }
      const pageItems = [
        ...(page.Versions ?? []),
        ...(page.DeleteMarkers ?? []),
      ];
      for (const item of pageItems) {
        inspectedEntries += 1;
        if (inspectedEntries > MAX_OBJECT_VERSIONS_PER_PURGE) {
          throw blobError(
            'verification-limit',
            'S3 exact-key version scan exceeded its safety bound'
          );
        }
        if (item.Key !== objectKey) continue;
        versions.push({
          key: objectKey,
          ...(item.VersionId ? { versionId: item.VersionId } : {}),
          ...(item.LastModified ? { lastModified: item.LastModified } : {}),
        });
      }
      // S3 orders versions by key. Once the exact prefix has advanced to a
      // longer/nonmatching key, no exact-key version can appear later.
      if (pageItems.some(item => item.Key && item.Key !== objectKey)) {
        return versions;
      }
      if (!page.IsTruncated) return versions;
      if (!page.NextKeyMarker) {
        throw blobError(
          'unavailable',
          'S3 version listing omitted its continuation key'
        );
      }
      keyMarker = page.NextKeyMarker;
      versionIdMarker = page.NextVersionIdMarker;
    }
  }

  /**
   * Remove every immutable version and delete marker for one exact managed
   * key. Two consecutive empty listings make an eventually-consistent result
   * explicit; the per-key PostgreSQL advisory lock prevents a cooperating
   * put/import from publishing a replacement inside that verification window.
   */
  private async purgeExactObjectVersions(
    objectKey: string,
    signal?: AbortSignal
  ): Promise<void> {
    let emptyPasses = 0;
    let deleted = 0;
    while (emptyPasses < REQUIRED_EMPTY_VERSION_LISTS) {
      const versions = await this.listExactObjectVersions(objectKey, signal);
      if (versions.length === 0) {
        emptyPasses += 1;
        continue;
      }
      emptyPasses = 0;
      for (const version of versions) {
        throwIfAborted(signal);
        deleted += 1;
        if (deleted > MAX_OBJECT_VERSIONS_PER_PURGE) {
          throw blobError(
            'verification-limit',
            'S3 blob object has too many retained versions to purge safely'
          );
        }
        try {
          await this.client.send(
            new DeleteObjectCommand({
              Bucket: this.bucket,
              Key: version.key,
              ...(version.versionId ? { VersionId: version.versionId } : {}),
            }),
            { abortSignal: signal }
          );
        } catch (error) {
          if (signal?.aborted) throwIfAborted(signal);
          throw blobError(
            'unavailable',
            'Unable to purge an S3 blob object version',
            error
          );
        }
      }
    }
  }

  /**
   * Only keys emitted by objectKey() belong to this lifecycle. Unknown keys
   * beneath a shared operator prefix are never treated as Libre garbage.
   */
  private managedObjectId(objectKey: string): string | undefined {
    const prefix = `${this.keyPrefix}/v1/`;
    if (!objectKey.startsWith(prefix)) return undefined;
    const relative = objectKey.slice(prefix.length);
    const match =
      /^([0-9a-f]{2})\/([0-9a-f]{2})\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.blob$/.exec(
        relative
      );
    const id = match?.[3];
    return id && match[1] === id.slice(0, 2) && match[2] === id.slice(2, 4)
      ? id
      : undefined;
  }

  private async row(
    id: string,
    ownerUserId: string,
    includeDeleting = false,
    executor: PostgresQueryExecutor = this.database
  ): Promise<BlobObjectRow | undefined> {
    validateBlobId(id);
    validateString(ownerUserId, 'owner', 256);
    const result = await executor.query<BlobObjectRow>(
      `SELECT id, owner_user_id, purpose, object_key, encrypted_bytes,
              plaintext_bytes, plaintext_sha256, ciphertext_sha256,
              wrapped_data_key, metadata_iv, metadata_tag,
              encrypted_metadata, state, created_at, updated_at
         FROM platform_blob_objects
        WHERE id = $1 AND owner_user_id = $2
          ${includeDeleting ? '' : "AND state = 'ready'"}`,
      [id, ownerUserId]
    );
    return result.rows[0];
  }

  private decryptMetadata(row: BlobObjectRow): {
    metadata: StoredS3BlobMetadata;
    dataKey: Buffer;
  } {
    let dataKey: Buffer | undefined;
    try {
      const rawEnvelope =
        typeof row.wrapped_data_key === 'string'
          ? (JSON.parse(row.wrapped_data_key) as unknown)
          : row.wrapped_data_key;
      const envelope = parseAesGcmEnvelope(rawEnvelope);
      dataKey = this.keyring.decrypt(envelope, keyAad(row.id));
      if (dataKey.length !== 32) {
        throw blobError('corrupt', 'Invalid S3 blob data key');
      }
      if (
        !Buffer.isBuffer(row.metadata_iv) ||
        row.metadata_iv.length !== METADATA_IV_BYTES ||
        !Buffer.isBuffer(row.metadata_tag) ||
        row.metadata_tag.length !== AUTH_TAG_BYTES ||
        !Buffer.isBuffer(row.encrypted_metadata) ||
        row.encrypted_metadata.length === 0 ||
        row.encrypted_metadata.length > MAX_METADATA_BYTES
      ) {
        throw blobError('corrupt', 'Invalid encrypted S3 blob metadata');
      }
      const decipher = crypto.createDecipheriv(
        'aes-256-gcm',
        dataKey,
        row.metadata_iv,
        { authTagLength: AUTH_TAG_BYTES }
      );
      decipher.setAAD(metadataAad(row.id, row.object_key));
      decipher.setAuthTag(row.metadata_tag);
      const plaintext = Buffer.concat([
        decipher.update(row.encrypted_metadata),
        decipher.final(),
      ]);
      let value: unknown;
      try {
        value = JSON.parse(plaintext.toString('utf8')) as unknown;
      } finally {
        plaintext.fill(0);
      }
      if (!isStoredMetadata(value)) {
        throw blobError('corrupt', 'Invalid encrypted S3 blob descriptor');
      }
      const encryptedBytes = safeInteger(
        row.encrypted_bytes,
        'encrypted byte count'
      );
      const plaintextBytes = safeInteger(
        row.plaintext_bytes,
        'plaintext byte count'
      );
      const bodyNonce = Buffer.from(value.bodyNonce, 'base64');
      if (
        value.id !== row.id ||
        value.ownerUserId !== row.owner_user_id ||
        value.purpose !== row.purpose ||
        value.objectKey !== row.object_key ||
        value.size !== plaintextBytes ||
        value.encryptedBytes !== encryptedBytes ||
        value.sha256 !== row.plaintext_sha256 ||
        value.ciphertextSha256 !== row.ciphertext_sha256 ||
        value.encryptionKeyId !== envelope.keyId ||
        value.chunkCount !== Math.ceil(value.size / value.chunkBytes) ||
        value.encryptedBytes !==
          value.size + value.chunkCount * AUTH_TAG_BYTES ||
        bodyNonce.length !== BODY_NONCE_BYTES ||
        bodyNonce.toString('base64') !== value.bodyNonce
      ) {
        throw blobError('corrupt', 'S3 blob metadata does not match its row');
      }
      return { metadata: value, dataKey };
    } catch (error) {
      dataKey?.fill(0);
      if (error instanceof BlobStoreError) throw error;
      if (error instanceof StorageEncryptionError) {
        throw blobError(
          'corrupt',
          'S3 blob metadata authentication failed',
          error
        );
      }
      throw blobError('corrupt', 'Unable to decrypt S3 blob metadata', error);
    }
  }

  private async assertPhysicalObject(
    metadata: StoredS3BlobMetadata,
    signal?: AbortSignal
  ): Promise<void> {
    try {
      const head = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: metadata.objectKey }),
        { abortSignal: signal }
      );
      if (
        head.ContentLength !== metadata.encryptedBytes ||
        head.Metadata?.['libre-format'] !== String(FORMAT_VERSION)
      ) {
        throw blobError('corrupt', 'S3 blob object metadata is inconsistent');
      }
    } catch (error) {
      if (error instanceof BlobStoreError) throw error;
      if (isNotFound(error)) {
        throw blobError('corrupt', 'S3 blob object is missing', error);
      }
      if (signal?.aborted) throwIfAborted(signal);
      throw blobError('unavailable', 'Unable to inspect S3 blob object', error);
    }
  }

  /**
   * Resolve a commit acknowledgement loss from authoritative SQL while the
   * per-object lifecycle lock is still held. A complete metadata/quota commit
   * is authenticated against the just-uploaded object and returned as
   * success. Only a provably absent outcome permits physical purge; any
   * partial/mismatched state is preserved for fail-closed reconciliation.
   */
  private async resolvePutCommitOutcome(
    executor: PostgresQueryExecutor,
    expected: StoredS3BlobMetadata,
    signal?: AbortSignal
  ): Promise<'absent' | { descriptor: BlobDescriptor }> {
    const metadataResult = await executor.query<BlobObjectRow>(
      `SELECT id, owner_user_id, purpose, object_key, encrypted_bytes,
              plaintext_bytes, plaintext_sha256, ciphertext_sha256,
              wrapped_data_key, metadata_iv, metadata_tag, encrypted_metadata,
              state, created_at, updated_at
         FROM platform_blob_objects
        WHERE id = $1 OR object_key = $2
        ORDER BY id`,
      [expected.id, expected.objectKey]
    );
    const quotaResult = await executor.query<BlobQuotaObjectRow>(
      `SELECT blob_id, owner_user_id, purpose, stored_bytes
         FROM platform_blob_quota_objects
        WHERE blob_id = $1`,
      [expected.id]
    );
    if (metadataResult.rowCount === 0 && quotaResult.rowCount === 0) {
      return 'absent';
    }
    if (metadataResult.rowCount !== 1 || quotaResult.rowCount !== 1) {
      throw blobError(
        'corrupt',
        'S3 blob commit outcome is inconsistent; uploaded evidence was preserved'
      );
    }
    const row = metadataResult.rows[0]!;
    const quota = quotaResult.rows[0]!;
    const opened = this.decryptMetadata(row);
    try {
      const actual = opened.metadata;
      if (
        row.state !== 'ready' ||
        quota.blob_id !== expected.id ||
        quota.owner_user_id !== expected.ownerUserId ||
        quota.purpose !== expected.purpose ||
        safeInteger(quota.stored_bytes, 'quota stored byte count') !==
          expected.size ||
        actual.id !== expected.id ||
        actual.ownerUserId !== expected.ownerUserId ||
        actual.purpose !== expected.purpose ||
        actual.contentType !== expected.contentType ||
        actual.originalFilename !== expected.originalFilename ||
        JSON.stringify(actual.metadata) !== JSON.stringify(expected.metadata) ||
        actual.objectKey !== expected.objectKey ||
        actual.size !== expected.size ||
        actual.sha256 !== expected.sha256 ||
        actual.ciphertextSha256 !== expected.ciphertextSha256 ||
        actual.encryptedBytes !== expected.encryptedBytes ||
        actual.chunkBytes !== expected.chunkBytes ||
        actual.chunkCount !== expected.chunkCount ||
        actual.bodyNonce !== expected.bodyNonce ||
        actual.createdAt !== expected.createdAt ||
        actual.encryptionKeyId !== expected.encryptionKeyId
      ) {
        throw blobError(
          'corrupt',
          'S3 blob commit outcome does not match the attempted upload; uploaded evidence was preserved'
        );
      }
      await this.assertPhysicalObject(actual, signal);
      return { descriptor: publicDescriptor(actual) };
    } finally {
      opened.dataKey.fill(0);
    }
  }

  async put(request: BlobPutRequest): Promise<BlobDescriptor> {
    return this.putInternal(request);
  }

  /**
   * Storage-migration seam. A deterministic ID makes a crash after S3 upload
   * but before the import ledger commit recoverable without duplicating data.
   */
  async putWithId(
    request: BlobPutRequest,
    id: string,
    createdAt?: string
  ): Promise<BlobDescriptor> {
    validateBlobId(id);
    if (createdAt !== undefined && !Number.isFinite(Date.parse(createdAt))) {
      throw blobError('invalid-input', 'Invalid migrated blob creation time');
    }
    return this.putInternal(request, id, createdAt);
  }

  private async putInternal(
    request: BlobPutRequest,
    requestedId?: string,
    requestedCreatedAt?: string
  ): Promise<BlobDescriptor> {
    throwIfAborted(request.signal);
    const normalizedMetadata = validatePutRequest(request, this.maxObjectBytes);
    const id = requestedId ?? crypto.randomUUID();
    const objectKey = this.objectKey(id);
    return this.withObjectLifecycleLock(
      objectKey,
      async executor => {
        const existing = await executor.query(
          'SELECT 1 FROM platform_blob_objects WHERE object_key = $1',
          [objectKey]
        );
        if (existing.rowCount !== 0) {
          throw blobError('invalid-input', 'S3 blob ID already exists');
        }
        const reservation = await this.quotaPolicy.reserve({
          ownerUserId: request.ownerUserId,
          purpose: request.purpose,
          ...(request.expectedSize !== undefined
            ? { expectedSize: request.expectedSize }
            : {}),
        });
        return this.putLocked(
          request,
          id,
          objectKey,
          requestedCreatedAt,
          normalizedMetadata,
          reservation
        );
      },
      request.ownerUserId
    );
  }

  private async putLocked(
    request: BlobPutRequest,
    id: string,
    objectKey: string,
    requestedCreatedAt: string | undefined,
    normalizedMetadata: Readonly<Record<string, string>>,
    reservation: BlobQuotaReservation
  ): Promise<BlobDescriptor> {
    this.activeObjectKeys.add(objectKey);
    const dataKey = crypto.randomBytes(32);
    const bodyNonce = crypto.randomBytes(BODY_NONCE_BYTES);
    const plaintextDigest = crypto.createHash('sha256');
    const ciphertextDigest = crypto.createHash('sha256');
    let size = 0;
    let chunkCount = 0;
    let encryptedBytes = 0;
    let uploaded = false;
    let metadataCommitted = false;
    let storedMetadata: StoredS3BlobMetadata | undefined;

    const encryptedBody = (async function* (
      store: S3EncryptedBlobStore
    ): AsyncGenerator<Buffer> {
      for await (const chunk of fixedChunks(
        request.source,
        store.chunkBytes,
        request.signal
      )) {
        const nextSize = size + chunk.length;
        if (nextSize > store.maxObjectBytes) {
          throw blobError(
            'quota-exceeded',
            'Blob exceeds the maximum object size'
          );
        }
        await reservation.consume(chunk.length);
        const cipher = crypto.createCipheriv(
          'aes-256-gcm',
          dataKey,
          createChunkIv(bodyNonce, chunkCount)
        );
        cipher.setAAD(
          chunkAad(
            { id, ownerUserId: request.ownerUserId, purpose: request.purpose },
            chunkCount,
            chunk.length
          )
        );
        const ciphertext = Buffer.concat([
          cipher.update(chunk),
          cipher.final(),
        ]);
        const tag = cipher.getAuthTag();
        plaintextDigest.update(chunk);
        ciphertextDigest.update(ciphertext);
        ciphertextDigest.update(tag);
        size = nextSize;
        chunkCount += 1;
        encryptedBytes += ciphertext.length + tag.length;
        yield ciphertext;
        yield tag;
      }
    })(this);

    const upload = new Upload({
      client: this.client,
      params: {
        Bucket: this.bucket,
        Key: objectKey,
        Body: Readable.from(encryptedBody, { objectMode: false }),
        ContentType: 'application/octet-stream',
        Metadata: { 'libre-format': String(FORMAT_VERSION) },
      },
      partSize: this.multipartPartBytes,
      queueSize: this.multipartConcurrency,
      leavePartsOnError: false,
    });
    const abortUpload = (): void => {
      void upload.abort();
    };
    request.signal?.addEventListener('abort', abortUpload, { once: true });

    try {
      await upload.done();
      uploaded = true;
      throwIfAborted(request.signal);
      if (request.expectedSize !== undefined && request.expectedSize !== size) {
        throw blobError(
          'invalid-input',
          `Expected ${request.expectedSize} blob bytes but received ${size}`
        );
      }

      const wrappedDataKey = this.keyring.encrypt(dataKey, keyAad(id));
      const createdAt = requestedCreatedAt
        ? new Date(requestedCreatedAt)
        : this.now();
      const metadata: StoredS3BlobMetadata = {
        id,
        ownerUserId: request.ownerUserId,
        purpose: request.purpose,
        contentType: request.contentType,
        ...(request.originalFilename
          ? { originalFilename: request.originalFilename }
          : {}),
        metadata: normalizedMetadata,
        size,
        sha256: plaintextDigest.digest('hex'),
        createdAt: createdAt.toISOString(),
        encryptionKeyId: wrappedDataKey.keyId,
        formatVersion: FORMAT_VERSION,
        objectKey,
        chunkBytes: this.chunkBytes,
        chunkCount,
        bodyNonce: bodyNonce.toString('base64'),
        encryptedBytes,
        ciphertextSha256: ciphertextDigest.digest('hex'),
      };
      storedMetadata = metadata;
      const metadataPlaintext = Buffer.from(JSON.stringify(metadata), 'utf8');
      if (metadataPlaintext.length > MAX_METADATA_BYTES) {
        throw blobError('invalid-input', 'Blob metadata is too large');
      }
      const metadataIv = crypto.randomBytes(METADATA_IV_BYTES);
      const cipher = crypto.createCipheriv('aes-256-gcm', dataKey, metadataIv);
      cipher.setAAD(metadataAad(id, objectKey));
      const encryptedMetadata = Buffer.concat([
        cipher.update(metadataPlaintext),
        cipher.final(),
      ]);
      metadataPlaintext.fill(0);
      const now = createdAt.getTime();

      const descriptor = publicDescriptor(metadata);
      const insertMetadata = async (executor: PostgresQueryExecutor) => {
        await executor.query(
          `INSERT INTO platform_blob_objects (
             id, owner_user_id, purpose, object_key, encrypted_bytes,
             plaintext_bytes, plaintext_sha256, ciphertext_sha256,
             wrapped_data_key, metadata_iv, metadata_tag, encrypted_metadata,
             state, created_at, updated_at
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12,
             'ready', $13, $13
           )`,
          [
            id,
            request.ownerUserId,
            request.purpose,
            objectKey,
            encryptedBytes,
            size,
            metadata.sha256,
            metadata.ciphertextSha256,
            JSON.stringify(wrappedDataKey),
            metadataIv,
            cipher.getAuthTag(),
            encryptedMetadata,
            now,
          ]
        );
      };
      const transactionalReservation =
        reservation as TransactionalBlobQuotaReservation;
      if (transactionalReservation.commitWithMetadata) {
        await transactionalReservation.commitWithMetadata(
          descriptor,
          executor => insertMetadata(executor as PostgresQueryExecutor)
        );
      } else {
        await insertMetadata(this.database);
        await reservation.commit(descriptor);
      }
      metadataCommitted = true;
      return descriptor;
    } catch (error) {
      if (uploaded && !metadataCommitted) {
        let outcome: 'absent' | { descriptor: BlobDescriptor };
        try {
          if (!storedMetadata) {
            await this.purgeExactObjectVersions(objectKey);
          } else {
            outcome = await this.resolvePutCommitOutcome(
              this.database,
              storedMetadata,
              request.signal
            );
            if (outcome !== 'absent') {
              metadataCommitted = true;
              return outcome.descriptor;
            }
            await this.purgeExactObjectVersions(objectKey, request.signal);
          }
        } catch (resolutionError) {
          if (resolutionError instanceof BlobStoreError) throw resolutionError;
          throw blobError(
            'unavailable',
            'Unable to resolve the S3 blob commit outcome; uploaded evidence was preserved',
            resolutionError
          );
        }
      }
      if (error instanceof BlobStoreError) throw error;
      if (request.signal?.aborted) throwIfAborted(request.signal);
      throw blobError(
        'unavailable',
        'Unable to store encrypted S3 blob',
        error
      );
    } finally {
      request.signal?.removeEventListener('abort', abortUpload);
      this.activeObjectKeys.delete(objectKey);
      dataKey.fill(0);
      if (!metadataCommitted) await reservation.release();
    }
  }

  async stat(id: string, ownerUserId: string): Promise<BlobDescriptor> {
    const row = await this.row(id, ownerUserId);
    if (!row) throw new BlobNotFoundError();
    const opened = this.decryptMetadata(row);
    try {
      await this.assertPhysicalObject(opened.metadata);
      return publicDescriptor(opened.metadata);
    } finally {
      opened.dataKey.fill(0);
    }
  }

  async health(): Promise<boolean> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    this.client.destroy();
  }

  private normalizeRange(
    metadata: StoredS3BlobMetadata,
    request: BlobReadRequest
  ): BlobContentRange | null {
    if (!request.range) return null;
    if (metadata.size === 0) {
      throw blobError('invalid-range', 'Empty blobs do not support ranges');
    }
    const requestedEnd = request.range.end ?? metadata.size - 1;
    if (
      !Number.isSafeInteger(request.range.start) ||
      !Number.isSafeInteger(requestedEnd) ||
      request.range.start < 0 ||
      request.range.start >= metadata.size ||
      requestedEnd < request.range.start
    ) {
      throw blobError('invalid-range', 'Invalid blob byte range');
    }
    const end = Math.min(requestedEnd, metadata.size - 1);
    return {
      start: request.range.start,
      end,
      total: metadata.size,
      length: end - request.range.start + 1,
    };
  }

  async open(request: BlobReadRequest): Promise<BlobReadResult> {
    throwIfAborted(request.signal);
    const row = await this.row(request.id, request.ownerUserId);
    if (!row) throw new BlobNotFoundError();
    const opened = this.decryptMetadata(row);
    const { metadata, dataKey } = opened;
    let range: BlobContentRange | null;
    try {
      range = this.normalizeRange(metadata, request);
    } catch (error) {
      dataKey.fill(0);
      throw error;
    }
    const start = range?.start ?? 0;
    const end = range?.end ?? metadata.size - 1;
    const firstChunk =
      metadata.size === 0 ? 0 : Math.floor(start / metadata.chunkBytes);
    const finalChunk =
      metadata.size === 0 ? -1 : Math.floor(end / metadata.chunkBytes);
    const encryptedStart = firstChunk * (metadata.chunkBytes + AUTH_TAG_BYTES);
    const finalPlaintextBytes =
      finalChunk < 0
        ? 0
        : Math.min(
            metadata.chunkBytes,
            metadata.size - finalChunk * metadata.chunkBytes
          );
    const encryptedEnd =
      finalChunk < 0
        ? -1
        : finalChunk * (metadata.chunkBytes + AUTH_TAG_BYTES) +
          finalPlaintextBytes +
          AUTH_TAG_BYTES -
          1;
    const fullRead = range === null;

    let response: GetObjectCommandOutput;
    try {
      response = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: metadata.objectKey,
          ...(metadata.size > 0 && !fullRead
            ? { Range: `bytes=${encryptedStart}-${encryptedEnd}` }
            : {}),
        }),
        { abortSignal: request.signal }
      );
    } catch (error) {
      dataKey.fill(0);
      if (isNotFound(error)) {
        throw blobError('corrupt', 'S3 blob object is missing', error);
      }
      if (request.signal?.aborted) throwIfAborted(request.signal);
      throw blobError('unavailable', 'Unable to open S3 blob object', error);
    }

    const rawBody = (response as { Body?: unknown }).Body;
    let source: AsyncIterable<Uint8Array>;
    try {
      source = asyncIterableBody(rawBody);
    } catch (error) {
      dataKey.fill(0);
      throw error;
    }
    const reader = new AsyncByteReader(source);
    const bodyNonce = Buffer.from(metadata.bodyNonce, 'base64');
    let disposed = false;
    const dispose = async (): Promise<void> => {
      if (disposed) return;
      disposed = true;
      dataKey.fill(0);
      await reader.close().catch(() => undefined);
      const destroy = (rawBody as { destroy?: () => void } | undefined)
        ?.destroy;
      destroy?.call(rawBody);
    };

    const iterator = (async function* (): AsyncGenerator<Buffer> {
      const plaintextDigest = fullRead ? crypto.createHash('sha256') : null;
      const ciphertextDigest = fullRead ? crypto.createHash('sha256') : null;
      try {
        for (let index = firstChunk; index <= finalChunk; index += 1) {
          throwIfAborted(request.signal);
          const chunkStart = index * metadata.chunkBytes;
          const plaintextBytes = Math.min(
            metadata.chunkBytes,
            metadata.size - chunkStart
          );
          const encrypted = await reader.readExactly(
            plaintextBytes + AUTH_TAG_BYTES
          );
          ciphertextDigest?.update(encrypted);
          let plaintext: Buffer;
          try {
            const decipher = crypto.createDecipheriv(
              'aes-256-gcm',
              dataKey,
              createChunkIv(bodyNonce, index),
              { authTagLength: AUTH_TAG_BYTES }
            );
            decipher.setAAD(chunkAad(metadata, index, plaintextBytes));
            decipher.setAuthTag(encrypted.subarray(plaintextBytes));
            plaintext = Buffer.concat([
              decipher.update(encrypted.subarray(0, plaintextBytes)),
              decipher.final(),
            ]);
          } catch (error) {
            throw blobError(
              'corrupt',
              'Encrypted S3 blob chunk authentication failed',
              error
            );
          }
          plaintextDigest?.update(plaintext);
          const sliceStart = Math.max(start - chunkStart, 0);
          const sliceEnd = Math.min(end - chunkStart + 1, plaintext.length);
          if (sliceEnd > sliceStart)
            yield plaintext.subarray(sliceStart, sliceEnd);
        }
        await reader.assertEnd();
        if (
          fullRead &&
          (plaintextDigest?.digest('hex') !== metadata.sha256 ||
            ciphertextDigest?.digest('hex') !== metadata.ciphertextSha256)
        ) {
          throw blobError('corrupt', 'Encrypted S3 blob checksum mismatch');
        }
      } finally {
        await dispose();
      }
    })();

    const body = Readable.from(iterator, { objectMode: false });
    body.once('close', () => {
      void dispose();
    });
    return { descriptor: publicDescriptor(metadata), range, body };
  }

  /** Offline migration rollback seam for an upload that never gained SQL. */
  async purgeUntrackedObject(id: string, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    const objectKey = this.objectKey(id);
    await this.withObjectLifecycleLock(objectKey, async executor => {
      const tracked = await executor.query(
        'SELECT 1 FROM platform_blob_objects WHERE object_key = $1',
        [objectKey]
      );
      if (tracked.rowCount !== 0) {
        throw blobError(
          'invalid-input',
          'Refusing to purge a tracked S3 blob object'
        );
      }
      await this.purgeExactObjectVersions(objectKey, signal);
    });
  }

  async delete(request: {
    id: string;
    ownerUserId: string;
    signal?: AbortSignal;
  }): Promise<boolean> {
    throwIfAborted(request.signal);
    const objectKey = this.objectKey(request.id);
    return this.withObjectLifecycleLock(
      objectKey,
      async executor => {
        const anyOwner = await executor.query<{ owner_user_id: string }>(
          'SELECT owner_user_id FROM platform_blob_objects WHERE id = $1',
          [request.id]
        );
        if (
          anyOwner.rows[0] &&
          anyOwner.rows[0].owner_user_id !== request.ownerUserId
        ) {
          return false;
        }
        const row = await this.row(
          request.id,
          request.ownerUserId,
          true,
          executor
        );
        if (!row) {
          await this.purgeExactObjectVersions(objectKey, request.signal);
          if ('releaseStored' in this.quotaPolicy) {
            await (
              this.quotaPolicy as BlobQuotaPolicy & {
                releaseStored(input: {
                  id: string;
                  ownerUserId: string;
                }): Promise<void>;
              }
            ).releaseStored({
              id: request.id,
              ownerUserId: request.ownerUserId,
            });
          }
          return false;
        }
        await executor.query(
          `UPDATE platform_blob_objects
            SET state = 'deleting', updated_at = $3
          WHERE id = $1 AND owner_user_id = $2`,
          [request.id, request.ownerUserId, this.now().getTime()]
        );
        try {
          await this.purgeExactObjectVersions(row.object_key, request.signal);
          await this.finalizeDeletingRow(row);
          return true;
        } catch (error) {
          if (request.signal?.aborted) throwIfAborted(request.signal);
          if (error instanceof BlobStoreError) throw error;
          throw blobError(
            'unavailable',
            'Unable to delete S3 blob object',
            error
          );
        }
      },
      request.ownerUserId
    );
  }

  private async finalizeDeletingRow(
    row: Pick<BlobObjectRow, 'id' | 'owner_user_id'>
  ): Promise<number> {
    let removed = 0;
    const deleteMetadata = async (executor: PostgresQueryExecutor) => {
      const deleted = await executor.query(
        `DELETE FROM platform_blob_objects
          WHERE id = $1 AND owner_user_id = $2 AND state = 'deleting'`,
        [row.id, row.owner_user_id]
      );
      removed = deleted.rowCount ?? 0;
    };
    const transactionalQuota = this.quotaPolicy as TransactionalBlobQuotaPolicy;
    if (transactionalQuota.releaseStoredWithMetadata) {
      await transactionalQuota.releaseStoredWithMetadata(
        { id: row.id, ownerUserId: row.owner_user_id },
        executor => deleteMetadata(executor as PostgresQueryExecutor)
      );
    } else {
      await deleteMetadata(this.database);
      if ('releaseStored' in this.quotaPolicy) {
        await (
          this.quotaPolicy as BlobQuotaPolicy & {
            releaseStored(input: {
              id: string;
              ownerUserId: string;
            }): Promise<void>;
          }
        ).releaseStored({ id: row.id, ownerUserId: row.owner_user_id });
      }
    }
    return removed;
  }

  private async resumeDeletes(
    limit: number,
    signal?: AbortSignal
  ): Promise<number> {
    const rows = await this.database.query<
      Pick<BlobObjectRow, 'id' | 'owner_user_id' | 'object_key'>
    >(
      `SELECT id, owner_user_id, object_key
         FROM platform_blob_objects
        WHERE state = 'deleting'
        ORDER BY updated_at, id
        LIMIT $1`,
      [limit]
    );
    let resumed = 0;
    for (const row of rows.rows) {
      throwIfAborted(signal);
      resumed += await this.withObjectLifecycleLock(
        row.object_key,
        async executor => {
          const current = await this.row(
            row.id,
            row.owner_user_id,
            true,
            executor
          );
          if (!current || current.state !== 'deleting') return 0;
          await this.purgeExactObjectVersions(current.object_key, signal);
          return this.finalizeDeletingRow(current);
        },
        row.owner_user_id
      );
    }
    return resumed;
  }

  async reconcileOrphans(
    options: S3BlobReconciliationOptions
  ): Promise<S3BlobReconciliationResult> {
    if (!Number.isFinite(options.olderThan.getTime())) {
      throw blobError('invalid-input', 'Invalid S3 blob orphan cutoff');
    }
    const maxObjects = options.maxObjects ?? MAX_RECORDS_PER_RECONCILIATION;
    if (!Number.isSafeInteger(maxObjects) || maxObjects <= 0) {
      throw blobError(
        'invalid-input',
        'Invalid S3 reconciliation object limit'
      );
    }
    if (
      options.continuationToken !== undefined &&
      (typeof options.continuationToken !== 'string' ||
        options.continuationToken.length === 0 ||
        Buffer.byteLength(options.continuationToken, 'utf8') > 8192)
    ) {
      throw blobError('invalid-input', 'Invalid S3 reconciliation cursor');
    }
    const resumedDeletes = await this.resumeDeletes(maxObjects, options.signal);
    let afterKey = decodeReconciliationCursor(
      options.continuationToken
    )?.afterKey;
    if (afterKey && !afterKey.startsWith(`${this.keyPrefix}/v1/`)) {
      throw blobError('invalid-input', 'Invalid S3 reconciliation cursor');
    }
    let deletedOrphans = 0;
    let inspectedObjects = 0;
    let complete = false;
    while (inspectedObjects < maxObjects) {
      throwIfAborted(options.signal);
      const remaining = maxObjects - inspectedObjects;
      const page = await this.client.send(
        new ListObjectVersionsCommand({
          Bucket: this.bucket,
          Prefix: `${this.keyPrefix}/v1/`,
          MaxKeys: Math.min(1_000, remaining),
          ...(afterKey ? { KeyMarker: afterKey } : {}),
        }),
        { abortSignal: options.signal }
      );
      const keys = [
        ...(page.Versions ?? []).map(item => item.Key),
        ...(page.DeleteMarkers ?? []).map(item => item.Key),
      ]
        .filter((key): key is string => Boolean(key))
        .filter((key, index, values) => values.indexOf(key) === index)
        .sort();
      if (keys.length === 0) {
        complete = true;
        afterKey = undefined;
        break;
      }
      for (const objectKey of keys) {
        throwIfAborted(options.signal);
        inspectedObjects += 1;
        afterKey = objectKey;
        if (!this.managedObjectId(objectKey)) continue;
        if (this.activeObjectKeys.has(objectKey)) continue;
        deletedOrphans += await this.withObjectLifecycleLock(
          objectKey,
          async executor => {
            const reference = await executor.query<{ id: string }>(
              'SELECT id FROM platform_blob_objects WHERE object_key = $1',
              [objectKey]
            );
            if (reference.rows.length > 0) return 0;
            const versions = await this.listExactObjectVersions(
              objectKey,
              options.signal
            );
            if (
              versions.length === 0 ||
              versions.some(
                version =>
                  !version.lastModified ||
                  version.lastModified.getTime() >= options.olderThan.getTime()
              )
            ) {
              return 0;
            }
            await this.purgeExactObjectVersions(objectKey, options.signal);
            return 1;
          }
        );
        if (inspectedObjects >= maxObjects) break;
      }
    }
    return {
      deletedOrphans,
      resumedDeletes,
      inspectedObjects,
      complete,
      ...(!complete && afterKey
        ? {
            continuationToken: encodeReconciliationCursor({
              version: 1,
              afterKey,
            }),
          }
        : {}),
    };
  }

  async verifyIntegrity(
    options: S3BlobIntegrityOptions = {}
  ): Promise<S3BlobIntegrityResult> {
    const maxObjects = options.maxObjects ?? 250_000;
    const maxEncryptedBytes =
      options.maxEncryptedBytes ?? 64 * 1024 * 1024 * 1024;
    const maxPlaintextBytes =
      options.maxPlaintextBytes ?? 64 * 1024 * 1024 * 1024;
    for (const [value, name] of [
      [maxObjects, 'object'],
      [maxEncryptedBytes, 'encrypted-byte'],
      [maxPlaintextBytes, 'plaintext-byte'],
    ] as const) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw blobError('invalid-input', `Invalid S3 integrity ${name} limit`);
      }
    }
    const aggregate = await this.database.query<{
      objects: string | number;
      encrypted_bytes: string | number;
      plaintext_bytes: string | number;
    }>(
      `SELECT COUNT(*) AS objects,
              COALESCE(SUM(encrypted_bytes), 0) AS encrypted_bytes,
              COALESCE(SUM(plaintext_bytes), 0) AS plaintext_bytes
         FROM platform_blob_objects
        WHERE state = 'ready'`
    );
    const objects = safeInteger(
      aggregate.rows[0]?.objects ?? 0,
      'object count'
    );
    const encryptedBytes = safeInteger(
      aggregate.rows[0]?.encrypted_bytes ?? 0,
      'encrypted byte total'
    );
    const plaintextBytes = safeInteger(
      aggregate.rows[0]?.plaintext_bytes ?? 0,
      'plaintext byte total'
    );
    if (
      objects > maxObjects ||
      encryptedBytes > maxEncryptedBytes ||
      plaintextBytes > maxPlaintextBytes
    ) {
      throw blobError(
        'verification-limit',
        'S3 blob storage exceeds bounded integrity verification limits'
      );
    }
    const rows = await this.database.query<{
      id: string;
      owner_user_id: string;
    }>(
      `SELECT id, owner_user_id
         FROM platform_blob_objects
        WHERE state = 'ready'
        ORDER BY id`
    );
    for (const row of rows.rows) {
      throwIfAborted(options.signal);
      const opened = await this.open({
        id: row.id,
        ownerUserId: row.owner_user_id,
        signal: options.signal,
      });
      for await (const _chunk of opened.body) {
        // Authentication and both checksums are verified by a complete read.
      }
    }
    return { objects, encryptedBytes, plaintextBytes };
  }
}

export const createS3EncryptedBlobStore = (
  options: Omit<
    S3EncryptedBlobStoreOptions,
    'client' | 'bucket' | 'keyPrefix'
  > & {
    env?: S3BlobEnvironment;
  }
): S3EncryptedBlobStore => {
  const configuration = resolveS3BlobConfiguration(options.env ?? process.env);
  return new S3EncryptedBlobStore({
    ...options,
    client: new S3Client(configuration.clientConfig),
    bucket: configuration.bucket,
    keyPrefix: configuration.keyPrefix,
  });
};
