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
import crypto from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test, { afterEach } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';

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
  SqliteEncryptedVectorStore,
  StorageEncryptionError,
  VectorStoreError,
  createBlobStore,
  createStorageKeyringFromEnvironment,
  createVectorStore,
  inspectStorageKeyConfiguration,
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
  const { database, store } = sqliteVectorStore();
  await store.upsert({
    actor: { userId: 'owner-a' },
    records: baseVectors,
  });
  database
    .prepare('UPDATE platform_vector_entries SET embedding = ? WHERE id = ?')
    .run(Buffer.from('intentionally corrupt'), 'alpha');

  const outsider = await store.query(query({ actor: { userId: 'outsider' } }));
  assert.deepEqual(outsider, []);

  const shared = await store.query(
    query({ actor: { userId: 'reader', groupIds: ['readers'] } })
  );
  assert.deepEqual(
    shared.map(hit => hit.id),
    ['beta']
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
  const { store } = sqliteVectorStore();
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
    error => error instanceof BlobStoreError && error.code === 'unavailable'
  );

  const database = new Database(':memory:');
  databases.push(database);
  assert.throws(
    () =>
      createVectorStore({
        database,
        env: { ...env, VECTOR_STORE_BACKEND: 'pgvector' },
      }),
    error => error instanceof VectorStoreError && error.code === 'unavailable'
  );
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
