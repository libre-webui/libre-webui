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

import crypto from 'node:crypto';
import fs from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  opendir,
  readdir,
  rename,
  stat,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import {
  Aes256GcmKeyring,
  parseAesGcmEnvelope,
  StorageEncryptionError,
} from './aesGcmKeyring.js';
import {
  BlobNotFoundError,
  BlobStoreError,
  NoopBlobQuotaPolicy,
  type BlobContentRange,
  type BlobDescriptor,
  type BlobPutRequest,
  type BlobQuotaPolicy,
  type BlobReadRequest,
  type BlobReadResult,
  type BlobStore,
} from './blobStore.js';

const FILE_MAGIC = Buffer.from('LWBLB001', 'ascii');
const FILE_FORMAT_VERSION = 1;
const METADATA_IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const BODY_NONCE_BYTES = 8;
const PREFIX_BYTES =
  FILE_MAGIC.length + 1 + 4 + 4 + METADATA_IV_BYTES + AUTH_TAG_BYTES;
const MAX_KEY_ENVELOPE_BYTES = 8 * 1024;
const MAX_METADATA_BYTES = 64 * 1024;
const DEFAULT_CHUNK_BYTES = 1024 * 1024;
const DEFAULT_MAX_OBJECT_BYTES = 512 * 1024 * 1024;
const DEFAULT_MAX_INTEGRITY_OBJECTS = 250_000;
const DEFAULT_MAX_INTEGRITY_ENCRYPTED_BYTES = 64 * 1024 * 1024 * 1024;
const DEFAULT_MAX_INTEGRITY_PLAINTEXT_BYTES = 64 * 1024 * 1024 * 1024;
const MIN_CHUNK_BYTES = 64 * 1024;
const MAX_CHUNK_BYTES = 8 * 1024 * 1024;
const BLOB_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PURPOSE_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,63}$/;
const METADATA_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

interface StoredBlobMetadata extends BlobDescriptor {
  chunkBytes: number;
  chunkCount: number;
  bodyNonce: string;
}

interface OpenedBlob {
  handle: fs.promises.FileHandle;
  metadata: StoredBlobMetadata;
  dataKey: Buffer;
  bodyOffset: number;
}

/** Zero key material before any asynchronous close can fail or be delayed. */
const disposeOpenedBlob = async (opened: OpenedBlob): Promise<void> => {
  opened.dataKey.fill(0);
  await opened.handle.close();
};

export interface LocalEncryptedBlobStoreOptions {
  rootDirectory: string;
  keyring: Aes256GcmKeyring;
  quotaPolicy?: BlobQuotaPolicy;
  chunkBytes?: number;
  maxObjectBytes?: number;
  now?: () => Date;
}

export interface BlobOrphanCleanupOptions {
  /**
   * Only objects older than this instant are considered. The grace period is
   * what makes a crash between rename and relational metadata commit safe.
   */
  olderThan: Date;
  isReferenced: (blobId: string) => Promise<boolean>;
  signal?: AbortSignal;
}

export interface BlobOrphanCleanupResult {
  deletedObjects: number;
  deletedStagingFiles: number;
  retainedObjects: number;
}

export interface BlobIntegrityVerificationOptions {
  /** Fail closed instead of traversing an unexpectedly large object set. */
  maxObjects?: number;
  /** Maximum aggregate on-disk bytes authenticated by this invocation. */
  maxEncryptedBytes?: number;
  /** Maximum aggregate plaintext bytes authenticated by this invocation. */
  maxPlaintextBytes?: number;
  signal?: AbortSignal;
}

export interface BlobIntegrityVerificationResult {
  objects: number;
  encryptedBytes: number;
  plaintextBytes: number;
}

interface BlobIntegrityCandidate {
  id: string;
  stat: fs.Stats;
}

const storageError = (
  code: ConstructorParameters<typeof BlobStoreError>[0],
  message: string,
  cause?: unknown
): BlobStoreError => new BlobStoreError(code, message, cause);

const throwIfAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) {
    throw storageError('aborted', 'Blob operation was aborted', signal.reason);
  }
};

const validateBoundedString = (
  value: string,
  field: string,
  maximumLength: number
): void => {
  if (
    !value ||
    value.length > maximumLength ||
    [...value].some(character => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || codePoint === 127;
    })
  ) {
    throw storageError('invalid-input', `Invalid blob ${field}`);
  }
};

const validateBlobId = (id: string): void => {
  if (!BLOB_ID_PATTERN.test(id)) {
    throw new BlobNotFoundError();
  }
};

const validateIntegrityLimit = (value: number, description: string): void => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw storageError('invalid-input', `Invalid ${description}`);
  }
};

const ownerMatches = (expected: string, actual: string): boolean => {
  const expectedHash = crypto.createHash('sha256').update(expected).digest();
  const actualHash = crypto.createHash('sha256').update(actual).digest();
  return crypto.timingSafeEqual(expectedHash, actualHash);
};

const metadataAad = (blobId: string): Buffer =>
  Buffer.from(JSON.stringify(['libre-blob-metadata', 1, blobId]), 'utf8');

const keyAad = (blobId: string): Buffer =>
  Buffer.from(JSON.stringify(['libre-blob-key', 1, blobId]), 'utf8');

const chunkAad = (
  metadata: Pick<StoredBlobMetadata, 'id' | 'ownerUserId' | 'purpose'>,
  chunkIndex: number,
  plaintextBytes: number
): Buffer =>
  Buffer.from(
    JSON.stringify([
      'libre-blob-chunk',
      1,
      metadata.id,
      metadata.ownerUserId,
      metadata.purpose,
      chunkIndex,
      plaintextBytes,
    ]),
    'utf8'
  );

const createChunkIv = (baseNonce: Buffer, chunkIndex: number): Buffer => {
  if (baseNonce.length !== BODY_NONCE_BYTES) {
    throw storageError('corrupt', 'Invalid encrypted blob nonce');
  }
  if (chunkIndex < 0 || chunkIndex > 0xffffffff) {
    throw storageError('corrupt', 'Encrypted blob has too many chunks');
  }
  const iv = Buffer.allocUnsafe(12);
  baseNonce.copy(iv, 0);
  iv.writeUInt32BE(chunkIndex, BODY_NONCE_BYTES);
  return iv;
};

const writeAll = async (
  handle: fs.promises.FileHandle,
  data: Uint8Array
): Promise<void> => {
  let offset = 0;
  while (offset < data.length) {
    const { bytesWritten } = await handle.write(
      data,
      offset,
      data.length - offset
    );
    if (bytesWritten <= 0) {
      throw storageError('unavailable', 'Unable to write encrypted blob');
    }
    offset += bytesWritten;
  }
};

const readExactly = async (
  handle: fs.promises.FileHandle,
  length: number,
  position: number
): Promise<Buffer> => {
  const buffer = Buffer.allocUnsafe(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await handle.read(
      buffer,
      offset,
      length - offset,
      position + offset
    );
    if (bytesRead <= 0) {
      throw storageError('corrupt', 'Encrypted blob is truncated');
    }
    offset += bytesRead;
  }
  return buffer;
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
      const required = chunkBytes - carry.length;
      if (input.length < required) {
        carry = Buffer.concat([carry, input], carry.length + input.length);
        continue;
      }
      yield Buffer.concat([carry, input.subarray(0, required)], chunkBytes);
      carry = Buffer.alloc(0);
      input = input.subarray(required);
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

const parseJson = (value: Buffer, description: string): unknown => {
  try {
    return JSON.parse(value.toString('utf8')) as unknown;
  } catch (error) {
    throw storageError(
      'corrupt',
      `Invalid encrypted blob ${description}`,
      error
    );
  }
};

const normalizeMetadata = (
  metadata: Readonly<Record<string, string>> | undefined
): Readonly<Record<string, string>> => {
  const entries = Object.entries(metadata ?? {});
  if (entries.length > 32) {
    throw storageError('invalid-input', 'Blob metadata has too many fields');
  }

  const normalized: Record<string, string> = {};
  for (const [key, value] of entries.sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    if (!METADATA_KEY_PATTERN.test(key)) {
      throw storageError('invalid-input', `Invalid blob metadata key: ${key}`);
    }
    if (
      typeof value !== 'string' ||
      Buffer.byteLength(value, 'utf8') > 4096 ||
      value.includes('\u0000')
    ) {
      throw storageError(
        'invalid-input',
        `Invalid blob metadata value: ${key}`
      );
    }
    normalized[key] = value;
  }
  return Object.freeze(normalized);
};

const validateRequest = (
  request: BlobPutRequest,
  maxObjectBytes: number
): Readonly<Record<string, string>> => {
  validateBoundedString(request.ownerUserId, 'owner', 256);
  if (!PURPOSE_PATTERN.test(request.purpose)) {
    throw storageError('invalid-input', 'Invalid blob purpose');
  }
  validateBoundedString(request.contentType, 'content type', 255);
  if (request.originalFilename !== undefined) {
    validateBoundedString(request.originalFilename, 'filename', 255);
  }
  if (
    request.expectedSize !== undefined &&
    (!Number.isSafeInteger(request.expectedSize) ||
      request.expectedSize < 0 ||
      request.expectedSize > maxObjectBytes)
  ) {
    throw storageError('invalid-input', 'Invalid expected blob size');
  }
  return normalizeMetadata(request.metadata);
};

const isStoredBlobMetadata = (value: unknown): value is StoredBlobMetadata => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<StoredBlobMetadata>;
  return (
    typeof candidate.id === 'string' &&
    BLOB_ID_PATTERN.test(candidate.id) &&
    typeof candidate.ownerUserId === 'string' &&
    candidate.ownerUserId.length > 0 &&
    typeof candidate.purpose === 'string' &&
    PURPOSE_PATTERN.test(candidate.purpose) &&
    typeof candidate.contentType === 'string' &&
    typeof candidate.size === 'number' &&
    Number.isSafeInteger(candidate.size) &&
    candidate.size >= 0 &&
    typeof candidate.sha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(candidate.sha256) &&
    typeof candidate.createdAt === 'string' &&
    Number.isFinite(Date.parse(candidate.createdAt)) &&
    typeof candidate.encryptionKeyId === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(candidate.encryptionKeyId) &&
    candidate.formatVersion === FILE_FORMAT_VERSION &&
    typeof candidate.chunkBytes === 'number' &&
    Number.isSafeInteger(candidate.chunkBytes) &&
    candidate.chunkBytes > 0 &&
    typeof candidate.chunkCount === 'number' &&
    Number.isSafeInteger(candidate.chunkCount) &&
    candidate.chunkCount >= 0 &&
    typeof candidate.bodyNonce === 'string' &&
    Boolean(candidate.metadata) &&
    typeof candidate.metadata === 'object' &&
    !Array.isArray(candidate.metadata)
  );
};

const publicDescriptor = (metadata: StoredBlobMetadata): BlobDescriptor => ({
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

/**
 * Immutable local blob backend with chunked authenticated encryption.
 *
 * Each blob receives a random data key. The configured keyring wraps that key;
 * metadata is encrypted, and every body chunk is bound to blob ID, owner,
 * purpose, chunk index, and plaintext length through AES-GCM AAD.
 */
export class LocalEncryptedBlobStore implements BlobStore {
  private readonly rootDirectory: string;
  private readonly objectsDirectory: string;
  private readonly stagingDirectory: string;
  private readonly keyring: Aes256GcmKeyring;
  private readonly quotaPolicy: BlobQuotaPolicy;
  private readonly chunkBytes: number;
  private readonly maxObjectBytes: number;
  private readonly now: () => Date;
  private initialized: Promise<void> | null = null;

  constructor(options: LocalEncryptedBlobStoreOptions) {
    if (!path.isAbsolute(options.rootDirectory)) {
      throw storageError(
        'invalid-input',
        'Local blob root directory must be absolute'
      );
    }
    const chunkBytes = options.chunkBytes ?? DEFAULT_CHUNK_BYTES;
    if (
      !Number.isSafeInteger(chunkBytes) ||
      chunkBytes < MIN_CHUNK_BYTES ||
      chunkBytes > MAX_CHUNK_BYTES
    ) {
      throw storageError(
        'invalid-input',
        'Blob chunk size must be between 64 KiB and 8 MiB'
      );
    }
    const maxObjectBytes = options.maxObjectBytes ?? DEFAULT_MAX_OBJECT_BYTES;
    if (!Number.isSafeInteger(maxObjectBytes) || maxObjectBytes <= 0) {
      throw storageError('invalid-input', 'Invalid maximum blob size');
    }

    this.rootDirectory = path.resolve(options.rootDirectory);
    this.objectsDirectory = path.join(this.rootDirectory, 'objects');
    this.stagingDirectory = path.join(this.rootDirectory, 'staging');
    this.keyring = options.keyring;
    this.quotaPolicy = options.quotaPolicy ?? new NoopBlobQuotaPolicy();
    this.chunkBytes = chunkBytes;
    this.maxObjectBytes = maxObjectBytes;
    this.now = options.now ?? (() => new Date());
  }

  private async initialize(): Promise<void> {
    if (!this.initialized) {
      this.initialized = (async () => {
        const rootCreated = await mkdir(this.rootDirectory, {
          recursive: true,
          mode: 0o700,
        });
        await this.assertPrivateDirectory(this.rootDirectory);
        const objectsCreated = await mkdir(this.objectsDirectory, {
          recursive: true,
          mode: 0o700,
        });
        await this.assertPrivateDirectory(this.objectsDirectory);
        const stagingCreated = await mkdir(this.stagingDirectory, {
          recursive: true,
          mode: 0o700,
        });
        await this.assertPrivateDirectory(this.stagingDirectory);
        if (objectsCreated || stagingCreated) {
          await this.syncDirectory(this.rootDirectory);
        }
        if (rootCreated) {
          await this.syncDirectory(path.dirname(this.rootDirectory));
        }
      })().catch(error => {
        this.initialized = null;
        throw storageError(
          'unavailable',
          'Unable to initialize local blob storage',
          error
        );
      });
    }
    await this.initialized;
  }

  private async assertPrivateDirectory(directory: string): Promise<void> {
    const directoryStat = await lstat(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
      throw storageError(
        'unavailable',
        `Local blob path is not a physical directory: ${directory}`
      );
    }
    await fs.promises.chmod(directory, 0o700);
  }

  private objectPath(id: string): string {
    validateBlobId(id);
    return path.join(
      this.objectsDirectory,
      id.slice(0, 2),
      id.slice(2, 4),
      `${id}.blob`
    );
  }

  private async ensureObjectDirectory(id: string): Promise<string> {
    validateBlobId(id);
    let current = this.objectsDirectory;
    for (const shard of [id.slice(0, 2), id.slice(2, 4)]) {
      current = path.join(current, shard);
      let created = false;
      try {
        await mkdir(current, { mode: 0o700 });
        created = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      // Validate every component separately. Recursive mkdir would follow an
      // attacker-controlled intermediate symlink before the final check.
      await this.assertPrivateDirectory(current);
      if (created) {
        // A file fsync cannot make a newly-created shard name durable in its
        // parent directory. Persist each level before publishing into it.
        await this.syncDirectory(path.dirname(current));
      }
    }
    return current;
  }

  private async syncDirectory(directory: string): Promise<void> {
    let handle: fs.promises.FileHandle | undefined;
    try {
      handle = await open(directory, fs.constants.O_RDONLY);
      await handle.sync();
    } catch (error) {
      if (process.platform !== 'win32') throw error;
    } finally {
      await handle?.close();
    }
  }

  private async unlinkIfExists(filePath: string): Promise<boolean> {
    try {
      await unlink(filePath);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }

  private async unlinkDurably(filePath: string): Promise<boolean> {
    const removed = await this.unlinkIfExists(filePath);
    if (removed) await this.syncDirectory(path.dirname(filePath));
    return removed;
  }

  private async cleanupStagingFiles(
    filePaths: readonly string[]
  ): Promise<void> {
    let removed = false;
    for (const filePath of filePaths) {
      try {
        removed = (await this.unlinkIfExists(filePath)) || removed;
      } catch {
        // Stale private staging files are recoverable through cleanupOrphans.
      }
    }
    if (removed) {
      await this.syncDirectory(this.stagingDirectory).catch(() => undefined);
    }
  }

  async put(request: BlobPutRequest): Promise<BlobDescriptor> {
    await this.initialize();
    throwIfAborted(request.signal);
    const normalizedMetadata = validateRequest(request, this.maxObjectBytes);
    const reservation = await this.quotaPolicy.reserve({
      ownerUserId: request.ownerUserId,
      purpose: request.purpose,
      ...(request.expectedSize !== undefined
        ? { expectedSize: request.expectedSize }
        : {}),
    });

    const id = crypto.randomUUID();
    const suffix = crypto.randomBytes(12).toString('hex');
    const bodyTemporaryPath = path.join(
      this.stagingDirectory,
      `${id}.${suffix}.body.tmp`
    );
    const objectTemporaryPath = path.join(
      this.stagingDirectory,
      `${id}.${suffix}.object.tmp`
    );
    const destinationPath = this.objectPath(id);
    let destinationVisible = false;
    let quotaCommitted = false;
    let dataKey: Buffer | undefined;

    try {
      dataKey = crypto.randomBytes(32);
      const bodyNonce = crypto.randomBytes(BODY_NONCE_BYTES);
      const digest = crypto.createHash('sha256');
      let size = 0;
      let chunkCount = 0;
      const bodyHandle = await open(
        bodyTemporaryPath,
        fs.constants.O_CREAT |
          fs.constants.O_EXCL |
          fs.constants.O_WRONLY |
          fs.constants.O_NOFOLLOW,
        0o600
      );
      try {
        for await (const chunk of fixedChunks(
          request.source,
          this.chunkBytes,
          request.signal
        )) {
          const nextSize = size + chunk.length;
          if (nextSize > this.maxObjectBytes) {
            throw storageError(
              'quota-exceeded',
              'Blob exceeds the maximum object size'
            );
          }
          await reservation.consume(chunk.length);
          throwIfAborted(request.signal);

          const cipher = crypto.createCipheriv(
            'aes-256-gcm',
            dataKey,
            createChunkIv(bodyNonce, chunkCount)
          );
          cipher.setAAD(
            chunkAad(
              {
                id,
                ownerUserId: request.ownerUserId,
                purpose: request.purpose,
              },
              chunkCount,
              chunk.length
            )
          );
          const ciphertext = Buffer.concat([
            cipher.update(chunk),
            cipher.final(),
          ]);
          await writeAll(bodyHandle, ciphertext);
          await writeAll(bodyHandle, cipher.getAuthTag());
          digest.update(chunk);
          size = nextSize;
          chunkCount += 1;
        }
        await bodyHandle.sync();
      } finally {
        await bodyHandle.close();
      }

      if (request.expectedSize !== undefined && request.expectedSize !== size) {
        throw storageError(
          'invalid-input',
          `Expected ${request.expectedSize} blob bytes but received ${size}`
        );
      }

      const wrappedDataKey = this.keyring.encrypt(dataKey, keyAad(id));
      const metadata: StoredBlobMetadata = {
        id,
        ownerUserId: request.ownerUserId,
        purpose: request.purpose,
        contentType: request.contentType,
        ...(request.originalFilename
          ? { originalFilename: request.originalFilename }
          : {}),
        metadata: normalizedMetadata,
        size,
        sha256: digest.digest('hex'),
        createdAt: this.now().toISOString(),
        encryptionKeyId: wrappedDataKey.keyId,
        formatVersion: FILE_FORMAT_VERSION,
        chunkBytes: this.chunkBytes,
        chunkCount,
        bodyNonce: bodyNonce.toString('base64'),
      };
      const metadataPlaintext = Buffer.from(JSON.stringify(metadata), 'utf8');
      if (metadataPlaintext.length > MAX_METADATA_BYTES) {
        throw storageError('invalid-input', 'Blob metadata is too large');
      }
      const metadataIv = crypto.randomBytes(METADATA_IV_BYTES);
      const metadataCipher = crypto.createCipheriv(
        'aes-256-gcm',
        dataKey,
        metadataIv
      );
      metadataCipher.setAAD(metadataAad(id));
      const encryptedMetadata = Buffer.concat([
        metadataCipher.update(metadataPlaintext),
        metadataCipher.final(),
      ]);
      const keyEnvelope = Buffer.from(JSON.stringify(wrappedDataKey), 'utf8');
      if (keyEnvelope.length > MAX_KEY_ENVELOPE_BYTES) {
        throw storageError('invalid-input', 'Blob key envelope is too large');
      }

      const prefix = Buffer.allocUnsafe(PREFIX_BYTES);
      FILE_MAGIC.copy(prefix, 0);
      prefix.writeUInt8(FILE_FORMAT_VERSION, FILE_MAGIC.length);
      prefix.writeUInt32BE(keyEnvelope.length, FILE_MAGIC.length + 1);
      prefix.writeUInt32BE(encryptedMetadata.length, FILE_MAGIC.length + 1 + 4);
      metadataIv.copy(prefix, FILE_MAGIC.length + 1 + 4 + 4);
      metadataCipher
        .getAuthTag()
        .copy(prefix, FILE_MAGIC.length + 1 + 4 + 4 + METADATA_IV_BYTES);

      const objectHandle = await open(
        objectTemporaryPath,
        fs.constants.O_CREAT |
          fs.constants.O_EXCL |
          fs.constants.O_WRONLY |
          fs.constants.O_NOFOLLOW,
        0o600
      );
      try {
        await writeAll(objectHandle, prefix);
        await writeAll(objectHandle, keyEnvelope);
        await writeAll(objectHandle, encryptedMetadata);
        const bodyStream = fs.createReadStream(bodyTemporaryPath);
        for await (const chunk of bodyStream) {
          throwIfAborted(request.signal);
          await writeAll(objectHandle, chunk);
        }
        await objectHandle.sync();
      } finally {
        await objectHandle.close();
      }

      const destinationDirectory = await this.ensureObjectDirectory(id);
      throwIfAborted(request.signal);
      await rename(objectTemporaryPath, destinationPath);
      destinationVisible = true;
      // rename(2) crosses from staging into a shard. Both directory entries
      // must be synced: the destination fsync persists visibility, while the
      // source fsync persists removal of the staging name.
      await this.syncDirectory(destinationDirectory);
      await this.syncDirectory(this.stagingDirectory);

      // The encrypted body staging file is no longer needed. Remove and sync it
      // before committing quota so a successful put has no undurable cleanup.
      await this.unlinkDurably(bodyTemporaryPath);

      const descriptor = publicDescriptor(metadata);
      await reservation.commit(descriptor);
      quotaCommitted = true;
      return descriptor;
    } catch (error) {
      if (destinationVisible) {
        await this.unlinkDurably(destinationPath).catch(() => undefined);
      }
      if (error instanceof BlobStoreError) throw error;
      if (error instanceof StorageEncryptionError) {
        throw storageError('corrupt', error.message, error);
      }
      throw storageError(
        'unavailable',
        'Unable to store encrypted blob',
        error
      );
    } finally {
      dataKey?.fill(0);
      await this.cleanupStagingFiles([bodyTemporaryPath, objectTemporaryPath]);
      if (!quotaCommitted) await reservation.release();
    }
  }

  private async openInternal(
    id: string,
    ownerUserId?: string,
    options: {
      skipInitialization?: boolean;
      expectedStat?: fs.Stats;
    } = {}
  ): Promise<OpenedBlob> {
    if (!options.skipInitialization) await this.initialize();
    validateBlobId(id);
    let handle: fs.promises.FileHandle;
    let dataKey: Buffer | undefined;
    try {
      handle = await open(
        this.objectPath(id),
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new BlobNotFoundError();
      }
      throw storageError('unavailable', 'Unable to open encrypted blob', error);
    }

    try {
      const prefix = await readExactly(handle, PREFIX_BYTES, 0);
      if (!prefix.subarray(0, FILE_MAGIC.length).equals(FILE_MAGIC)) {
        throw storageError('corrupt', 'Invalid encrypted blob format');
      }
      const version = prefix.readUInt8(FILE_MAGIC.length);
      if (version !== FILE_FORMAT_VERSION) {
        throw storageError(
          'corrupt',
          `Unsupported encrypted blob format version: ${version}`
        );
      }
      const envelopeBytes = prefix.readUInt32BE(FILE_MAGIC.length + 1);
      const metadataBytes = prefix.readUInt32BE(FILE_MAGIC.length + 1 + 4);
      if (
        envelopeBytes <= 0 ||
        envelopeBytes > MAX_KEY_ENVELOPE_BYTES ||
        metadataBytes <= 0 ||
        metadataBytes > MAX_METADATA_BYTES
      ) {
        throw storageError('corrupt', 'Invalid encrypted blob header lengths');
      }

      const metadataIvStart = FILE_MAGIC.length + 1 + 4 + 4;
      const metadataIv = prefix.subarray(
        metadataIvStart,
        metadataIvStart + METADATA_IV_BYTES
      );
      const metadataTag = prefix.subarray(
        metadataIvStart + METADATA_IV_BYTES,
        PREFIX_BYTES
      );
      const envelopeBuffer = await readExactly(
        handle,
        envelopeBytes,
        PREFIX_BYTES
      );
      const envelope = parseAesGcmEnvelope(
        parseJson(envelopeBuffer, 'key envelope')
      );
      dataKey = this.keyring.decrypt(envelope, keyAad(id));
      if (dataKey.length !== 32) {
        throw storageError('corrupt', 'Invalid encrypted blob data key');
      }

      const encryptedMetadata = await readExactly(
        handle,
        metadataBytes,
        PREFIX_BYTES + envelopeBytes
      );
      let metadataPlaintext: Buffer;
      try {
        const decipher = crypto.createDecipheriv(
          'aes-256-gcm',
          dataKey,
          metadataIv
        );
        decipher.setAAD(metadataAad(id));
        decipher.setAuthTag(metadataTag);
        metadataPlaintext = Buffer.concat([
          decipher.update(encryptedMetadata),
          decipher.final(),
        ]);
      } catch (error) {
        throw storageError(
          'corrupt',
          'Encrypted blob metadata authentication failed',
          error
        );
      }

      const metadataValue = parseJson(metadataPlaintext, 'metadata');
      if (!isStoredBlobMetadata(metadataValue) || metadataValue.id !== id) {
        throw storageError('corrupt', 'Invalid encrypted blob metadata');
      }
      if (
        metadataValue.encryptionKeyId !== envelope.keyId ||
        metadataValue.chunkBytes < MIN_CHUNK_BYTES ||
        metadataValue.chunkBytes > MAX_CHUNK_BYTES
      ) {
        throw storageError('corrupt', 'Invalid encrypted blob metadata');
      }
      if (
        metadataValue.chunkCount !==
          Math.ceil(metadataValue.size / metadataValue.chunkBytes) ||
        metadataValue.chunkCount > 0x1_0000_0000
      ) {
        throw storageError('corrupt', 'Invalid encrypted blob chunk count');
      }
      const bodyNonce = Buffer.from(metadataValue.bodyNonce, 'base64');
      if (
        bodyNonce.length !== BODY_NONCE_BYTES ||
        bodyNonce.toString('base64') !== metadataValue.bodyNonce
      ) {
        throw storageError('corrupt', 'Invalid encrypted blob body nonce');
      }
      if (
        ownerUserId !== undefined &&
        !ownerMatches(ownerUserId, metadataValue.ownerUserId)
      ) {
        throw new BlobNotFoundError();
      }

      const bodyOffset = PREFIX_BYTES + envelopeBytes + metadataBytes;
      const fileStat = await handle.stat();
      const expectedFileBytes =
        bodyOffset +
        metadataValue.size +
        metadataValue.chunkCount * AUTH_TAG_BYTES;
      if (
        !Number.isSafeInteger(expectedFileBytes) ||
        !fileStat.isFile() ||
        fileStat.size !== expectedFileBytes ||
        (options.expectedStat !== undefined &&
          (fileStat.dev !== options.expectedStat.dev ||
            fileStat.ino !== options.expectedStat.ino ||
            fileStat.size !== options.expectedStat.size))
      ) {
        throw storageError('corrupt', 'Invalid encrypted blob file size');
      }

      return { handle, metadata: metadataValue, dataKey, bodyOffset };
    } catch (error) {
      dataKey?.fill(0);
      await handle.close();
      if (
        error instanceof BlobStoreError ||
        error instanceof BlobNotFoundError
      ) {
        throw error;
      }
      if (error instanceof StorageEncryptionError) {
        throw storageError('corrupt', error.message, error);
      }
      throw storageError(
        'corrupt',
        'Unable to authenticate encrypted blob',
        error
      );
    }
  }

  async stat(id: string, ownerUserId: string): Promise<BlobDescriptor> {
    const opened = await this.openInternal(id, ownerUserId);
    try {
      return publicDescriptor(opened.metadata);
    } finally {
      await disposeOpenedBlob(opened);
    }
  }

  private async authenticateFullBody(
    opened: OpenedBlob,
    signal?: AbortSignal
  ): Promise<void> {
    const { metadata } = opened;
    const digest = crypto.createHash('sha256');
    const bodyNonce = Buffer.from(metadata.bodyNonce, 'base64');

    for (
      let chunkIndex = 0;
      chunkIndex < metadata.chunkCount;
      chunkIndex += 1
    ) {
      throwIfAborted(signal);
      const chunkStart = chunkIndex * metadata.chunkBytes;
      const plaintextBytes = Math.min(
        metadata.chunkBytes,
        metadata.size - chunkStart
      );
      const encryptedChunk = await readExactly(
        opened.handle,
        plaintextBytes + AUTH_TAG_BYTES,
        opened.bodyOffset + chunkIndex * (metadata.chunkBytes + AUTH_TAG_BYTES)
      );
      let plaintext: Buffer | undefined;
      try {
        const decipher = crypto.createDecipheriv(
          'aes-256-gcm',
          opened.dataKey,
          createChunkIv(bodyNonce, chunkIndex)
        );
        decipher.setAAD(chunkAad(metadata, chunkIndex, plaintextBytes));
        decipher.setAuthTag(encryptedChunk.subarray(plaintextBytes));
        plaintext = Buffer.concat([
          decipher.update(encryptedChunk.subarray(0, plaintextBytes)),
          decipher.final(),
        ]);
        digest.update(plaintext);
      } catch (error) {
        throw storageError(
          'corrupt',
          'Encrypted blob chunk authentication failed',
          error
        );
      } finally {
        plaintext?.fill(0);
      }
    }

    if (digest.digest('hex') !== metadata.sha256) {
      throw storageError('corrupt', 'Encrypted blob checksum mismatch');
    }
  }

  private normalizeRange(
    metadata: StoredBlobMetadata,
    request: BlobReadRequest
  ): BlobContentRange | null {
    if (!request.range) return null;
    if (metadata.size === 0) {
      throw storageError('invalid-range', 'Empty blobs do not support ranges');
    }
    const { start } = request.range;
    const requestedEnd = request.range.end ?? metadata.size - 1;
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(requestedEnd) ||
      start < 0 ||
      start >= metadata.size ||
      requestedEnd < start
    ) {
      throw storageError('invalid-range', 'Invalid blob byte range');
    }
    const end = Math.min(requestedEnd, metadata.size - 1);
    return { start, end, total: metadata.size, length: end - start + 1 };
  }

  async open(request: BlobReadRequest): Promise<BlobReadResult> {
    throwIfAborted(request.signal);
    const opened = await this.openInternal(request.id, request.ownerUserId);
    let contentRange: BlobContentRange | null;
    try {
      contentRange = this.normalizeRange(opened.metadata, request);
    } catch (error) {
      await disposeOpenedBlob(opened);
      throw error;
    }

    const metadata = opened.metadata;
    const start = contentRange?.start ?? 0;
    const end = contentRange?.end ?? metadata.size - 1;
    const fullRead = contentRange === null;
    const bodyNonce = Buffer.from(metadata.bodyNonce, 'base64');

    let disposePromise: Promise<void> | undefined;
    const dispose = (): Promise<void> => {
      disposePromise ||= disposeOpenedBlob(opened);
      return disposePromise;
    };
    const iterator = (async function* (): AsyncGenerator<Buffer> {
      const digest = fullRead ? crypto.createHash('sha256') : null;
      try {
        if (metadata.size === 0) {
          if (digest?.digest('hex') !== metadata.sha256) {
            throw storageError('corrupt', 'Encrypted blob checksum mismatch');
          }
          return;
        }

        const firstChunk = Math.floor(start / metadata.chunkBytes);
        const finalChunk = Math.floor(end / metadata.chunkBytes);
        for (
          let chunkIndex = firstChunk;
          chunkIndex <= finalChunk;
          chunkIndex += 1
        ) {
          throwIfAborted(request.signal);
          const chunkStart = chunkIndex * metadata.chunkBytes;
          const plaintextBytes = Math.min(
            metadata.chunkBytes,
            metadata.size - chunkStart
          );
          const encryptedBytes = plaintextBytes + AUTH_TAG_BYTES;
          const position =
            opened.bodyOffset +
            chunkIndex * (metadata.chunkBytes + AUTH_TAG_BYTES);
          const encryptedChunk = await readExactly(
            opened.handle,
            encryptedBytes,
            position
          );

          let plaintext: Buffer;
          try {
            const decipher = crypto.createDecipheriv(
              'aes-256-gcm',
              opened.dataKey,
              createChunkIv(bodyNonce, chunkIndex)
            );
            decipher.setAAD(chunkAad(metadata, chunkIndex, plaintextBytes));
            decipher.setAuthTag(encryptedChunk.subarray(plaintextBytes));
            plaintext = Buffer.concat([
              decipher.update(encryptedChunk.subarray(0, plaintextBytes)),
              decipher.final(),
            ]);
          } catch (error) {
            throw storageError(
              'corrupt',
              'Encrypted blob chunk authentication failed',
              error
            );
          }

          digest?.update(plaintext);
          const sliceStart = Math.max(start - chunkStart, 0);
          const sliceEnd = Math.min(end - chunkStart + 1, plaintext.length);
          if (sliceEnd > sliceStart) {
            yield plaintext.subarray(sliceStart, sliceEnd);
          }
        }

        if (digest && digest.digest('hex') !== metadata.sha256) {
          throw storageError('corrupt', 'Encrypted blob checksum mismatch');
        }
      } finally {
        await dispose();
      }
    })();
    let body: Readable;
    try {
      body = Readable.from(iterator, { objectMode: false });
    } catch (error) {
      await dispose();
      throw error;
    }
    // Destroying an unconsumed Readable can return an async generator before
    // its body (and therefore its finally block) ever starts. Close is the
    // independent lifetime boundary that guarantees key/file cleanup there.
    body.once('close', () => {
      void dispose().catch(() => undefined);
    });

    return {
      descriptor: publicDescriptor(metadata),
      range: contentRange,
      body,
    };
  }

  async delete(request: {
    id: string;
    ownerUserId: string;
    signal?: AbortSignal;
  }): Promise<boolean> {
    throwIfAborted(request.signal);
    let opened: OpenedBlob;
    try {
      opened = await this.openInternal(request.id, request.ownerUserId);
    } catch (error) {
      if (error instanceof BlobNotFoundError) return false;
      throw error;
    }
    await disposeOpenedBlob(opened);
    throwIfAborted(request.signal);
    try {
      return await this.unlinkDurably(this.objectPath(request.id));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw storageError(
        'unavailable',
        'Unable to delete encrypted blob',
        error
      );
    }
  }

  private async integrityDirectoryExists(
    directory: string,
    allowMissing = false
  ): Promise<boolean> {
    let directoryStat: fs.Stats;
    try {
      directoryStat = await lstat(directory);
    } catch (error) {
      if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        return false;
      }
      throw storageError(
        'unavailable',
        'Unable to inspect the local blob-store directory',
        error
      );
    }
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
      throw storageError(
        'corrupt',
        'Local blob storage contains a non-physical directory'
      );
    }
    return true;
  }

  private async *integrityDirectoryEntries(
    directory: string
  ): AsyncGenerator<fs.Dirent> {
    let directoryHandle: fs.Dir;
    try {
      directoryHandle = await opendir(directory);
    } catch (error) {
      throw storageError(
        'unavailable',
        'Unable to enumerate the local blob-store directory',
        error
      );
    }
    try {
      for await (const entry of directoryHandle) yield entry;
    } catch (error) {
      throw storageError(
        'unavailable',
        'Unable to enumerate the local blob-store directory',
        error
      );
    }
  }

  private async *integrityCandidates(): AsyncGenerator<BlobIntegrityCandidate> {
    if (!(await this.integrityDirectoryExists(this.rootDirectory, true)))
      return;

    for await (const entry of this.integrityDirectoryEntries(
      this.rootDirectory
    )) {
      if (entry.name !== 'objects' && entry.name !== 'staging') {
        throw storageError(
          'corrupt',
          'Local blob storage contains an unexpected root entry'
        );
      }
      await this.integrityDirectoryExists(
        path.join(this.rootDirectory, entry.name)
      );
    }

    if (!(await this.integrityDirectoryExists(this.objectsDirectory, true))) {
      return;
    }
    for await (const firstShard of this.integrityDirectoryEntries(
      this.objectsDirectory
    )) {
      if (!/^[0-9a-f]{2}$/.test(firstShard.name)) {
        throw storageError(
          'corrupt',
          'Local blob storage contains an invalid object shard'
        );
      }
      const firstPath = path.join(this.objectsDirectory, firstShard.name);
      await this.integrityDirectoryExists(firstPath);

      for await (const secondShard of this.integrityDirectoryEntries(
        firstPath
      )) {
        if (!/^[0-9a-f]{2}$/.test(secondShard.name)) {
          throw storageError(
            'corrupt',
            'Local blob storage contains an invalid object shard'
          );
        }
        const secondPath = path.join(firstPath, secondShard.name);
        await this.integrityDirectoryExists(secondPath);

        for await (const objectEntry of this.integrityDirectoryEntries(
          secondPath
        )) {
          const match = /^([0-9a-f-]{36})\.blob$/.exec(objectEntry.name);
          const id = match?.[1];
          if (
            !id ||
            !BLOB_ID_PATTERN.test(id) ||
            id.slice(0, 2) !== firstShard.name ||
            id.slice(2, 4) !== secondShard.name
          ) {
            throw storageError(
              'corrupt',
              'Local blob storage contains an invalid object name'
            );
          }
          const objectPath = path.join(secondPath, objectEntry.name);
          let objectStat: fs.Stats;
          try {
            objectStat = await lstat(objectPath);
          } catch (error) {
            throw storageError(
              'unavailable',
              'Unable to inspect a local blob object',
              error
            );
          }
          if (
            !objectStat.isFile() ||
            objectStat.isSymbolicLink() ||
            objectStat.nlink !== 1 ||
            !Number.isSafeInteger(objectStat.size) ||
            objectStat.size <= 0
          ) {
            throw storageError(
              'corrupt',
              'Local blob storage contains an invalid physical object'
            );
          }
          yield { id, stat: objectStat };
        }
      }
    }
  }

  /**
   * Authenticates every durable local object without creating directories,
   * changing permissions, deleting or rewriting source data. Work is bounded
   * before each object is opened and plaintext is processed one chunk at a
   * time.
   */
  async verifyIntegrity(
    options: BlobIntegrityVerificationOptions = {}
  ): Promise<BlobIntegrityVerificationResult> {
    const maxObjects = options.maxObjects ?? DEFAULT_MAX_INTEGRITY_OBJECTS;
    const maxEncryptedBytes =
      options.maxEncryptedBytes ?? DEFAULT_MAX_INTEGRITY_ENCRYPTED_BYTES;
    const maxPlaintextBytes =
      options.maxPlaintextBytes ?? DEFAULT_MAX_INTEGRITY_PLAINTEXT_BYTES;
    validateIntegrityLimit(maxObjects, 'blob integrity object limit');
    validateIntegrityLimit(
      maxEncryptedBytes,
      'blob integrity encrypted-byte limit'
    );
    validateIntegrityLimit(
      maxPlaintextBytes,
      'blob integrity plaintext-byte limit'
    );

    let objects = 0;
    let encryptedBytes = 0;
    let plaintextBytes = 0;
    for await (const candidate of this.integrityCandidates()) {
      throwIfAborted(options.signal);
      objects += 1;
      encryptedBytes += candidate.stat.size;
      if (
        !Number.isSafeInteger(encryptedBytes) ||
        objects > maxObjects ||
        encryptedBytes > maxEncryptedBytes
      ) {
        throw storageError(
          'verification-limit',
          'Local blob storage exceeds bounded integrity verification limits'
        );
      }

      const opened = await this.openInternal(candidate.id, undefined, {
        skipInitialization: true,
        expectedStat: candidate.stat,
      });
      try {
        plaintextBytes += opened.metadata.size;
        if (
          !Number.isSafeInteger(plaintextBytes) ||
          plaintextBytes > maxPlaintextBytes
        ) {
          throw storageError(
            'verification-limit',
            'Local blob storage exceeds bounded integrity verification limits'
          );
        }
        await this.authenticateFullBody(opened, options.signal);
        const after = await opened.handle.stat();
        if (
          after.dev !== candidate.stat.dev ||
          after.ino !== candidate.stat.ino ||
          after.size !== candidate.stat.size ||
          after.mtimeMs !== candidate.stat.mtimeMs ||
          after.ctimeMs !== candidate.stat.ctimeMs
        ) {
          throw storageError(
            'corrupt',
            'Local blob object changed during integrity verification'
          );
        }
      } finally {
        await disposeOpenedBlob(opened);
      }
    }

    return { objects, encryptedBytes, plaintextBytes };
  }

  private async listObjectFiles(directory: string): Promise<string[]> {
    const entries = await readdir(directory, { withFileTypes: true }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      }
    );
    const paths: string[] = [];
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        paths.push(...(await this.listObjectFiles(entryPath)));
      } else if (entry.isFile() && entry.name.endsWith('.blob')) {
        paths.push(entryPath);
      }
    }
    return paths;
  }

  async cleanupOrphans(
    options: BlobOrphanCleanupOptions
  ): Promise<BlobOrphanCleanupResult> {
    await this.initialize();
    if (!Number.isFinite(options.olderThan.getTime())) {
      throw storageError('invalid-input', 'Invalid blob orphan cutoff');
    }
    const cutoff = options.olderThan.getTime();
    let deletedObjects = 0;
    let retainedObjects = 0;
    let deletedStagingFiles = 0;

    for (const objectPath of await this.listObjectFiles(
      this.objectsDirectory
    )) {
      throwIfAborted(options.signal);
      const objectStat = await stat(objectPath);
      if (objectStat.mtimeMs >= cutoff) {
        retainedObjects += 1;
        continue;
      }
      const blobId = path.basename(objectPath, '.blob');
      if (
        !BLOB_ID_PATTERN.test(blobId) ||
        (await options.isReferenced(blobId))
      ) {
        retainedObjects += 1;
        continue;
      }
      if (await this.unlinkDurably(objectPath)) deletedObjects += 1;
    }

    const stagingEntries = await readdir(this.stagingDirectory, {
      withFileTypes: true,
    });
    for (const entry of stagingEntries) {
      throwIfAborted(options.signal);
      if (!entry.isFile() || !entry.name.endsWith('.tmp')) continue;
      const stagingPath = path.join(this.stagingDirectory, entry.name);
      const stagingStat = await stat(stagingPath);
      if (stagingStat.mtimeMs >= cutoff) continue;
      if (await this.unlinkDurably(stagingPath)) deletedStagingFiles += 1;
    }

    return { deletedObjects, deletedStagingFiles, retainedObjects };
  }
}
