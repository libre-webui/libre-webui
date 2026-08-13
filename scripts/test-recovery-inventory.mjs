import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import Database from 'better-sqlite3';

const repoRoot = path.resolve(import.meta.dirname, '..');
const testSource = process.env.LIBRE_OPERATIONAL_TEST_SOURCE === '1';
const modulePath = path.join(
  repoRoot,
  'backend',
  testSource ? 'src' : 'dist',
  'services',
  testSource ? 'recoveryInventoryService.ts' : 'recoveryInventoryService.js'
);
const inventoryModule = await import(pathToFileURL(modulePath).href);
const newRecoveryService = () =>
  new inventoryModule.RecoveryInventoryService({
    legacyPluginsDirectories: [],
  });
const legacyCiphertextModulePath = path.join(
  repoRoot,
  'backend',
  testSource ? 'src' : 'dist',
  'services',
  testSource ? 'legacyCiphertextIntegrity.ts' : 'legacyCiphertextIntegrity.js'
);
const { verifyLegacyCiphertextIntegrity } = await import(
  pathToFileURL(legacyCiphertextModulePath).href
);
const storageModulePath = path.join(
  repoRoot,
  'backend',
  testSource ? 'src' : 'dist',
  'platform',
  'storage',
  testSource ? 'index.ts' : 'index.js'
);
const storageModule = await import(pathToFileURL(storageModulePath).href);
const {
  Aes256GcmKeyring,
  LocalEncryptedBlobStore,
  SqliteEncryptedVectorStore,
} = storageModule;
const jobsModulePath = path.join(
  repoRoot,
  'backend',
  testSource ? 'src' : 'dist',
  'platform',
  'jobs',
  testSource ? 'index.ts' : 'index.js'
);
const jobsModule = await import(pathToFileURL(jobsModulePath).href);
const { DurableJobService, SQLiteDurableJobRepository } = jobsModule;
const cliPath = path.join(
  repoRoot,
  'backend',
  testSource ? 'src' : 'dist',
  'cli',
  testSource ? 'recoveryInventory.ts' : 'recoveryInventory.js'
);
const cliRuntimeArgs = testSource ? ['--import', 'tsx'] : [];
const encryptionKey = 'a4'.repeat(32);
const jwtSecret = 'recovery-jwt-secret-that-must-never-be-reported';
const sessionSecret = 'recovery-session-secret-that-must-never-be-reported';

const encryptLegacyText = (plaintext, key = encryptionKey) => {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(
    'aes-256-gcm',
    Buffer.from(key, 'hex'),
    iv
  );
  const encrypted = Buffer.concat([
    cipher.update(Buffer.from(plaintext, 'utf8')),
    cipher.final(),
  ]);
  return `${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${encrypted.toString('hex')}`;
};

const identityEmailLookup = (email, key = encryptionKey) =>
  crypto
    .createHmac('sha256', Buffer.from(key, 'hex'))
    .update('libre:identity-email:v1\0', 'utf8')
    .update(email, 'utf8')
    .digest('hex');

const encryptLegacyBuffer = (
  plaintext,
  additionalData,
  key = encryptionKey
) => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(
    'aes-256-gcm',
    Buffer.from(key, 'hex'),
    iv
  );
  cipher.setAAD(Buffer.from(additionalData, 'utf8'));
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([
    Buffer.from('LWB1', 'ascii'),
    iv,
    cipher.getAuthTag(),
    encrypted,
  ]);
};

const seedLegacyVoice = (database, id = 'voice', userId = 'default') => {
  const audio = Buffer.from('authenticated voice bytes');
  database
    .prepare(
      `INSERT INTO voice_profiles
         (id, user_id, name, plugin_id, model, routing_fingerprint,
          reference_audio, reference_text, audio_mime_type, audio_format,
          audio_size, consent_confirmed_at, created_at, updated_at)
       VALUES (?, ?, ?, 'provider', 'model', ?, ?, ?, 'audio/wav', 'wav',
               ?, 1, 1, 1)`
    )
    .run(
      id,
      userId,
      encryptLegacyBuffer(
        Buffer.from('Recovery voice', 'utf8'),
        `voice-profile:${id}:${userId}:name`
      ),
      'a'.repeat(64),
      encryptLegacyBuffer(audio, `voice-profile:${id}:${userId}:audio`),
      encryptLegacyBuffer(
        Buffer.from('Reference transcript', 'utf8'),
        `voice-profile:${id}:${userId}:transcript`
      ),
      audio.length
    );
};

const healthyEnv = overrides => ({
  ENCRYPTION_KEY: encryptionKey,
  JWT_SECRET: jwtSecret,
  SESSION_SECRET: sessionSecret,
  NODE_ENV: 'production',
  ...overrides,
});

const createDatabase = (dataDir, complete = true) => {
  fs.mkdirSync(dataDir, { recursive: true });
  if (!complete) {
    const database = new Database(path.join(dataDir, 'data.sqlite'));
    database.exec('CREATE TABLE users (id TEXT PRIMARY KEY)');
    return database;
  }
  const databaseArtifact = pathToFileURL(
    path.join(
      repoRoot,
      'backend',
      testSource ? 'src' : 'dist',
      testSource ? 'db.ts' : 'db.js'
    )
  ).href;
  const initialized = spawnSync(
    process.execPath,
    [
      ...cliRuntimeArgs,
      '--input-type=module',
      '-e',
      `const database = await import(${JSON.stringify(
        databaseArtifact
      )}); database.getDatabase(); database.closeDatabase();`,
    ],
    {
      cwd: repoRoot,
      env: { ...process.env, DATA_DIR: dataDir },
      encoding: 'utf8',
    }
  );
  assert.equal(
    initialized.status,
    0,
    `${initialized.stderr}\n${initialized.stdout}`
  );
  return new Database(path.join(dataDir, 'data.sqlite'));
};

const presentInspector = async ({ resources }) => ({
  available: true,
  matches: Object.fromEntries(
    resources.map(resource => [resource.taskId, true])
  ),
});

const storageKeyring = (key = encryptionKey, keyId = 'legacy') =>
  new Aes256GcmKeyring(keyId, { [keyId]: Buffer.from(key, 'hex') });

const seedPlatformVector = async (
  database,
  keyring = storageKeyring(),
  id = 'vector'
) => {
  const store = new SqliteEncryptedVectorStore({ database, keyring });
  await store.upsert({
    actor: { userId: 'default' },
    records: [
      {
        namespace: 'documents',
        id,
        ownerUserId: 'default',
        resourceId: 'document',
        model: 'model',
        dimensions: 2,
        version: 'v1',
        sourceRevision: 'revision',
        embedding: [1, 0],
        grants: [{ type: 'user', id: 'default' }],
        attributes: { collection: 'general' },
        createdAt: 1,
      },
    ],
  });
  return database
    .prepare('SELECT embedding FROM platform_vector_entries WHERE id = ?')
    .get(id).embedding;
};

const seedPlatformBlob = async (
  dataDir,
  keyring = storageKeyring(),
  plaintext = Buffer.from('authenticated private blob')
) => {
  const rootDirectory = path.join(dataDir, 'blobs');
  const store = new LocalEncryptedBlobStore({
    rootDirectory,
    keyring,
    chunkBytes: 64 * 1024,
  });
  const descriptor = await store.put({
    ownerUserId: 'default',
    purpose: 'recovery.fixture',
    contentType: 'application/octet-stream',
    expectedSize: plaintext.length,
    metadata: { source: 'recovery-test' },
    source: Readable.from([plaintext]),
  });
  const objectPath = path.join(
    rootDirectory,
    'objects',
    descriptor.id.slice(0, 2),
    descriptor.id.slice(2, 4),
    `${descriptor.id}.blob`
  );
  return { descriptor, objectPath, encrypted: fs.readFileSync(objectPath) };
};

const seedDurableState = (
  database,
  keyring = storageKeyring(),
  options = {}
) => {
  const now = () => 1_000;
  const service = new DurableJobService(
    new SQLiteDurableJobRepository(database, now),
    keyring,
    now
  );
  const encryptedJob = service.enqueue({
    jobType: 'recovery.private',
    actorUserId: 'default',
    payload: {
      mode: 'encrypted',
      value: { secret: 'durable-job-secret-must-not-be-reported' },
    },
    idempotencyScope: 'recovery-test',
    idempotencyKey: 'encrypted-job',
  });
  const lease = service.claim('recovery-test-worker', 1_000);
  assert.ok(lease);
  if (!options.leaveRunning) service.complete(lease, 'blob:result');
  if (!options.leaveRunning) {
    service.enqueue({
      jobType: 'recovery.reference',
      actorUserId: 'default',
      payload: { mode: 'reference', referenceId: 'blob:job-reference' },
      idempotencyScope: 'recovery-test',
      idempotencyKey: 'reference-job',
    });
    const encryptedCursor = service.appendEvent({
      streamId: 'recovery:test',
      eventType: 'recovery.private',
      subjectId: encryptedJob.id,
      actorUserId: 'default',
      payload: {
        mode: 'encrypted',
        value: { secret: 'durable-event-secret-must-not-be-reported' },
      },
    });
    service.appendEvent({
      streamId: 'recovery:test',
      eventType: 'recovery.reference',
      subjectId: encryptedJob.id,
      payload: { mode: 'reference', referenceId: 'blob:event-reference' },
    });
    return { encryptedJob, encryptedCursor };
  }
  return { encryptedJob, encryptedCursor: null };
};

test('healthy inventory is complete, versioned, and secret-safe', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'libre-recovery-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const database = createDatabase(dataDir);
  database.exec(`
    INSERT INTO generated_images
      (id, prompt, model, image_data, created_at)
      VALUES ('media', 'prompt', 'model', 'encoded-media', 1);
    INSERT INTO documents
      (id, filename, content, uploaded_at, created_at, updated_at)
      VALUES ('document', 'document.txt', 'document text', 1, 1, 1);
    INSERT INTO document_chunks
      (id, document_id, chunk_index, content, embedding, created_at)
      VALUES ('chunk', 'document', 0, 'chunk text', '[0.1,0.2]', 1);
  `);
  seedLegacyVoice(database);
  const vectorCiphertext = await seedPlatformVector(database);
  seedDurableState(database);
  database.close();
  const pluginsDir = path.join(dataDir, 'plugins');
  fs.mkdirSync(pluginsDir);
  fs.writeFileSync(
    path.join(pluginsDir, 'custom.json'),
    '{"endpoint":"private"}'
  );
  const blob = await seedPlatformBlob(dataDir);

  const service = newRecoveryService();
  const inventory = await service.collect({
    dataDir,
    env: healthyEnv(),
    inspectWorkResources: presentInspector,
    now: new Date('2026-08-13T12:00:00.000Z'),
  });
  assert.equal(inventory.format, 'libre-webui-recovery-inventory');
  assert.equal(inventory.version, 1);
  assert.equal(inventory.readOnly, true);
  assert.equal(inventory.restoreReady, true, inventory.blockers.join('\n'));
  assert.equal(inventory.database.quickCheck, 'ok');
  assert.equal(inventory.database.foreignKeyViolations, 0);
  assert.equal(inventory.database.schema.missing.length, 0);
  assert.equal(inventory.database.schema.ledgerPresent, true);
  assert.equal(
    inventory.database.schema.currentVersion,
    inventory.database.schema.targetVersion
  );
  assert.ok(
    inventory.database.schema.appliedMigrations.every(
      migration => migration.checksumMatches
    )
  );
  assert.match(inventory.database.schema.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(inventory.encryption.source, 'environment');
  assert.match(inventory.encryption.fingerprint, /^[a-f0-9]{16}$/);
  assert.deepEqual(inventory.configuration.storageEncryption, {
    status: 'configured',
    source: 'legacy-encryption-key',
    activeKeyId: 'legacy',
    keyFingerprints: [
      { keyId: 'legacy', sha256Prefix: inventory.encryption.fingerprint },
    ],
  });
  assert.equal(inventory.storage.customPlugins.definitions, 1);
  assert.equal(inventory.storage.customPlugins.includedInDataDirectory, true);
  assert.equal(inventory.storage.embeddedBlobs.generatedMedia.records, 1);
  assert.equal(inventory.storage.embeddedBlobs.voiceReferences.records, 1);
  assert.equal(inventory.storage.localBlobStore.files, 1);
  assert.equal(inventory.storage.localBlobStore.bytes, blob.encrypted.length);
  assert.equal(
    inventory.storage.embeddedVectors.legacyDocumentChunks.records,
    1
  );
  assert.equal(inventory.storage.embeddedVectors.platform.records, 1);
  assert.equal(
    inventory.storage.embeddedVectors.platform.bytes,
    vectorCiphertext.length
  );
  assert.equal(inventory.storage.embeddedVectors.platform.aclRecords, 1);
  assert.equal(inventory.storage.embeddedVectors.platform.attributeRecords, 1);
  assert.equal(inventory.jobs.durable.substrateAvailable, true);
  assert.equal(inventory.work.activePreviews, 0);
  assert.equal(inventory.jobs.durable.handlerWorkerBootstrapped, false);
  assert.equal(inventory.jobs.durable.externalWorkerAvailable, false);
  assert.equal(inventory.jobs.durable.total, 2);
  assert.deepEqual(inventory.jobs.durable.byState, {
    queued: 1,
    running: 0,
    succeeded: 1,
    cancelled: 0,
    dead_letter: 0,
  });
  assert.equal(inventory.jobs.durable.attempts.total, 1);
  assert.equal(inventory.jobs.durable.attempts.active, 0);
  assert.equal(inventory.jobs.durable.attempts.byOutcome.succeeded, 1);
  assert.equal(inventory.jobs.durable.events.streams, 3);
  assert.equal(inventory.jobs.durable.events.total, 6);
  assert.equal(inventory.jobs.durable.events.lastCursor, 6);
  assert.equal(inventory.jobs.durable.payloadIntegrity.verified, true);
  assert.equal(
    inventory.jobs.durable.payloadIntegrity.encryptedAuthenticated,
    true
  );
  assert.equal(
    inventory.jobs.durable.payloadIntegrity.referenceTargetsVerified,
    false
  );
  assert.equal(inventory.jobs.durable.payloadIntegrity.records, 8);
  assert.equal(inventory.jobs.durable.payloadIntegrity.encryptedRecords, 2);
  assert.equal(inventory.jobs.durable.payloadIntegrity.referenceRecords, 6);
  assert.match(
    inventory.warnings.join('\n'),
    /no domain handler worker is bootstrapped/i
  );
  assert.match(
    inventory.warnings.join('\n'),
    /reference.*target existence.*could not be verified/i
  );

  const serialized = JSON.stringify(inventory);
  assert.doesNotMatch(serialized, new RegExp(encryptionKey));
  assert.doesNotMatch(serialized, new RegExp(jwtSecret));
  assert.doesNotMatch(serialized, new RegExp(sessionSecret));
  assert.doesNotMatch(
    serialized,
    /encoded-media|document text|durable-(?:job|event)-secret/
  );
  assert.deepEqual(fs.readFileSync(blob.objectPath), blob.encrypted);
  const verifiedDatabase = new Database(path.join(dataDir, 'data.sqlite'), {
    readonly: true,
  });
  assert.deepEqual(
    verifiedDatabase
      .prepare('SELECT embedding FROM platform_vector_entries WHERE id = ?')
      .get('vector').embedding,
    vectorCiphertext
  );
  verifiedDatabase.close();

  const blobLimited = await service.collect({
    dataDir,
    env: healthyEnv(),
    inspectWorkResources: presentInspector,
    blobIntegrityLimits: { maxEncryptedBytes: 1 },
  });
  assert.equal(blobLimited.restoreReady, false);
  assert.match(
    blobLimited.blockers.join('\n'),
    /blob storage exceeds bounded.*verification limits/i
  );

  const vectorLimited = await service.collect({
    dataDir,
    env: healthyEnv(),
    inspectWorkResources: presentInspector,
    vectorIntegrityLimits: { maxEncryptedBytes: 1 },
  });
  assert.equal(vectorLimited.restoreReady, false);
  assert.match(
    vectorLimited.blockers.join('\n'),
    /vector storage exceeds bounded.*verification limits/i
  );

  const durableLimited = await service.collect({
    dataDir,
    env: healthyEnv(),
    inspectWorkResources: presentInspector,
    durablePayloadIntegrityLimits: { maxRecords: 1 },
  });
  assert.equal(durableLimited.restoreReady, false);
  assert.match(
    durableLimited.blockers.join('\n'),
    /durable job and event payloads exceed bounded.*verification limits/i
  );
  const durableCipherLimited = await service.collect({
    dataDir,
    env: healthyEnv(),
    inspectWorkResources: presentInspector,
    durablePayloadIntegrityLimits: { maxCiphertextBytes: 1 },
  });
  assert.equal(durableCipherLimited.restoreReady, false);
  assert.match(
    durableCipherLimited.blockers.join('\n'),
    /durable job and event payloads exceed bounded.*verification limits/i
  );
  const durablePlaintextLimited = await service.collect({
    dataDir,
    env: healthyEnv(),
    inspectWorkResources: presentInspector,
    durablePayloadIntegrityLimits: { maxPlaintextBytes: 1 },
  });
  assert.equal(durablePlaintextLimited.restoreReady, false);
  assert.match(
    durablePlaintextLimited.blockers.join('\n'),
    /durable job and event payloads exceed bounded.*verification limits/i
  );
});

test('arbitrary, corrupt, wrong-key, and unavailable-key platform ciphertext block recovery read-only', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'libre-recovery-crypto-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const service = newRecoveryService();
  const collect = dataDir =>
    service.collect({
      dataDir,
      env: healthyEnv(),
      inspectWorkResources: presentInspector,
    });

  const arbitraryDir = path.join(root, 'arbitrary-blob');
  createDatabase(arbitraryDir).close();
  const arbitraryId = '00000000-0000-4000-8000-000000000000';
  const arbitraryPath = path.join(
    arbitraryDir,
    'blobs',
    'objects',
    '00',
    '00',
    `${arbitraryId}.blob`
  );
  fs.mkdirSync(path.dirname(arbitraryPath), { recursive: true });
  fs.writeFileSync(arbitraryPath, Buffer.from('not-an-encrypted-blob'));
  const arbitraryBefore = fs.readFileSync(arbitraryPath);
  const arbitrary = await collect(arbitraryDir);
  assert.equal(arbitrary.restoreReady, false);
  assert.match(arbitrary.blockers.join('\n'), /blob ciphertext.*integrity/i);
  assert.deepEqual(fs.readFileSync(arbitraryPath), arbitraryBefore);

  const corruptBlobDir = path.join(root, 'corrupt-blob');
  createDatabase(corruptBlobDir).close();
  const corruptBlob = await seedPlatformBlob(corruptBlobDir);
  const corruptBlobBytes = Buffer.from(corruptBlob.encrypted);
  corruptBlobBytes[corruptBlobBytes.length - 1] ^= 0xff;
  fs.writeFileSync(corruptBlob.objectPath, corruptBlobBytes);
  const corruptBlobInventory = await collect(corruptBlobDir);
  assert.equal(corruptBlobInventory.restoreReady, false);
  assert.match(
    corruptBlobInventory.blockers.join('\n'),
    /blob ciphertext.*integrity/i
  );
  assert.deepEqual(fs.readFileSync(corruptBlob.objectPath), corruptBlobBytes);

  const corruptVectorDir = path.join(root, 'corrupt-vector');
  const corruptVectorDatabase = createDatabase(corruptVectorDir);
  const validVector = await seedPlatformVector(corruptVectorDatabase);
  const corruptVector = Buffer.from(validVector);
  corruptVector[corruptVector.length - 1] ^= 0xff;
  corruptVectorDatabase
    .prepare('UPDATE platform_vector_entries SET embedding = ?')
    .run(corruptVector);
  corruptVectorDatabase.close();
  const corruptDatabaseBefore = fs.readFileSync(
    path.join(corruptVectorDir, 'data.sqlite')
  );
  const corruptVectorInventory = await collect(corruptVectorDir);
  assert.equal(corruptVectorInventory.restoreReady, false);
  assert.match(
    corruptVectorInventory.blockers.join('\n'),
    /vector ciphertext.*integrity/i
  );
  assert.deepEqual(
    fs.readFileSync(path.join(corruptVectorDir, 'data.sqlite')),
    corruptDatabaseBefore
  );

  const corruptJobDir = path.join(root, 'corrupt-durable-job');
  const corruptJobDatabase = createDatabase(corruptJobDir);
  const corruptJobSeed = seedDurableState(corruptJobDatabase);
  const jobEnvelope = JSON.parse(
    corruptJobDatabase
      .prepare('SELECT payload FROM platform_jobs WHERE id = ?')
      .get(corruptJobSeed.encryptedJob.id).payload
  );
  jobEnvelope.ciphertext = `${jobEnvelope.ciphertext[0] === 'A' ? 'B' : 'A'}${jobEnvelope.ciphertext.slice(1)}`;
  corruptJobDatabase
    .prepare('UPDATE platform_jobs SET payload = ? WHERE id = ?')
    .run(JSON.stringify(jobEnvelope), corruptJobSeed.encryptedJob.id);
  corruptJobDatabase.close();
  const corruptJobBefore = fs.readFileSync(
    path.join(corruptJobDir, 'data.sqlite')
  );
  const corruptJobInventory = await collect(corruptJobDir);
  assert.equal(corruptJobInventory.restoreReady, false);
  assert.match(
    corruptJobInventory.blockers.join('\n'),
    /durable job or event payload integrity verification failed/i
  );
  assert.deepEqual(
    fs.readFileSync(path.join(corruptJobDir, 'data.sqlite')),
    corruptJobBefore
  );

  const corruptEventDir = path.join(root, 'corrupt-durable-event');
  const corruptEventDatabase = createDatabase(corruptEventDir);
  const corruptEventSeed = seedDurableState(corruptEventDatabase);
  corruptEventDatabase
    .prepare(
      'UPDATE platform_events SET subject_id = ? WHERE global_cursor = ?'
    )
    .run('different-authenticated-subject', corruptEventSeed.encryptedCursor);
  corruptEventDatabase.close();
  const corruptEventInventory = await collect(corruptEventDir);
  assert.equal(corruptEventInventory.restoreReady, false);
  assert.match(
    corruptEventInventory.blockers.join('\n'),
    /durable job or event payload integrity verification failed/i
  );

  const wrongKeyDir = path.join(root, 'wrong-key');
  const wrongKey = storageKeyring('b6'.repeat(32));
  const wrongKeyDatabase = createDatabase(wrongKeyDir);
  await seedPlatformVector(wrongKeyDatabase, wrongKey);
  seedDurableState(wrongKeyDatabase, wrongKey);
  wrongKeyDatabase.close();
  const wrongKeyBlob = await seedPlatformBlob(wrongKeyDir, wrongKey);
  const wrongKeyInventory = await collect(wrongKeyDir);
  assert.equal(wrongKeyInventory.restoreReady, false);
  assert.match(
    wrongKeyInventory.blockers.join('\n'),
    /vector ciphertext.*configured storage keys/i
  );
  assert.match(
    wrongKeyInventory.blockers.join('\n'),
    /blob ciphertext.*configured storage keys/i
  );
  assert.match(
    wrongKeyInventory.blockers.join('\n'),
    /durable job or event payload integrity verification failed/i
  );
  assert.deepEqual(
    fs.readFileSync(wrongKeyBlob.objectPath),
    wrongKeyBlob.encrypted
  );

  const unavailableKeyDir = path.join(root, 'unavailable-key');
  const unavailableKeyDatabase = createDatabase(unavailableKeyDir);
  const unavailableKeyring = storageKeyring('c7'.repeat(32), 'retired');
  await seedPlatformVector(unavailableKeyDatabase, unavailableKeyring);
  seedDurableState(unavailableKeyDatabase, unavailableKeyring);
  unavailableKeyDatabase.close();
  await seedPlatformBlob(unavailableKeyDir, unavailableKeyring);
  const unavailableKeyInventory = await collect(unavailableKeyDir);
  assert.equal(unavailableKeyInventory.restoreReady, false);
  assert.match(
    unavailableKeyInventory.blockers.join('\n'),
    /vector ciphertext.*configured storage keys/i
  );
  assert.match(
    unavailableKeyInventory.blockers.join('\n'),
    /blob ciphertext.*configured storage keys/i
  );
  assert.match(
    unavailableKeyInventory.blockers.join('\n'),
    /durable job or event payload integrity verification failed/i
  );
  assert.doesNotMatch(JSON.stringify(unavailableKeyInventory), /retired/);
});

test('missing and corrupt databases fail closed without mutating storage', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'libre-recovery-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const service = newRecoveryService();

  const missingDir = path.join(root, 'missing');
  const missing = await service.collect({
    dataDir: missingDir,
    env: healthyEnv(),
    inspectWorkResources: presentInspector,
  });
  assert.equal(missing.restoreReady, false);
  assert.equal(missing.database.present, false);
  assert.match(missing.blockers.join('\n'), /data directory is missing/i);
  assert.match(missing.blockers.join('\n'), /database file is missing/i);
  assert.equal(
    fs.existsSync(missingDir),
    false,
    'inventory must not create paths'
  );

  const corruptDir = path.join(root, 'corrupt');
  fs.mkdirSync(corruptDir);
  fs.writeFileSync(
    path.join(corruptDir, 'data.sqlite'),
    'not a sqlite database'
  );
  const before = fs.readFileSync(path.join(corruptDir, 'data.sqlite'));
  const corrupt = await service.collect({
    dataDir: corruptDir,
    env: healthyEnv(),
    inspectWorkResources: presentInspector,
  });
  assert.equal(corrupt.restoreReady, false);
  assert.equal(corrupt.database.quickCheck, 'failed');
  assert.match(corrupt.blockers.join('\n'), /could not be opened or checked/i);
  assert.deepEqual(
    fs.readFileSync(path.join(corruptDir, 'data.sqlite')),
    before
  );
});

test('volume recovery rejects linked or non-regular SQLite sources without following them', async t => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'libre-recovery-sqlite-paths-')
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const service = newRecoveryService();
  const collect = (dataDir, databasePath) =>
    service.collect({
      dataDir,
      ...(databasePath ? { databasePath } : {}),
      env: healthyEnv(),
      inspectWorkResources: presentInspector,
    });

  const externalDatabaseDir = path.join(root, 'external-database');
  createDatabase(externalDatabaseDir).close();
  const externalDatabasePath = path.join(externalDatabaseDir, 'data.sqlite');
  const externalDatabaseBefore = fs.readFileSync(externalDatabasePath);
  const externalDatabaseMtime = fs.statSync(externalDatabasePath).mtimeMs;
  const symlinkDatabaseDir = path.join(root, 'symlink-database');
  fs.mkdirSync(symlinkDatabaseDir);
  fs.symlinkSync(
    externalDatabasePath,
    path.join(symlinkDatabaseDir, 'data.sqlite')
  );
  const symlinkDatabase = await collect(symlinkDatabaseDir);
  assert.equal(symlinkDatabase.restoreReady, false);
  assert.equal(symlinkDatabase.database.open, false);
  assert.match(
    symlinkDatabase.blockers.join('\n'),
    /SQLite database path is a symbolic link.*refuses to follow/i
  );
  assert.deepEqual(
    fs.readFileSync(externalDatabasePath),
    externalDatabaseBefore
  );
  assert.equal(
    fs.statSync(externalDatabasePath).mtimeMs,
    externalDatabaseMtime
  );

  const companionDir = path.join(root, 'symlink-companions');
  createDatabase(companionDir).close();
  const externalWal = path.join(root, 'external-wal');
  const externalShm = path.join(root, 'external-shm');
  fs.writeFileSync(externalWal, 'external WAL bytes');
  fs.writeFileSync(externalShm, 'external SHM bytes');
  const externalWalBefore = fs.readFileSync(externalWal);
  const externalShmBefore = fs.readFileSync(externalShm);
  fs.symlinkSync(externalWal, path.join(companionDir, 'data.sqlite-wal'));
  fs.symlinkSync(externalShm, path.join(companionDir, 'data.sqlite-shm'));
  const symlinkCompanions = await collect(companionDir);
  assert.equal(symlinkCompanions.restoreReady, false);
  assert.equal(symlinkCompanions.database.open, false);
  assert.match(
    symlinkCompanions.blockers.join('\n'),
    /SQLite WAL companion file path is a symbolic link/i
  );
  assert.match(
    symlinkCompanions.blockers.join('\n'),
    /SQLite SHM companion file path is a symbolic link/i
  );
  assert.deepEqual(fs.readFileSync(externalWal), externalWalBefore);
  assert.deepEqual(fs.readFileSync(externalShm), externalShmBefore);

  const hardLinkDir = path.join(root, 'hard-link-database');
  fs.mkdirSync(hardLinkDir);
  fs.linkSync(externalDatabasePath, path.join(hardLinkDir, 'data.sqlite'));
  const hardLinkedDatabase = await collect(hardLinkDir);
  assert.equal(hardLinkedDatabase.restoreReady, false);
  assert.equal(hardLinkedDatabase.database.open, false);
  assert.match(
    hardLinkedDatabase.blockers.join('\n'),
    /SQLite database has multiple hard links/i
  );
  assert.deepEqual(
    fs.readFileSync(externalDatabasePath),
    externalDatabaseBefore
  );

  const nonRegularDir = path.join(root, 'non-regular-companion');
  createDatabase(nonRegularDir).close();
  fs.mkdirSync(path.join(nonRegularDir, 'data.sqlite-wal'));
  const nonRegular = await collect(nonRegularDir);
  assert.equal(nonRegular.restoreReady, false);
  assert.equal(nonRegular.database.open, false);
  assert.match(
    nonRegular.blockers.join('\n'),
    /SQLite WAL companion file path is not a regular file/i
  );

  const explicitDataDir = path.join(root, 'explicit-data');
  createDatabase(explicitDataDir).close();
  const explicitOutside = await collect(explicitDataDir, externalDatabasePath);
  assert.equal(
    explicitOutside.restoreReady,
    true,
    explicitOutside.blockers.join('\n')
  );
});

test('schema and encryption-key problems are explicit blockers', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'libre-recovery-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  createDatabase(dataDir, false).close();
  const service = newRecoveryService();

  const missingKey = await service.collect({
    dataDir,
    env: { JWT_SECRET: jwtSecret, NODE_ENV: 'production' },
    inspectWorkResources: presentInspector,
  });
  assert.equal(missingKey.encryption.status, 'missing');
  assert.match(missingKey.blockers.join('\n'), /encryption key/i);
  assert.ok(
    missingKey.database.schema.missing.some(item => item.startsWith('sessions'))
  );

  fs.writeFileSync(path.join(dataDir, '.encryption_key'), 'b5'.repeat(32));
  const conflict = await service.collect({
    dataDir,
    env: healthyEnv(),
    inspectWorkResources: presentInspector,
  });
  assert.equal(conflict.encryption.status, 'conflict');
  assert.match(conflict.blockers.join('\n'), /differs from the key file/i);
  const serialized = JSON.stringify(conflict);
  assert.doesNotMatch(serialized, /(?:a4|b5){16}/);

  const invalidStorageKeys = await service.collect({
    dataDir,
    env: {
      ...healthyEnv(),
      STORAGE_ENCRYPTION_KEYS: '{"primary":"not-a-key"}',
      STORAGE_ENCRYPTION_ACTIVE_KEY_ID: 'primary',
    },
    inspectWorkResources: presentInspector,
  });
  assert.equal(invalidStorageKeys.restoreReady, false);
  assert.equal(
    invalidStorageKeys.configuration.storageEncryption.status,
    'invalid'
  );
  assert.match(
    invalidStorageKeys.blockers.join('\n'),
    /storage encryption keyring configuration is invalid/i
  );
  assert.doesNotMatch(JSON.stringify(invalidStorageKeys), /not-a-key/);
});

test('recovery refuses linked or non-regular persistent encryption keys', async t => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'libre-recovery-key-paths-')
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const service = newRecoveryService();
  const collect = dataDir =>
    service.collect({
      dataDir,
      env: healthyEnv({ ENCRYPTION_KEY: undefined }),
      inspectWorkResources: presentInspector,
    });
  const externalKey = path.join(root, 'external-key');
  fs.writeFileSync(externalKey, encryptionKey, { mode: 0o600 });
  const externalBefore = fs.readFileSync(externalKey);

  const symlinkDir = path.join(root, 'symlink');
  createDatabase(symlinkDir).close();
  fs.symlinkSync(externalKey, path.join(symlinkDir, '.encryption_key'));
  const symlinked = await collect(symlinkDir);
  assert.equal(symlinked.restoreReady, false);
  assert.equal(symlinked.encryption.status, 'invalid');
  assert.equal(symlinked.encryption.source, 'data-file');
  assert.match(
    symlinked.blockers.join('\n'),
    /encryption key.*not.*hexadecimal/i
  );
  assert.deepEqual(fs.readFileSync(externalKey), externalBefore);

  const hardLinkDir = path.join(root, 'hard-link');
  createDatabase(hardLinkDir).close();
  fs.linkSync(externalKey, path.join(hardLinkDir, '.encryption_key'));
  const hardLinked = await collect(hardLinkDir);
  assert.equal(hardLinked.restoreReady, false);
  assert.equal(hardLinked.encryption.status, 'invalid');
  assert.deepEqual(fs.readFileSync(externalKey), externalBefore);

  const nonRegularDir = path.join(root, 'non-regular');
  createDatabase(nonRegularDir).close();
  fs.mkdirSync(path.join(nonRegularDir, '.encryption_key'));
  const nonRegular = await collect(nonRegularDir);
  assert.equal(nonRegular.restoreReady, false);
  assert.equal(nonRegular.encryption.status, 'invalid');
});

test('a quiesced read-only recovery source warns without blocking', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'libre-recovery-ro-'));
  t.after(() => {
    fs.chmodSync(dataDir, 0o700);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const database = createDatabase(dataDir);
  await seedPlatformVector(database);
  seedDurableState(database);
  database.close();
  await seedPlatformBlob(dataDir);
  fs.chmodSync(dataDir, 0o500);

  const service = newRecoveryService();
  const inventory = await service.collect({
    dataDir,
    env: healthyEnv(),
    inspectWorkResources: presentInspector,
  });

  assert.equal(inventory.storage.dataDirectory.writable, false);
  assert.equal(inventory.restoreReady, true, inventory.blockers.join('\n'));
  assert.match(inventory.warnings.join('\n'), /read-only.*recovery source/i);
  assert.doesNotMatch(inventory.blockers.join('\n'), /not writable/i);
});

test('active or missing Work resources and active media jobs block a snapshot', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'libre-recovery-'));
  const privateHostPath = path.join(
    os.tmpdir(),
    'customer-private-project-name'
  );
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const database = createDatabase(dataDir);
  database.exec(`
    INSERT INTO work_tasks
      (id, user_id, title, model, status, volume_name, container_name,
       host_path, created_at, updated_at)
      VALUES ('work-1', 'default', 'Work 1', 'model', 'running',
              'libre-work-1', 'libre-container-1', NULL, 1, 1);
    INSERT INTO work_tasks
      (id, user_id, title, model, status, volume_name, container_name,
       host_path, created_at, updated_at)
      VALUES ('work-2', 'default', 'Work 2', 'model', 'idle', 'unused',
              'libre-container-2', '${privateHostPath.replaceAll("'", "''")}', 1, 1);
    INSERT INTO work_runs
      (id, task_id, model, status, created_at)
      VALUES ('run-1', 'work-1', 'model', 'running', 1);
    UPDATE work_tasks
      SET preview_status = 'running', preview_url = 'http://127.0.0.1:4173'
      WHERE id = 'work-1';
    INSERT INTO media_generation_jobs
      (id, user_id, provider_job_id, plugin_id, model, prompt, status,
       created_at, updated_at)
      VALUES ('job-1', 'default', 'provider-job', 'provider', 'model',
              'prompt', 'in_progress', 1, 1);
  `);
  seedDurableState(database, storageKeyring(), { leaveRunning: true });
  database.close();
  const service = newRecoveryService();
  const inventory = await service.collect({
    dataDir,
    env: healthyEnv(),
    inspectWorkResources: async ({ resources }) => ({
      available: true,
      matches: Object.fromEntries(
        resources.map(resource => [resource.taskId, false])
      ),
    }),
  });
  assert.equal(inventory.restoreReady, false);
  assert.equal(inventory.work.activeRuns, 1);
  assert.equal(inventory.work.activePreviews, 1);
  assert.equal(inventory.jobs.active, 1);
  assert.equal(inventory.jobs.durable.running, 1);
  assert.equal(inventory.jobs.durable.attempts.active, 1);
  assert.equal(inventory.work.workspaces[0].present, false);
  assert.match(inventory.blockers.join('\n'), /Work run.*active/i);
  assert.match(inventory.blockers.join('\n'), /Work preview.*active/i);
  assert.match(inventory.blockers.join('\n'), /media generation job.*active/i);
  assert.match(inventory.blockers.join('\n'), /durable job.*running/i);
  assert.match(inventory.blockers.join('\n'), /workspace.*missing/i);
  assert.match(inventory.exclusions.join('\n'), /host-bound Work workspace/i);
  assert.doesNotMatch(
    JSON.stringify(inventory),
    /customer-private-project-name/
  );
  assert.match(
    inventory.work.workspaces.find(item => item.kind === 'host-path')
      .pathFingerprint,
    /^[a-f0-9]{16}$/
  );
});

test('external plugin definitions are inventoried and block an uncoordinated snapshot', async t => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'libre-recovery-external-plugins-')
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'data');
  const pluginsDir = path.join(root, 'operator-plugins');
  createDatabase(dataDir).close();
  fs.mkdirSync(pluginsDir);
  fs.writeFileSync(
    path.join(pluginsDir, 'custom.json'),
    JSON.stringify({ id: 'custom' })
  );

  const inventory = await newRecoveryService().collect({
    dataDir,
    env: healthyEnv({ PLUGINS_DIR: pluginsDir }),
    inspectWorkResources: presentInspector,
    pluginPathLocations: {
      backendDirectory: path.join(root, 'backend'),
      projectDirectory: root,
      bundledDirectory: path.join(root, 'bundled-plugins'),
    },
  });

  assert.equal(inventory.restoreReady, false);
  assert.equal(inventory.storage.customPlugins.path, pluginsDir);
  assert.equal(inventory.storage.customPlugins.definitions, 1);
  assert.equal(inventory.storage.customPlugins.includedInDataDirectory, false);
  assert.match(
    inventory.blockers.join('\n'),
    /custom plugin definition.*outside the configured data directory/i
  );
  assert.match(
    inventory.exclusions.join('\n'),
    /custom plugin directory.*separate backup/i
  );
});

test('plugin recovery rejects linked entries and inventories deterministic legacy paths', async t => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'libre-recovery-plugin-paths-')
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'data');
  const backendDirectory = path.join(root, 'backend');
  const projectDirectory = path.join(root, 'project');
  const bundledDirectory = path.join(projectDirectory, 'plugins');
  const legacyDirectory = path.join(backendDirectory, 'plugins');
  createDatabase(dataDir).close();
  fs.mkdirSync(path.join(dataDir, 'plugins'));
  fs.mkdirSync(legacyDirectory, { recursive: true });
  fs.mkdirSync(bundledDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(legacyDirectory, 'legacy-provider.json'),
    '{"id":"legacy-provider"}'
  );
  fs.writeFileSync(
    path.join(bundledDirectory, 'bundled-provider.json'),
    '{"id":"bundled-provider"}'
  );
  const externalDefinition = path.join(root, 'outside-provider.json');
  fs.writeFileSync(externalDefinition, '{"id":"outside-provider"}');
  const externalBefore = fs.readFileSync(externalDefinition);
  fs.symlinkSync(
    externalDefinition,
    path.join(dataDir, 'plugins', 'linked-provider.json')
  );

  const inventory =
    await new inventoryModule.RecoveryInventoryService().collect({
      dataDir,
      env: healthyEnv(),
      inspectWorkResources: presentInspector,
      pluginPathLocations: {
        backendDirectory,
        projectDirectory,
        bundledDirectory,
      },
    });

  assert.equal(inventory.restoreReady, false);
  assert.match(
    inventory.blockers.join('\n'),
    /custom plugin entry is symlinked, non-regular, or unreadable/i
  );
  assert.match(
    inventory.blockers.join('\n'),
    /custom plugin definition is outside the configured data directory/i
  );
  const legacySource = inventory.storage.customPlugins.sources.find(
    source => source.kind === 'legacy'
  );
  assert.deepEqual(
    {
      path: legacySource?.path,
      definitions: legacySource?.definitions,
      included: legacySource?.includedInDataDirectory,
    },
    { path: legacyDirectory, definitions: 1, included: false }
  );
  assert.equal(
    inventory.storage.customPlugins.sources.some(
      source => source.path === bundledDirectory
    ),
    false,
    'shipped bundled definitions are not recovery-owned custom state'
  );
  assert.deepEqual(fs.readFileSync(externalDefinition), externalBefore);
});

test('plugin recovery rejects a PLUGINS_DIR reached through an ancestor symlink', async t => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'libre-recovery-plugin-ancestor-')
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'data');
  const externalRoot = path.join(root, 'external');
  const externalPlugins = path.join(externalRoot, 'plugins');
  createDatabase(dataDir).close();
  fs.mkdirSync(externalPlugins, { recursive: true });
  fs.writeFileSync(
    path.join(externalPlugins, 'external-provider.json'),
    '{"id":"external-provider"}'
  );
  const externalBefore = fs.readFileSync(
    path.join(externalPlugins, 'external-provider.json')
  );
  fs.symlinkSync(externalRoot, path.join(dataDir, 'linked-root'));
  const configuredPlugins = path.join(dataDir, 'linked-root', 'plugins');

  const inventory = await newRecoveryService().collect({
    dataDir,
    env: healthyEnv({ PLUGINS_DIR: configuredPlugins }),
    inspectWorkResources: presentInspector,
  });

  assert.equal(inventory.restoreReady, false);
  assert.equal(inventory.storage.customPlugins.includedInDataDirectory, false);
  assert.match(
    inventory.blockers.join('\n'),
    /custom plugin entry is symlinked, non-regular, or unreadable/i
  );
  assert.deepEqual(
    fs.readFileSync(path.join(externalPlugins, 'external-provider.json')),
    externalBefore
  );
});

test('relative PLUGINS_DIR retains and blocks the historical backend-relative path', async t => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'libre-recovery-relative-plugins-')
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'data');
  const backendDirectory = path.join(root, 'backend');
  const projectDirectory = path.join(root, 'project');
  const historicalWorkingDirectory = path.join(root, 'historical-cwd');
  const relativePlugins = 'operator-plugins';
  const selectedDirectory = path.join(projectDirectory, relativePlugins);
  const historicalDirectory = path.join(backendDirectory, relativePlugins);
  const callerHistoricalDirectory = path.join(
    historicalWorkingDirectory,
    relativePlugins
  );
  createDatabase(dataDir).close();
  fs.mkdirSync(selectedDirectory, { recursive: true });
  fs.mkdirSync(historicalDirectory, { recursive: true });
  fs.mkdirSync(callerHistoricalDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(historicalDirectory, 'historical-provider.json'),
    '{"id":"historical-provider"}'
  );
  fs.writeFileSync(
    path.join(callerHistoricalDirectory, 'caller-provider.json'),
    '{"id":"caller-provider"}'
  );

  const inventory =
    await new inventoryModule.RecoveryInventoryService().collect({
      dataDir,
      env: healthyEnv({ PLUGINS_DIR: relativePlugins }),
      inspectWorkResources: presentInspector,
      pluginPathLocations: {
        backendDirectory,
        projectDirectory,
        bundledDirectory: path.join(root, 'bundled-plugins'),
        historicalWorkingDirectory,
      },
    });

  assert.equal(inventory.restoreReady, false);
  assert.ok(
    inventory.storage.customPlugins.sources.some(
      source =>
        source.kind === 'legacy' &&
        source.path === historicalDirectory &&
        source.definitions === 1
    )
  );
  assert.ok(
    inventory.storage.customPlugins.sources.some(
      source =>
        source.kind === 'legacy' &&
        source.path === callerHistoricalDirectory &&
        source.definitions === 1
    )
  );
  assert.match(
    inventory.blockers.join('\n'),
    /custom plugin definition is outside the configured data directory/i
  );
});

test('default plugin recovery blocks caller-cwd legacy definitions', async t => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'libre-recovery-default-cwd-plugins-')
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'data');
  const backendDirectory = path.join(root, 'backend');
  const projectDirectory = path.join(root, 'project');
  const historicalWorkingDirectory = path.join(root, 'historical-cwd');
  const historicalDirectory = path.join(historicalWorkingDirectory, 'plugins');
  createDatabase(dataDir).close();
  fs.mkdirSync(historicalDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(historicalDirectory, 'caller-provider.json'),
    '{"id":"caller-provider"}'
  );

  const inventory =
    await new inventoryModule.RecoveryInventoryService().collect({
      dataDir,
      env: healthyEnv(),
      inspectWorkResources: presentInspector,
      pluginPathLocations: {
        backendDirectory,
        projectDirectory,
        bundledDirectory: path.join(projectDirectory, 'plugins'),
        historicalWorkingDirectory,
      },
    });

  assert.equal(inventory.restoreReady, false);
  assert.ok(
    inventory.storage.customPlugins.sources.some(
      source =>
        source.kind === 'legacy' &&
        source.path === historicalDirectory &&
        source.definitions === 1
    )
  );
});

test('Docker Work volume inventory verifies exact task ownership labels', async t => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'libre-recovery-work-labels-')
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'data');
  const database = createDatabase(dataDir);
  database
    .prepare(
      `INSERT INTO work_tasks
       (id, user_id, title, model, status, volume_name, container_name,
        host_path, created_at, updated_at)
     VALUES (?, 'default', 'Owned workspace', 'model', 'idle', ?, ?,
             NULL, 1, 1)`
    )
    .run('owned-task', 'libre-owned-volume', 'libre-owned-container');
  database.close();

  const fakeDocker = path.join(root, 'docker');
  const writeDockerOutput = taskId => {
    fs.writeFileSync(
      fakeDocker,
      `#!/usr/bin/env bash
if [[ "$2" == "ls" ]]; then
  printf 'libre-owned-volume\\n'
else
  printf 'libre-owned-volume\\ttrue\\t${taskId}\\n'
fi
`,
      { mode: 0o700 }
    );
  };
  writeDockerOutput('different-task');
  const service = newRecoveryService();
  const mismatched = await service.collect({
    dataDir,
    env: healthyEnv({ WORK_DOCKER_COMMAND: fakeDocker }),
  });
  assert.equal(mismatched.restoreReady, false);
  assert.equal(mismatched.work.resourcesVerified, false);
  assert.equal(mismatched.work.workspaces[0].present, false);
  assert.match(
    mismatched.blockers.join('\n'),
    /workspace.*mismatched ownership metadata/i
  );

  writeDockerOutput('owned-task');
  const matched = await service.collect({
    dataDir,
    env: healthyEnv({ WORK_DOCKER_COMMAND: fakeDocker }),
  });
  assert.equal(matched.restoreReady, true, matched.blockers.join('\n'));
  assert.equal(matched.work.resourcesVerified, true);
  assert.equal(matched.work.workspaces[0].present, true);
});

test('default recovery fails closed on a legacy nested data conflict', async t => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'libre-recovery-legacy-path-')
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const canonicalDir = path.join(root, 'backend', 'data');
  const legacyDir = path.join(root, 'backend', 'backend', 'data');
  createDatabase(canonicalDir).close();
  fs.mkdirSync(legacyDir, { recursive: true });
  fs.copyFileSync(
    path.join(canonicalDir, 'data.sqlite'),
    path.join(legacyDir, 'data.sqlite')
  );
  const service = newRecoveryService();

  const conflicted = await service.collect({
    cwd: root,
    env: healthyEnv(),
    inspectWorkResources: presentInspector,
  });
  assert.equal(conflicted.restoreReady, false);
  assert.match(conflicted.blockers.join('\n'), /Legacy data exists/i);

  const explicitData = await service.collect({
    dataDir: canonicalDir,
    cwd: root,
    env: healthyEnv(),
    inspectWorkResources: presentInspector,
  });
  assert.equal(
    explicitData.restoreReady,
    true,
    explicitData.blockers.join('\n')
  );
  assert.doesNotMatch(explicitData.blockers.join('\n'), /Legacy data exists/i);

  const explicitDatabase = await service.collect({
    databasePath: path.join(canonicalDir, 'data.sqlite'),
    cwd: root,
    env: healthyEnv(),
    inspectWorkResources: presentInspector,
  });
  assert.equal(
    explicitDatabase.restoreReady,
    true,
    explicitDatabase.blockers.join('\n')
  );
  assert.doesNotMatch(
    explicitDatabase.blockers.join('\n'),
    /Legacy data exists/i
  );
});

test('durable event sequence gaps block recovery even when the head matches the maximum', async t => {
  const dataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'libre-recovery-event-gap-')
  );
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const database = createDatabase(dataDir);
  database
    .prepare(
      'INSERT INTO platform_event_stream_heads (stream_id, last_sequence) VALUES (?, 3)'
    )
    .run('gap-stream');
  const insert = database.prepare(
    `INSERT INTO platform_events
       (event_id, stream_id, stream_sequence, event_type, subject_id,
        actor_user_id, payload_format, payload, occurred_at)
     VALUES (?, 'gap-stream', ?, 'recovery.event', 'subject', NULL,
             'reference', ?, ?)`
  );
  insert.run('gap-event-1', 1, 'blob:event-one', 1);
  insert.run('gap-event-3', 3, 'blob:event-three', 3);
  database.close();

  const inventory = await newRecoveryService().collect({
    dataDir,
    env: healthyEnv(),
    inspectWorkResources: presentInspector,
  });
  assert.equal(inventory.restoreReady, false);
  assert.match(
    inventory.blockers.join('\n'),
    /durable job or event payload integrity verification failed/i
  );
});

test('legacy text and voice ciphertext is authenticated without plaintext fallback', async t => {
  const dataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'libre-recovery-legacy-cipher-')
  );
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const database = createDatabase(dataDir);
  database
    .prepare(
      `INSERT INTO notes
         (id, user_id, title, content, created_at, updated_at)
       VALUES ('private-note', 'default', ?, ?, 1, 1)`
    )
    .run(
      encryptLegacyText('Authenticated title'),
      encryptLegacyText('Authenticated note body')
    );
  seedLegacyVoice(database);
  database.close();

  const inventory = await newRecoveryService().collect({
    dataDir,
    env: healthyEnv(),
    inspectWorkResources: presentInspector,
  });
  assert.equal(inventory.restoreReady, true, inventory.blockers.join('\n'));
  assert.equal(inventory.encryption.legacyCiphertext.verified, true);
  assert.equal(
    inventory.encryption.legacyCiphertext.encryptedAuthenticated,
    true
  );
  assert.equal(inventory.encryption.legacyCiphertext.records, 5);
  assert.equal(inventory.encryption.legacyCiphertext.textRecords, 2);
  assert.equal(inventory.encryption.legacyCiphertext.binaryRecords, 3);
  assert.ok(inventory.encryption.legacyCiphertext.ciphertextBytes > 0);
  assert.ok(inventory.encryption.legacyCiphertext.plaintextBytes > 0);
});

test('wrong or tampered legacy ciphertext blocks recovery', async t => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'libre-recovery-legacy-corrupt-')
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const service = newRecoveryService();

  const wrongKeyDir = path.join(root, 'wrong-key');
  const wrongKeyDatabase = createDatabase(wrongKeyDir);
  wrongKeyDatabase
    .prepare(
      `INSERT INTO notes
         (id, user_id, title, content, created_at, updated_at)
       VALUES ('wrong-key-note', 'default', ?, 'legacy plaintext', 1, 1)`
    )
    .run(encryptLegacyText('Original key required'));
  wrongKeyDatabase.close();
  const wrongKey = await service.collect({
    dataDir: wrongKeyDir,
    env: healthyEnv({ ENCRYPTION_KEY: 'b7'.repeat(32) }),
    inspectWorkResources: presentInspector,
  });
  assert.equal(wrongKey.restoreReady, false);
  assert.match(
    wrongKey.blockers.join('\n'),
    /legacy application ciphertext failed read-only integrity verification/i
  );

  const tamperedDir = path.join(root, 'tampered');
  const tamperedDatabase = createDatabase(tamperedDir);
  const ciphertext = encryptLegacyText('Authenticated before tampering');
  const malformedIv = `z${ciphertext.slice(1)}`;
  tamperedDatabase
    .prepare(
      `INSERT INTO notes
         (id, user_id, title, content, created_at, updated_at)
       VALUES ('tampered-note', 'default', ?, 'legacy plaintext', 1, 1)`
    )
    .run(malformedIv);
  tamperedDatabase.close();
  const tampered = await service.collect({
    dataDir: tamperedDir,
    env: healthyEnv(),
    inspectWorkResources: presentInspector,
  });
  assert.equal(tampered.restoreReady, false);
  assert.match(
    tampered.blockers.join('\n'),
    /legacy application ciphertext failed read-only integrity verification/i
  );

  const voiceDir = path.join(root, 'tampered-voice');
  const voiceDatabase = createDatabase(voiceDir);
  seedLegacyVoice(voiceDatabase);
  const voiceCiphertext = voiceDatabase
    .prepare(
      "SELECT reference_audio AS value FROM voice_profiles WHERE id = 'voice'"
    )
    .get().value;
  voiceCiphertext[voiceCiphertext.length - 1] ^= 0x01;
  voiceDatabase
    .prepare("UPDATE voice_profiles SET reference_audio = ? WHERE id = 'voice'")
    .run(voiceCiphertext);
  voiceDatabase.close();
  const tamperedVoice = await service.collect({
    dataDir: voiceDir,
    env: healthyEnv(),
    inspectWorkResources: presentInspector,
  });
  assert.equal(tamperedVoice.restoreReady, false);
  assert.match(
    tamperedVoice.blockers.join('\n'),
    /legacy application ciphertext failed read-only integrity verification/i
  );
});

test('legacy ciphertext verification is bounded and an empty database passes', async t => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'libre-recovery-legacy-limits-')
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const service = newRecoveryService();
  const dataDir = path.join(root, 'bounded');
  const database = createDatabase(dataDir);
  database
    .prepare(
      `INSERT INTO notes
         (id, user_id, title, content, created_at, updated_at)
       VALUES ('bounded-note', 'default', ?, ?, 1, 1)`
    )
    .run(encryptLegacyText('one'), encryptLegacyText('two'));
  database.close();
  const bounded = await service.collect({
    dataDir,
    env: healthyEnv(),
    inspectWorkResources: presentInspector,
    legacyCiphertextIntegrityLimits: { maxRecords: 1 },
  });
  assert.equal(bounded.restoreReady, false);
  assert.match(
    bounded.blockers.join('\n'),
    /legacy application ciphertext exceeds bounded recovery integrity verification limits/i
  );
  for (const limits of [{ maxCiphertextBytes: 1 }, { maxPlaintextBytes: 1 }]) {
    const byteBounded = await service.collect({
      dataDir,
      env: healthyEnv(),
      inspectWorkResources: presentInspector,
      legacyCiphertextIntegrityLimits: limits,
    });
    assert.equal(byteBounded.restoreReady, false);
    assert.match(
      byteBounded.blockers.join('\n'),
      /legacy application ciphertext exceeds bounded recovery integrity verification limits/i
    );
  }

  const emptyDir = path.join(root, 'empty');
  createDatabase(emptyDir).close();
  const empty = await service.collect({
    dataDir: emptyDir,
    env: healthyEnv(),
    inspectWorkResources: presentInspector,
  });
  assert.equal(empty.restoreReady, true, empty.blockers.join('\n'));
  assert.deepEqual(empty.encryption.legacyCiphertext, {
    verified: true,
    encryptedAuthenticated: true,
    records: 0,
    textRecords: 0,
    binaryRecords: 0,
    ciphertextBytes: 0,
    plaintextBytes: 0,
  });
});

test('v4 identity email lookup integrity is verified during recovery', async t => {
  const dataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'libre-recovery-email-lookup-')
  );
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const database = createDatabase(dataDir);
  const email = 'recovery@example.test';
  const encryptedEmail = encryptLegacyText(email);
  const validLookup = identityEmailLookup(email);
  const update = database.prepare(
    "UPDATE users SET email = ?, email_lookup = ? WHERE id = 'default'"
  );
  const service = newRecoveryService();
  const collect = () =>
    service.collect({
      dataDir,
      env: healthyEnv(),
      inspectWorkResources: presentInspector,
    });
  const verifyStartupWindow = () =>
    verifyLegacyCiphertextIntegrity(
      database,
      Buffer.from(encryptionKey, 'hex'),
      {},
      { requireIdentityLookupToken: false }
    );

  update.run(encryptedEmail, validLookup);
  let inventory = await collect();
  assert.equal(inventory.restoreReady, true, inventory.blockers.join('\n'));
  assert.equal(inventory.encryption.legacyCiphertext.textRecords, 1);

  const mismatchedLookup = `${validLookup.slice(0, -1)}${validLookup.endsWith('0') ? '1' : '0'}`;
  update.run(encryptedEmail, mismatchedLookup);
  inventory = await collect();
  assert.equal(inventory.restoreReady, false);
  assert.match(
    inventory.blockers.join('\n'),
    /legacy application ciphertext failed read-only integrity verification/i
  );
  assert.throws(verifyStartupWindow);

  update.run(encryptedEmail, null);
  inventory = await collect();
  assert.equal(inventory.restoreReady, false);
  assert.match(
    inventory.blockers.join('\n'),
    /legacy application ciphertext failed read-only integrity verification/i
  );
  assert.doesNotThrow(verifyStartupWindow);

  const interruptedPlaintext = 'legacy:interrupted@example.test';
  update.run(interruptedPlaintext, null);
  inventory = await collect();
  assert.equal(inventory.restoreReady, false);
  assert.doesNotThrow(
    verifyStartupWindow,
    'startup must allow the identity repository to finish the v4 backfill'
  );

  update.run('not-an-email', null);
  inventory = await collect();
  assert.equal(inventory.restoreReady, false);
  assert.doesNotThrow(
    verifyStartupWindow,
    'startup must preserve arbitrary email strings accepted by older releases'
  );

  update.run('', null);
  inventory = await collect();
  assert.equal(inventory.restoreReady, false);
  assert.doesNotThrow(
    verifyStartupWindow,
    'startup must allow the repository to normalize a legacy cleared email'
  );

  const [iv, tag, ciphertext] = encryptedEmail.split(':');
  update.run(`${iv.slice(1)}:${tag.slice(1)}:${ciphertext}`, null);
  assert.throws(
    verifyStartupWindow,
    /Legacy ciphertext recovery verification failed/
  );

  update.run(interruptedPlaintext, identityEmailLookup(interruptedPlaintext));
  assert.throws(
    verifyStartupWindow,
    /Legacy ciphertext recovery verification failed/
  );

  update.run(null, validLookup);
  inventory = await collect();
  assert.equal(inventory.restoreReady, false);
  assert.match(
    inventory.blockers.join('\n'),
    /legacy application ciphertext failed read-only integrity verification/i
  );
  assert.throws(verifyStartupWindow);
  database.close();
});

test('pre-v4 identity emails reject damaged envelopes without rejecting legacy values', () => {
  const database = new Database(':memory:');
  database.exec('CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT)');
  const update = database.prepare(
    "INSERT OR REPLACE INTO users (id, email) VALUES ('legacy', ?)"
  );
  const verify = () =>
    verifyLegacyCiphertextIntegrity(
      database,
      Buffer.from(encryptionKey, 'hex')
    );

  update.run('not-an-email');
  assert.doesNotThrow(verify);
  const encryptedEmail = encryptLegacyText('legacy@example.test');
  update.run(encryptedEmail);
  assert.doesNotThrow(verify);
  const [iv, tag, ciphertext] = encryptedEmail.split(':');
  update.run(`${iv.slice(1)}:${tag.slice(1)}:${ciphertext}`);
  assert.throws(verify, /Legacy ciphertext recovery verification failed/);
  database.close();
});

test('CLI exit codes distinguish ready, blocked, and invalid invocation', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'libre-recovery-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const readyDir = path.join(root, 'ready');
  const emptyLegacyPlugins = path.join(root, 'empty-legacy-plugins');
  createDatabase(readyDir).close();
  fs.mkdirSync(emptyLegacyPlugins);
  const cliEnv = { ...process.env, ...healthyEnv(), DATA_DIR: readyDir };

  const ready = spawnSync(
    process.execPath,
    [
      ...cliRuntimeArgs,
      cliPath,
      '--json',
      '--data-dir',
      readyDir,
      '--legacy-plugins-dir',
      emptyLegacyPlugins,
    ],
    { cwd: repoRoot, env: cliEnv, encoding: 'utf8' }
  );
  assert.equal(ready.status, 0, ready.stderr);
  assert.equal(JSON.parse(ready.stdout).restoreReady, true);
  assert.doesNotMatch(ready.stdout, new RegExp(encryptionKey));
  assert.doesNotMatch(ready.stdout, new RegExp(jwtSecret));

  const blocked = spawnSync(
    process.execPath,
    [
      ...cliRuntimeArgs,
      cliPath,
      '--json',
      '--data-dir',
      path.join(root, 'missing'),
      '--legacy-plugins-dir',
      emptyLegacyPlugins,
    ],
    { cwd: repoRoot, env: cliEnv, encoding: 'utf8' }
  );
  assert.equal(blocked.status, 1, blocked.stderr);
  assert.equal(JSON.parse(blocked.stdout).restoreReady, false);

  const invalid = spawnSync(
    process.execPath,
    [...cliRuntimeArgs, cliPath, '--unknown'],
    {
      cwd: repoRoot,
      env: cliEnv,
      encoding: 'utf8',
    }
  );
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /Unknown option/);

  for (const missingPathOption of [
    '--data-dir',
    '--database',
    '--legacy-plugins-dir',
  ]) {
    const missingPath = spawnSync(
      process.execPath,
      [...cliRuntimeArgs, cliPath, missingPathOption, '--json'],
      { cwd: repoRoot, env: cliEnv, encoding: 'utf8' }
    );
    assert.equal(missingPath.status, 2);
    assert.match(missingPath.stderr, /requires a path/);
  }

  if (!testSource) {
    const documented = spawnSync(
      'npm',
      [
        'run',
        '--silent',
        'recovery:check',
        '--',
        '--json',
        '--data-dir',
        readyDir,
        '--legacy-plugins-dir',
        emptyLegacyPlugins,
      ],
      { cwd: repoRoot, env: cliEnv, encoding: 'utf8' }
    );
    assert.equal(documented.status, 0, documented.stderr);
    assert.equal(JSON.parse(documented.stdout).restoreReady, true);
  }
});
