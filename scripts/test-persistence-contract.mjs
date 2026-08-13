import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
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
        CHECK(account_status IN ('pending', 'active')),
      approved_at INTEGER,
      approved_by TEXT,
      avatar TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
};

test('SQLite identity repository satisfies the async persistence contract', async () => {
  const { createSQLitePersistence } = await importBuilt(
    'persistence/sqlitePersistence.js'
  );
  const database = new Database(':memory:');
  createIdentitySchema(database);
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

    assert.equal(await identity.delete('waiting'), true);
    assert.equal(await identity.delete('waiting'), false);
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
