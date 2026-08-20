import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import path from 'node:path';
import Database from 'better-sqlite3';

const importBuilt = file =>
  import(pathToFileURL(path.resolve('backend/dist', file)).href);

process.env.ENCRYPTION_KEY = '7a'.repeat(32);

const loadIdentityEmailCodec = async () => {
  const { encryptionService } = await importBuilt(
    'services/encryptionService.js'
  );
  return {
    codec: encryptionService,
    encryptionService,
  };
};

const user = (id, overrides = {}) => ({
  id,
  username: id,
  email: `${id}@example.test`,
  password_hash: `hash-${id}`,
  role: 'user',
  account_status: 'pending',
  approved_at: null,
  approved_by: null,
  avatar: null,
  created_at: 100,
  updated_at: 100,
  ...overrides,
});

const createIdentitySchema = database => {
  database.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE,
      email_lookup TEXT UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      account_status TEXT NOT NULL DEFAULT 'active'
        CHECK(account_status IN ('pending', 'active', 'retiring')),
      approved_at INTEGER,
      approved_by TEXT,
      avatar TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
};

const createArchiveResourceSchema = database => {
  database.exec(`
    CREATE TABLE session_folders (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE notes (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      pinned INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE personas (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      model TEXT NOT NULL,
      parameters TEXT NOT NULL,
      avatar TEXT,
      background TEXT,
      embedding_model TEXT,
      memory_settings TEXT,
      mutation_settings TEXT,
      bindings TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE knowledge_collections (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      title TEXT NOT NULL,
      model TEXT NOT NULL,
      persona_id TEXT,
      provider_type TEXT,
      provider_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      archived INTEGER NOT NULL,
      settings TEXT,
      folder_id TEXT,
      pinned INTEGER NOT NULL
    );
    CREATE TABLE session_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      thinking TEXT,
      timestamp INTEGER NOT NULL,
      message_index INTEGER NOT NULL,
      model TEXT,
      provider_metadata TEXT,
      images TEXT,
      statistics TEXT,
      artifacts TEXT,
      parent_id TEXT,
      branch_index INTEGER NOT NULL,
      is_active INTEGER NOT NULL,
      rating INTEGER
    );
    CREATE TABLE documents (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      filename TEXT NOT NULL,
      title TEXT,
      content TEXT,
      file_type TEXT,
      size INTEGER,
      session_id TEXT,
      collection_id TEXT,
      metadata TEXT,
      uploaded_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE document_chunks (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      content TEXT NOT NULL,
      start_char INTEGER,
      end_char INTEGER,
      embedding TEXT,
      created_at INTEGER NOT NULL
    );
  `);
};

test('SQLite identity repository satisfies the async persistence contract', async () => {
  const { createSQLitePersistence } = await importBuilt(
    'persistence/sqlitePersistence.js'
  );
  const database = new Database(':memory:');
  createIdentitySchema(database);
  database.exec(`
    CREATE TABLE identity_deletion_outbox (
      target_user_id TEXT PRIMARY KEY,
      actor_user_id TEXT NOT NULL
    )
  `);
  const { codec, encryptionService } = await loadIdentityEmailCodec();
  const persistence = createSQLitePersistence(database, codec);
  const identity = persistence.repositories.identity;

  try {
    await identity.insert(
      user('default', {
        username: 'admin',
        email: null,
        role: 'admin',
        account_status: 'active',
      })
    );
    await identity.insert(user('waiting'));
    await identity.insert(
      user('status-only', {
        email: 'status-only@example.test',
        account_status: 'active',
      })
    );
    database
      .prepare('UPDATE users SET email = ? WHERE id = ?')
      .run('00:00:00', 'status-only');
    assert.equal(
      await identity.findAccountStatusById('status-only'),
      'active',
      'authorization status must not decode unrelated identity ciphertext'
    );
    await assert.rejects(
      identity.findPublicById('status-only'),
      /Invalid encrypted identity email/
    );
    database.prepare('DELETE FROM users WHERE id = ?').run('status-only');

    const storedWaitingEmail = database
      .prepare('SELECT email FROM users WHERE id = ?')
      .get('waiting').email;
    assert.equal(storedWaitingEmail.includes('waiting@example.test'), false);
    assert.equal(encryptionService.isEncrypted(storedWaitingEmail), true);

    assert.equal(await identity.countRealUsers(), 1);
    assert.deepEqual(
      (await identity.list()).map(record => record.id),
      ['waiting']
    );
    assert.equal(
      (await identity.findByUsername('waiting'))?.password_hash,
      'hash-waiting'
    );
    assert.equal(
      (await identity.findPublicById('waiting'))?.username,
      'waiting'
    );
    assert.equal(await identity.usernameExists('waiting'), true);
    assert.equal(await identity.emailExists('waiting@example.test'), true);
    assert.equal(await identity.emailExists('missing@example.test'), false);

    assert.throws(
      () => identity.insert(user('empty-email', { email: '' })),
      /Invalid identity email/
    );

    await assert.rejects(
      identity.insert(
        user('duplicate-email', { email: 'waiting@example.test' })
      ),
      /unique constraint/i
    );
    assert.deepEqual(await identity.getPendingApprovalSummary(), {
      count: 1,
      latest_created_at: 100,
    });

    assert.equal(await identity.approve('waiting', 'default', 200), true);
    assert.equal(
      (await identity.findPublicById('waiting'))?.approved_by,
      'default'
    );
    assert.equal(
      await identity.update('waiting', {
        username: 'approved',
        email: null,
        role: 'admin',
        avatar: 'avatar',
        passwordHash: 'replacement-hash',
        updatedAt: 300,
      }),
      true
    );
    assert.deepEqual(
      await identity.findByUsername('approved'),
      user('waiting', {
        username: 'approved',
        email: null,
        role: 'admin',
        account_status: 'active',
        approved_at: 200,
        approved_by: 'default',
        avatar: 'avatar',
        password_hash: 'replacement-hash',
        updated_at: 300,
      })
    );

    await assert.rejects(
      persistence.transaction(unitOfWork => {
        unitOfWork.identity.insert(user('rolled-back'));
        throw new Error('rollback requested');
      }),
      /rollback requested/
    );
    assert.equal(await identity.findPublicById('rolled-back'), null);

    await persistence.transaction(unitOfWork => {
      unitOfWork.identity.insert(user('committed'));
    });
    assert.equal((await identity.findPublicById('committed'))?.id, 'committed');

    await assert.rejects(
      persistence.transaction(() => persistence.transaction(() => {})),
      /Nested persistence transactions/
    );

    await assert.rejects(
      persistence.transaction(() => {
        identity.insert(user('escaped-repository-write'));
      }),
      /provided unit of work/
    );
    assert.equal(
      await identity.findPublicById('escaped-repository-write'),
      null
    );

    let delayedUnitOfWorkError;
    const unhandledRejections = [];
    const captureUnhandledRejection = reason => {
      unhandledRejections.push(reason);
    };
    process.on('unhandledRejection', captureUnhandledRejection);
    try {
      await assert.rejects(
        persistence.transaction(async unitOfWork => {
          unitOfWork.identity.insert(user('async-rolled-back'));
          await Promise.resolve();
          database
            .prepare(
              `INSERT INTO users (
                 id, username, email, password_hash, role, account_status,
                 approved_at, approved_by, avatar, created_at, updated_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .run(
              ...Object.values(
                user('legacy-after-await', {
                  email: encryptionService.encrypt(
                    'legacy-after-await@example.test'
                  ),
                })
              )
            );
          try {
            unitOfWork.identity.insert(user('late-unit-of-work'));
          } catch (error) {
            delayedUnitOfWorkError = error;
          }
          throw new Error('async transaction callback failure');
        }),
        /callbacks must be synchronous/
      );
      await new Promise(resolve => setImmediate(resolve));
    } finally {
      process.off('unhandledRejection', captureUnhandledRejection);
    }
    assert.deepEqual(unhandledRejections, []);
    assert.equal(await identity.findPublicById('async-rolled-back'), null);
    assert.equal(
      (await identity.findPublicById('legacy-after-await'))?.id,
      'legacy-after-await'
    );
    assert.match(delayedUnitOfWorkError?.message ?? '', /no longer active/);

    await identity.insert(user('delete-with-outbox'));
    assert.equal(
      await identity.deleteAndEnqueue('delete-with-outbox', 'default', {
        enqueueSQLite() {
          throw new Error('active account must not enqueue deletion');
        },
        async enqueuePostgres() {
          throw new Error('wrong persistence dialect');
        },
      }),
      false,
      'identity deletion must require the durable retirement fence'
    );
    assert.equal(
      await identity.beginRetirement('delete-with-outbox', 11),
      true
    );
    assert.equal(
      await identity.beginRetirement('delete-with-outbox', 12),
      true,
      'retirement must be idempotent'
    );
    assert.equal(
      await identity.deleteAndEnqueue('delete-with-outbox', 'default', {
        enqueueSQLite(executor, input) {
          executor.run(
            `INSERT INTO identity_deletion_outbox
                 (target_user_id, actor_user_id)
               VALUES (?, ?)`,
            [input.targetUserId, input.actorUserId]
          );
        },
        async enqueuePostgres() {
          throw new Error('wrong persistence dialect');
        },
      }),
      true
    );
    assert.deepEqual(
      database.prepare('SELECT * FROM identity_deletion_outbox').get(),
      { target_user_id: 'delete-with-outbox', actor_user_id: 'default' }
    );

    await identity.insert(user('delete-outbox-rollback'));
    assert.equal(
      await identity.beginRetirement('delete-outbox-rollback', 13),
      true
    );
    await assert.rejects(
      identity.deleteAndEnqueue('delete-outbox-rollback', 'default', {
        enqueueSQLite() {
          throw new Error('enqueue rollback sentinel');
        },
        async enqueuePostgres() {
          throw new Error('wrong persistence dialect');
        },
      }),
      /enqueue rollback sentinel/
    );
    assert.equal(
      (await identity.findPublicById('delete-outbox-rollback'))?.id,
      'delete-outbox-rollback'
    );

    await identity.insert(
      user('retiring-delete-actor', { account_status: 'active' })
    );
    await identity.insert(
      user('actor-fenced-delete-target', { account_status: 'active' })
    );
    assert.equal(
      await identity.beginRetirement('retiring-delete-actor', 14),
      true
    );
    assert.equal(
      await identity.beginRetirement('actor-fenced-delete-target', 14),
      true
    );
    await assert.rejects(
      identity.deleteAndEnqueue(
        'actor-fenced-delete-target',
        'retiring-delete-actor',
        {
          enqueueSQLite() {
            throw new Error('inactive actor reached enqueue');
          },
          async enqueuePostgres() {
            throw new Error('wrong persistence dialect');
          },
        }
      ),
      /requires an active actor/
    );
    assert.equal(
      (await identity.findPublicById('actor-fenced-delete-target'))
        ?.account_status,
      'retiring'
    );

    assert.equal(await identity.delete('waiting'), true);
    assert.equal(await identity.delete('waiting'), false);
  } finally {
    database.close();
  }
});

test('SQLite preference, archive, note, and persona patches preserve concurrent updates', async () => {
  const { createSQLiteResourceRepositories } = await importBuilt(
    'persistence/sqliteResourceRepositories.js'
  );
  const { createSQLitePlatformDomainRepositories } = await importBuilt(
    'platform/storage/sqlitePlatformDomainRepositories.js'
  );
  const { encryptionService } = await loadIdentityEmailCodec();
  const directory = mkdtempSync(
    path.join(tmpdir(), 'libre-sqlite-preference-atomicity-')
  );
  const databasePath = path.join(directory, 'libre.db');
  const database = new Database(databasePath);
  database.pragma('busy_timeout = 2000');
  createIdentitySchema(database);
  database.exec(`
    CREATE TABLE user_preferences (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(user_id, key)
    )
  `);
  createArchiveResourceSchema(database);
  database.exec(`
    CREATE TABLE platform_resource_deletion_tombstones (
      resource_type TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      owner_user_id TEXT NOT NULL,
      deletion_incarnation INTEGER NOT NULL,
      deletion_token TEXT NOT NULL UNIQUE,
      deleted_at INTEGER NOT NULL,
      completed_at INTEGER,
      PRIMARY KEY (resource_type, resource_id)
    )
  `);
  const insertUser = database.prepare(
    `INSERT INTO users
       (id, username, email, email_lookup, password_hash, role,
        account_status, approved_at, approved_by, avatar, created_at,
        updated_at)
     VALUES (?, ?, NULL, NULL, 'hash', 'user', 'active', NULL, NULL, NULL,
             ?, ?)`
  );
  insertUser.run('later', 'later', 20, 20);
  insertUser.run('z-oldest', 'z-oldest', 10, 10);
  insertUser.run('a-oldest', 'a-oldest', 10, 10);
  const repositories = createSQLiteResourceRepositories(database);
  const domains = createSQLitePlatformDomainRepositories(
    database,
    encryptionService
  );
  const preferences = repositories.preferences;
  const add = (key, value) => current => {
    const next = new Map(current.map(row => [row.key, row.value]));
    next.set(key, value);
    return [...next].map(([entryKey, entryValue]) => ({
      key: entryKey,
      value: entryValue,
    }));
  };

  try {
    assert.equal(await preferences.resolveOwner(), 'a-oldest');
    await Promise.all([
      preferences.mutateAll('a-oldest', 100, add('theme', 'dark')),
      preferences.mutateAll('a-oldest', 101, add('model', 'llama')),
    ]);
    assert.deepEqual(await preferences.listByOwner('a-oldest'), [
      { key: 'model', value: 'llama' },
      { key: 'theme', value: 'dark' },
    ]);

    let archiveSawConcurrentValue = false;
    const worker = new Worker(
      `
        const { parentPort, workerData } = require('node:worker_threads');
        const Database = require('better-sqlite3');
        const database = new Database(workerData.databasePath);
        database.pragma('busy_timeout = 2000');
        database.exec('BEGIN IMMEDIATE');
        database.prepare(
          'INSERT INTO user_preferences (id, user_id, key, value, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
        ).run('concurrent-preference', 'a-oldest', 'replica', 'committed-during-lock-wait', 102, 102);
        parentPort.postMessage('locked');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
        database.exec('COMMIT');
        database.close();
      `,
      { eval: true, workerData: { databasePath } }
    );
    const workerExit = new Promise((resolve, reject) => {
      worker.once('exit', code =>
        code === 0
          ? resolve()
          : reject(new Error(`SQLite writer exited with code ${code}`))
      );
      worker.once('error', reject);
    });
    await new Promise((resolve, reject) => {
      worker.once('message', resolve);
      worker.once('error', reject);
    });
    await repositories.archive.applyImport({
      userId: 'a-oldest',
      strategy: 'skip',
      timestamp: 103,
      maximumNotes: 10,
      maximumSessionFolders: 10,
      preferences: current => {
        archiveSawConcurrentValue = current.some(
          row =>
            row.key === 'replica' && row.value === 'committed-during-lock-wait'
        );
        return add('archive', 'merged')(current);
      },
      sessionFolders: [],
      sessions: [],
      notes: [],
      knowledgeCollections: [],
      documents: [],
    });
    await workerExit;
    assert.equal(archiveSawConcurrentValue, true);
    assert.deepEqual(await preferences.listByOwner('a-oldest'), [
      { key: 'archive', value: 'merged' },
      { key: 'model', value: 'llama' },
      { key: 'replica', value: 'committed-during-lock-wait' },
      { key: 'theme', value: 'dark' },
    ]);

    const beforeAdmissionLoss = await preferences.listByOwner('a-oldest');
    await assert.rejects(
      repositories.archive.applyImport({
        userId: 'a-oldest',
        strategy: 'skip',
        timestamp: 104,
        maximumNotes: 10,
        maximumSessionFolders: 10,
        preferences: add('must-rollback', 'never-committed'),
        sessionFolders: [],
        sessions: [],
        notes: [],
        knowledgeCollections: [],
        documents: [],
        assertCanCommit: () => {
          throw new Error('shared archive admission was lost');
        },
      }),
      /shared archive admission was lost/
    );
    assert.deepEqual(
      await preferences.listByOwner('a-oldest'),
      beforeAdmissionLoss,
      'admission loss at the SQLite commit fence must roll back every section'
    );

    await repositories.notes.replaceWithLimit(
      {
        id: 'concurrent-note',
        user_id: 'a-oldest',
        title: 'original-title',
        content: 'original-content',
          pinned: 0,
        created_at: 110,
        updated_at: 110,
      },
      10
    );
    const noteWorker = new Worker(
      `
        const { parentPort, workerData } = require('node:worker_threads');
        const Database = require('better-sqlite3');
        const database = new Database(workerData.databasePath);
        database.pragma('busy_timeout = 2000');
        database.exec('BEGIN IMMEDIATE');
        database.prepare(
          'UPDATE notes SET content = ?, updated_at = ? WHERE id = ? AND user_id = ?'
        ).run('worker-content', 111, 'concurrent-note', 'a-oldest');
        parentPort.postMessage('locked');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
        database.exec('COMMIT');
        database.close();
      `,
      { eval: true, workerData: { databasePath } }
    );
    const noteWorkerExit = new Promise((resolve, reject) => {
      noteWorker.once('exit', code =>
        code === 0
          ? resolve()
          : reject(new Error(`SQLite note writer exited with code ${code}`))
      );
      noteWorker.once('error', reject);
    });
    await new Promise((resolve, reject) => {
      noteWorker.once('message', resolve);
      noteWorker.once('error', reject);
    });
    const patchedNote = await repositories.notes.patchByOwner(
      'concurrent-note',
      'a-oldest',
      { title: 'replica-title', updated_at: 112 }
    );
    await noteWorkerExit;
    assert.deepEqual(patchedNote, {
      id: 'concurrent-note',
      user_id: 'a-oldest',
      title: 'replica-title',
      content: 'worker-content',
      pinned: 0,
      created_at: 110,
      updated_at: 112,
    });

    await domains.personas.insert({
      id: 'concurrent-persona',
      user_id: 'a-oldest',
      name: 'Original persona',
      description: 'original-description',
      model: 'original-model',
      parameters: { temperature: 0.7 },
      created_at: 120,
      updated_at: 120,
    });
    const personaWorker = new Worker(
      `
        const { parentPort, workerData } = require('node:worker_threads');
        const Database = require('better-sqlite3');
        const database = new Database(workerData.databasePath);
        database.pragma('busy_timeout = 2000');
        database.exec('BEGIN IMMEDIATE');
        database.prepare(
          'UPDATE personas SET model = ?, updated_at = ? WHERE id = ? AND user_id = ?'
        ).run('worker-model', 121, 'concurrent-persona', 'a-oldest');
        parentPort.postMessage('locked');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
        database.exec('COMMIT');
        database.close();
      `,
      { eval: true, workerData: { databasePath } }
    );
    const personaWorkerExit = new Promise((resolve, reject) => {
      personaWorker.once('exit', code =>
        code === 0
          ? resolve()
          : reject(new Error(`SQLite persona writer exited with code ${code}`))
      );
      personaWorker.once('error', reject);
    });
    await new Promise((resolve, reject) => {
      personaWorker.once('message', resolve);
      personaWorker.once('error', reject);
    });
    const patchedPersona = await domains.personas.patchByOwner(
      'concurrent-persona',
      'a-oldest',
      { description: 'replica-description', updated_at: 122 }
    );
    await personaWorkerExit;
    assert.equal(patchedPersona?.name, 'Original persona');
    assert.equal(patchedPersona?.model, 'worker-model');
    assert.equal(patchedPersona?.description, 'replica-description');
    assert.deepEqual(patchedPersona?.parameters, { temperature: 0.7 });
    assert.equal(patchedPersona?.updated_at, 122);
    const encryptedPersonaDescription = database
      .prepare('SELECT description FROM personas WHERE id = ?')
      .get('concurrent-persona').description;
    assert.notEqual(encryptedPersonaDescription, 'replica-description');
    assert.equal(
      encryptionService.isEncrypted(encryptedPersonaDescription),
      true
    );

    await assert.rejects(
      preferences.mutateAll('a-oldest', 102, () => {
        throw new Error('preference rollback sentinel');
      }),
      /preference rollback sentinel/
    );
    assert.deepEqual(await preferences.listByOwner('a-oldest'), [
      { key: 'archive', value: 'merged' },
      { key: 'model', value: 'llama' },
      { key: 'replica', value: 'committed-during-lock-wait' },
      { key: 'theme', value: 'dark' },
    ]);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('SQLite chat persistence and durable enqueue commit or roll back together', async () => {
  const { createSQLiteResourceRepositories } = await importBuilt(
    'persistence/sqliteResourceRepositories.js'
  );
  const database = new Database(':memory:');
  createIdentitySchema(database);
  database.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      model TEXT NOT NULL,
      persona_id TEXT,
      provider_type TEXT,
      provider_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      archived INTEGER NOT NULL,
      settings TEXT,
      folder_id TEXT,
      pinned INTEGER NOT NULL
    );
    CREATE TABLE session_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      thinking TEXT,
      timestamp INTEGER NOT NULL,
      message_index INTEGER NOT NULL,
      model TEXT,
      provider_metadata TEXT,
      images TEXT,
      statistics TEXT,
      artifacts TEXT,
      parent_id TEXT,
      branch_index INTEGER NOT NULL,
      is_active INTEGER NOT NULL,
      rating INTEGER
    );
    CREATE TABLE chat_generation_outbox (
      assistant_message_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL
    );
  `);
  database
    .prepare(
      `INSERT INTO users
         (id, username, email, email_lookup, password_hash, role,
          account_status, approved_at, approved_by, avatar, created_at,
          updated_at)
       VALUES ('chat-owner', 'chat-owner', NULL, NULL, 'hash', 'user',
               'active', NULL, NULL, NULL, 1, 1)`
    )
    .run();
  const repositories = createSQLiteResourceRepositories(database);
  const aggregate = {
    session: {
      id: 'chat-session',
      user_id: 'chat-owner',
      title: 'encrypted-title',
      model: 'model',
      persona_id: null,
      provider_type: null,
      provider_id: null,
      created_at: 1,
      updated_at: 2,
      archived: 0,
      settings: null,
      folder_id: null,
      pinned: 0,
    },
    messages: [
      {
        id: 'user-message',
        session_id: 'chat-session',
        role: 'user',
        content: 'encrypted-message',
        thinking: null,
        timestamp: 2,
        message_index: 0,
        model: null,
        provider_metadata: null,
        images: null,
        statistics: null,
        artifacts: null,
        parent_id: null,
        branch_index: 0,
        is_active: 1,
        rating: null,
      },
    ],
  };
  const input = {
    sessionId: 'chat-session',
    actorUserId: 'chat-owner',
    userMessageId: 'user-message',
    assistantMessageId: 'assistant-message',
    message: 'encrypted-payload',
    options: {},
    webSearch: false,
  };
  const enqueuer = {
    enqueueSQLite(executor, value) {
      executor.run(
        `INSERT INTO chat_generation_outbox
           (assistant_message_id, session_id)
         VALUES (?, ?)`,
        [value.assistantMessageId, value.sessionId]
      );
      return { created: true };
    },
    async enqueuePostgres() {
      throw new Error('wrong persistence dialect');
    },
  };
  try {
    await repositories.chatSessions.replaceAndEnqueue(
      aggregate,
      enqueuer,
      input
    );
    assert.equal(
      database.prepare('SELECT session_id FROM chat_generation_outbox').get()
        .session_id,
      'chat-session'
    );
    assert.equal(
      database.prepare('SELECT title FROM sessions').get().title,
      'encrypted-title'
    );

    await assert.rejects(
      repositories.chatSessions.replaceAndEnqueue(
        {
          ...aggregate,
          session: { ...aggregate.session, title: 'must-roll-back' },
        },
        {
          ...enqueuer,
          enqueueSQLite() {
            throw new Error('chat enqueue rollback sentinel');
          },
        },
        { ...input, assistantMessageId: 'assistant-message-two' }
      ),
      /chat enqueue rollback sentinel/
    );
    assert.equal(
      database.prepare('SELECT title FROM sessions').get().title,
      'encrypted-title'
    );
  } finally {
    database.close();
  }
});

test('SQLite identity repository migrates legacy email storage without plaintext leaks', async () => {
  const { createSQLitePersistence } = await importBuilt(
    'persistence/sqlitePersistence.js'
  );
  const { codec, encryptionService } = await loadIdentityEmailCodec();
  const database = new Database(':memory:');
  createIdentitySchema(database);
  const insert = database.prepare(
    `INSERT INTO users (
       id, username, email, password_hash, role, account_status,
       approved_at, approved_by, avatar, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  insert.run(...Object.values(user('legacy-plaintext')));
  insert.run(
    ...Object.values(
      user('legacy-colon', { email: 'legacy:colon@example.test' })
    )
  );
  insert.run(
    ...Object.values(
      user('legacy-encrypted', {
        email: encryptionService.encrypt('legacy-encrypted@example.test'),
      })
    )
  );
  insert.run(...Object.values(user('legacy-empty', { email: '' })));
  insert.run(
    ...Object.values(user('legacy-opaque', { email: 'not-an-email' }))
  );

  try {
    const persistence = createSQLitePersistence(database, codec);
    const rawEmails = database
      .prepare('SELECT id, email FROM users ORDER BY id')
      .all();
    assert.equal(
      JSON.stringify(rawEmails).includes('legacy-plaintext@example.test'),
      false
    );
    assert.ok(
      rawEmails.every(
        row => row.email === null || encryptionService.isEncrypted(row.email)
      )
    );
    assert.equal(
      (
        await persistence.repositories.identity.findByUsername(
          'legacy-plaintext'
        )
      )?.email,
      'legacy-plaintext@example.test'
    );
    assert.equal(
      (
        await persistence.repositories.identity.findPublicById(
          'legacy-encrypted'
        )
      )?.email,
      'legacy-encrypted@example.test'
    );
    assert.equal(
      (await persistence.repositories.identity.findPublicById('legacy-colon'))
        ?.email,
      'legacy:colon@example.test'
    );
    assert.equal(
      (await persistence.repositories.identity.findPublicById('legacy-empty'))
        ?.email,
      null
    );
    assert.equal(
      (await persistence.repositories.identity.findPublicById('legacy-opaque'))
        ?.email,
      'not-an-email'
    );
    assert.equal(
      await persistence.repositories.identity.emailExists(
        'legacy-plaintext@example.test'
      ),
      true
    );

    const firstMigrationValues = rawEmails.map(row => row.email);
    createSQLitePersistence(database, codec);
    assert.deepEqual(
      database
        .prepare('SELECT email FROM users ORDER BY id')
        .all()
        .map(row => row.email),
      firstMigrationValues,
      'reopening the adapter must not re-encrypt authenticated envelopes'
    );
  } finally {
    database.close();
  }
});

test('SQLite identity repository rejects damaged encrypted legacy emails', async () => {
  const { createSQLitePersistence } = await importBuilt(
    'persistence/sqlitePersistence.js'
  );
  const { codec, encryptionService } = await loadIdentityEmailCodec();
  const database = new Database(':memory:');
  createIdentitySchema(database);
  const encrypted = encryptionService.encrypt('damaged@example.test');
  const damaged = `${encrypted.slice(0, -1)}${
    encrypted.endsWith('0') ? '1' : '0'
  }`;
  database
    .prepare(
      `INSERT INTO users (
         id, username, email, password_hash, role, account_status,
         approved_at, approved_by, avatar, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(...Object.values(user('damaged', { email: damaged })));

  try {
    assert.throws(
      () => createSQLitePersistence(database, codec),
      /Failed to decrypt authenticated text data/
    );
    assert.equal(
      database.prepare('SELECT email FROM users WHERE id = ?').get('damaged')
        .email,
      damaged
    );
  } finally {
    database.close();
  }
});

test('SQLite identity migration rejects a damaged envelope that lost fixed widths', async () => {
  const { createSQLitePersistence } = await importBuilt(
    'persistence/sqlitePersistence.js'
  );
  const { codec, encryptionService } = await loadIdentityEmailCodec();
  const database = new Database(':memory:');
  createIdentitySchema(database);
  const [iv, tag, ciphertext] = encryptionService
    .encrypt('shortened@example.test')
    .split(':');
  const damaged = `${iv.slice(1)}:${tag.slice(1)}:${ciphertext}`;
  database
    .prepare(
      `INSERT INTO users (
         id, username, email, password_hash, role, account_status,
         approved_at, approved_by, avatar, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(...Object.values(user('shortened', { email: damaged })));

  try {
    assert.throws(
      () => createSQLitePersistence(database, codec),
      /Invalid encrypted identity email/
    );
    assert.equal(
      database.prepare('SELECT email FROM users WHERE id = ?').get('shortened')
        .email,
      damaged
    );
  } finally {
    database.close();
  }
});
