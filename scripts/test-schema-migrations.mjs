import assert from 'node:assert/strict';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';

const repoRoot = path.resolve(import.meta.dirname, '..');
const databaseModuleUrl = pathToFileURL(
  path.join(repoRoot, 'backend', 'dist', 'db.js')
).href;
const migrations = await import(
  pathToFileURL(
    path.join(repoRoot, 'backend', 'dist', 'persistence', 'sqliteMigrations.js')
  ).href
);
const databaseHelpers = await import(databaseModuleUrl);
const dataDirectoryHelpers = await import(
  pathToFileURL(
    path.join(repoRoot, 'backend', 'dist', 'utils', 'dataDirectory.js')
  ).href
);

const startApplicationDatabase = dataDir =>
  spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `const database = await import(${JSON.stringify(
        databaseModuleUrl
      )}); database.getDatabase(); database.closeDatabase();`,
    ],
    {
      cwd: repoRoot,
      env: { ...process.env, DATA_DIR: dataDir },
      encoding: 'utf8',
    }
  );

const initializeApplicationDatabase = dataDir => {
  const child = startApplicationDatabase(dataDir);
  assert.equal(child.status, 0, `${child.stderr}\n${child.stdout}`);
  return path.join(dataDir, 'data.sqlite');
};

const schemaSnapshot = database => ({
  schemaVersion: database.pragma('schema_version', { simple: true }),
  objects: database
    .prepare(
      `SELECT type, name, tbl_name, sql
       FROM sqlite_master
       ORDER BY type, name`
    )
    .all(),
  sentinel: database.prepare('SELECT * FROM preflight_sentinel').all(),
  workRouting: database
    .prepare(
      `SELECT id, provider_type, provider_id, network_enabled
       FROM work_tasks
       ORDER BY id`
    )
    .all(),
});

const assertFileUnchanged = (databasePath, beforeBytes, message) => {
  assert.deepEqual(fs.readFileSync(databasePath), beforeBytes, message);
};

const encryptLegacyText = (plaintext, keyHex) => {
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), iv);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(plaintext, 'utf8')),
    cipher.final(),
  ]);
  return `${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${ciphertext.toString('hex')}`;
};

const removeDurableJobsMigration = database => {
  database.exec(`
    DROP INDEX idx_platform_resource_tombstones_owner;
    DROP TABLE platform_resource_deletion_tombstones;
    DELETE FROM _libre_schema_migrations WHERE version = 12;
    DELETE FROM _libre_schema_migrations WHERE version = 11;
    DELETE FROM _libre_schema_migrations WHERE version = 10;
    DELETE FROM _libre_schema_migrations WHERE version = 9;
    DROP INDEX idx_platform_blob_quota_objects_owner;
    DROP TABLE platform_blob_quota_objects;
    DROP INDEX idx_platform_blob_quota_reservations_owner;
    DROP INDEX idx_platform_blob_quota_reservations_expiry;
    DROP TABLE platform_blob_quota_reservations;
    DROP TABLE platform_blob_quota_usage;
    DELETE FROM _libre_schema_migrations WHERE version = 8;
    DROP INDEX idx_plugin_definitions_updated;
    DROP TABLE plugin_definitions;
    DELETE FROM _libre_schema_migrations WHERE version = 7;
    DROP INDEX idx_voice_profiles_name_lookup;
    ALTER TABLE voice_profiles DROP COLUMN name_lookup;
    DELETE FROM _libre_schema_migrations WHERE version = 6;
    DROP INDEX idx_platform_blob_references_resource;
    DROP INDEX idx_platform_blob_references_owner;
    DROP TABLE platform_blob_references;
    DELETE FROM _libre_schema_migrations WHERE version = 5;
    DROP INDEX idx_users_email_lookup;
    ALTER TABLE users DROP COLUMN email_lookup;
    DELETE FROM _libre_schema_migrations WHERE version = 4;
    DROP TABLE platform_events;
    DROP TABLE platform_event_stream_heads;
    DROP TABLE platform_job_attempts;
    DROP TABLE platform_jobs;
    DELETE FROM _libre_schema_migrations WHERE version = 3;
  `);
};

const migrationChecksum = version =>
  migrations.SQLITE_MIGRATION_CONTRACT.find(
    migration => migration.version === version
  ).checksum;

const markHistoricalVectorChecksum = database => {
  database
    .prepare(
      `UPDATE _libre_schema_migrations
          SET checksum = 'VECTOR_CHECKSUM_TO_FREEZE'
        WHERE version = 2 AND name = 'platform-vector-storage'`
    )
    .run();
};

test('fresh SQLite state uses private filesystem permissions', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'libre-private-state-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'data');
  const databasePath = initializeApplicationDatabase(dataDir);
  assert.equal(fs.statSync(dataDir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(databasePath).mode & 0o777, 0o600);
});

test('read-only bootstrap preflight accepts every supported starting state', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'libre-bootstrap-valid-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const absentPath = path.join(root, 'absent', 'data.sqlite');
  databaseHelpers.preflightExistingSQLiteDatabase(absentPath);
  assert.equal(fs.existsSync(path.dirname(absentPath)), false);

  for (const state of ['current', 'v2', 'v1', 'legacy-ledgerless']) {
    const dataDir = path.join(root, state);
    const databasePath = initializeApplicationDatabase(dataDir);
    const database = new Database(databasePath);
    if (state !== 'current') removeDurableJobsMigration(database);
    if (state === 'v1') {
      database.exec(`
        DROP TABLE platform_vector_attributes;
        DROP TABLE platform_vector_acl;
        DROP TABLE platform_vector_entries;
        DELETE FROM _libre_schema_migrations WHERE version = 2;
      `);
    } else if (state === 'legacy-ledgerless') {
      database.exec(`
        DROP TABLE platform_vector_attributes;
        DROP TABLE platform_vector_acl;
        DROP TABLE platform_vector_entries;
        DROP TABLE _libre_schema_migrations;
        ALTER TABLE users DROP COLUMN avatar;
        ALTER TABLE sessions DROP COLUMN provider_type;
        ALTER TABLE sessions DROP COLUMN provider_id;
      `);
      const inspection = migrations.inspectSQLiteSchema(database);
      assert.equal(inspection.status, 'uninitialized');
      assert.equal(inspection.compatible, false);
      assert.match(inspection.reason, /ledger has not been adopted/i);
    }
    database.close();
    const beforeBytes = fs.readFileSync(databasePath);
    const beforeFiles = fs.readdirSync(dataDir).sort();

    databaseHelpers.preflightExistingSQLiteDatabase(databasePath);

    assertFileUnchanged(
      databasePath,
      beforeBytes,
      `${state} preflight must leave database bytes unchanged`
    );
    assert.deepEqual(fs.readdirSync(dataDir).sort(), beforeFiles);
  }
});

test('data and preflight paths are stable across launch working directories', t => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'libre-data-path-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const defaultData = path.join(fixture, 'canonical');
  const legacyData = path.join(fixture, 'legacy');
  fs.mkdirSync(legacyData, { recursive: true });
  fs.writeFileSync(path.join(legacyData, 'data.sqlite'), 'legacy');

  assert.equal(
    dataDirectoryHelpers.resolveDataDirectory({ DATA_DIR: './backend/data' }),
    path.join(repoRoot, 'backend', 'backend', 'data')
  );
  assert.equal(
    dataDirectoryHelpers.resolveDataDirectory({ DATA_DIR: './data' }),
    path.join(repoRoot, 'backend', 'data')
  );
  const environmentModule = pathToFileURL(
    path.join(repoRoot, 'backend', 'dist', 'env.js')
  ).href;
  const dataDirectoryModule = pathToFileURL(
    path.join(repoRoot, 'backend', 'dist', 'utils', 'dataDirectory.js')
  ).href;
  const resolveFrom = cwd => {
    const childEnv = { ...process.env };
    // Keep DATA_DIR present but empty so dotenv cannot inject a developer's
    // ignored backend/.env value into this default-path fixture.
    childEnv.DATA_DIR = '';
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `await import(${JSON.stringify(environmentModule)}); const paths = await import(${JSON.stringify(dataDirectoryModule)}); process.stdout.write(paths.resolveDataDirectory());`,
      ],
      { cwd, env: childEnv, encoding: 'utf8' }
    );
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  assert.equal(resolveFrom(repoRoot), path.join(repoRoot, 'backend', 'data'));
  assert.equal(
    resolveFrom(path.join(repoRoot, 'backend')),
    path.join(repoRoot, 'backend', 'data')
  );
  assert.throws(
    () =>
      dataDirectoryHelpers.assertPreflightDirectoryOutsideDataDirectory(
        defaultData,
        path.join(defaultData, 'preflight')
      ),
    /must be outside DATA_DIR/
  );
  dataDirectoryHelpers.assertPreflightDirectoryOutsideDataDirectory(
    defaultData,
    path.join(fixture, 'preflight')
  );
  fs.mkdirSync(defaultData, { recursive: true });
  const aliasedData = path.join(fixture, 'data-alias');
  fs.symlinkSync(defaultData, aliasedData, 'dir');
  assert.throws(
    () =>
      dataDirectoryHelpers.assertPreflightDirectoryOutsideDataDirectory(
        defaultData,
        path.join(aliasedData, 'preflight')
      ),
    /must be outside DATA_DIR/
  );
  assert.equal(
    dataDirectoryHelpers.resolvePreflightDirectory({
      PLATFORM_PREFLIGHT_TMP_DIR: path.join(aliasedData, 'preflight'),
    }),
    dataDirectoryHelpers.resolvePhysicalPathCandidate(
      path.join(defaultData, 'preflight')
    )
  );
  assert.equal(
    dataDirectoryHelpers.resolveDataDirectory(
      {},
      {
        defaultDataDirectory: defaultData,
        legacyDataDirectory: legacyData,
      }
    ),
    legacyData,
    'an unset source profile must preserve its sole historical store'
  );
  dataDirectoryHelpers.assertNoLegacyDataDirectoryConflict(
    {},
    { defaultDataDirectory: defaultData, legacyDataDirectory: legacyData }
  );
  assert.throws(
    () =>
      dataDirectoryHelpers.assertNoLegacyDataDirectoryConflict(
        { DATA_DIR: defaultData },
        {
          defaultDataDirectory: defaultData,
          legacyDataDirectory: legacyData,
        }
      ),
    /startup will not choose or copy/i
  );
  dataDirectoryHelpers.assertNoLegacyDataDirectoryConflict(
    { DATA_DIR: legacyData },
    { defaultDataDirectory: defaultData, legacyDataDirectory: legacyData }
  );
  fs.writeFileSync(path.join(defaultData, 'data.sqlite'), 'canonical');
  assert.throws(
    () =>
      dataDirectoryHelpers.assertNoLegacyDataDirectoryConflict(
        {},
        { defaultDataDirectory: defaultData, legacyDataDirectory: legacyData }
      ),
    /startup will not choose or copy/i,
    'an unset source profile must not choose between divergent stores'
  );

  const historicalRelativeName = `.libre-relative-${process.pid}-${Date.now()}`;
  const historicalRelativeData = path.join(
    repoRoot,
    'backend',
    historicalRelativeName
  );
  t.after(() =>
    fs.rmSync(historicalRelativeData, { recursive: true, force: true })
  );
  fs.mkdirSync(historicalRelativeData, { recursive: true });
  fs.writeFileSync(path.join(historicalRelativeData, 'data.sqlite'), 'legacy');
  dataDirectoryHelpers.assertNoLegacyDataDirectoryConflict({
    DATA_DIR: `./${historicalRelativeName}`,
  });

  const callerWorkingDirectory = path.join(fixture, 'npx-caller');
  const callerRelativeData = path.join(callerWorkingDirectory, 'state');
  fs.mkdirSync(callerRelativeData, { recursive: true });
  fs.writeFileSync(path.join(callerRelativeData, 'data.sqlite'), 'legacy');
  assert.throws(
    () =>
      dataDirectoryHelpers.assertNoLegacyDataDirectoryConflict(
        { DATA_DIR: './state' },
        { historicalWorkingDirectories: [callerWorkingDirectory] }
      ),
    /historical process working directory.*absolute DATA_DIR/is
  );

  const encryptedState = path.join(fixture, 'encrypted-state');
  const blobId = 'ab123456-7890-4abc-8def-1234567890ab';
  fs.mkdirSync(path.join(encryptedState, 'blobs', 'objects', 'ab', '12'), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(encryptedState, 'blobs', 'objects', 'ab', '12', `${blobId}.blob`),
    'ciphertext'
  );
  assert.throws(
    () =>
      dataDirectoryHelpers.assertExistingStateHasLegacyEncryptionKey(
        encryptedState,
        {}
      ),
    /refusing to generate a replacement key/i
  );
  assert.equal(
    fs.existsSync(path.join(encryptedState, '.encryption_key')),
    false
  );
  dataDirectoryHelpers.assertExistingStateHasLegacyEncryptionKey(
    encryptedState,
    { ENCRYPTION_KEY: 'ab'.repeat(32) }
  );

  const emptyStore = path.join(fixture, 'empty-blob-store');
  fs.mkdirSync(path.join(emptyStore, 'blobs', 'objects'), { recursive: true });
  fs.mkdirSync(path.join(emptyStore, 'blobs', 'staging'), { recursive: true });
  fs.writeFileSync(
    path.join(emptyStore, 'blobs', 'staging', `${blobId}.body.tmp`),
    'recoverable staging data'
  );
  assert.equal(
    dataDirectoryHelpers.hasKeyDependentApplicationState(emptyStore),
    false
  );
  dataDirectoryHelpers.assertExistingStateHasLegacyEncryptionKey(
    emptyStore,
    {}
  );

  fs.writeFileSync(
    path.join(emptyStore, 'blobs', 'objects', 'unexpected.blob'),
    'malformed state'
  );
  assert.equal(
    dataDirectoryHelpers.hasKeyDependentApplicationState(emptyStore),
    true
  );
});

test('bootstrap preflight uses dedicated scratch and removes its private copy', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'libre-preflight-root-'));
  const dataDir = path.join(root, 'data');
  const scratchDir = path.join(root, 'scratch');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const databasePath = initializeApplicationDatabase(dataDir);

  databaseHelpers.preflightExistingSQLiteDatabase(databasePath, scratchDir);

  assert.deepEqual(fs.readdirSync(scratchDir), []);
  assert.deepEqual(
    fs
      .readdirSync(dataDir)
      .filter(name => name.startsWith('.libre-bootstrap-')),
    []
  );
});

test('bootstrap preflight refuses linked SQLite sources without following them', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'libre-preflight-link-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const externalDir = path.join(root, 'external');
  const selectedDir = path.join(root, 'selected');
  fs.mkdirSync(selectedDir);
  const externalDatabase = initializeApplicationDatabase(externalDir);
  const externalBytes = fs.readFileSync(externalDatabase);
  const selectedDatabase = path.join(selectedDir, 'data.sqlite');
  fs.symlinkSync(externalDatabase, selectedDatabase);

  assert.throws(
    () => databaseHelpers.preflightExistingSQLiteDatabase(selectedDatabase),
    /single-link regular file/
  );
  assert.deepEqual(fs.readFileSync(externalDatabase), externalBytes);
});

test('bootstrap preflight reads WAL state without changing source files', t => {
  const dataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'libre-bootstrap-wal-')
  );
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const databasePath = initializeApplicationDatabase(dataDir);
  const writer = new Database(databasePath);
  t.after(() => writer.close());
  writer.pragma('wal_autocheckpoint = 0');
  writer
    .prepare(
      "UPDATE _libre_schema_migrations SET checksum = 'wal-tampered' WHERE version = 1"
    )
    .run();

  const beforeFiles = fs.readdirSync(dataDir).sort();
  assert.ok(beforeFiles.includes('data.sqlite-wal'));
  assert.ok(beforeFiles.includes('data.sqlite-shm'));
  const beforeBytes = new Map(
    beforeFiles.map(name => [name, fs.readFileSync(path.join(dataDir, name))])
  );

  assert.throws(
    () => databaseHelpers.preflightExistingSQLiteDatabase(databasePath),
    /checksum mismatch/i
  );

  assert.deepEqual(fs.readdirSync(dataDir).sort(), beforeFiles);
  for (const [name, bytes] of beforeBytes) {
    assert.deepEqual(
      fs.readFileSync(path.join(dataDir, name)),
      bytes,
      `${name} must remain unchanged during preflight`
    );
  }
});

test('main rejects invalid existing databases before durable singleton writes', t => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'libre-bootstrap-invalid-')
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cases = [
    {
      name: 'future-ledger',
      mutate(database) {
        database
          .prepare(
            `INSERT INTO _libre_schema_migrations
               (version, name, checksum, applied_at)
             VALUES (999, 'future', 'future', 1)`
          )
          .run();
      },
      error: /newer than supported/i,
    },
    {
      name: 'tampered-ledger',
      mutate(database) {
        database
          .prepare(
            "UPDATE _libre_schema_migrations SET checksum = 'tampered' WHERE version = 1"
          )
          .run();
      },
      error: /checksum mismatch/i,
    },
    {
      name: 'incompatible-ledger',
      mutate(database) {
        database.exec('DROP INDEX idx_sessions_user_id');
      },
      error: /schema is incompatible.*idx_sessions_user_id/is,
    },
    {
      name: 'malformed-ledger',
      mutate(database) {
        const applied = database
          .prepare(
            `SELECT version, name, checksum
             FROM _libre_schema_migrations
             ORDER BY version`
          )
          .all();
        database.exec(`
          DROP TABLE _libre_schema_migrations;
          CREATE TABLE _libre_schema_migrations (
            version INTEGER PRIMARY KEY,
            name TEXT NOT NULL UNIQUE,
            checksum TEXT NOT NULL
          );
        `);
        const insert = database.prepare(
          `INSERT INTO _libre_schema_migrations (version, name, checksum)
           VALUES (?, ?, ?)`
        );
        for (const row of applied)
          insert.run(row.version, row.name, row.checksum);
      },
      error: /migration ledger is incompatible.*applied_at/is,
    },
    {
      name: 'malformed-ledgerless',
      mutate(database) {
        database.pragma('foreign_keys = OFF');
        database.exec(`
          DROP TABLE _libre_schema_migrations;
          CREATE TABLE sessions_without_foreign_keys AS
            SELECT * FROM sessions;
          DROP TABLE sessions;
          ALTER TABLE sessions_without_foreign_keys RENAME TO sessions;
        `);
      },
      error: /sessions primary key|sessions foreign key/i,
    },
    {
      name: 'malformed-empty-ledger',
      mutate(database) {
        database.pragma('foreign_keys = OFF');
        database.exec(`
          DELETE FROM _libre_schema_migrations;
          CREATE TABLE sessions_without_foreign_keys AS
            SELECT * FROM sessions;
          DROP TABLE sessions;
          ALTER TABLE sessions_without_foreign_keys RENAME TO sessions;
        `);
      },
      error: /migration version 0.*sessions (?:primary key|foreign key)/is,
    },
  ];

  for (const fixture of cases) {
    const dataDir = path.join(root, fixture.name);
    const databasePath = initializeApplicationDatabase(dataDir);
    const database = new Database(databasePath);
    fixture.mutate(database);
    database.close();
    const beforeBytes = fs.readFileSync(databasePath);
    const beforeFiles = fs.readdirSync(dataDir).sort();
    const env = {
      ...process.env,
      DATA_DIR: dataDir,
      PLUGINS_DIR: path.join(dataDir, 'plugins'),
      NODE_ENV: 'production',
      JWT_SECRET: 'bootstrap-audit-jwt-secret-bootstrap-audit',
      SESSION_SECRET: 'bootstrap-audit-session-bootstrap-audit',
      ENCRYPTION_KEY: '42'.repeat(32),
    };
    delete env.STORAGE_ENCRYPTION_KEYS;
    delete env.STORAGE_ENCRYPTION_ACTIVE_KEY_ID;

    const child = spawnSync(
      process.execPath,
      [path.join(repoRoot, 'backend', 'dist', 'main.js')],
      { cwd: repoRoot, env, encoding: 'utf8', timeout: 10_000 }
    );
    assert.notEqual(child.status, 0, fixture.name);
    assert.match(`${child.stderr}\n${child.stdout}`, fixture.error);
    assert.equal(fs.existsSync(path.join(dataDir, '.encryption_key')), false);
    assert.equal(fs.existsSync(path.join(dataDir, 'plugins')), false);
    assertFileUnchanged(
      databasePath,
      beforeBytes,
      `${fixture.name} startup must leave database bytes unchanged`
    );
    assert.deepEqual(fs.readdirSync(dataDir).sort(), beforeFiles);
  }

  const corruptDir = path.join(root, 'corrupt');
  fs.mkdirSync(corruptDir);
  const corruptPath = path.join(corruptDir, 'data.sqlite');
  fs.writeFileSync(corruptPath, 'not a sqlite database');
  const beforeCorrupt = fs.readFileSync(corruptPath);
  const corruptEnv = {
    ...process.env,
    DATA_DIR: corruptDir,
    PLUGINS_DIR: path.join(corruptDir, 'plugins'),
    NODE_ENV: 'production',
    ENCRYPTION_KEY: '42'.repeat(32),
  };
  delete corruptEnv.STORAGE_ENCRYPTION_KEYS;
  delete corruptEnv.STORAGE_ENCRYPTION_ACTIVE_KEY_ID;
  const corrupt = spawnSync(
    process.execPath,
    [path.join(repoRoot, 'backend', 'dist', 'main.js')],
    { cwd: repoRoot, env: corruptEnv, encoding: 'utf8', timeout: 10_000 }
  );
  assert.notEqual(corrupt.status, 0);
  assert.equal(fs.existsSync(path.join(corruptDir, '.encryption_key')), false);
  assert.equal(fs.existsSync(path.join(corruptDir, 'plugins')), false);
  assertFileUnchanged(
    corruptPath,
    beforeCorrupt,
    'corrupt startup must leave database bytes unchanged'
  );

  const wrongKeyDir = path.join(root, 'wrong-encryption-key');
  const wrongKeyPath = initializeApplicationDatabase(wrongKeyDir);
  const correctKey = '31'.repeat(32);
  const wrongKeyDatabase = new Database(wrongKeyPath);
  wrongKeyDatabase
    .prepare(
      `INSERT INTO users (
         id, username, email, email_lookup, password_hash, role,
         account_status, approved_at, approved_by, avatar, created_at,
         updated_at
       ) VALUES (?, ?, ?, NULL, ?, 'admin', 'active', ?, NULL, NULL, ?, ?)`
    )
    .run(
      'wrong-key-user',
      'wrong-key-user',
      encryptLegacyText('wrong-key@example.test', correctKey),
      'hash',
      1,
      1,
      1
    );
  wrongKeyDatabase.close();
  const wrongKeyBefore = fs.readFileSync(wrongKeyPath);
  const wrongKeyFiles = fs.readdirSync(wrongKeyDir).sort();
  const wrongKey = spawnSync(
    process.execPath,
    [path.join(repoRoot, 'backend', 'dist', 'main.js')],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        DATA_DIR: wrongKeyDir,
        PLUGINS_DIR: path.join(wrongKeyDir, 'plugins'),
        ENCRYPTION_KEY: '42'.repeat(32),
        NODE_ENV: 'production',
      },
      encoding: 'utf8',
      timeout: 10_000,
    }
  );
  assert.notEqual(wrongKey.status, 0);
  assert.match(
    `${wrongKey.stderr}\n${wrongKey.stdout}`,
    /Legacy ciphertext recovery verification failed/
  );
  assert.equal(fs.existsSync(path.join(wrongKeyDir, 'plugins')), false);
  assertFileUnchanged(
    wrongKeyPath,
    wrongKeyBefore,
    'wrong-key startup must leave database bytes unchanged'
  );
  assert.deepEqual(fs.readdirSync(wrongKeyDir).sort(), wrongKeyFiles);
});

test('legacy SQLite schema is adopted into immutable checksummed migrations', t => {
  const dataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'libre-schema-ledger-')
  );
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const databasePath = initializeApplicationDatabase(dataDir);
  const database = new Database(databasePath);
  t.after(() => database.close());

  assert.equal(
    createHash('sha256')
      .update('002-platform-vector-storage\n')
      .update(migrations.PLATFORM_VECTOR_SCHEMA_SQL)
      .digest('hex'),
    '633f4d535c207fb212764f4fddf43536678a3f02e8ccad52628b7223d17b00d5',
    'released migration v2 DDL and checksum must stay immutable'
  );
  assert.equal(
    createHash('sha256')
      .update('003-durable-jobs-events\n')
      .update(migrations.DURABLE_JOBS_EVENTS_SCHEMA_SQL)
      .digest('hex'),
    'dbc2cfa903c0ab173acc2e29f9aa576b7ba744816fb819492271c39a4fbd23de',
    'released migration v3 DDL and checksum must stay immutable'
  );
  assert.equal(
    createHash('sha256')
      .update('004-identity-email-lookup\n')
      .update(migrations.IDENTITY_EMAIL_LOOKUP_SCHEMA_SQL)
      .digest('hex'),
    'abac261ef3848667aa3ad5dbb47c123b119cadbc0738c167c9b9d35b057a43a0',
    'released migration v4 DDL and checksum must stay immutable'
  );
  assert.equal(
    createHash('sha256')
      .update('005-blob-references\n')
      .update(migrations.SQLITE_BLOB_REFERENCE_SCHEMA_SQL)
      .digest('hex'),
    '84a2c0cf783c81f46e90c73ae2e62ca80b89669e672767f94af7ea5d37098b79',
    'released migration v5 DDL and checksum must stay immutable'
  );
  assert.equal(
    createHash('sha256')
      .update('006-voice-profile-name-lookup\n')
      .update(migrations.VOICE_PROFILE_NAME_LOOKUP_SCHEMA_SQL)
      .digest('hex'),
    '6162d4feb454f812ea1ddf88c472943f1fc07da5933c29986d4b8b27d6156df6',
    'released migration v6 DDL and checksum must stay immutable'
  );
  assert.equal(
    createHash('sha256')
      .update('007-shared-plugin-definitions\n')
      .update(migrations.PLUGIN_DEFINITION_SCHEMA_SQL)
      .digest('hex'),
    '7092b4bb02ad71be4ef7d6106ed5bab6d5b76e9ec8d98f36f7a8a6c3a70c84c6',
    'released migration v7 DDL and checksum must stay immutable'
  );
  assert.equal(
    createHash('sha256')
      .update('008-blob-quotas\n')
      .update(migrations.SQLITE_BLOB_QUOTA_SCHEMA_SQL)
      .digest('hex'),
    'c6dd6ff729b92dc935aacd5ea236bbbf6f8f455999abd3ab8f687457ec0ca998',
    'released migration v8 DDL and checksum must stay immutable'
  );
  assert.equal(
    createHash('sha256')
      .update('009-identity-account-retirement\n')
      .update(migrations.IDENTITY_ACCOUNT_RETIREMENT_SCHEMA_SQL)
      .digest('hex'),
    '72c57042dd74cba8b1b22395bfe7942e62e269a0041706711094565fb6860657',
    'released migration v9 DDL and checksum must stay immutable'
  );
  assert.equal(
    createHash('sha256')
      .update('010-work-preview-upstream\n')
      .update(migrations.WORK_PREVIEW_UPSTREAM_SCHEMA_SQL)
      .digest('hex'),
    'aa2023e736da5a2b63ab2e39c378a3c43fc6f40be9318eec1397dff83c4a9358',
    'released migration v10 DDL and checksum must stay immutable'
  );
  assert.equal(
    createHash('sha256')
      .update('011-durable-event-idempotency\n')
      .update(migrations.DURABLE_EVENT_IDEMPOTENCY_SCHEMA_SQL)
      .digest('hex'),
    'fe9aee7dc21dc4ca6a5bdcd0fcd5788104501f68bc2c72e83faf9b6ce6514d44',
    'released migration v11 DDL and checksum must stay immutable'
  );
  assert.equal(
    createHash('sha256')
      .update('012-resource-deletion-lifecycle\n')
      .update(migrations.RESOURCE_DELETION_LIFECYCLE_SCHEMA_SQL)
      .digest('hex'),
    'a72e862afe109daf68b7ec8e445ef359bc3550a5ac8973d135cf7a18eb5bf1cc',
    'released migration v12 DDL and checksum must stay immutable'
  );

  assert.equal(migrations.getSchemaCompatibilityState().targetVersion, 12);
  assert.deepEqual(
    migrations.inspectSQLiteSchema(database).appliedMigrations.map(row => ({
      version: row.version,
      name: row.name,
      checksum: row.checksum,
      checksumMatches: row.checksumMatches,
    })),
    [
      {
        version: 1,
        name: 'adopt-current-schema',
        checksum:
          '6027d48757e31a6d2a65819c46a5b641bfd9a8bde50628757e2d682ec3e320bf',
        checksumMatches: true,
      },
      {
        version: 2,
        name: 'platform-vector-storage',
        checksum:
          '633f4d535c207fb212764f4fddf43536678a3f02e8ccad52628b7223d17b00d5',
        checksumMatches: true,
      },
      {
        version: 3,
        name: 'durable-jobs-events',
        checksum:
          'dbc2cfa903c0ab173acc2e29f9aa576b7ba744816fb819492271c39a4fbd23de',
        checksumMatches: true,
      },
      {
        version: 4,
        name: 'identity-email-lookup',
        checksum:
          'abac261ef3848667aa3ad5dbb47c123b119cadbc0738c167c9b9d35b057a43a0',
        checksumMatches: true,
      },
      {
        version: 5,
        name: 'blob-references',
        checksum:
          '84a2c0cf783c81f46e90c73ae2e62ca80b89669e672767f94af7ea5d37098b79',
        checksumMatches: true,
      },
      {
        version: 6,
        name: 'voice-profile-name-lookup',
        checksum:
          '6162d4feb454f812ea1ddf88c472943f1fc07da5933c29986d4b8b27d6156df6',
        checksumMatches: true,
      },
      {
        version: 7,
        name: 'shared-plugin-definitions',
        checksum:
          '7092b4bb02ad71be4ef7d6106ed5bab6d5b76e9ec8d98f36f7a8a6c3a70c84c6',
        checksumMatches: true,
      },
      {
        version: 8,
        name: 'blob-quotas',
        checksum:
          'c6dd6ff729b92dc935aacd5ea236bbbf6f8f455999abd3ab8f687457ec0ca998',
        checksumMatches: true,
      },
      {
        version: 9,
        name: 'identity-account-retirement',
        checksum:
          '72c57042dd74cba8b1b22395bfe7942e62e269a0041706711094565fb6860657',
        checksumMatches: true,
      },
      {
        version: 10,
        name: 'work-preview-upstream',
        checksum:
          'aa2023e736da5a2b63ab2e39c378a3c43fc6f40be9318eec1397dff83c4a9358',
        checksumMatches: true,
      },
      {
        version: 11,
        name: 'durable-event-idempotency',
        checksum:
          'fe9aee7dc21dc4ca6a5bdcd0fcd5788104501f68bc2c72e83faf9b6ce6514d44',
        checksumMatches: true,
      },
      {
        version: 12,
        name: 'resource-deletion-lifecycle',
        checksum:
          'a72e862afe109daf68b7ec8e445ef359bc3550a5ac8973d135cf7a18eb5bf1cc',
        checksumMatches: true,
      },
    ]
  );

  database.exec('DROP TABLE _libre_schema_migrations');
  assert.deepEqual(migrations.runSQLiteMigrationCoordinator(database), {
    dialect: 'sqlite',
    status: 'compatible',
    currentVersion: 12,
    targetVersion: 12,
    minimumSupportedVersion: 1,
  });
  assert.equal(
    database
      .prepare('SELECT COUNT(*) AS count FROM _libre_schema_migrations')
      .get().count,
    12
  );

  migrations.runSQLiteMigrationCoordinator(database);
  assert.equal(
    database
      .prepare('SELECT COUNT(*) AS count FROM _libre_schema_migrations')
      .get().count,
    12
  );
});

test('vector schema is installed only through checksummed migration v2', t => {
  const dataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'libre-schema-vector-')
  );
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const database = new Database(initializeApplicationDatabase(dataDir));
  t.after(() => database.close());

  removeDurableJobsMigration(database);
  database.exec(`
    DROP TABLE platform_vector_attributes;
    DROP TABLE platform_vector_acl;
    DROP TABLE platform_vector_entries;
    DELETE FROM _libre_schema_migrations WHERE version = 2;
  `);
  const before = migrations.inspectSQLiteSchema(database);
  assert.equal(before.currentVersion, 1);
  assert.equal(before.status, 'migrating');
  assert.equal(before.compatible, false);
  assert.match(before.reason, /requires migration to version 12/);
  assert.ok(before.missing.includes('platform_vector_entries (table)'));

  const migrated = migrations.runSQLiteMigrationCoordinator(database);
  assert.equal(migrated.currentVersion, 12);
  assert.equal(migrated.status, 'compatible');
  assert.equal(migrations.inspectSQLiteSchema(database).missing.length, 0);
});

test('historical vector checksum is repaired only in the atomic live coordinator', t => {
  const dataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'libre-schema-vector-checksum-')
  );
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const databasePath = initializeApplicationDatabase(dataDir);
  const database = new Database(databasePath);
  t.after(() => database.close());

  removeDurableJobsMigration(database);
  markHistoricalVectorChecksum(database);
  const appliedAt = database
    .prepare(
      'SELECT applied_at FROM _libre_schema_migrations WHERE version = 2'
    )
    .get().applied_at;
  const beforeBytes = fs.readFileSync(databasePath);

  const inspection = migrations.inspectSQLiteSchema(database);
  assert.equal(inspection.status, 'migrating');
  assert.equal(inspection.compatible, false);
  assert.equal(
    inspection.appliedMigrations.find(row => row.version === 2).checksumMatches,
    false
  );
  assert.match(inspection.reason, /recognized historical checksum/i);
  assert.deepEqual(migrations.preflightSQLiteMigrationLedger(database), {
    dialect: 'sqlite',
    status: 'migrating',
    currentVersion: 2,
    targetVersion: 12,
    minimumSupportedVersion: 1,
  });
  assert.deepEqual(
    fs.readFileSync(databasePath),
    beforeBytes,
    'read-only preflight must not repair the historical checksum'
  );

  assert.deepEqual(migrations.runSQLiteMigrationCoordinator(database), {
    dialect: 'sqlite',
    status: 'compatible',
    currentVersion: 12,
    targetVersion: 12,
    minimumSupportedVersion: 1,
  });
  const repaired = database
    .prepare(
      `SELECT version, checksum, applied_at
         FROM _libre_schema_migrations
        ORDER BY version`
    )
    .all();
  assert.equal(repaired.length, 12);
  assert.equal(repaired[1].checksum, migrationChecksum(2));
  assert.equal(repaired[1].applied_at, appliedAt);
  assert.equal(
    migrations
      .inspectSQLiteSchema(database)
      .appliedMigrations.find(row => row.version === 2).checksumMatches,
    true
  );
  assert.ok(
    migrations.SQLITE_MIGRATION_CONTRACT.every(
      migration => migration.checksum !== 'VECTOR_CHECKSUM_TO_FREEZE'
    )
  );
});

test('historical vector checksum repairs under coherent later ledger rows', t => {
  const dataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'libre-schema-vector-checksum-current-')
  );
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const databasePath = initializeApplicationDatabase(dataDir);
  const database = new Database(databasePath);
  t.after(() => database.close());
  markHistoricalVectorChecksum(database);
  const beforeRows = database
    .prepare(
      `SELECT version, name, checksum, applied_at
         FROM _libre_schema_migrations
        ORDER BY version`
    )
    .all();
  const beforeBytes = fs.readFileSync(databasePath);

  assert.deepEqual(migrations.preflightSQLiteMigrationLedger(database), {
    dialect: 'sqlite',
    status: 'migrating',
    currentVersion: 12,
    targetVersion: 12,
    minimumSupportedVersion: 1,
  });
  assert.deepEqual(fs.readFileSync(databasePath), beforeBytes);
  migrations.runSQLiteMigrationCoordinator(database);

  const afterRows = database
    .prepare(
      `SELECT version, name, checksum, applied_at
         FROM _libre_schema_migrations
        ORDER BY version`
    )
    .all();
  assert.deepEqual(
    afterRows,
    beforeRows.map(row =>
      row.version === 2 ? { ...row, checksum: migrationChecksum(2) } : row
    )
  );
});

test('historical vector checksum does not excuse schema or later-ledger tampering', t => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'libre-schema-vector-checksum-reject-')
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cases = [
    {
      name: 'altered-vector-schema',
      mutate(database) {
        database.exec(`
          DROP INDEX idx_platform_vectors_scope;
          CREATE INDEX idx_platform_vectors_scope
            ON platform_vector_entries(namespace, owner_user_id);
        `);
      },
    },
    {
      name: 'extra-vector-index',
      mutate(database) {
        database.exec(`
          CREATE INDEX unexpected_vector_index
            ON platform_vector_entries(id);
        `);
      },
    },
    {
      name: 'altered-vector-check-literal',
      mutate(database) {
        database.exec(`
          DROP TABLE platform_vector_acl;
          CREATE TABLE platform_vector_acl (
            namespace TEXT NOT NULL,
            owner_user_id TEXT NOT NULL,
            vector_id TEXT NOT NULL,
            principal_type TEXT NOT NULL CHECK(
              principal_type IN ('USER', 'group')
            ),
            principal_id TEXT NOT NULL,
            PRIMARY KEY (
              namespace,
              owner_user_id,
              vector_id,
              principal_type,
              principal_id
            ),
            FOREIGN KEY (namespace, owner_user_id, vector_id)
              REFERENCES platform_vector_entries(namespace, owner_user_id, id)
              ON DELETE CASCADE
          );
          CREATE INDEX idx_platform_vector_acl_principal
            ON platform_vector_acl(
              principal_type,
              principal_id,
              namespace,
              owner_user_id,
              vector_id
            );
        `);
      },
    },
    {
      name: 'tampered-later-checksum',
      mutate(database) {
        database
          .prepare(
            "UPDATE _libre_schema_migrations SET checksum = 'tampered' WHERE version = 3"
          )
          .run();
      },
    },
    {
      name: 'arbitrary-vector-checksum',
      mutate(database) {
        database
          .prepare(
            "UPDATE _libre_schema_migrations SET checksum = 'not-the-historical-marker' WHERE version = 2"
          )
          .run();
      },
    },
  ];

  for (const fixture of cases) {
    const dataDir = path.join(root, fixture.name);
    const databasePath = initializeApplicationDatabase(dataDir);
    const database = new Database(databasePath);
    markHistoricalVectorChecksum(database);
    fixture.mutate(database);
    const beforeLedger = database
      .prepare(
        `SELECT version, name, checksum, applied_at
           FROM _libre_schema_migrations
          ORDER BY version`
      )
      .all();
    const beforeSchema = database
      .prepare(
        `SELECT type, name, tbl_name, sql
           FROM sqlite_master
          ORDER BY type, name`
      )
      .all();
    database.close();
    const beforeBytes = fs.readFileSync(databasePath);

    const reopened = new Database(databasePath);
    try {
      assert.throws(
        () => migrations.preflightSQLiteMigrationLedger(reopened),
        /checksum|canonical/i,
        fixture.name
      );
      assert.throws(
        () => migrations.runSQLiteMigrationCoordinator(reopened),
        /checksum|canonical/i,
        fixture.name
      );
      assert.deepEqual(
        reopened
          .prepare(
            `SELECT version, name, checksum, applied_at
               FROM _libre_schema_migrations
              ORDER BY version`
          )
          .all(),
        beforeLedger
      );
      assert.deepEqual(
        reopened
          .prepare(
            `SELECT type, name, tbl_name, sql
               FROM sqlite_master
              ORDER BY type, name`
          )
          .all(),
        beforeSchema
      );
      assert.deepEqual(fs.readFileSync(databasePath), beforeBytes);
      assert.equal(
        reopened
          .prepare(
            'SELECT checksum FROM _libre_schema_migrations WHERE version = 2'
          )
          .get().checksum,
        beforeLedger.find(row => row.version === 2).checksum
      );
    } finally {
      reopened.close();
    }
  }
});

test('failed vector migration does not record v2 as applied', t => {
  const dataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'libre-schema-vector-failure-')
  );
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const database = new Database(initializeApplicationDatabase(dataDir));
  t.after(() => database.close());

  removeDurableJobsMigration(database);
  database.exec(`
    DROP TABLE platform_vector_attributes;
    DROP TABLE platform_vector_acl;
    DROP TABLE platform_vector_entries;
    DELETE FROM _libre_schema_migrations WHERE version = 2;
    CREATE TABLE platform_vector_entries (
      namespace TEXT NOT NULL,
      id TEXT NOT NULL,
      owner_user_id TEXT NOT NULL
    );
  `);

  assert.throws(
    () => migrations.runSQLiteMigrationCoordinator(database),
    /no such column|vector schema is incomplete/i
  );
  assert.equal(
    database
      .prepare(
        'SELECT COUNT(*) AS count FROM _libre_schema_migrations WHERE version = 2'
      )
      .get().count,
    0
  );
  assert.equal(
    database
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'platform_vector_acl'"
      )
      .get(),
    undefined,
    'v2 DDL must roll back together when validation fails'
  );
});

test('schema inspection rejects missing critical and platform invariants', t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'libre-schema-shape-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const database = new Database(initializeApplicationDatabase(dataDir));
  t.after(() => database.close());

  database.exec('DROP INDEX idx_platform_vectors_scope');
  let inspection = migrations.inspectSQLiteSchema(database);
  assert.equal(inspection.status, 'incompatible');
  assert.ok(
    inspection.missing.includes(
      'index idx_platform_vectors_scope (namespace, model, dimensions, embedding_version, owner_user_id)'
    )
  );

  database.exec(`
    CREATE INDEX idx_platform_vectors_scope
      ON platform_vector_entries(
        namespace, model, dimensions, embedding_version, owner_user_id
      );
    DROP INDEX idx_work_runs_one_active;
    CREATE INDEX idx_work_runs_one_active ON work_runs(task_id);
  `);
  inspection = migrations.inspectSQLiteSchema(database);
  assert.ok(
    inspection.missing.includes('index idx_work_runs_one_active (task_id)')
  );
});

test('schema inspection and startup preflight reject the same malformed ledger', t => {
  const dataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'libre-schema-ledger-shape-')
  );
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const database = new Database(initializeApplicationDatabase(dataDir));
  t.after(() => database.close());
  const applied = database
    .prepare(
      `SELECT version, name, checksum
       FROM _libre_schema_migrations
       ORDER BY version`
    )
    .all();
  database.exec(`
    DROP TABLE _libre_schema_migrations;
    CREATE TABLE _libre_schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      checksum TEXT NOT NULL
    );
  `);
  const insert = database.prepare(
    `INSERT INTO _libre_schema_migrations (version, name, checksum)
     VALUES (?, ?, ?)`
  );
  for (const row of applied) insert.run(row.version, row.name, row.checksum);

  const inspection = migrations.inspectSQLiteSchema(database);
  assert.equal(inspection.compatible, false);
  assert.equal(inspection.status, 'incompatible');
  assert.ok(inspection.missing.includes('_libre_schema_migrations.applied_at'));
  assert.match(inspection.reason, /migration ledger is incompatible/i);
  assert.throws(
    () => migrations.preflightSQLiteMigrationLedger(database),
    /migration ledger is incompatible.*applied_at/i
  );
});

for (const ledgerCase of ['tampered', 'future', 'incompatible']) {
  const article = ledgerCase === 'incompatible' ? 'an' : 'a';
  test(`startup preflight rejects ${article} ${ledgerCase} ledger without mutation`, t => {
    const dataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), `libre-schema-${ledgerCase}-`)
    );
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const databasePath = initializeApplicationDatabase(dataDir);
    const database = new Database(databasePath);
    database.exec(`
      DROP INDEX idx_sessions_user_id;
      CREATE TABLE preflight_sentinel (
        id TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      INSERT INTO preflight_sentinel (id, value)
        VALUES ('sentinel', 'must remain unchanged');
    `);
    if (ledgerCase === 'tampered') {
      database
        .prepare(
          "UPDATE _libre_schema_migrations SET checksum = 'tampered' WHERE version = 1"
        )
        .run();
    } else if (ledgerCase === 'future') {
      database
        .prepare(
          `INSERT INTO _libre_schema_migrations
             (version, name, checksum, applied_at)
           VALUES (999, 'future-migration', 'future-checksum', 1)`
        )
        .run();
    }
    const before = schemaSnapshot(database);
    database.close();
    const beforeBytes = fs.readFileSync(databasePath);

    const child = startApplicationDatabase(dataDir);
    assert.notEqual(child.status, 0);
    assert.match(
      `${child.stderr}\n${child.stdout}`,
      ledgerCase === 'tampered'
        ? /checksum mismatch/
        : ledgerCase === 'future'
          ? /newer than supported/
          : /schema is incompatible.*idx_sessions_user_id/is
    );

    const afterFailure = new Database(databasePath);
    try {
      assert.deepEqual(schemaSnapshot(afterFailure), before);
      assert.deepEqual(
        fs.readFileSync(databasePath),
        beforeBytes,
        'read-only preflight must not alter the SQLite file'
      );
      assert.equal(
        afterFailure
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_sessions_user_id'"
          )
          .get(),
        undefined,
        'legacy initialization must not recreate an index before preflight'
      );
    } finally {
      afterFailure.close();
    }
  });
}

test('failed ledgerless adoption rolls back inline schema and Work data migrations', t => {
  const dataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'libre-schema-ledgerless-rollback-')
  );
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const databasePath = initializeApplicationDatabase(dataDir);
  const database = new Database(databasePath);
  database.pragma('foreign_keys = OFF');
  database.exec(`
    INSERT INTO work_tasks (
      id, user_id, title, model, provider_type, provider_id,
      status, network_enabled, volume_name, container_name,
      preview_status, created_at, updated_at
    ) VALUES (
      'legacy-work-routing', 'default', 'Legacy Work routing', 'model',
      'invalid-provider', 'must-survive', 'idle', 0,
      'legacy-work-volume', 'legacy-work-container', 'stopped', 1, 1
    );

    CREATE TABLE preflight_sentinel (
      id TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    INSERT INTO preflight_sentinel (id, value)
      VALUES ('sentinel', 'ledgerless state must remain unchanged');

    DROP TABLE _libre_schema_migrations;

    CREATE TABLE sessions_without_foreign_keys (
      id TEXT PRIMARY KEY,
      user_id TEXT DEFAULT 'default',
      title TEXT NOT NULL,
      model TEXT NOT NULL,
      persona_id TEXT,
      provider_type TEXT,
      provider_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      archived INTEGER DEFAULT 0,
      settings TEXT,
      folder_id TEXT,
      pinned INTEGER DEFAULT 0
    );
    INSERT INTO sessions_without_foreign_keys
      SELECT * FROM sessions;
    DROP TABLE sessions;
    ALTER TABLE sessions_without_foreign_keys RENAME TO sessions;
  `);
  const before = schemaSnapshot(database);
  const inspection = migrations.inspectSQLiteSchema(database);
  assert.equal(inspection.status, 'incompatible');
  assert.match(inspection.reason, /ledgerless schema is incompatible/i);
  assert.deepEqual(before.workRouting, [
    {
      id: 'legacy-work-routing',
      provider_type: 'invalid-provider',
      provider_id: 'must-survive',
      network_enabled: 0,
    },
  ]);
  database.close();
  const beforeBytes = fs.readFileSync(databasePath);

  const child = startApplicationDatabase(dataDir);
  assert.notEqual(child.status, 0);
  assert.match(
    `${child.stderr}\n${child.stdout}`,
    /sessions foreign key \(user_id\).*users \(id\)/is
  );

  const afterFailure = new Database(databasePath);
  try {
    assert.deepEqual(
      schemaSnapshot(afterFailure),
      before,
      'schema and Work routing/network values must roll back together'
    );
    assert.deepEqual(
      fs.readFileSync(databasePath),
      beforeBytes,
      'failed ledgerless initialization must leave database bytes unchanged'
    );
    assert.equal(
      afterFailure
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '_libre_schema_migrations'"
        )
        .get(),
      undefined
    );
  } finally {
    afterFailure.close();
  }
});
