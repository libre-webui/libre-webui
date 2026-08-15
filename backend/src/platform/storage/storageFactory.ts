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
import type {
  PostgresDatabase,
  PostgresQueryExecutor,
} from '../../persistence/postgresDatabase.js';
import { hasKeyDependentApplicationState } from '../../utils/dataDirectory.js';
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
import {
  createS3EncryptedBlobStore,
  type S3BlobEnvironment,
} from './s3EncryptedBlobStore.js';
import { PgVectorStore } from './pgVectorStore.js';
import {
  VectorStoreError,
  type VectorPrincipalResolver,
  type VectorStore,
} from './vectorStore.js';

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
  S3_BUCKET?: string;
  S3_REGION?: string;
  S3_ENDPOINT?: string;
  S3_ACCESS_KEY_ID?: string;
  S3_SECRET_ACCESS_KEY?: string;
  S3_SESSION_TOKEN?: string;
  S3_FORCE_PATH_STYLE?: string;
  S3_BLOB_PREFIX?: string;
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
  postgresDatabase?: PostgresQueryExecutor;
  quotaPolicy?: BlobQuotaPolicy;
  chunkBytes?: number;
  maxObjectBytes?: number;
}

export interface EmbeddedVectorStoreFactoryOptions {
  database?: Database.Database;
  postgresDatabase?: PostgresDatabase;
  env?: StorageFactoryEnvironment;
  principalResolver?: VectorPrincipalResolver;
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
const STORAGE_KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

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
  } catch {
    throw new StorageEncryptionError(
      'STORAGE_ENCRYPTION_KEYS must be a valid JSON object'
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
  const keys = Object.create(null) as Record<string, Buffer>;
  try {
    for (const [keyId, key] of entries) {
      if (!STORAGE_KEY_ID_PATTERN.test(keyId)) {
        throw new StorageEncryptionError(
          'STORAGE_ENCRYPTION_KEYS contains an invalid key ID'
        );
      }
      keys[keyId] = parseHexKey(key, 'Storage key material');
    }
    return keys;
  } catch (error) {
    for (const key of Object.values(keys)) key.fill(0);
    throw error;
  }
};

const sameKey = (left: Buffer, right: Buffer): boolean =>
  left.length === right.length && crypto.timingSafeEqual(left, right);

const clearKeys = (keys: Readonly<Record<string, Buffer>>): void => {
  for (const key of Object.values(keys)) key.fill(0);
};

const persistentKeyPath = (
  env: StorageKeyringEnvironment
): string | undefined => {
  const rawDataDirectory = env.DATA_DIR;
  if (rawDataDirectory === undefined || rawDataDirectory === '')
    return undefined;
  if (
    rawDataDirectory.trim() !== rawDataDirectory ||
    !path.isAbsolute(rawDataDirectory)
  ) {
    throw new StorageEncryptionError(
      'DATA_DIR must be an absolute path before storage initialization'
    );
  }
  return path.join(path.normalize(rawDataDirectory), '.encryption_key');
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
  let content: Buffer | undefined;
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

    content = Buffer.alloc(MAX_PERSISTENT_KEY_FILE_BYTES + 1);
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
    content?.fill(0);
    fs.closeSync(descriptor);
  }
};

const syncDirectory = (directory: string): void => {
  // Windows does not expose a portable directory-fsync operation through
  // Node. The key file itself is still fsynced before atomic publication.
  if (process.platform === 'win32') return;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
    fs.fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
};

/**
 * Select the legacy application encryption key before stateful modules load.
 * A fresh installation receives one durably published key; an existing store
 * without its original key always fails closed. The returned value is suitable
 * for assigning to ENCRYPTION_KEY and is never logged by this helper.
 */
export const provisionLegacyEncryptionKey = (
  env: StorageKeyringEnvironment = process.env
): string => {
  const environmentValue = env.ENCRYPTION_KEY;
  if (environmentValue !== undefined && environmentValue !== '') {
    if (environmentValue.trim() !== environmentValue) {
      throw new StorageEncryptionError(
        'ENCRYPTION_KEY must not contain leading or trailing whitespace'
      );
    }
  }

  // Resolve and validate every configured key source before creating a data
  // directory or publishing a key. In particular, malformed versioned-key
  // settings must fail without leaving behind state from a rejected launch.
  const resolvedKeys = resolveStorageKeys(env);
  if (resolvedKeys) {
    const legacyKey = resolvedKeys.keys.legacy;
    if (!legacyKey) {
      clearKeys(resolvedKeys.keys);
      throw new StorageEncryptionError(
        'Storage encryption configuration must retain the legacy key'
      );
    }
    try {
      return legacyKey.toString('hex');
    } finally {
      clearKeys(resolvedKeys.keys);
    }
  }

  const keyPath = persistentKeyPath(env);
  if (!keyPath) {
    throw new StorageEncryptionError(
      'DATA_DIR must be selected before provisioning the encryption key'
    );
  }

  const dataDirectory = path.dirname(keyPath);
  if (hasKeyDependentApplicationState(dataDirectory)) {
    throw new StorageEncryptionError(
      'Existing encrypted application state requires its original encryption key'
    );
  }

  const dataDirectoryExisted = fs.existsSync(dataDirectory);
  let temporaryPath: string | undefined;
  let published = false;
  const generatedKey = crypto.randomBytes(32);
  try {
    fs.mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
    const directoryStat = fs.lstatSync(dataDirectory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
      throw new StorageEncryptionError(
        'DATA_DIR must be a physical directory before key provisioning'
      );
    }
    if (process.platform !== 'win32') fs.chmodSync(dataDirectory, 0o700);

    temporaryPath = path.join(
      dataDirectory,
      `.encryption_key.${process.pid}.${crypto.randomUUID()}.tmp`
    );
    const descriptor = fs.openSync(
      temporaryPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
      0o600
    );
    try {
      if (process.platform !== 'win32') fs.fchmodSync(descriptor, 0o600);
      const serialized = Buffer.from(generatedKey.toString('hex'), 'utf8');
      try {
        let offset = 0;
        while (offset < serialized.length) {
          const bytesWritten = fs.writeSync(
            descriptor,
            serialized,
            offset,
            serialized.length - offset
          );
          if (bytesWritten <= 0) {
            throw new StorageEncryptionError(
              'Unable to completely write the persistent encryption key'
            );
          }
          offset += bytesWritten;
        }
        fs.fsyncSync(descriptor);
      } finally {
        serialized.fill(0);
      }
    } finally {
      fs.closeSync(descriptor);
    }

    // Hard-link publication is an atomic no-overwrite operation. Renaming a
    // staging file could silently replace a key created by another process.
    fs.linkSync(temporaryPath, keyPath);
    published = true;
    fs.unlinkSync(temporaryPath);
    temporaryPath = undefined;
    syncDirectory(dataDirectory);

    const verified = readPersistentStorageKey(env);
    if (!verified || !sameKey(generatedKey, verified)) {
      verified?.fill(0);
      throw new StorageEncryptionError(
        'The persistent encryption key could not be verified after publication'
      );
    }
    verified.fill(0);
    return generatedKey.toString('hex');
  } catch (error) {
    if (temporaryPath) {
      try {
        fs.unlinkSync(temporaryPath);
      } catch {
        // Preserve the original failure; a private orphan is safer than
        // continuing with an unpersisted key.
      }
    }
    // Once the canonical name has been published, never remove it during
    // rollback. Another process may already have selected that exact key; its
    // removal could make subsequently encrypted state unrecoverable. Startup
    // still fails closed, and the next launch revalidates the published file.
    if (!dataDirectoryExisted && !published) {
      try {
        fs.rmdirSync(dataDirectory);
      } catch {
        // Parent cleanup is best effort and never permits startup to continue.
      }
    }
    if (error instanceof StorageEncryptionError) throw error;
    throw new StorageEncryptionError(
      'Unable to durably provision the application encryption key'
    );
  } finally {
    generatedKey.fill(0);
  }
};

const resolveStorageKeys = (
  env: StorageKeyringEnvironment
): ResolvedStorageKeys | undefined => {
  const rawKeyMap = env.STORAGE_ENCRYPTION_KEYS?.trim();
  const requestedActiveKeyId = env.STORAGE_ENCRYPTION_ACTIVE_KEY_ID?.trim();
  const rawEnvironmentKey = env.ENCRYPTION_KEY?.trim();
  let environmentKey = rawEnvironmentKey
    ? parseHexKey(rawEnvironmentKey, 'ENCRYPTION_KEY')
    : undefined;
  let persistentKey: Buffer | undefined;
  let versionedKeys: Record<string, Buffer> | undefined;
  try {
    persistentKey = readPersistentStorageKey(env);

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
      versionedKeys = parseKeyMap(rawKeyMap);
      if (
        !STORAGE_KEY_ID_PATTERN.test(requestedActiveKeyId) ||
        !Object.prototype.hasOwnProperty.call(
          versionedKeys,
          requestedActiveKeyId
        )
      ) {
        throw new StorageEncryptionError(
          'The active storage key ID is invalid or unavailable'
        );
      }
      if (!legacyKey) {
        throw new StorageEncryptionError(
          'Versioned storage keys currently require a stable ENCRYPTION_KEY or DATA_DIR/.encryption_key legacy key'
        );
      }
      if (!versionedKeys.legacy || !sameKey(versionedKeys.legacy, legacyKey)) {
        throw new StorageEncryptionError(
          'Versioned storage keys must retain the configured legacy key as key ID legacy'
        );
      }
      environmentKey?.fill(0);
      environmentKey = undefined;
      persistentKey?.fill(0);
      persistentKey = undefined;
      const keys = versionedKeys;
      versionedKeys = undefined;
      return {
        source: 'versioned-keyring',
        activeKeyId: requestedActiveKeyId,
        keys,
      };
    }

    if (environmentKey) {
      persistentKey?.fill(0);
      persistentKey = undefined;
      const key = environmentKey;
      environmentKey = undefined;
      return {
        source: 'legacy-encryption-key',
        activeKeyId: 'legacy',
        keys: { legacy: key },
      };
    }
    if (persistentKey) {
      const key = persistentKey;
      persistentKey = undefined;
      return {
        source: 'persistent-key-file',
        activeKeyId: 'legacy',
        keys: { legacy: key },
      };
    }
    return undefined;
  } catch (error) {
    environmentKey?.fill(0);
    persistentKey?.fill(0);
    if (versionedKeys) clearKeys(versionedKeys);
    throw error;
  }
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
    if (!resolved) {
      return {
        status: 'missing',
        source: 'none',
        activeKeyId: null,
        keyFingerprints: [],
      };
    }
    try {
      return {
        status: 'configured',
        source: resolved.source,
        activeKeyId: resolved.activeKeyId,
        keyFingerprints: fingerprintKeys(resolved.keys),
      };
    } finally {
      clearKeys(resolved.keys);
    }
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
  try {
    return new Aes256GcmKeyring(resolved.activeKeyId, resolved.keys);
  } finally {
    clearKeys(resolved.keys);
  }
};

/**
 * Read the legacy application key for the offline SQLite migration command.
 * This is deliberately read-only: it never provisions state, and callers
 * must keep the returned secret out of logs and reports.
 */
export const resolveLegacyEncryptionKeyForMigration = (
  env: StorageKeyringEnvironment
): string => {
  const resolved = resolveStorageKeys(env);
  if (!resolved?.keys.legacy) {
    if (resolved) clearKeys(resolved.keys);
    throw new StorageEncryptionError(
      'SQLite migration requires the source legacy encryption key'
    );
  }
  try {
    return resolved.keys.legacy.toString('hex');
  } finally {
    clearKeys(resolved.keys);
  }
};

export const createBlobStore = (
  options: LocalBlobStoreFactoryOptions
): BlobStore => {
  const env = options.env ?? process.env;
  const backend = env.BLOB_STORE_BACKEND?.trim().toLowerCase() || 'local';
  if (backend === 's3') {
    if (!options.postgresDatabase) {
      throw new BlobStoreError(
        'invalid-input',
        'BLOB_STORE_BACKEND=s3 requires the shared PostgreSQL database'
      );
    }
    return createS3EncryptedBlobStore({
      database: options.postgresDatabase,
      keyring: createStorageKeyringFromEnvironment(env),
      env: env as S3BlobEnvironment,
      ...(options.quotaPolicy ? { quotaPolicy: options.quotaPolicy } : {}),
      ...(options.chunkBytes !== undefined
        ? { chunkBytes: options.chunkBytes }
        : {}),
      ...(options.maxObjectBytes !== undefined
        ? { maxObjectBytes: options.maxObjectBytes }
        : {}),
    });
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
    if (!options.postgresDatabase) {
      throw new VectorStoreError(
        'invalid-input',
        'VECTOR_STORE_BACKEND=pgvector requires the shared PostgreSQL database'
      );
    }
    return new PgVectorStore({
      database: options.postgresDatabase,
      ...(options.principalResolver
        ? { principalResolver: options.principalResolver }
        : {}),
    });
  }
  if (backend !== 'embedded') {
    throw new VectorStoreError(
      'invalid-input',
      'VECTOR_STORE_BACKEND must be embedded or pgvector'
    );
  }

  if (!options.database) {
    throw new VectorStoreError(
      'invalid-input',
      'VECTOR_STORE_BACKEND=embedded requires the selected SQLite database'
    );
  }

  return new SqliteEncryptedVectorStore({
    database: options.database,
    keyring: createStorageKeyringFromEnvironment(env),
    ...(options.principalResolver
      ? { principalResolver: options.principalResolver }
      : {}),
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
