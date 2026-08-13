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
import path from 'node:path';
import type Database from 'better-sqlite3';
import { Aes256GcmKeyring, StorageEncryptionError } from './aesGcmKeyring.js';
import {
  BlobStoreError,
  type BlobQuotaPolicy,
  type BlobStore,
} from './blobStore.js';
import {
  LocalEncryptedBlobStore,
  type LocalEncryptedBlobStoreOptions,
} from './localEncryptedBlobStore.js';
import { SqliteEncryptedVectorStore } from './sqliteEncryptedVectorStore.js';
import { VectorStoreError, type VectorStore } from './vectorStore.js';

export type BlobStoreBackendSelection = 'local' | 's3';
export type VectorStoreBackendSelection = 'embedded' | 'pgvector';

export interface StorageKeyringEnvironment {
  STORAGE_ENCRYPTION_ACTIVE_KEY_ID?: string;
  STORAGE_ENCRYPTION_KEYS?: string;
  ENCRYPTION_KEY?: string;
  DATA_DIR?: string;
}

export interface StorageFactoryEnvironment extends StorageKeyringEnvironment {
  BLOB_STORE_BACKEND?: string;
  VECTOR_STORE_BACKEND?: string;
}

export type StorageKeyConfigurationSource =
  | 'versioned-keyring'
  | 'legacy-encryption-key'
  | 'persistent-key-file'
  | 'none';

export interface StorageKeyFingerprint {
  keyId: string;
  /** First 64 bits of SHA-256, sufficient for backup key-set comparison. */
  sha256Prefix: string;
}

export interface StorageKeyConfigurationInspection {
  status: 'configured' | 'invalid' | 'missing';
  source: StorageKeyConfigurationSource;
  activeKeyId: string | null;
  keyFingerprints: readonly StorageKeyFingerprint[];
}

export interface LocalBlobStoreFactoryOptions {
  rootDirectory: string;
  env?: StorageFactoryEnvironment;
  quotaPolicy?: BlobQuotaPolicy;
  chunkBytes?: number;
  maxObjectBytes?: number;
}

export interface EmbeddedVectorStoreFactoryOptions {
  database: Database.Database;
  env?: StorageFactoryEnvironment;
  maxCandidates?: number;
  maxCandidateBytes?: number;
  maxScoringComponents?: number;
}

interface ResolvedStorageKeys {
  source: Exclude<StorageKeyConfigurationSource, 'none'>;
  activeKeyId: string;
  keys: Readonly<Record<string, Buffer>>;
}

const MAX_PERSISTENT_KEY_FILE_BYTES = 256;

const parseHexKey = (value: unknown, description: string): Buffer => {
  if (typeof value !== 'string' || !/^[a-fA-F0-9]{64}$/.test(value)) {
    throw new StorageEncryptionError(
      `${description} must be exactly 64 hexadecimal characters`
    );
  }
  return Buffer.from(value, 'hex');
};

const parseKeyMap = (rawValue: string): Record<string, Buffer> => {
  let value: unknown;
  try {
    value = JSON.parse(rawValue) as unknown;
  } catch (error) {
    throw new StorageEncryptionError(
      `STORAGE_ENCRYPTION_KEYS must be a JSON object: ${
        error instanceof Error ? error.message : 'invalid JSON'
      }`
    );
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new StorageEncryptionError(
      'STORAGE_ENCRYPTION_KEYS must be a JSON object'
    );
  }

  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0 || entries.length > 32) {
    throw new StorageEncryptionError(
      'STORAGE_ENCRYPTION_KEYS must contain 1-32 keys'
    );
  }
  return Object.fromEntries(
    entries.map(([keyId, key]) => [
      keyId,
      parseHexKey(key, `Storage key ${keyId}`),
    ])
  );
};

const sameKey = (left: Buffer, right: Buffer): boolean =>
  left.length === right.length && crypto.timingSafeEqual(left, right);

const persistentKeyPath = (
  env: StorageKeyringEnvironment
): string | undefined => {
  const dataDirectory = env.DATA_DIR?.trim();
  if (!dataDirectory) return undefined;
  try {
    return path.join(path.resolve(dataDirectory), '.encryption_key');
  } catch {
    throw new StorageEncryptionError('Invalid DATA_DIR for storage key');
  }
};

/**
 * Reads the legacy persistent key without following a final-component symlink
 * or mutating/generating key material. A changing or loosely permissioned file
 * fails closed so a privileged path cannot silently select attacker input.
 */
const readPersistentStorageKey = (
  env: StorageKeyringEnvironment
): Buffer | undefined => {
  const keyPath = persistentKeyPath(env);
  if (!keyPath) return undefined;

  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  let descriptor: number;
  try {
    descriptor = fs.openSync(keyPath, fs.constants.O_RDONLY | noFollow);
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return undefined;
    }
    throw new StorageEncryptionError(
      'Unable to safely open the persistent storage encryption key'
    );
  }

  try {
    const before = fs.fstatSync(descriptor);
    const named = fs.lstatSync(keyPath);
    if (
      !before.isFile() ||
      !named.isFile() ||
      before.dev !== named.dev ||
      before.ino !== named.ino ||
      before.nlink !== 1 ||
      before.size <= 0 ||
      before.size > MAX_PERSISTENT_KEY_FILE_BYTES
    ) {
      throw new StorageEncryptionError(
        'Persistent storage encryption key must be a small, single-link regular file'
      );
    }
    if (process.platform !== 'win32' && (before.mode & 0o077) !== 0) {
      throw new StorageEncryptionError(
        'Persistent storage encryption key permissions must be 0600 or stricter'
      );
    }

    const content = Buffer.alloc(MAX_PERSISTENT_KEY_FILE_BYTES + 1);
    const bytesRead = fs.readSync(descriptor, content, 0, content.length, 0);
    const after = fs.fstatSync(descriptor);
    const namedAfter = fs.lstatSync(keyPath);
    if (
      bytesRead > MAX_PERSISTENT_KEY_FILE_BYTES ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      after.dev !== namedAfter.dev ||
      after.ino !== namedAfter.ino
    ) {
      throw new StorageEncryptionError(
        'Persistent storage encryption key changed while being read'
      );
    }
    return parseHexKey(
      content.subarray(0, bytesRead).toString('utf8').trim(),
      'Persistent storage encryption key'
    );
  } catch (error) {
    if (error instanceof StorageEncryptionError) throw error;
    throw new StorageEncryptionError(
      'Unable to safely read the persistent storage encryption key'
    );
  } finally {
    fs.closeSync(descriptor);
  }
};

const resolveStorageKeys = (
  env: StorageKeyringEnvironment
): ResolvedStorageKeys | undefined => {
  const rawKeyMap = env.STORAGE_ENCRYPTION_KEYS?.trim();
  const requestedActiveKeyId = env.STORAGE_ENCRYPTION_ACTIVE_KEY_ID?.trim();
  const rawEnvironmentKey = env.ENCRYPTION_KEY?.trim();
  const environmentKey = rawEnvironmentKey
    ? parseHexKey(rawEnvironmentKey, 'ENCRYPTION_KEY')
    : undefined;
  const persistentKey = readPersistentStorageKey(env);

  if (
    environmentKey &&
    persistentKey &&
    !sameKey(environmentKey, persistentKey)
  ) {
    throw new StorageEncryptionError(
      'ENCRYPTION_KEY differs from the persistent storage encryption key'
    );
  }
  const legacyKey = environmentKey ?? persistentKey;

  if (rawKeyMap || requestedActiveKeyId) {
    if (!rawKeyMap || !requestedActiveKeyId) {
      throw new StorageEncryptionError(
        'Versioned storage keys require a key map and active key ID'
      );
    }
    const keys = parseKeyMap(rawKeyMap);
    // Constructing validates key IDs and proves that the active ID exists.
    new Aes256GcmKeyring(requestedActiveKeyId, keys);
    if (!legacyKey) {
      throw new StorageEncryptionError(
        'Versioned storage keys currently require a stable ENCRYPTION_KEY or DATA_DIR/.encryption_key legacy key'
      );
    }
    if (!keys.legacy || !sameKey(keys.legacy, legacyKey)) {
      throw new StorageEncryptionError(
        'Versioned storage keys must retain the configured legacy key as key ID legacy'
      );
    }
    return {
      source: 'versioned-keyring',
      activeKeyId: requestedActiveKeyId,
      keys,
    };
  }

  if (environmentKey) {
    return {
      source: 'legacy-encryption-key',
      activeKeyId: 'legacy',
      keys: { legacy: environmentKey },
    };
  }
  if (persistentKey) {
    return {
      source: 'persistent-key-file',
      activeKeyId: 'legacy',
      keys: { legacy: persistentKey },
    };
  }
  return undefined;
};

const fingerprintKeys = (
  keys: Readonly<Record<string, Buffer>>
): readonly StorageKeyFingerprint[] =>
  Object.entries(keys)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([keyId, key]) => ({
      keyId,
      sha256Prefix: crypto
        .createHash('sha256')
        .update(key)
        .digest('hex')
        .slice(0, 16),
    }));

/**
 * Returns only non-secret key-set identity for recovery diagnostics. Invalid
 * input is never reflected into the result and key bytes are never returned.
 */
export const inspectStorageKeyConfiguration = (
  env: StorageKeyringEnvironment = process.env
): StorageKeyConfigurationInspection => {
  try {
    const resolved = resolveStorageKeys(env);
    return resolved
      ? {
          status: 'configured',
          source: resolved.source,
          activeKeyId: resolved.activeKeyId,
          keyFingerprints: fingerprintKeys(resolved.keys),
        }
      : {
          status: 'missing',
          source: 'none',
          activeKeyId: null,
          keyFingerprints: [],
        };
  } catch {
    const source: StorageKeyConfigurationSource =
      env.STORAGE_ENCRYPTION_KEYS?.trim() ||
      env.STORAGE_ENCRYPTION_ACTIVE_KEY_ID?.trim()
        ? 'versioned-keyring'
        : env.ENCRYPTION_KEY?.trim()
          ? 'legacy-encryption-key'
          : env.DATA_DIR?.trim()
            ? 'persistent-key-file'
            : 'none';
    return {
      status: 'invalid',
      source,
      activeKeyId: null,
      keyFingerprints: [],
    };
  }
};

/**
 * Builds a fail-closed storage keyring. Existing ENCRYPTION_KEY and
 * DATA_DIR/.encryption_key deployments remain usable, while a JSON key map
 * enables rotation without losing reads. This factory never writes key data.
 */
export const createStorageKeyringFromEnvironment = (
  env: StorageKeyringEnvironment = process.env
): Aes256GcmKeyring => {
  const resolved = resolveStorageKeys(env);
  if (!resolved) {
    throw new StorageEncryptionError(
      'Storage encryption requires STORAGE_ENCRYPTION_KEYS, ENCRYPTION_KEY, or DATA_DIR/.encryption_key'
    );
  }
  return new Aes256GcmKeyring(resolved.activeKeyId, resolved.keys);
};

export const createBlobStore = (
  options: LocalBlobStoreFactoryOptions
): BlobStore => {
  const env = options.env ?? process.env;
  const backend = env.BLOB_STORE_BACKEND?.trim().toLowerCase() || 'local';
  if (backend === 's3') {
    throw new BlobStoreError(
      'unavailable',
      'BLOB_STORE_BACKEND=s3 is unavailable in this release; use local storage until the tested S3 adapter ships'
    );
  }
  if (backend !== 'local') {
    throw new BlobStoreError(
      'invalid-input',
      'BLOB_STORE_BACKEND must be local or s3'
    );
  }

  const localOptions: LocalEncryptedBlobStoreOptions = {
    rootDirectory: options.rootDirectory,
    keyring: createStorageKeyringFromEnvironment(env),
    ...(options.quotaPolicy ? { quotaPolicy: options.quotaPolicy } : {}),
    ...(options.chunkBytes !== undefined
      ? { chunkBytes: options.chunkBytes }
      : {}),
    ...(options.maxObjectBytes !== undefined
      ? { maxObjectBytes: options.maxObjectBytes }
      : {}),
  };
  return new LocalEncryptedBlobStore(localOptions);
};

export const createVectorStore = (
  options: EmbeddedVectorStoreFactoryOptions
): VectorStore => {
  const env = options.env ?? process.env;
  const backend = env.VECTOR_STORE_BACKEND?.trim().toLowerCase() || 'embedded';
  if (backend === 'pgvector') {
    throw new VectorStoreError(
      'unavailable',
      'VECTOR_STORE_BACKEND=pgvector is unavailable in this release; use the encrypted embedded index until the tested PGVector adapter ships'
    );
  }
  if (backend !== 'embedded') {
    throw new VectorStoreError(
      'invalid-input',
      'VECTOR_STORE_BACKEND must be embedded or pgvector'
    );
  }

  return new SqliteEncryptedVectorStore({
    database: options.database,
    keyring: createStorageKeyringFromEnvironment(env),
    ...(options.maxCandidates !== undefined
      ? { maxCandidates: options.maxCandidates }
      : {}),
    ...(options.maxCandidateBytes !== undefined
      ? { maxCandidateBytes: options.maxCandidateBytes }
      : {}),
    ...(options.maxScoringComponents !== undefined
      ? { maxScoringComponents: options.maxScoringComponents }
      : {}),
  });
};
