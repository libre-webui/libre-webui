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

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test, { afterEach } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';

process.env.ENCRYPTION_KEY ||= '7'.repeat(64);

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '..');
const storageModule = await import(
  pathToFileURL(
    path.join(repoRoot, 'backend', 'dist', 'platform', 'storage', 'index.js')
  ).href
);
const migrationModule = await import(
  pathToFileURL(
    path.join(repoRoot, 'backend', 'dist', 'persistence', 'sqliteMigrations.js')
  ).href
);

const {
  Aes256GcmKeyring,
  BlobNotFoundError,
  BlobQuotaExceededError,
  BlobStoreError,
  LocalEncryptedBlobStore,
  SQLITE_BLOB_REFERENCE_SCHEMA_SQL,
  SQLITE_BLOB_QUOTA_SCHEMA_SQL,
  SQLiteDurableBlobQuotaPolicy,
  SqliteEncryptedVectorStore,
  StorageEncryptionError,
  VectorStoreError,
  createBlobStore,
  createStorageKeyringFromEnvironment,
  createVectorStore,
  inspectStorageKeyConfiguration,
  provisionLegacyEncryptionKey,
} = storageModule;

const temporaryRoots = [];
const databases = [];

afterEach(() => {
  while (databases.length > 0) databases.pop().close();
  while (temporaryRoots.length > 0) {
    fs.rmSync(temporaryRoots.pop(), { recursive: true, force: true });
  }
});

function temporaryDirectory(prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryRoots.push(directory);
  return directory;
}

test('storage barrel import is side-effect free before bootstrap', () => {
  const dataDirectory = temporaryDirectory('libre-storage-pure-import-');
  const barrelUrl = pathToFileURL(
    path.join(repoRoot, 'backend', 'dist', 'platform', 'storage', 'index.js')
  ).href;
  const childEnvironment = { ...process.env, DATA_DIR: dataDirectory };
  delete childEnvironment.ENCRYPTION_KEY;
  delete childEnvironment.STORAGE_ENCRYPTION_KEYS;
  delete childEnvironment.STORAGE_ENCRYPTION_ACTIVE_KEY_ID;
  const child = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `const fs = await import('node:fs'); await import(${JSON.stringify(
        barrelUrl
      )}); process.stdout.write(JSON.stringify(fs.readdirSync(${JSON.stringify(
        dataDirectory
      )})));`,
    ],
    { cwd: repoRoot, env: childEnvironment, encoding: 'utf8' }
  );
  assert.equal(child.status, 0, `${child.stderr}\n${child.stdout}`);
  assert.deepEqual(JSON.parse(child.stdout), []);
});

function keyring(key = Buffer.alloc(32, 0x41), keyId = 'test') {
  return new Aes256GcmKeyring(keyId, { [keyId]: key });
}

function blobStore(overrides = {}) {
  const rootDirectory = temporaryDirectory('libre-blob-store-');
  return {
    rootDirectory,
    store: new LocalEncryptedBlobStore({
      rootDirectory,
      keyring: keyring(),
      chunkBytes: 64 * 1024,
      maxObjectBytes: 2 * 1024 * 1024,
      ...overrides,
    }),
  };
}

function sqliteVectorStore(overrides = {}, databaseOptions = {}) {
  const database = new Database(':memory:', databaseOptions);
  databases.push(database);
  installVectorMigrationFixture(database);
  return {
    database,
    store: new SqliteEncryptedVectorStore({
      database,
      keyring: keyring(),
      ...overrides,
    }),
  };
}

function sqliteQuotaPolicy(options = {}) {
  const database = new Database(':memory:');
  databases.push(database);
  database.exec(SQLITE_BLOB_REFERENCE_SCHEMA_SQL);
  database.exec(SQLITE_BLOB_QUOTA_SCHEMA_SQL);
  return {
    database,
    policy: new SQLiteDurableBlobQuotaPolicy(database, options),
  };
}

function installVectorMigrationFixture(database, maximumVersion = 2) {
  database.exec(`
    CREATE TABLE _libre_schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      checksum TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    )
  `);
  for (const migration of migrationModule.SQLITE_MIGRATION_CONTRACT) {
    if (migration.version > maximumVersion) continue;
    database
      .prepare(
        `INSERT INTO _libre_schema_migrations
           (version, name, checksum, applied_at)
         VALUES (?, ?, ?, 1)`
      )
      .run(migration.version, migration.name, migration.checksum);
  }
  if (maximumVersion >= 2) {
    database.exec(migrationModule.PLATFORM_VECTOR_SCHEMA_SQL);
  }
}

async function readBody(result) {
  const chunks = [];
  for await (const chunk of result.body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function putBlob(store, bytes, overrides = {}) {
  return store.put({
    ownerUserId: 'owner-a',
    purpose: 'gallery.audio',
    contentType: 'audio/wav',
    expectedSize: bytes.length,
    originalFilename: 'private recording.wav',
    metadata: { source: 'test' },
    source: Readable.from([
      bytes.subarray(0, 17),
      bytes.subarray(17, 80_005),
      bytes.subarray(80_005),
    ]),
    ...overrides,
  });
}

function storedObjectPath(rootDirectory, id) {
  return path.join(
    rootDirectory,
    'objects',
    id.slice(0, 2),
    id.slice(2, 4),
    `${id}.blob`
  );
}

function observeDirectorySyncs(store) {
  const syncedDirectories = [];
  const syncDirectory = store.syncDirectory.bind(store);
  store.syncDirectory = async directory => {
    syncedDirectories.push(path.resolve(directory));
    await syncDirectory(directory);
  };
  return syncedDirectories;
}

function keyringCapturingDataKeys() {
  const ring = keyring();
  const encryptedDataKeys = [];
  const decryptedDataKeys = [];
  const encrypt = ring.encrypt.bind(ring);
  const decrypt = ring.decrypt.bind(ring);
  ring.encrypt = (plaintext, ...args) => {
    encryptedDataKeys.push(plaintext);
    return encrypt(plaintext, ...args);
  };
  ring.decrypt = (...args) => {
    const dataKey = decrypt(...args);
    decryptedDataKeys.push(dataKey);
    return dataKey;
  };
  return { ring, encryptedDataKeys, decryptedDataKeys };
}

function assertDataKeyWasZeroed(dataKey) {
  assert.equal(dataKey.equals(Buffer.alloc(dataKey.length)), true);
}

test('local blob store streams encrypted bytes, metadata, checksum, and exact ranges', async () => {
  const rootDirectory = temporaryDirectory('libre-blob-store-');
  const store = new LocalEncryptedBlobStore({
    rootDirectory,
    keyring: keyring(),
    chunkBytes: 64 * 1024,
  });
  const plaintext = Buffer.concat([
    Buffer.from('private-prefix:'),
    crypto.randomBytes(150_000),
    Buffer.from(':private-suffix'),
  ]);

  const descriptor = await putBlob(store, plaintext);
  assert.equal(descriptor.ownerUserId, 'owner-a');
  assert.equal(descriptor.size, plaintext.length);
  assert.equal(
    descriptor.sha256,
    crypto.createHash('sha256').update(plaintext).digest('hex')
  );
  assert.deepEqual(descriptor.metadata, { source: 'test' });

  const storedBytes = fs.readFileSync(
    storedObjectPath(rootDirectory, descriptor.id)
  );
  assert.equal(storedBytes.includes(Buffer.from('private-prefix:')), false);
  assert.equal(
    storedBytes.includes(Buffer.from('private recording.wav')),
    false
  );
  assert.equal(storedBytes.includes(Buffer.from('owner-a')), false);

  const complete = await store.open({
    id: descriptor.id,
    ownerUserId: 'owner-a',
  });
  assert.equal(complete.range, null);
  assert.deepEqual(await readBody(complete), plaintext);

  const range = await store.open({
    id: descriptor.id,
    ownerUserId: 'owner-a',
    range: { start: 65_500, end: 131_099 },
  });
  assert.deepEqual(range.range, {
    start: 65_500,
    end: 131_099,
    total: plaintext.length,
    length: 65_600,
  });
  assert.deepEqual(await readBody(range), plaintext.subarray(65_500, 131_100));
  assert.equal(fs.statSync(rootDirectory).mode & 0o777, 0o700);
  assert.equal(
    fs.statSync(storedObjectPath(rootDirectory, descriptor.id)).mode & 0o777,
    0o600
  );
});

test('local blob store supports authenticated empty objects', async () => {
  const { store } = blobStore();
  const descriptor = await putBlob(store, Buffer.alloc(0));
  assert.equal(descriptor.size, 0);
  assert.equal(
    descriptor.sha256,
    crypto.createHash('sha256').update(Buffer.alloc(0)).digest('hex')
  );
  const opened = await store.open({
    id: descriptor.id,
    ownerUserId: 'owner-a',
  });
  assert.deepEqual(await readBody(opened), Buffer.alloc(0));
});

test('local blob store hides cross-owner objects and deletes idempotently', async () => {
  const { store } = blobStore();
  const descriptor = await putBlob(store, Buffer.from('owner secret'));

  await assert.rejects(
    store.stat(descriptor.id, 'owner-b'),
    error => error instanceof BlobNotFoundError && error.code === 'not-found'
  );
  assert.equal(
    await store.delete({ id: descriptor.id, ownerUserId: 'owner-b' }),
    false
  );
  assert.equal(
    await store.delete({ id: descriptor.id, ownerUserId: 'owner-a' }),
    true
  );
  assert.equal(
    await store.delete({ id: descriptor.id, ownerUserId: 'owner-a' }),
    false
  );
});

test('local blob store rejects a symlinked storage root', async () => {
  const parent = temporaryDirectory('libre-blob-symlink-');
  const target = path.join(parent, 'target');
  const link = path.join(parent, 'link');
  fs.mkdirSync(target);
  fs.symlinkSync(target, link, 'dir');
  const store = new LocalEncryptedBlobStore({
    rootDirectory: link,
    keyring: keyring(),
    chunkBytes: 64 * 1024,
  });
  await assert.rejects(
    putBlob(store, Buffer.from('must-not-follow')),
    error => error instanceof BlobStoreError && error.code === 'unavailable'
  );
  assert.deepEqual(fs.readdirSync(target), []);
});

test('local blob store rejects symlinks in every object shard', async () => {
  const rootDirectory = temporaryDirectory('libre-blob-shards-');
  const escapedDirectory = temporaryDirectory('libre-blob-escaped-');
  const objectsDirectory = path.join(rootDirectory, 'objects');
  fs.mkdirSync(objectsDirectory);
  for (let index = 0; index < 256; index += 1) {
    fs.symlinkSync(
      escapedDirectory,
      path.join(objectsDirectory, index.toString(16).padStart(2, '0')),
      'dir'
    );
  }
  const store = new LocalEncryptedBlobStore({
    rootDirectory,
    keyring: keyring(),
    chunkBytes: 64 * 1024,
  });

  await assert.rejects(
    putBlob(store, Buffer.from('must-remain-inside-the-root')),
    error => error instanceof BlobStoreError && error.code === 'unavailable'
  );
  assert.deepEqual(fs.readdirSync(escapedDirectory), []);
});

test('local blob integrity verification is bounded, read-only, and authenticates every object', async () => {
  const { rootDirectory, store } = blobStore();
  const firstBytes = crypto.randomBytes(90_000);
  const secondBytes = Buffer.from('second encrypted object');
  const first = await putBlob(store, firstBytes);
  const second = await putBlob(store, secondBytes);
  const firstPath = storedObjectPath(rootDirectory, first.id);
  const secondPath = storedObjectPath(rootDirectory, second.id);
  const beforeFirst = fs.readFileSync(firstPath);
  const beforeSecond = fs.readFileSync(secondPath);
  const beforeFirstStat = fs.statSync(firstPath);

  assert.deepEqual(await store.verifyIntegrity(), {
    objects: 2,
    encryptedBytes: beforeFirst.length + beforeSecond.length,
    plaintextBytes: firstBytes.length + secondBytes.length,
  });
  assert.deepEqual(fs.readFileSync(firstPath), beforeFirst);
  assert.deepEqual(fs.readFileSync(secondPath), beforeSecond);
  assert.equal(fs.statSync(firstPath).mtimeMs, beforeFirstStat.mtimeMs);

  await assert.rejects(
    store.verifyIntegrity({ maxObjects: 1 }),
    error =>
      error instanceof BlobStoreError && error.code === 'verification-limit'
  );
  await assert.rejects(
    new LocalEncryptedBlobStore({
      rootDirectory,
      keyring: keyring(Buffer.alloc(32, 0x72)),
      chunkBytes: 64 * 1024,
    }).verifyIntegrity(),
    error => error instanceof BlobStoreError && error.code === 'corrupt'
  );

  const tampered = Buffer.from(beforeSecond);
  tampered[tampered.length - 1] ^= 0xff;
  fs.writeFileSync(secondPath, tampered);
  await assert.rejects(
    store.verifyIntegrity(),
    error => error instanceof BlobStoreError && error.code === 'corrupt'
  );

  const missingRoot = path.join(
    temporaryDirectory('libre-blob-integrity-missing-'),
    'absent'
  );
  assert.deepEqual(
    await new LocalEncryptedBlobStore({
      rootDirectory: missingRoot,
      keyring: keyring(),
    }).verifyIntegrity(),
    { objects: 0, encryptedBytes: 0, plaintextBytes: 0 }
  );
  assert.equal(fs.existsSync(missingRoot), false);
});

test('local blob integrity verification rejects non-canonical object entries', async () => {
  const rootDirectory = temporaryDirectory('libre-blob-invalid-layout-');
  const objectsDirectory = path.join(rootDirectory, 'objects');
  fs.mkdirSync(objectsDirectory);
  fs.writeFileSync(path.join(objectsDirectory, 'opaque-object'), 'arbitrary');
  const store = new LocalEncryptedBlobStore({
    rootDirectory,
    keyring: keyring(),
  });
  await assert.rejects(
    store.verifyIntegrity(),
    error => error instanceof BlobStoreError && error.code === 'corrupt'
  );
});

test('local blob store fails closed when ciphertext or AAD-bound owner metadata is changed', async () => {
  const rootDirectory = temporaryDirectory('libre-blob-store-');
  const store = new LocalEncryptedBlobStore({
    rootDirectory,
    keyring: keyring(),
    chunkBytes: 64 * 1024,
  });
  const descriptor = await putBlob(store, crypto.randomBytes(90_000));
  const objectPath = storedObjectPath(rootDirectory, descriptor.id);
  const bytes = fs.readFileSync(objectPath);
  bytes[bytes.length - 20] ^= 0xff;
  fs.writeFileSync(objectPath, bytes);

  const opened = await store.open({
    id: descriptor.id,
    ownerUserId: 'owner-a',
  });
  await assert.rejects(
    readBody(opened),
    error => error instanceof BlobStoreError && error.code === 'corrupt'
  );

  const otherRoot = temporaryDirectory('libre-blob-store-');
  const wrongKeyStore = new LocalEncryptedBlobStore({
    rootDirectory: otherRoot,
    keyring: keyring(Buffer.alloc(32, 0x42)),
    chunkBytes: 64 * 1024,
  });
  const wrongDescriptor = await putBlob(
    wrongKeyStore,
    Buffer.from('wrong-key-secret')
  );
  const readerWithDifferentKey = new LocalEncryptedBlobStore({
    rootDirectory: otherRoot,
    keyring: keyring(Buffer.alloc(32, 0x43)),
    chunkBytes: 64 * 1024,
  });
  await assert.rejects(
    readerWithDifferentKey.stat(wrongDescriptor.id, 'owner-a'),
    error => error instanceof BlobStoreError && error.code === 'corrupt'
  );
});

test('local blob store reads old key IDs after rotation and writes with the active key', async () => {
  const rootDirectory = temporaryDirectory('libre-blob-store-');
  const oldKey = Buffer.alloc(32, 0x31);
  const newKey = Buffer.alloc(32, 0x32);
  const oldStore = new LocalEncryptedBlobStore({
    rootDirectory,
    keyring: new Aes256GcmKeyring('old', { old: oldKey }),
    chunkBytes: 64 * 1024,
  });
  const oldPlaintext = Buffer.from('created-before-key-rotation');
  const oldDescriptor = await putBlob(oldStore, oldPlaintext);

  const rotatedStore = new LocalEncryptedBlobStore({
    rootDirectory,
    keyring: new Aes256GcmKeyring('new', { old: oldKey, new: newKey }),
    chunkBytes: 64 * 1024,
  });
  const oldRead = await rotatedStore.open({
    id: oldDescriptor.id,
    ownerUserId: 'owner-a',
  });
  assert.deepEqual(await readBody(oldRead), oldPlaintext);

  const newDescriptor = await putBlob(
    rotatedStore,
    Buffer.from('created-after-key-rotation')
  );
  assert.equal(oldDescriptor.encryptionKeyId, 'old');
  assert.equal(newDescriptor.encryptionKeyId, 'new');
});

test('local blob store zeroes unwrapped data keys on every completed read path', async () => {
  const rootDirectory = temporaryDirectory('libre-blob-zero-key-');
  const { ring: writerKeyring, encryptedDataKeys } = keyringCapturingDataKeys();
  const writer = new LocalEncryptedBlobStore({
    rootDirectory,
    keyring: writerKeyring,
    chunkBytes: 64 * 1024,
  });
  const plaintext = crypto.randomBytes(90_000);
  const descriptor = await putBlob(writer, plaintext);
  assert.equal(encryptedDataKeys.length, 1);
  assertDataKeyWasZeroed(encryptedDataKeys[0]);
  const { ring, decryptedDataKeys } = keyringCapturingDataKeys();
  const reader = new LocalEncryptedBlobStore({
    rootDirectory,
    keyring: ring,
    chunkBytes: 64 * 1024,
  });

  await reader.stat(descriptor.id, 'owner-a');
  assertDataKeyWasZeroed(decryptedDataKeys.at(-1));

  await assert.rejects(
    reader.open({
      id: descriptor.id,
      ownerUserId: 'owner-a',
      range: { start: plaintext.length },
    }),
    error => error instanceof BlobStoreError && error.code === 'invalid-range'
  );
  assertDataKeyWasZeroed(decryptedDataKeys.at(-1));

  const consumed = await reader.open({
    id: descriptor.id,
    ownerUserId: 'owner-a',
  });
  assert.deepEqual(await readBody(consumed), plaintext);
  assertDataKeyWasZeroed(decryptedDataKeys.at(-1));

  const unconsumed = await reader.open({
    id: descriptor.id,
    ownerUserId: 'owner-a',
  });
  const closed = once(unconsumed.body, 'close');
  unconsumed.body.destroy();
  await closed;
  assertDataKeyWasZeroed(decryptedDataKeys.at(-1));

  await reader.verifyIntegrity();
  assertDataKeyWasZeroed(decryptedDataKeys.at(-1));

  assert.equal(
    await reader.delete({ id: descriptor.id, ownerUserId: 'owner-a' }),
    true
  );
  assert.equal(decryptedDataKeys.length, 6);
  for (const dataKey of decryptedDataKeys) assertDataKeyWasZeroed(dataKey);
});

test('local blob store syncs both rename directories and rollback deletion', async () => {
  const { rootDirectory, store } = blobStore();
  const syncedDirectories = observeDirectorySyncs(store);
  const descriptor = await putBlob(store, Buffer.from('durable publish'));
  const destinationDirectory = path.dirname(
    storedObjectPath(rootDirectory, descriptor.id)
  );
  const stagingDirectory = path.join(rootDirectory, 'staging');
  assert.ok(syncedDirectories.includes(destinationDirectory));
  assert.ok(
    syncedDirectories.filter(directory => directory === stagingDirectory)
      .length >= 2
  );

  const rollbackRoot = temporaryDirectory('libre-blob-rollback-');
  const { ring: rollbackKeyring, encryptedDataKeys: rollbackDataKeys } =
    keyringCapturingDataKeys();
  const rollbackStore = new LocalEncryptedBlobStore({
    rootDirectory: rollbackRoot,
    keyring: rollbackKeyring,
    chunkBytes: 64 * 1024,
    quotaPolicy: {
      async reserve() {
        return {
          async consume() {},
          async commit() {
            throw new Error('simulated metadata commit failure');
          },
          async release() {},
        };
      },
    },
  });
  const rollbackSyncs = observeDirectorySyncs(rollbackStore);
  await assert.rejects(
    putBlob(rollbackStore, Buffer.from('must roll back')),
    error => error instanceof BlobStoreError && error.code === 'unavailable'
  );
  assert.equal(rollbackDataKeys.length, 1);
  assertDataKeyWasZeroed(rollbackDataKeys[0]);
  const objectsDirectory = path.join(rollbackRoot, 'objects');
  const rollbackShardSyncs = rollbackSyncs.filter(
    directory => path.dirname(path.dirname(directory)) === objectsDirectory
  );
  assert.equal(new Set(rollbackShardSyncs).size, 1);
  assert.ok(rollbackShardSyncs.length >= 2);
  assert.ok(
    rollbackSyncs.filter(
      directory => directory === path.join(rollbackRoot, 'staging')
    ).length >= 2
  );
  assert.deepEqual(
    fs
      .readdirSync(objectsDirectory, { recursive: true })
      .filter(entry => String(entry).endsWith('.blob')),
    []
  );
});

test('local blob store releases quota and leaves no object after a streamed failure', async () => {
  const events = [];
  const { rootDirectory, store } = blobStore({
    quotaPolicy: {
      async reserve(request) {
        events.push(['reserve', request.expectedSize]);
        let consumed = 0;
        return {
          async consume(bytes) {
            consumed += bytes;
            events.push(['consume', bytes]);
            if (consumed > 64 * 1024) {
              throw new BlobQuotaExceededError('test quota exhausted');
            }
          },
          async commit() {
            events.push(['commit']);
          },
          async release() {
            events.push(['release']);
          },
        };
      },
    },
  });
  const plaintext = crypto.randomBytes(100_000);

  await assert.rejects(
    putBlob(store, plaintext),
    error => error instanceof BlobQuotaExceededError
  );
  assert.equal(events.filter(event => event[0] === 'release').length, 1);
  assert.equal(
    events.some(event => event[0] === 'commit'),
    false
  );
  const objectFiles = fs
    .readdirSync(path.join(rootDirectory, 'objects'), {
      recursive: true,
    })
    .filter(name => String(name).endsWith('.blob'));
  assert.deepEqual(objectFiles, []);
});

test('durable SQLite quota atomically excludes concurrent over-reservation', async () => {
  const { database, policy } = sqliteQuotaPolicy({
    maximumBytesPerOwner: 100,
  });
  const attempts = await Promise.allSettled([
    policy.reserve({
      ownerUserId: 'quota-owner',
      purpose: 'gallery.audio',
      expectedSize: 60,
    }),
    policy.reserve({
      ownerUserId: 'quota-owner',
      purpose: 'gallery.audio',
      expectedSize: 60,
    }),
  ]);
  assert.equal(
    attempts.filter(result => result.status === 'fulfilled').length,
    1
  );
  assert.equal(
    attempts.filter(result => result.status === 'rejected').length,
    1
  );
  assert.ok(
    attempts.find(result => result.status === 'rejected').reason instanceof
      BlobQuotaExceededError
  );
  assert.deepEqual(
    database
      .prepare(
        `SELECT stored_bytes AS storedBytes, reserved_bytes AS reservedBytes
           FROM platform_blob_quota_usage WHERE owner_user_id = ?`
      )
      .get('quota-owner'),
    { storedBytes: 0, reservedBytes: 60 }
  );
  await attempts.find(result => result.status === 'fulfilled').value.release();
  assert.equal(
    database
      .prepare(
        'SELECT reserved_bytes FROM platform_blob_quota_usage WHERE owner_user_id = ?'
      )
      .get('quota-owner').reserved_bytes,
    0
  );
});

test('durable SQLite quota releases an aborted stream reservation', async () => {
  const { database, policy } = sqliteQuotaPolicy({
    maximumBytesPerOwner: 1_000,
  });
  const rootDirectory = temporaryDirectory('libre-durable-quota-abort-');
  const store = new LocalEncryptedBlobStore({
    rootDirectory,
    keyring: keyring(),
    quotaPolicy: policy,
  });
  async function* failedUpload() {
    yield Buffer.alloc(80, 0x61);
    throw new Error('simulated disconnected upload');
  }

  await assert.rejects(
    store.put({
      ownerUserId: 'quota-owner',
      purpose: 'gallery.audio',
      contentType: 'audio/wav',
      expectedSize: 100,
      source: failedUpload(),
    }),
    error => error instanceof BlobStoreError && error.code === 'unavailable'
  );
  assert.deepEqual(
    database
      .prepare(
        `SELECT stored_bytes AS storedBytes, reserved_bytes AS reservedBytes
           FROM platform_blob_quota_usage WHERE owner_user_id = ?`
      )
      .get('quota-owner'),
    { storedBytes: 0, reservedBytes: 0 }
  );
  assert.equal(
    database
      .prepare('SELECT COUNT(*) AS count FROM platform_blob_quota_reservations')
      .get().count,
    0
  );
  assert.deepEqual(
    fs
      .readdirSync(path.join(rootDirectory, 'objects'), { recursive: true })
      .filter(name => String(name).endsWith('.blob')),
    []
  );
});

test('durable SQLite quota repairs crashed reservations and missing objects', async () => {
  let now = 1_000;
  const { database, policy } = sqliteQuotaPolicy({
    maximumBytesPerOwner: 1_000,
    reservationTtlMs: 60_000,
    now: () => now,
  });
  const crashed = await policy.reserve({
    ownerUserId: 'quota-owner',
    purpose: 'document.source',
    expectedSize: 40,
  });
  await crashed.consume(20);
  now += 60_000;
  assert.deepEqual(await policy.reconcileExpiredReservations(), {
    releasedReservations: 1,
    releasedBytes: 40,
  });

  const committed = await policy.reserve({
    ownerUserId: 'quota-owner',
    purpose: 'document.source',
    expectedSize: 25,
  });
  await committed.consume(25);
  await committed.commit({
    id: 'missing-blob',
    ownerUserId: 'quota-owner',
    purpose: 'document.source',
    contentType: 'text/plain',
    metadata: {},
    size: 25,
    sha256: '0'.repeat(64),
    createdAt: new Date(now).toISOString(),
    encryptionKeyId: 'test',
    formatVersion: 1,
  });
  assert.deepEqual(await policy.listStoredObjectIdsByOwner('quota-owner'), [
    'missing-blob',
  ]);
  assert.deepEqual(
    await policy.reconcileMissingStoredObjects(async () => false),
    { releasedObjects: 1, releasedBytes: 25, inspectedObjects: 1 }
  );
  assert.deepEqual(
    database
      .prepare(
        `SELECT stored_bytes AS storedBytes, reserved_bytes AS reservedBytes
           FROM platform_blob_quota_usage WHERE owner_user_id = ?`
      )
      .get('quota-owner'),
    { storedBytes: 0, reservedBytes: 0 }
  );
  assert.deepEqual(await policy.listStoredObjectIdsByOwner('quota-owner'), []);
});

test('local blob orphan cleanup respects reference checks and an age grace period', async () => {
  const rootDirectory = temporaryDirectory('libre-blob-store-');
  const store = new LocalEncryptedBlobStore({
    rootDirectory,
    keyring: keyring(),
    chunkBytes: 64 * 1024,
  });
  const referenced = await putBlob(store, Buffer.from('referenced'));
  const orphan = await putBlob(store, Buffer.from('orphan'));
  const stagingPath = path.join(
    rootDirectory,
    'staging',
    'abandoned-object.tmp'
  );
  fs.writeFileSync(stagingPath, 'stale staging bytes');
  const old = new Date('2020-01-01T00:00:00Z');
  fs.utimesSync(storedObjectPath(rootDirectory, referenced.id), old, old);
  fs.utimesSync(storedObjectPath(rootDirectory, orphan.id), old, old);
  fs.utimesSync(stagingPath, old, old);
  const syncedDirectories = observeDirectorySyncs(store);

  const cleanup = await store.cleanupOrphans({
    olderThan: new Date('2021-01-01T00:00:00Z'),
    isReferenced: async id => id === referenced.id,
  });
  assert.deepEqual(cleanup, {
    deletedObjects: 1,
    deletedStagingFiles: 1,
    retainedObjects: 1,
  });
  assert.ok(
    syncedDirectories.includes(
      path.dirname(storedObjectPath(rootDirectory, orphan.id))
    )
  );
  assert.ok(syncedDirectories.includes(path.join(rootDirectory, 'staging')));
  assert.equal((await store.stat(referenced.id, 'owner-a')).id, referenced.id);
  await assert.rejects(store.stat(orphan.id, 'owner-a'), BlobNotFoundError);
});

test('local blob reconciliation is bounded and resumes from an opaque cursor', async () => {
  const rootDirectory = temporaryDirectory('libre-blob-reconcile-');
  const store = new LocalEncryptedBlobStore({
    rootDirectory,
    keyring: keyring(),
    chunkBytes: 64 * 1024,
  });
  const descriptors = [];
  for (const value of ['first', 'second', 'third']) {
    descriptors.push(await putBlob(store, Buffer.from(value)));
  }
  const old = new Date('2020-01-01T00:00:00Z');
  for (const descriptor of descriptors) {
    fs.utimesSync(storedObjectPath(rootDirectory, descriptor.id), old, old);
  }

  let continuationToken;
  let complete = false;
  let deletedObjects = 0;
  for (let pass = 0; pass < 10 && !complete; pass += 1) {
    const result = await store.reconcileOrphans({
      olderThan: new Date('2021-01-01T00:00:00Z'),
      maxEntries: 1,
      isReferenced: async () => false,
      ...(continuationToken ? { continuationToken } : {}),
    });
    assert.ok(result.inspectedEntries <= 1);
    deletedObjects += result.deletedObjects;
    continuationToken = result.continuationToken;
    complete = result.complete;
  }
  assert.equal(complete, true);
  assert.equal(deletedObjects, descriptors.length);
  await assert.rejects(
    store.reconcileOrphans({
      olderThan: new Date(),
      maxEntries: 1,
      isReferenced: async () => false,
      continuationToken: 'not-a-valid-cursor',
    }),
    /Invalid local reconciliation cursor/
  );
});

test('SQLite runtime reaps an aged blob left by a hard kill after durable rename', async () => {
  const dataDirectory = temporaryDirectory('libre-runtime-blob-recovery-');
  const blobRoot = path.join(dataDirectory, 'blobs');
  const storageUrl = pathToFileURL(
    path.join(repoRoot, 'backend', 'dist', 'platform', 'storage', 'index.js')
  ).href;
  const persistenceUrl = pathToFileURL(
    path.join(repoRoot, 'backend', 'dist', 'persistence', 'index.js')
  ).href;
  const encryptionUrl = pathToFileURL(
    path.join(repoRoot, 'backend', 'dist', 'services', 'encryptionService.js')
  ).href;
  const childEnvironment = {
    ...process.env,
    NODE_ENV: 'test',
    DATA_DIR: dataDirectory,
    DATABASE_BACKEND: 'sqlite',
    BLOB_STORE_BACKEND: 'local',
    VECTOR_STORE_BACKEND: 'embedded',
    ENCRYPTION_KEY: '7'.repeat(64),
  };
  const killed = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `const { Readable } = await import('node:stream');
       const storage = await import(${JSON.stringify(storageUrl)});
       const quotaPolicy = { async reserve() { return {
         async consume() {},
         async commit() {
           process.kill(process.pid, 'SIGKILL');
           await new Promise(() => {});
         },
         async release() {},
       }; } };
       const store = new storage.LocalEncryptedBlobStore({
         rootDirectory: ${JSON.stringify(blobRoot)},
         keyring: storage.createStorageKeyringFromEnvironment(process.env),
         quotaPolicy,
         chunkBytes: 64 * 1024,
       });
       await store.put({
         ownerUserId: 'killed-owner',
         purpose: 'document.source',
         contentType: 'text/plain',
         expectedSize: 12,
         source: Readable.from([Buffer.from('killed-bytes')]),
       });`,
    ],
    { cwd: repoRoot, env: childEnvironment, encoding: 'utf8' }
  );
  assert.equal(killed.signal, 'SIGKILL', killed.stderr);
  const objectFiles = () =>
    fs
      .readdirSync(path.join(blobRoot, 'objects'), { recursive: true })
      .map(value => String(value))
      .filter(value => value.endsWith('.blob'));
  assert.equal(objectFiles().length, 1);

  const runRuntime = () => {
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `const [{ encryptionService }, persistence, storage] = await Promise.all([
           import(${JSON.stringify(encryptionUrl)}),
           import(${JSON.stringify(persistenceUrl)}),
           import(${JSON.stringify(storageUrl)}),
         ]);
         const selected = await persistence.initializePersistence({
           dialect: 'sqlite', emailCodec: encryptionService, env: process.env,
         });
         const runtime = await storage.initializePlatformStorageRuntime({
           persistence: selected, cipher: encryptionService, env: process.env,
         });
         process.stdout.write(JSON.stringify(await runtime.health()));
         await storage.closePlatformStorageRuntime();
         await persistence.closePersistence();`,
      ],
      { cwd: repoRoot, env: childEnvironment, encoding: 'utf8' }
    );
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    assert.equal(JSON.parse(result.stdout).ready, true);
  };

  runRuntime();
  assert.equal(
    objectFiles().length,
    1,
    'the grace period preserves recent data'
  );
  const orphanPath = path.join(blobRoot, 'objects', objectFiles()[0]);
  const old = new Date('2020-01-01T00:00:00Z');
  fs.utimesSync(orphanPath, old, old);
  runRuntime();
  assert.equal(objectFiles().length, 0);
});

const baseVectors = [
  {
    namespace: 'document_chunk',
    id: 'alpha',
    ownerUserId: 'owner-a',
    resourceId: 'document-a',
    model: 'embed-model',
    dimensions: 3,
    version: 'v1',
    sourceRevision: 'sha256:alpha',
    embedding: [1, 0, 0],
    attributes: { collection: 'project-red' },
  },
  {
    namespace: 'document_chunk',
    id: 'beta',
    ownerUserId: 'owner-a',
    resourceId: 'document-b',
    model: 'embed-model',
    dimensions: 3,
    version: 'v1',
    sourceRevision: 'sha256:beta',
    embedding: [0.7, 0.7, 0],
    attributes: { collection: 'project-blue' },
    grants: [{ type: 'group', id: 'readers' }],
  },
];

function query(overrides = {}) {
  return {
    actor: { userId: 'owner-a' },
    namespace: 'document_chunk',
    model: 'embed-model',
    dimensions: 3,
    version: 'v1',
    embedding: [1, 0, 0],
    limit: 10,
    ...overrides,
  };
}

test('embedded vector adapter refuses to bypass migration v2', () => {
  const database = new Database(':memory:');
  databases.push(database);
  installVectorMigrationFixture(database, 1);

  assert.throws(
    () => new SqliteEncryptedVectorStore({ database, keyring: keyring() }),
    error => error instanceof VectorStoreError && error.code === 'unavailable'
  );
  assert.equal(
    database
      .prepare(
        "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name LIKE 'platform_vector_%'"
      )
      .get().count,
    0
  );
  assert.equal(
    database
      .prepare('SELECT MAX(version) AS version FROM _libre_schema_migrations')
      .get().version,
    1
  );
});

test('embedded vector store encrypts embeddings and returns deterministic cosine results', async () => {
  const { database, store } = sqliteVectorStore();
  await store.upsert({
    actor: { userId: 'owner-a' },
    records: baseVectors,
  });

  const raw = database
    .prepare('SELECT embedding FROM platform_vector_entries WHERE id = ?')
    .get('alpha').embedding;
  assert.equal(
    raw.includes(Buffer.from(new Float32Array([1, 0, 0]).buffer)),
    false
  );

  const hits = await store.query(query());
  assert.deepEqual(
    hits.map(hit => hit.id),
    ['alpha', 'beta']
  );
  assert.equal(hits[0].score, 1);
  assert.ok(Math.abs(hits[1].score - Math.SQRT1_2) < 1e-6);
  assert.deepEqual(hits[0].attributes, { collection: 'project-red' });

  const filtered = await store.query(
    query({ attributes: { collection: 'project-blue' } })
  );
  assert.deepEqual(
    filtered.map(hit => hit.id),
    ['beta']
  );
});

test('embedded vector ACLs are enforced by SQL before ciphertext is returned', async () => {
  const trustedGroups = new Map([['reader', ['readers']]]);
  const { database, store } = sqliteVectorStore({
    principalResolver: {
      async resolveGroupIds(userId) {
        return trustedGroups.get(userId) || [];
      },
    },
  });
  await store.upsert({
    actor: { userId: 'owner-a' },
    records: baseVectors,
  });
  database
    .prepare('UPDATE platform_vector_entries SET embedding = ? WHERE id = ?')
    .run(Buffer.from('intentionally corrupt'), 'alpha');

  const outsider = await store.query(query({ actor: { userId: 'outsider' } }));
  assert.deepEqual(outsider, []);

  const forged = await store.query(
    query({ actor: { userId: 'outsider', groupIds: ['readers'] } })
  );
  assert.deepEqual(forged, []);

  const shared = await store.query(
    query({ actor: { userId: 'reader', groupIds: ['readers'] } })
  );
  assert.deepEqual(
    shared.map(hit => hit.id),
    ['beta']
  );
  trustedGroups.delete('reader');
  assert.deepEqual(
    await store.query(
      query({ actor: { userId: 'reader', groupIds: ['readers'] } })
    ),
    [],
    'revoked trusted group membership must take effect immediately'
  );

  await assert.rejects(
    store.query(query()),
    error => error instanceof VectorStoreError && error.code === 'corrupt'
  );
});

test('embedded vector store separates model/version and owner-scopes all mutations', async () => {
  const { store } = sqliteVectorStore();
  await store.upsert({ actor: { userId: 'owner-a' }, records: baseVectors });

  assert.deepEqual(await store.query(query({ version: 'v2' })), []);
  assert.deepEqual(await store.query(query({ model: 'other-model' })), []);
  await assert.rejects(
    store.upsert({
      actor: { userId: 'owner-b' },
      records: [baseVectors[0]],
    }),
    error => error instanceof VectorStoreError && error.code === 'forbidden'
  );
  assert.equal(
    await store.delete({
      actor: { userId: 'owner-b' },
      namespace: 'document_chunk',
      resourceId: 'document-a',
    }),
    0
  );
  assert.equal(
    await store.delete({
      actor: { userId: 'owner-a' },
      namespace: 'document_chunk',
      resourceId: 'document-a',
    }),
    1
  );
  assert.deepEqual(
    (await store.query(query())).map(hit => hit.id),
    ['beta']
  );
});

test('embedded vector IDs are isolated across owners without existence leaks', async () => {
  const { store } = sqliteVectorStore();
  await store.upsert({
    actor: { userId: 'owner-a' },
    records: [baseVectors[0]],
  });
  await store.upsert({
    actor: { userId: 'owner-b' },
    records: [
      {
        ...baseVectors[0],
        ownerUserId: 'owner-b',
        sourceRevision: 'sha256:owner-b-alpha',
        embedding: [0, 1, 0],
      },
    ],
  });
  const ownerHits = await store.query(query());
  assert.deepEqual(
    ownerHits.map(hit => hit.id),
    ['alpha']
  );
  assert.equal(ownerHits[0].score, 1);
  assert.equal(ownerHits[0].sourceRevision, 'sha256:alpha');

  const secondOwnerHits = await store.query(
    query({ actor: { userId: 'owner-b' } })
  );
  assert.deepEqual(
    secondOwnerHits.map(hit => hit.id),
    ['alpha']
  );
  assert.equal(secondOwnerHits[0].score, 0);
  assert.equal(secondOwnerHits[0].sourceRevision, 'sha256:owner-b-alpha');
});

test('embedded vector upserts replace ACLs and embeddings atomically', async () => {
  const { store } = sqliteVectorStore({
    principalResolver: {
      async resolveGroupIds(userId) {
        return userId === 'reader' ? ['readers'] : [];
      },
    },
  });
  await store.upsert({
    actor: { userId: 'owner-a' },
    records: [baseVectors[1]],
  });
  assert.deepEqual(
    (
      await store.query(
        query({ actor: { userId: 'reader', groupIds: ['readers'] } })
      )
    ).map(hit => hit.id),
    ['beta']
  );

  await store.upsert({
    actor: { userId: 'owner-a' },
    records: [
      {
        ...baseVectors[1],
        embedding: [0, 1, 0],
        sourceRevision: 'sha256:beta-v2',
        grants: [],
      },
    ],
  });
  assert.deepEqual(
    await store.query(
      query({ actor: { userId: 'reader', groupIds: ['readers'] } })
    ),
    []
  );
  const ownerHits = await store.query(query());
  assert.equal(ownerHits[0].sourceRevision, 'sha256:beta-v2');
  assert.equal(ownerHits[0].score, 0);
});

test('embedded vector store rejects malformed embeddings and broad candidate scans', async () => {
  const { store } = sqliteVectorStore({ maxCandidates: 1 });
  await assert.rejects(
    store.upsert({
      actor: { userId: 'owner-a' },
      records: [{ ...baseVectors[0], embedding: [1, Number.NaN, 0] }],
    }),
    error => error instanceof VectorStoreError && error.code === 'invalid-input'
  );
  await store.upsert({ actor: { userId: 'owner-a' }, records: baseVectors });
  await assert.rejects(
    store.query(query()),
    error =>
      error instanceof VectorStoreError && error.code === 'candidate-limit'
  );
});

test('embedded vector store rejects encrypted byte and scoring budgets before materializing candidates', async () => {
  const statements = [];
  const byteLimited = sqliteVectorStore(
    {
      maxCandidates: 10,
      maxCandidateBytes: 1,
      maxScoringComponents: 1_000,
    },
    { verbose: sql => statements.push(sql) }
  );
  await byteLimited.store.upsert({
    actor: { userId: 'owner-a' },
    records: baseVectors,
  });
  byteLimited.database
    .prepare('UPDATE platform_vector_entries SET embedding = ? WHERE id = ?')
    .run(Buffer.from('intentionally corrupt'), 'alpha');
  statements.length = 0;
  await assert.rejects(
    byteLimited.store.query(query()),
    error =>
      error instanceof VectorStoreError && error.code === 'candidate-limit'
  );
  assert.equal(
    statements.some(statement =>
      statement.includes('ORDER BY e.namespace, e.owner_user_id, e.id')
    ),
    false,
    'candidate ciphertext SELECT must not execute after the aggregate budget fails'
  );

  const workLimited = sqliteVectorStore({
    maxCandidates: 10,
    maxCandidateBytes: 1_000_000,
    maxScoringComponents: 5,
  });
  await workLimited.store.upsert({
    actor: { userId: 'owner-a' },
    records: baseVectors,
  });
  await assert.rejects(
    workLimited.store.query(query()),
    error =>
      error instanceof VectorStoreError && error.code === 'candidate-limit'
  );
});

test('embedded vector integrity verification is bounded, read-only, and authenticates every row', async () => {
  const statements = [];
  const { database, store } = sqliteVectorStore(
    {},
    { verbose: sql => statements.push(sql) }
  );
  await store.upsert({ actor: { userId: 'owner-a' }, records: baseVectors });
  const aggregate = database
    .prepare(
      `SELECT COUNT(*) AS records,
              SUM(LENGTH(embedding)) AS encryptedBytes,
              SUM(dimensions) AS components
       FROM platform_vector_entries`
    )
    .get();
  const changesBefore = database
    .prepare('SELECT total_changes() AS changes')
    .get().changes;

  assert.deepEqual(store.verifyIntegrity(), aggregate);
  assert.equal(
    database.prepare('SELECT total_changes() AS changes').get().changes,
    changesBefore
  );

  statements.length = 0;
  assert.throws(
    () => store.verifyIntegrity({ maxRecords: 1 }),
    error =>
      error instanceof VectorStoreError && error.code === 'verification-limit'
  );
  assert.equal(
    statements.some(statement =>
      statement.includes('ORDER BY namespace, owner_user_id, id')
    ),
    false,
    'ciphertext iteration must not start after aggregate limits fail'
  );

  assert.throws(
    () =>
      new SqliteEncryptedVectorStore({
        database,
        keyring: keyring(Buffer.alloc(32, 0x72)),
      }).verifyIntegrity(),
    error => error instanceof VectorStoreError && error.code === 'corrupt'
  );

  const encrypted = database
    .prepare('SELECT embedding FROM platform_vector_entries WHERE id = ?')
    .get('alpha').embedding;
  const tampered = Buffer.from(encrypted);
  tampered[tampered.length - 1] ^= 0xff;
  database
    .prepare('UPDATE platform_vector_entries SET embedding = ? WHERE id = ?')
    .run(tampered, 'alpha');
  assert.throws(
    () => store.verifyIntegrity(),
    error => error instanceof VectorStoreError && error.code === 'corrupt'
  );
});

test('storage factories support only implemented backends and require durable key material', () => {
  const env = { ENCRYPTION_KEY: 'ab'.repeat(32) };
  assert.equal(createStorageKeyringFromEnvironment(env).activeKeyId, 'legacy');
  assert.throws(
    () => createStorageKeyringFromEnvironment({}),
    StorageEncryptionError
  );
  assert.throws(
    () =>
      createBlobStore({
        rootDirectory: temporaryDirectory('libre-blob-store-'),
        env: { ...env, BLOB_STORE_BACKEND: 's3' },
      }),
    error =>
      error instanceof BlobStoreError &&
      error.code === 'invalid-input' &&
      error.message.includes('shared PostgreSQL database')
  );

  const database = new Database(':memory:');
  databases.push(database);
  assert.throws(
    () =>
      createVectorStore({
        database,
        env: { ...env, VECTOR_STORE_BACKEND: 'pgvector' },
      }),
    error =>
      error instanceof VectorStoreError &&
      error.code === 'invalid-input' &&
      error.message.includes('shared PostgreSQL database')
  );
});

test('key bootstrap durably provisions one private key before stateful application import', () => {
  const root = temporaryDirectory('libre-key-bootstrap-');
  const dataDirectory = path.join(root, 'data');
  const output = [];
  const originalConsole = {
    error: console.error,
    info: console.info,
    log: console.log,
    warn: console.warn,
  };
  for (const method of Object.keys(originalConsole)) {
    console[method] = (...values) => output.push(values.join(' '));
  }

  let generatedKey;
  try {
    generatedKey = provisionLegacyEncryptionKey({ DATA_DIR: dataDirectory });
  } finally {
    Object.assign(console, originalConsole);
  }

  assert.match(generatedKey, /^[0-9a-f]{64}$/);
  const keyPath = path.join(dataDirectory, '.encryption_key');
  assert.equal(fs.readFileSync(keyPath, 'utf8'), generatedKey);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(dataDirectory).mode & 0o777, 0o700);
    assert.equal(fs.statSync(keyPath).mode & 0o777, 0o600);
  }
  assert.deepEqual(fs.readdirSync(dataDirectory), ['.encryption_key']);
  assert.equal(fs.existsSync(path.join(dataDirectory, 'data.sqlite')), false);
  assert.equal(fs.existsSync(path.join(dataDirectory, 'plugins')), false);
  assert.equal(fs.existsSync(path.join(dataDirectory, 'blobs')), false);
  assert.doesNotMatch(output.join('\n'), new RegExp(generatedKey, 'i'));

  const before = fs.statSync(keyPath);
  assert.equal(
    provisionLegacyEncryptionKey({ DATA_DIR: dataDirectory }),
    generatedKey
  );
  const after = fs.statSync(keyPath);
  assert.equal(after.mtimeMs, before.mtimeMs);

  const mainSource = fs.readFileSync(
    path.join(repoRoot, 'backend', 'src', 'main.ts'),
    'utf8'
  );
  const canonicalSelection = mainSource.indexOf(
    'process.env.DATA_DIR = dataDir'
  );
  const provision = mainSource.indexOf(
    'provisionLegacyEncryptionKey(process.env)'
  );
  const statefulImport = mainSource.indexOf("await import('./index.js')");
  assert.ok(canonicalSelection >= 0 && canonicalSelection < provision);
  assert.ok(provision >= 0 && provision < statefulImport);
});

test('key bootstrap rolls back a persistence failure before creating application state', () => {
  const root = temporaryDirectory('libre-key-persistence-failure-');
  const dataDirectory = path.join(root, 'data');
  const secretSentinel = 'raw-key-material-must-not-escape';
  const originalLinkSync = fs.linkSync;
  fs.linkSync = () => {
    throw new Error(secretSentinel);
  };
  try {
    assert.throws(
      () => provisionLegacyEncryptionKey({ DATA_DIR: dataDirectory }),
      error => {
        assert.ok(error instanceof StorageEncryptionError);
        assert.match(error.message, /durably provision/i);
        assert.doesNotMatch(error.message, new RegExp(secretSentinel, 'i'));
        return true;
      }
    );
  } finally {
    fs.linkSync = originalLinkSync;
  }

  assert.equal(fs.existsSync(dataDirectory), false);
  assert.equal(fs.existsSync(path.join(dataDirectory, 'data.sqlite')), false);
  assert.equal(fs.existsSync(path.join(dataDirectory, 'plugins')), false);
  assert.equal(fs.existsSync(path.join(dataDirectory, 'blobs')), false);
});

test('team worker refuses missing deployment keys before creating local state', () => {
  const root = temporaryDirectory('libre-team-worker-no-key-');
  const dataDirectory = path.join(root, 'data');
  const result = spawnSync(
    process.execPath,
    [path.join(repoRoot, 'backend', 'dist', 'worker.js')],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 10_000,
      env: {
        ...process.env,
        DATA_DIR: dataDirectory,
        PLATFORM_PREFLIGHT_TMP_DIR: path.join(root, 'preflight'),
        LIBRE_PLATFORM_MODE: 'team',
        DATABASE_BACKEND: 'postgres',
        DATABASE_URL: 'postgresql://worker.invalid/libre',
        DATABASE_SSL_MODE: 'disable',
        BLOB_STORE_BACKEND: 's3',
        S3_BUCKET: 'worker-test',
        S3_REGION: 'us-east-1',
        S3_ACCESS_KEY_ID: 'worker-test',
        S3_SECRET_ACCESS_KEY: 'worker-test',
        VECTOR_STORE_BACKEND: 'pgvector',
        COORDINATION_BACKEND: 'redis',
        REDIS_URL: 'redis://worker.invalid:6379',
        JOB_WORKER_MODE: 'external',
        JWT_SECRET:
          'team-worker-no-key-jwt-secret-team-worker-no-key-jwt-secret',
        AGENT_CLI_MODELS_ENABLED: 'false',
        CODEX_OAUTH_MODELS_ENABLED: 'false',
        ENCRYPTION_KEY: '',
        STORAGE_ENCRYPTION_KEYS: '',
        STORAGE_ENCRYPTION_ACTIVE_KEY_ID: '',
      },
    }
  );
  assert.notEqual(result.status, 0);
  assert.match(
    `${result.stdout}\n${result.stderr}`,
    /Team mode requires encryption keys supplied by the deployment secret/
  );
  assert.equal(fs.existsSync(dataDirectory), false);
});

test('persona memory indexing removes a vector recreated after persona deletion', async () => {
  const record = {
    id: 'memory-race',
    userId: 'owner-race',
    personaId: 'persona-race',
    content: 'A memory racing persona deletion',
    timestamp: Date.now(),
    importanceScore: 0.5,
    memoryType: 'general',
    accessCount: 0,
    decayFactor: 1,
  };
  let memoryPresent = true;
  let vectorPresent = false;
  let releaseUpsert;
  let markUpsertStarted;
  const upsertStarted = new Promise(resolve => {
    markUpsertStarted = resolve;
  });
  const upsertReleased = new Promise(resolve => {
    releaseUpsert = resolve;
  });
  const deletedIds = [];
  const runtime = {
    domains: {
      memories: {
        async findByOwner(id, userId, personaId) {
          return memoryPresent &&
            id === record.id &&
            userId === record.userId &&
            personaId === record.personaId
            ? record
            : undefined;
        },
      },
    },
    vectorStore: {
      async upsert() {
        markUpsertStarted();
        await upsertReleased;
        vectorPresent = true;
      },
      async delete(request) {
        deletedIds.push(...(request.ids || []));
        vectorPresent = false;
        return request.ids?.length || 0;
      },
    },
  };
  const indexing = (async () => {
    await runtime.vectorStore.upsert();
    await storageModule.assertPersonaMemoryStillReferenced(
      runtime,
      record,
      'persona-memory'
    );
  })();
  await upsertStarted;

  // The relational delete and its first cleanup pass win while the vector
  // write is paused. Releasing the write recreates the vector after cleanup.
  memoryPresent = false;
  vectorPresent = false;
  releaseUpsert();

  await assert.rejects(indexing, /disappeared while it was being indexed/);
  assert.equal(vectorPresent, false);
  assert.deepEqual(deletedIds, [record.id]);
});

test('legacy encryption service import aborts instead of retaining an unpersisted key', () => {
  const root = temporaryDirectory('libre-legacy-key-failure-');
  const blockedDataDirectory = path.join(root, 'not-a-directory');
  const before = Buffer.from('path blocker');
  fs.writeFileSync(blockedDataDirectory, before);
  const env = {
    ...process.env,
    DATA_DIR: blockedDataDirectory,
  };
  delete env.ENCRYPTION_KEY;
  delete env.STORAGE_ENCRYPTION_ACTIVE_KEY_ID;
  delete env.STORAGE_ENCRYPTION_KEYS;

  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `await import(${JSON.stringify(
        pathToFileURL(
          path.join(
            repoRoot,
            'backend',
            'dist',
            'services',
            'encryptionService.js'
          )
        ).href
      )})`,
    ],
    { cwd: root, env, encoding: 'utf8', timeout: 10_000 }
  );
  const output = `${result.stderr}\n${result.stdout}`;
  assert.notEqual(result.status, 0);
  assert.match(output, /refusing to continue with an ephemeral key/i);
  assert.doesNotMatch(output, /\b[0-9a-f]{64}\b/i);
  assert.deepEqual(fs.readFileSync(blockedDataDirectory), before);
  assert.deepEqual(fs.readdirSync(root), ['not-a-directory']);
});

test('key bootstrap fails closed for existing state without its original key', () => {
  const dataDirectory = temporaryDirectory('libre-key-existing-state-');
  const databasePath = path.join(dataDirectory, 'data.sqlite');
  const before = Buffer.from('existing-encrypted-state');
  fs.writeFileSync(databasePath, before, { mode: 0o600 });

  assert.throws(
    () => provisionLegacyEncryptionKey({ DATA_DIR: dataDirectory }),
    error =>
      error instanceof StorageEncryptionError &&
      /requires its original encryption key/i.test(error.message)
  );
  assert.deepEqual(fs.readFileSync(databasePath), before);
  assert.equal(
    fs.existsSync(path.join(dataDirectory, '.encryption_key')),
    false
  );
  assert.deepEqual(fs.readdirSync(dataDirectory), ['data.sqlite']);
});

test('storage initialization rejects relative DATA_DIR after bootstrap selection', () => {
  const validKey = '7a'.repeat(32);
  assert.throws(
    () =>
      provisionLegacyEncryptionKey({
        DATA_DIR: './relative-data',
        ENCRYPTION_KEY: validKey,
      }),
    error =>
      error instanceof StorageEncryptionError &&
      /DATA_DIR must be an absolute path/i.test(error.message)
  );
  assert.throws(
    () =>
      createStorageKeyringFromEnvironment({
        DATA_DIR: './relative-data',
        ENCRYPTION_KEY: validKey,
      }),
    error =>
      error instanceof StorageEncryptionError &&
      /DATA_DIR must be an absolute path/i.test(error.message)
  );
});

test('invalid versioned key settings fail without provisioning local state', () => {
  const root = temporaryDirectory('libre-invalid-key-bootstrap-');
  const dataDirectory = path.join(root, 'data');
  const secretSentinel = 'secret-sentinel';
  assert.throws(
    () =>
      provisionLegacyEncryptionKey({
        DATA_DIR: dataDirectory,
        STORAGE_ENCRYPTION_ACTIVE_KEY_ID: 'active',
        STORAGE_ENCRYPTION_KEYS: JSON.stringify({ active: secretSentinel }),
      }),
    error => {
      assert.ok(error instanceof StorageEncryptionError);
      assert.doesNotMatch(error.message, new RegExp(secretSentinel, 'i'));
      return true;
    }
  );
  assert.equal(fs.existsSync(dataDirectory), false);
});

test('storage key factory reads the persistent data key without mutating it and rejects conflicts', () => {
  const dataDirectory = temporaryDirectory('libre-storage-key-');
  const keyPath = path.join(dataDirectory, '.encryption_key');
  const persistentKey = '33'.repeat(32);
  const activeKey = '44'.repeat(32);
  fs.writeFileSync(keyPath, persistentKey, { mode: 0o600 });
  fs.chmodSync(keyPath, 0o600);
  const before = fs.statSync(keyPath);

  const keyring = createStorageKeyringFromEnvironment({
    DATA_DIR: dataDirectory,
  });
  assert.equal(keyring.activeKeyId, 'legacy');
  const aad = Buffer.from('persistent-key-test');
  const ciphertext = keyring.encrypt(Buffer.from('private'), aad);
  assert.equal(keyring.decrypt(ciphertext, aad).toString('utf8'), 'private');
  assert.deepEqual(
    inspectStorageKeyConfiguration({ DATA_DIR: dataDirectory }),
    {
      status: 'configured',
      source: 'persistent-key-file',
      activeKeyId: 'legacy',
      keyFingerprints: [
        {
          keyId: 'legacy',
          sha256Prefix: crypto
            .createHash('sha256')
            .update(Buffer.from(persistentKey, 'hex'))
            .digest('hex')
            .slice(0, 16),
        },
      ],
    }
  );
  const after = fs.statSync(keyPath);
  assert.equal(fs.readFileSync(keyPath, 'utf8'), persistentKey);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal(after.mode & 0o777, 0o600);

  assert.throws(
    () =>
      createStorageKeyringFromEnvironment({
        DATA_DIR: dataDirectory,
        ENCRYPTION_KEY: '55'.repeat(32),
      }),
    StorageEncryptionError
  );
  assert.throws(
    () =>
      createStorageKeyringFromEnvironment({
        DATA_DIR: dataDirectory,
        STORAGE_ENCRYPTION_ACTIVE_KEY_ID: 'active',
        STORAGE_ENCRYPTION_KEYS: JSON.stringify({ active: activeKey }),
      }),
    StorageEncryptionError
  );
  assert.equal(
    createStorageKeyringFromEnvironment({
      DATA_DIR: dataDirectory,
      STORAGE_ENCRYPTION_ACTIVE_KEY_ID: 'active',
      STORAGE_ENCRYPTION_KEYS: JSON.stringify({
        legacy: persistentKey,
        active: activeKey,
      }),
    }).activeKeyId,
    'active'
  );
});

test('storage key factory rejects unsafe persistent key files', () => {
  if (process.platform === 'win32') return;

  const dataDirectory = temporaryDirectory('libre-storage-key-mode-');
  const keyPath = path.join(dataDirectory, '.encryption_key');
  fs.writeFileSync(keyPath, '66'.repeat(32), { mode: 0o644 });
  fs.chmodSync(keyPath, 0o644);
  assert.throws(
    () => createStorageKeyringFromEnvironment({ DATA_DIR: dataDirectory }),
    StorageEncryptionError
  );

  fs.rmSync(keyPath);
  const targetPath = path.join(dataDirectory, 'actual-key');
  fs.writeFileSync(targetPath, '66'.repeat(32), { mode: 0o600 });
  fs.symlinkSync(targetPath, keyPath);
  assert.throws(
    () => createStorageKeyringFromEnvironment({ DATA_DIR: dataDirectory }),
    StorageEncryptionError
  );
});

test('storage key inspection is deterministic and never returns key bytes', () => {
  const oldKey = '11'.repeat(32);
  const activeKey = '22'.repeat(32);
  const inspection = inspectStorageKeyConfiguration({
    ENCRYPTION_KEY: oldKey,
    STORAGE_ENCRYPTION_ACTIVE_KEY_ID: 'active',
    STORAGE_ENCRYPTION_KEYS: JSON.stringify({
      legacy: oldKey,
      active: activeKey,
    }),
  });
  assert.deepEqual(inspection, {
    status: 'configured',
    source: 'versioned-keyring',
    activeKeyId: 'active',
    keyFingerprints: [
      {
        keyId: 'active',
        sha256Prefix: crypto
          .createHash('sha256')
          .update(Buffer.from(activeKey, 'hex'))
          .digest('hex')
          .slice(0, 16),
      },
      {
        keyId: 'legacy',
        sha256Prefix: crypto
          .createHash('sha256')
          .update(Buffer.from(oldKey, 'hex'))
          .digest('hex')
          .slice(0, 16),
      },
    ],
  });
  assert.equal(JSON.stringify(inspection).includes(oldKey), false);
  assert.equal(JSON.stringify(inspection).includes(activeKey), false);
  assert.equal(
    inspectStorageKeyConfiguration({
      STORAGE_ENCRYPTION_ACTIVE_KEY_ID: 'active',
      STORAGE_ENCRYPTION_KEYS: JSON.stringify({ active: activeKey }),
    }).status,
    'invalid'
  );
  assert.deepEqual(inspectStorageKeyConfiguration({}), {
    status: 'missing',
    source: 'none',
    activeKeyId: null,
    keyFingerprints: [],
  });
  assert.deepEqual(
    inspectStorageKeyConfiguration({
      STORAGE_ENCRYPTION_KEYS: '{not-json',
      STORAGE_ENCRYPTION_ACTIVE_KEY_ID: 'attacker-controlled\nvalue',
    }),
    {
      status: 'invalid',
      source: 'versioned-keyring',
      activeKeyId: null,
      keyFingerprints: [],
    }
  );
});
