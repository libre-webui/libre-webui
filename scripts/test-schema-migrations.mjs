import assert from 'node:assert/strict';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
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

// This fixture was created by the unmodified SQLite initializer from
// origin/main at 24eb9ec814b0729ddc321fd758746bb798599e42 (v0.21.3), using
// that release's exact better-sqlite3 13.0.2 / SQLite 3.53.4 and tsx 4.23.1
// dependencies.
// It is ledgerless and contains 25 inert rows spanning all 24 legacy tables.
const releasedMainSQLiteFixture = Object.freeze({
  path: path.join(
    repoRoot,
    'scripts',
    'fixtures',
    'sqlite',
    'libre-webui-v0.21.3-main.sqlite.gz'
  ),
  gzipSha256:
    '3ad476251490df7e21e12bab73231e0dc52d0241aadd5da7d9e4a7458f9a1999',
  databaseSha256:
    'f06c4f1c6ae5e5b28683dc2a5461207d3218adfc4b0fc90db1ad3b1d0d0165ac',
});

const releasedMainSQLiteTables = Object.freeze([
  'document_chunks',
  'documents',
  'generated_images',
  'knowledge_collections',
  'media_generation_jobs',
  'notes',
  'personas',
  'plugin_activations',
  'plugin_credentials',
  'plugin_definition_approvals',
  'plugin_discovered_capability_models',
  'plugin_discovered_models',
  'plugin_usage_events',
  'plugin_variables',
  'session_folders',
  'session_messages',
  'sessions',
  'system_settings',
  'user_preferences',
  'users',
  'work_messages',
  'work_policies',
  'work_runs',
  'work_tasks',
]);

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

const startPreflightedApplicationDatabase = (dataDir, scratchDir) => {
  const databasePath = path.join(dataDir, 'data.sqlite');
  return spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `const database = await import(${JSON.stringify(
        databaseModuleUrl
      )}); database.preflightExistingSQLiteDatabase(${JSON.stringify(
        databasePath
      )}, ${JSON.stringify(
        scratchDir
      )}); try { database.getDatabase(); } finally { database.closeDatabase(); }`,
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        DATA_DIR: dataDir,
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
      },
      encoding: 'utf8',
      timeout: 10_000,
    }
  );
};

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
    DELETE FROM _libre_schema_migrations WHERE version = 22;
    ALTER TABLE automations DROP COLUMN target;
    ALTER TABLE automations DROP COLUMN work_policy_id;
    ALTER TABLE automation_runs DROP COLUMN work_task_id;
    DELETE FROM _libre_schema_migrations WHERE version = 21;
    DROP TABLE recovery_drills;
    DROP TABLE push_subscriptions;
    DROP TABLE webauthn_credentials;
    DROP TABLE mfa_recovery_codes;
    DROP TABLE user_mfa;
    DELETE FROM _libre_schema_migrations WHERE version = 20;
    DROP TABLE eval_runs;
    DROP TABLE eval_sets;
    DROP TABLE arena_votes;
    DROP TABLE message_feedback;
    DROP TABLE usage_budgets;
    DROP TABLE model_tariffs;
    ALTER TABLE voice_profiles DROP COLUMN consent_expires_at;
    ALTER TABLE voice_profiles DROP COLUMN revoked_at;
    ALTER TABLE voice_profiles DROP COLUMN transfer_count;
    ALTER TABLE voice_profiles DROP COLUMN last_transfer_at;
    DELETE FROM _libre_schema_migrations WHERE version = 19;
    DROP TABLE webhook_targets;
    DROP TABLE notifications;
    DROP TABLE channel_attachments;
    DROP TABLE channel_reactions;
    DROP TABLE channel_messages;
    DROP TABLE channel_members;
    DROP TABLE channels;
    DROP TABLE calendars;
    DROP INDEX IF EXISTS idx_calendar_scoped_events;
    ALTER TABLE calendar_events DROP COLUMN calendar_id;
    ALTER TABLE calendar_events DROP COLUMN reminder_minutes;
    ALTER TABLE calendar_events DROP COLUMN last_reminded_occurrence;
    DELETE FROM _libre_schema_migrations WHERE version = 18;
    DROP TABLE note_attachments;
    DROP TABLE note_revisions;
    ALTER TABLE notes DROP COLUMN pinned;
    DELETE FROM _libre_schema_migrations WHERE version = 17;
    DROP TABLE skill_files;
    DELETE FROM _libre_schema_migrations WHERE version = 16;
    DROP TABLE skill_versions;
    DROP TABLE skills;
    DROP TABLE prompt_versions;
    DROP TABLE prompts;
    DROP TABLE tool_approvals;
    DROP TABLE tool_server_credentials;
    DROP TABLE tool_server_tools;
    DROP TABLE tool_servers;
    ALTER TABLE personas DROP COLUMN bindings;
    DELETE FROM _libre_schema_migrations WHERE version = 15;
    DROP TABLE automation_runs;
    DROP TABLE automations;
    DROP TABLE calendar_events;
    DELETE FROM _libre_schema_migrations WHERE version = 14;
    DROP TABLE security_audit_events;
    DROP TABLE oauth_identities;
    DROP TABLE api_tokens;
    DROP TABLE auth_sessions;
    DROP TABLE resource_grants;
    DROP TABLE user_group_members;
    DROP TABLE user_groups;
    DELETE FROM _libre_schema_migrations WHERE version = 13;
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

const markHistoricalDurableEventReplayIndexChecksum = database => {
  database
    .prepare(
      `UPDATE _libre_schema_migrations
          SET checksum = 'DURABLE_EVENT_REPLAY_INDEX_CHECKSUM_TO_FREEZE'
        WHERE version = 13 AND name = 'durable-event-replay-index'`
    )
    .run();
};

const downgradeToMigrationV8 = database => {
  const foreignKeysEnabled = database.pragma('foreign_keys', { simple: true });
  database.pragma('foreign_keys = OFF');
  try {
    database.transaction(() => {
      database.exec(`
        DROP TABLE automation_runs;
        DROP TABLE automations;
        DROP TABLE calendar_events;
        DROP TABLE security_audit_events;
        DROP TABLE oauth_identities;
        DROP TABLE api_tokens;
        DROP TABLE auth_sessions;
        DROP TABLE resource_grants;
        DROP TABLE user_group_members;
        DROP TABLE user_groups;
        DROP INDEX idx_platform_events_stream_subject_cursor;
        DROP INDEX idx_platform_resource_tombstones_owner;
        DROP TABLE platform_resource_deletion_tombstones;
        ALTER TABLE work_tasks DROP COLUMN preview_upstream_port;
        ALTER TABLE work_tasks DROP COLUMN preview_upstream_host;
        ALTER TABLE platform_events DROP COLUMN request_fingerprint;
        DELETE FROM _libre_schema_migrations WHERE version > 8;

        DROP INDEX idx_users_email_lookup;
        CREATE TABLE users__v8 (
          id TEXT PRIMARY KEY,
          username TEXT UNIQUE NOT NULL,
          email TEXT UNIQUE,
          password_hash TEXT NOT NULL,
          role TEXT DEFAULT 'user',
          account_status TEXT NOT NULL DEFAULT 'active'
            CHECK(account_status IN ('pending', 'active')),
          approved_at INTEGER,
          approved_by TEXT,
          avatar TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          email_lookup TEXT
        );
        INSERT INTO users__v8 (
          id, username, email, password_hash, role, account_status,
          approved_at, approved_by, avatar, created_at, updated_at,
          email_lookup
        )
        SELECT id, username, email, password_hash, role, account_status,
               approved_at, approved_by, avatar, created_at, updated_at,
               email_lookup
          FROM users;
        DROP TABLE users;
        ALTER TABLE users__v8 RENAME TO users;
        CREATE UNIQUE INDEX idx_users_email_lookup
          ON users(email_lookup)
          WHERE email_lookup IS NOT NULL;
      `);
    })();
    assert.deepEqual(database.pragma('foreign_key_check'), []);
  } finally {
    database.pragma(
      `foreign_keys = ${foreignKeysEnabled === 1 ? 'ON' : 'OFF'}`
    );
  }
};

const snapshotTables = (database, tables) =>
  Object.fromEntries(
    tables.map(table => {
      const columns = database
        .prepare(`PRAGMA table_info("${table}")`)
        .all()
        .map(column => column.name);
      const projection = columns
        .map(column => `"${column.replaceAll('"', '""')}"`)
        .join(', ');
      return [
        table,
        {
          columns,
          rows: database
            .prepare(`SELECT ${projection} FROM "${table}" ORDER BY 1`)
            .all(),
        },
      ];
    })
  );

const snapshotForeignKeys = (database, tables) =>
  Object.fromEntries(
    tables.map(table => [
      table,
      database
        .prepare(`PRAGMA foreign_key_list("${table.replaceAll('"', '""')}")`)
        .all()
        .map(row => ({
          id: row.id,
          seq: row.seq,
          table: row.table,
          from: row.from,
          to: row.to,
          on_update: row.on_update,
          on_delete: row.on_delete,
          match: row.match,
        })),
    ])
  );

const assertTableSnapshots = (database, expected) => {
  for (const [table, snapshot] of Object.entries(expected)) {
    const projection = snapshot.columns
      .map(column => `"${column.replaceAll('"', '""')}"`)
      .join(', ');
    assert.deepEqual(
      database.prepare(`SELECT ${projection} FROM "${table}" ORDER BY 1`).all(),
      snapshot.rows,
      `${table} rows must survive the SQLite migration`
    );
  }
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

test('released v0.21.3 main SQLite state upgrades through startup', t => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'libre-main-sqlite-upgrade-')
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'data');
  const scratchDir = path.join(root, 'preflight');
  const databasePath = path.join(dataDir, 'data.sqlite');
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });

  const compressedFixture = fs.readFileSync(releasedMainSQLiteFixture.path);
  assert.equal(
    createHash('sha256').update(compressedFixture).digest('hex'),
    releasedMainSQLiteFixture.gzipSha256,
    'the released-main fixture gzip must retain its reviewed provenance'
  );
  const fixtureBytes = gunzipSync(compressedFixture);
  assert.equal(
    createHash('sha256').update(fixtureBytes).digest('hex'),
    releasedMainSQLiteFixture.databaseSha256,
    'the released-main SQLite database must retain its reviewed provenance'
  );
  fs.writeFileSync(databasePath, fixtureBytes, {
    flag: 'wx',
    mode: 0o600,
  });

  const filesBeforePreflight = fs.readdirSync(dataDir).sort();
  databaseHelpers.preflightExistingSQLiteDatabase(databasePath, scratchDir);
  assertFileUnchanged(
    databasePath,
    fixtureBytes,
    'startup preflight must not alter the released-main database'
  );
  assert.deepEqual(fs.readdirSync(dataDir).sort(), filesBeforePreflight);
  assert.deepEqual(fs.readdirSync(scratchDir), []);

  let legacySnapshot;
  let legacyForeignKeys;
  const released = new Database(databasePath, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    assert.equal(released.pragma('quick_check', { simple: true }), 'ok');
    assert.deepEqual(released.pragma('foreign_key_check'), []);
    assert.equal(
      released
        .prepare(
          `SELECT 1
             FROM sqlite_master
            WHERE type = 'table' AND name = '_libre_schema_migrations'`
        )
        .get(),
      undefined,
      'v0.21.3 main must remain a real ledgerless upgrade boundary'
    );
    const tables = released
      .prepare(
        `SELECT name
           FROM sqlite_master
          WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
          ORDER BY name`
      )
      .all()
      .map(row => row.name);
    assert.deepEqual(tables, releasedMainSQLiteTables);
    const rowCount = tables.reduce(
      (count, table) =>
        count +
        released
          .prepare(
            `SELECT COUNT(*) AS count
               FROM "${table.replaceAll('"', '""')}"`
          )
          .get().count,
      0
    );
    assert.equal(rowCount, 25);
    assert.ok(
      tables.every(
        table =>
          released
            .prepare(
              `SELECT COUNT(*) AS count
                 FROM "${table.replaceAll('"', '""')}"`
            )
            .get().count > 0
      ),
      'every released-main table must carry representative state'
    );
    legacySnapshot = snapshotTables(released, tables);
    legacyForeignKeys = snapshotForeignKeys(released, tables);
  } finally {
    released.close();
  }

  const firstStartup = startPreflightedApplicationDatabase(dataDir, scratchDir);
  assert.equal(
    firstStartup.status,
    0,
    `${firstStartup.stderr}\n${firstStartup.stdout}`
  );

  let firstLedger;
  const upgraded = new Database(databasePath, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    assert.equal(upgraded.pragma('quick_check', { simple: true }), 'ok');
    assert.deepEqual(upgraded.pragma('foreign_key_check'), []);
    assertTableSnapshots(upgraded, legacySnapshot);
    assert.deepEqual(
      snapshotForeignKeys(upgraded, releasedMainSQLiteTables),
      legacyForeignKeys,
      'the account-retirement table rebuild must preserve every legacy foreign key'
    );

    firstLedger = upgraded
      .prepare(
        `SELECT version, name, checksum, applied_at
           FROM _libre_schema_migrations
          ORDER BY version`
      )
      .all();
    assert.deepEqual(
      firstLedger.map(row => ({
        version: row.version,
        name: row.name,
        checksum: row.checksum,
      })),
      migrations.SQLITE_MIGRATION_CONTRACT
    );
    assert.deepEqual(
      firstLedger.map(row => row.version),
      Array.from({ length: 22 }, (_, index) => index + 1),
      'the adopted ledger must be canonical, contiguous, and complete'
    );
    assert.ok(
      firstLedger.every(
        row => Number.isSafeInteger(row.applied_at) && row.applied_at > 0
      )
    );
    assert.deepEqual(migrations.preflightSQLiteMigrationLedger(upgraded), {
      dialect: 'sqlite',
      status: 'compatible',
      currentVersion: 22,
      targetVersion: 22,
      minimumSupportedVersion: 1,
    });
  } finally {
    upgraded.close();
  }

  const secondStartup = startPreflightedApplicationDatabase(
    dataDir,
    scratchDir
  );
  assert.equal(
    secondStartup.status,
    0,
    `${secondStartup.stderr}\n${secondStartup.stdout}`
  );

  const reopened = new Database(databasePath, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    assert.equal(reopened.pragma('quick_check', { simple: true }), 'ok');
    assert.deepEqual(reopened.pragma('foreign_key_check'), []);
    assertTableSnapshots(reopened, legacySnapshot);
    assert.deepEqual(
      snapshotForeignKeys(reopened, releasedMainSQLiteTables),
      legacyForeignKeys
    );
    assert.deepEqual(
      reopened
        .prepare(
          `SELECT version, name, checksum, applied_at
             FROM _libre_schema_migrations
            ORDER BY version`
        )
        .all(),
      firstLedger,
      'a second startup must not rewrite the canonical migration ledger'
    );
    assert.deepEqual(migrations.preflightSQLiteMigrationLedger(reopened), {
      dialect: 'sqlite',
      status: 'compatible',
      currentVersion: 22,
      targetVersion: 22,
      minimumSupportedVersion: 1,
    });
  } finally {
    reopened.close();
  }
  assert.deepEqual(fs.readdirSync(scratchDir), []);
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
  assert.equal(
    createHash('sha256')
      .update('013-durable-event-replay-index\n')
      .update(migrations.DURABLE_EVENT_REPLAY_INDEX_SCHEMA_SQL)
      .digest('hex'),
    '7d6b769ceadd08791c77ac5c5a1d7bd61a63d87cac87da56ae847c4067cacdad',
    'released migration v13 DDL and checksum must stay immutable'
  );
  assert.equal(
    createHash('sha256')
      .update('014-trust-foundation\n')
      .update(migrations.TRUST_FOUNDATION_SCHEMA_SQL)
      .digest('hex'),
    '53a5d8ada7e80ec584494cda2c1c4ba2755afa5be2f4644f39823f5ef2a3bca6',
    'released migration v14 DDL must stay immutable'
  );
  assert.equal(
    createHash('sha256')
      .update('015-personal-automations\n')
      .update(migrations.PERSONAL_AUTOMATIONS_SCHEMA_SQL)
      .digest('hex'),
    '5bfb4a1789480a3cacc09c5a4359a4e77b82b0edafa80f6d78cde73e57ddc70b',
    'released migration v15 DDL and checksum must stay immutable'
  );
  assert.equal(
    createHash('sha256')
      .update('016-agent-foundation\n')
      .update(migrations.AGENT_FOUNDATION_SCHEMA_SQL)
      .digest('hex'),
    '7e3a346fae66c073aac800aa45847999a4300b2f17eb3eaf9ed6351e891e2941',
    'released migration v16 DDL and checksum must stay immutable'
  );
  assert.equal(
    createHash('sha256')
      .update('017-skill-files\n')
      .update(migrations.SKILL_FILES_SCHEMA_SQL)
      .digest('hex'),
    '584e1f9bca79eb5974f997088636d74d7f2c1e5fd816fcd0f6cf74ec30aea161',
    'released migration v17 DDL and checksum must stay immutable'
  );
  assert.equal(
    createHash('sha256')
      .update('018-notes-v2\n')
      .update(migrations.NOTES_V2_SCHEMA_SQL)
      .digest('hex'),
    '05a6758ab2b2a54f9097a5d5604a2bd57e085f1dd16816b5dc96d1eb7a41a399',
    'released migration v18 DDL and checksum must stay immutable'
  );

  assert.equal(migrations.getSchemaCompatibilityState().targetVersion, 22);
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
      {
        version: 13,
        name: 'durable-event-replay-index',
        checksum:
          '7d6b769ceadd08791c77ac5c5a1d7bd61a63d87cac87da56ae847c4067cacdad',
        checksumMatches: true,
      },
      {
        version: 14,
        name: 'trust-foundation',
        checksum:
          'c5a73245de3cd3e37db8877c8457c975d789f98c1c71ae1e4fc891ba09e8de5a',
        checksumMatches: true,
      },
      {
        version: 15,
        name: 'personal-automations',
        checksum:
          '5bfb4a1789480a3cacc09c5a4359a4e77b82b0edafa80f6d78cde73e57ddc70b',
        checksumMatches: true,
      },
      {
        version: 16,
        name: 'agent-foundation',
        checksum:
          '7e3a346fae66c073aac800aa45847999a4300b2f17eb3eaf9ed6351e891e2941',
        checksumMatches: true,
      },
      {
        version: 17,
        name: 'skill-files',
        checksum:
          '584e1f9bca79eb5974f997088636d74d7f2c1e5fd816fcd0f6cf74ec30aea161',
        checksumMatches: true,
      },
      {
        version: 18,
        name: 'notes-v2',
        checksum:
          '05a6758ab2b2a54f9097a5d5604a2bd57e085f1dd16816b5dc96d1eb7a41a399',
        checksumMatches: true,
      },
      {
        version: 19,
        name: 'team-collaboration',
        checksum:
          '1cf021c941cfd9207a82e794e58d7553ae24a35b3f8f8a84bb4a0e06d0d77443',
        checksumMatches: true,
      },
      {
        version: 20,
        name: 'media-enterprise-ops',
        checksum:
          'c6bc6d98518f7a279ad7109cfdfcd8a75fbf7e3e157c50bca98142b50ac0f38b',
        checksumMatches: true,
      },
      {
        version: 21,
        name: 'mfa-push-recovery',
        checksum:
          '9b2cdc08d2316877af091587113c749aed4b224d6ee12e72626b830da5447005',
        checksumMatches: true,
      },
      {
        version: 22,
        name: 'automation-work-target',
        checksum:
          'e5fb43e9bf42ab206dce74bfd867d5001754983c7a3cef30b811c4d4da54d1a9',
        checksumMatches: true,
      },
    ]
  );
  assert.deepEqual(
    database
      .prepare('PRAGMA index_info(idx_platform_events_stream_subject_cursor)')
      .all()
      .map(column => column.name),
    ['stream_id', 'subject_id', 'global_cursor']
  );

  database.exec('DROP TABLE _libre_schema_migrations');
  assert.deepEqual(migrations.runSQLiteMigrationCoordinator(database), {
    dialect: 'sqlite',
    status: 'compatible',
    currentVersion: 22,
    targetVersion: 22,
    minimumSupportedVersion: 1,
  });
  assert.equal(
    database
      .prepare('SELECT COUNT(*) AS count FROM _libre_schema_migrations')
      .get().count,
    22
  );

  migrations.runSQLiteMigrationCoordinator(database);
  assert.equal(
    database
      .prepare('SELECT COUNT(*) AS count FROM _libre_schema_migrations')
      .get().count,
    22
  );
});

test('v13 installs and inspects the subject-filtered event replay index', t => {
  const dataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'libre-schema-event-replay-index-')
  );
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const database = new Database(initializeApplicationDatabase(dataDir));
  t.after(() => database.close());

  database.exec(`
    DELETE FROM _libre_schema_migrations WHERE version = 22;
    ALTER TABLE automations DROP COLUMN target;
    ALTER TABLE automations DROP COLUMN work_policy_id;
    ALTER TABLE automation_runs DROP COLUMN work_task_id;
    DELETE FROM _libre_schema_migrations WHERE version = 21;
    DROP TABLE recovery_drills;
    DROP TABLE push_subscriptions;
    DROP TABLE webauthn_credentials;
    DROP TABLE mfa_recovery_codes;
    DROP TABLE user_mfa;
    DELETE FROM _libre_schema_migrations WHERE version = 20;
    DROP TABLE eval_runs;
    DROP TABLE eval_sets;
    DROP TABLE arena_votes;
    DROP TABLE message_feedback;
    DROP TABLE usage_budgets;
    DROP TABLE model_tariffs;
    ALTER TABLE voice_profiles DROP COLUMN consent_expires_at;
    ALTER TABLE voice_profiles DROP COLUMN revoked_at;
    ALTER TABLE voice_profiles DROP COLUMN transfer_count;
    ALTER TABLE voice_profiles DROP COLUMN last_transfer_at;
    DELETE FROM _libre_schema_migrations WHERE version = 19;
    DROP TABLE webhook_targets;
    DROP TABLE notifications;
    DROP TABLE channel_attachments;
    DROP TABLE channel_reactions;
    DROP TABLE channel_messages;
    DROP TABLE channel_members;
    DROP TABLE channels;
    DROP TABLE calendars;
    DROP INDEX IF EXISTS idx_calendar_scoped_events;
    ALTER TABLE calendar_events DROP COLUMN calendar_id;
    ALTER TABLE calendar_events DROP COLUMN reminder_minutes;
    ALTER TABLE calendar_events DROP COLUMN last_reminded_occurrence;
    DELETE FROM _libre_schema_migrations WHERE version = 18;
    DROP TABLE note_attachments;
    DROP TABLE note_revisions;
    ALTER TABLE notes DROP COLUMN pinned;
    DELETE FROM _libre_schema_migrations WHERE version = 17;
    DROP TABLE skill_files;
    DELETE FROM _libre_schema_migrations WHERE version = 16;
    DROP TABLE skill_versions;
    DROP TABLE skills;
    DROP TABLE prompt_versions;
    DROP TABLE prompts;
    DROP TABLE tool_approvals;
    DROP TABLE tool_server_credentials;
    DROP TABLE tool_server_tools;
    DROP TABLE tool_servers;
    ALTER TABLE personas DROP COLUMN bindings;
    DELETE FROM _libre_schema_migrations WHERE version = 15;
    DROP TABLE automation_runs;
    DROP TABLE automations;
    DROP TABLE calendar_events;
    DELETE FROM _libre_schema_migrations WHERE version = 14;
    DROP TABLE security_audit_events;
    DROP TABLE oauth_identities;
    DROP TABLE api_tokens;
    DROP TABLE auth_sessions;
    DROP TABLE resource_grants;
    DROP TABLE user_group_members;
    DROP TABLE user_groups;
    DROP INDEX idx_platform_events_stream_subject_cursor;
    DELETE FROM _libre_schema_migrations WHERE version = 13;
  `);
  assert.deepEqual(migrations.preflightSQLiteMigrationLedger(database), {
    dialect: 'sqlite',
    status: 'migrating',
    currentVersion: 12,
    targetVersion: 22,
    minimumSupportedVersion: 1,
  });

  assert.equal(
    migrations.runSQLiteMigrationCoordinator(database).currentVersion,
    22
  );
  assert.deepEqual(
    database
      .prepare('PRAGMA index_info(idx_platform_events_stream_subject_cursor)')
      .all()
      .map(column => column.name),
    ['stream_id', 'subject_id', 'global_cursor']
  );

  database.exec('DROP INDEX idx_platform_events_stream_subject_cursor');
  const drifted = migrations.inspectSQLiteSchema(database);
  assert.equal(drifted.status, 'incompatible');
  assert.ok(
    drifted.missing.includes(
      'index idx_platform_events_stream_subject_cursor (stream_id, subject_id, global_cursor)'
    )
  );
});

test('v18 preflight permits the team collaboration migration', t => {
  const dataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'libre-schema-team-collaboration-')
  );
  const database = new Database(initializeApplicationDatabase(dataDir));
  t.after(() => {
    database.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  database.exec(`
    DELETE FROM _libre_schema_migrations WHERE version = 22;
    ALTER TABLE automations DROP COLUMN target;
    ALTER TABLE automations DROP COLUMN work_policy_id;
    ALTER TABLE automation_runs DROP COLUMN work_task_id;
    DELETE FROM _libre_schema_migrations WHERE version = 21;
    DROP TABLE recovery_drills;
    DROP TABLE push_subscriptions;
    DROP TABLE webauthn_credentials;
    DROP TABLE mfa_recovery_codes;
    DROP TABLE user_mfa;
    DELETE FROM _libre_schema_migrations WHERE version = 20;
    DROP TABLE eval_runs;
    DROP TABLE eval_sets;
    DROP TABLE arena_votes;
    DROP TABLE message_feedback;
    DROP TABLE usage_budgets;
    DROP TABLE model_tariffs;
    ALTER TABLE voice_profiles DROP COLUMN consent_expires_at;
    ALTER TABLE voice_profiles DROP COLUMN revoked_at;
    ALTER TABLE voice_profiles DROP COLUMN transfer_count;
    ALTER TABLE voice_profiles DROP COLUMN last_transfer_at;
    DELETE FROM _libre_schema_migrations WHERE version = 19;
    DROP TABLE webhook_targets;
    DROP TABLE notifications;
    DROP TABLE channel_attachments;
    DROP TABLE channel_reactions;
    DROP TABLE channel_messages;
    DROP TABLE channel_members;
    DROP TABLE channels;
    DROP TABLE calendars;
    DROP INDEX IF EXISTS idx_calendar_scoped_events;
    ALTER TABLE calendar_events DROP COLUMN calendar_id;
    ALTER TABLE calendar_events DROP COLUMN reminder_minutes;
    ALTER TABLE calendar_events DROP COLUMN last_reminded_occurrence;
  `);

  assert.deepEqual(migrations.preflightSQLiteMigrationLedger(database), {
    dialect: 'sqlite',
    status: 'migrating',
    currentVersion: 18,
    targetVersion: 22,
    minimumSupportedVersion: 1,
  });
  assert.equal(
    migrations.runSQLiteMigrationCoordinator(database).currentVersion,
    22
  );
  assert.deepEqual(
    database
      .prepare('PRAGMA index_info(idx_calendar_scoped_events)')
      .all()
      .map(column => column.name),
    ['calendar_id']
  );
});

test('historical v13 checksum is repaired only for the canonical replay index', t => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'libre-schema-event-replay-checksum-')
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const repairDir = path.join(root, 'repair');
  const databasePath = initializeApplicationDatabase(repairDir);
  const database = new Database(databasePath);
  markHistoricalDurableEventReplayIndexChecksum(database);
  const beforeRows = database
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
  const beforeBytes = fs.readFileSync(databasePath);

  const inspection = migrations.inspectSQLiteSchema(database);
  assert.equal(inspection.status, 'migrating');
  assert.equal(inspection.compatible, false);
  assert.equal(
    inspection.appliedMigrations.find(row => row.version === 13)
      .checksumMatches,
    false
  );
  assert.match(inspection.reason, /migration 13.*historical checksum/i);
  assert.deepEqual(migrations.preflightSQLiteMigrationLedger(database), {
    dialect: 'sqlite',
    status: 'migrating',
    currentVersion: 22,
    targetVersion: 22,
    minimumSupportedVersion: 1,
  });
  assert.deepEqual(
    fs.readFileSync(databasePath),
    beforeBytes,
    'read-only preflight must not repair the historical v13 checksum'
  );

  assert.deepEqual(migrations.runSQLiteMigrationCoordinator(database), {
    dialect: 'sqlite',
    status: 'compatible',
    currentVersion: 22,
    targetVersion: 22,
    minimumSupportedVersion: 1,
  });
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
      row.version === 13 ? { ...row, checksum: migrationChecksum(13) } : row
    )
  );
  assert.deepEqual(
    database
      .prepare(
        `SELECT type, name, tbl_name, sql
           FROM sqlite_master
          ORDER BY type, name`
      )
      .all(),
    beforeSchema
  );
  assert.ok(
    migrations.SQLITE_MIGRATION_CONTRACT.every(
      migration =>
        migration.checksum !== 'DURABLE_EVENT_REPLAY_INDEX_CHECKSUM_TO_FREEZE'
    )
  );
  database.close();

  const rejectionCases = [
    {
      name: 'partial-index',
      mutate(candidate) {
        candidate.exec(`
          DROP INDEX idx_platform_events_stream_subject_cursor;
          CREATE INDEX idx_platform_events_stream_subject_cursor
            ON platform_events(stream_id, subject_id, global_cursor)
            WHERE subject_id IS NOT NULL;
        `);
      },
    },
    {
      name: 'arbitrary-checksum',
      mutate(candidate) {
        candidate
          .prepare(
            "UPDATE _libre_schema_migrations SET checksum = 'not-the-historical-marker' WHERE version = 13"
          )
          .run();
      },
    },
  ];

  for (const fixture of rejectionCases) {
    const candidatePath = initializeApplicationDatabase(
      path.join(root, fixture.name)
    );
    const candidate = new Database(candidatePath);
    markHistoricalDurableEventReplayIndexChecksum(candidate);
    fixture.mutate(candidate);
    const ledgerBefore = candidate
      .prepare(
        `SELECT version, name, checksum, applied_at
           FROM _libre_schema_migrations
          ORDER BY version`
      )
      .all();
    const schemaBefore = candidate
      .prepare(
        `SELECT type, name, tbl_name, sql
           FROM sqlite_master
          ORDER BY type, name`
      )
      .all();
    assert.throws(
      () => migrations.preflightSQLiteMigrationLedger(candidate),
      /checksum|canonical/i,
      fixture.name
    );
    assert.throws(
      () => migrations.runSQLiteMigrationCoordinator(candidate),
      /checksum|canonical/i,
      fixture.name
    );
    assert.deepEqual(
      candidate
        .prepare(
          `SELECT version, name, checksum, applied_at
             FROM _libre_schema_migrations
            ORDER BY version`
        )
        .all(),
      ledgerBefore
    );
    assert.deepEqual(
      candidate
        .prepare(
          `SELECT type, name, tbl_name, sql
             FROM sqlite_master
            ORDER BY type, name`
        )
        .all(),
      schemaBefore
    );
    candidate.close();
  }
});

test('recognized v2 and v13 checksum repairs commit atomically', t => {
  const dataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'libre-schema-dual-checksum-repair-')
  );
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const database = new Database(initializeApplicationDatabase(dataDir));
  t.after(() => database.close());
  markHistoricalVectorChecksum(database);
  markHistoricalDurableEventReplayIndexChecksum(database);
  database.exec(`
    CREATE TRIGGER block_v13_checksum_repair
    BEFORE UPDATE OF checksum ON _libre_schema_migrations
    WHEN OLD.version = 13
    BEGIN
      SELECT RAISE(ABORT, 'v13 repair blocked');
    END;
  `);
  const beforeRows = database
    .prepare(
      `SELECT version, name, checksum, applied_at
         FROM _libre_schema_migrations
        ORDER BY version`
    )
    .all();

  assert.throws(
    () => migrations.runSQLiteMigrationCoordinator(database),
    /v13 repair blocked/
  );
  assert.deepEqual(
    database
      .prepare(
        `SELECT version, name, checksum, applied_at
           FROM _libre_schema_migrations
          ORDER BY version`
      )
      .all(),
    beforeRows,
    'failure repairing v13 must roll back the earlier v2 checksum update'
  );

  database.exec('DROP TRIGGER block_v13_checksum_repair');
  assert.deepEqual(migrations.runSQLiteMigrationCoordinator(database), {
    dialect: 'sqlite',
    status: 'compatible',
    currentVersion: 22,
    targetVersion: 22,
    minimumSupportedVersion: 1,
  });
  const repaired = database
    .prepare(
      `SELECT version, name, checksum, applied_at
         FROM _libre_schema_migrations
        ORDER BY version`
    )
    .all();
  assert.deepEqual(
    repaired,
    beforeRows.map(row =>
      row.version === 2 || row.version === 13
        ? { ...row, checksum: migrationChecksum(row.version) }
        : row
    )
  );
});

test('v8 startup preserves user-owned and durable state through v9-v14', t => {
  const dataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'libre-schema-v8-preservation-')
  );
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const databasePath = initializeApplicationDatabase(dataDir);
  const database = new Database(databasePath);
  database.pragma('foreign_keys = ON');
  downgradeToMigrationV8(database);
  assert.deepEqual(migrations.preflightSQLiteMigrationLedger(database), {
    dialect: 'sqlite',
    status: 'migrating',
    currentVersion: 8,
    targetVersion: 22,
    minimumSupportedVersion: 1,
  });

  database.exec(`
    INSERT INTO users (
      id, username, email, email_lookup, password_hash, role,
      account_status, approved_at, approved_by, avatar, created_at,
      updated_at
    ) VALUES (
      'v8-user', 'v8-user', 'v8@example.test', 'v8-email-lookup',
      'password', 'admin', 'active', 1, 'default', 'avatar', 1, 2
    );
    INSERT INTO personas (
      id, user_id, name, description, model, parameters, avatar,
      background, embedding_model, memory_settings, mutation_settings,
      created_at, updated_at
    ) VALUES (
      'v8-persona', 'v8-user', 'persona', 'description', 'model', '{}',
      'avatar', 'background', 'embedding-model', '{}', '{}', 1, 2
    );
    INSERT INTO session_folders (id, user_id, name, created_at, updated_at)
      VALUES ('v8-folder', 'v8-user', 'folder', 1, 2);
    INSERT INTO sessions (
      id, user_id, title, model, persona_id, provider_type, provider_id,
      created_at, updated_at, archived, settings, folder_id, pinned
    ) VALUES (
      'v8-session', 'v8-user', 'session', 'model', 'v8-persona',
      'ollama', NULL, 1, 2, 0, '{}', 'v8-folder', 1
    );
    INSERT INTO session_messages (
      id, session_id, role, content, thinking, timestamp, message_index,
      model, provider_metadata, images, statistics, artifacts, parent_id,
      branch_index, is_active, rating
    ) VALUES (
      'v8-message', 'v8-session', 'assistant', 'message', 'thinking', 1, 0,
      'model', '{}', '[]', '{}', '[]', NULL, 0, 1, 1
    );
    INSERT INTO knowledge_collections (
      id, user_id, name, created_at, updated_at
    ) VALUES ('v8-collection', 'v8-user', 'collection', 1, 2);
    INSERT INTO notes (id, user_id, title, content, created_at, updated_at)
      VALUES ('v8-note', 'v8-user', 'note', 'content', 1, 2);
    INSERT INTO documents (
      id, user_id, filename, title, content, file_type, size, session_id,
      collection_id, metadata, uploaded_at, created_at, updated_at
    ) VALUES (
      'v8-document', 'v8-user', 'document.txt', 'document', 'content',
      'text/plain', 7, 'v8-session', 'v8-collection', '{}', 1, 1, 2
    );
    INSERT INTO document_chunks (
      id, document_id, chunk_index, content, start_char, end_char,
      embedding, created_at
    ) VALUES ('v8-chunk', 'v8-document', 0, 'content', 0, 7, '[1]', 1);
    INSERT INTO user_preferences (
      id, user_id, key, value, created_at, updated_at
    ) VALUES ('v8-preference', 'v8-user', 'theme', '"dark"', 1, 2);
    INSERT INTO plugin_credentials (
      id, user_id, plugin_id, api_key, routing_auth_fingerprint,
      created_at, updated_at
    ) VALUES (
      'v8-credential', 'v8-user', 'plugin', 'ciphertext', 'route', 1, 2
    );
    INSERT INTO plugin_variables (
      id, user_id, plugin_id, variable_name, variable_value, is_encrypted,
      created_at, updated_at
    ) VALUES (
      'v8-variable', 'v8-user', 'plugin', 'variable', 'value', 1, 1, 2
    );
    INSERT INTO plugin_discovered_models (
      user_id, plugin_id, models_json, updated_at
    ) VALUES ('v8-user', 'plugin', '["model"]', 2);
    INSERT INTO plugin_discovered_capability_models (
      user_id, plugin_id, capability, models_json, updated_at
    ) VALUES ('v8-user', 'plugin', 'image', '["image-model"]', 2);
    INSERT INTO plugin_activations (user_id, plugin_id, activated_at)
      VALUES ('v8-user', 'plugin', 1);
    INSERT INTO plugin_definition_approvals (
      plugin_id, definition_fingerprint, source_path, approved_by_user_id,
      approved_at
    ) VALUES ('plugin', 'fingerprint', '/plugin.json', 'v8-user', 1);
    INSERT INTO plugin_usage_events (
      id, user_id, plugin_id, plugin_name, capability, model, status,
      prompt_tokens, completion_tokens, total_tokens, input_units,
      output_units, unit_kind, duration_ms, created_at
    ) VALUES (
      'v8-usage', 'v8-user', 'plugin', 'Plugin', 'chat', 'model', 'success',
      1, 2, 3, 4, 5, 'tokens', 6, 1
    );
    INSERT INTO voice_profiles (
      id, user_id, name, plugin_id, model, routing_fingerprint,
      reference_audio, reference_text, audio_mime_type, audio_format,
      audio_size, consent_confirmed_at, created_at, updated_at, name_lookup
    ) VALUES (
      'v8-voice', 'v8-user', X'01', 'plugin', 'model', 'route', X'02',
      X'03', 'audio/wav', 'wav', 1, 1, 1, 2, 'voice-lookup'
    );
    INSERT INTO generated_images (
      id, user_id, kind, prompt, model, plugin_id, image_data, mime_type,
      size, quality, metadata, created_at
    ) VALUES (
      'v8-media', 'v8-user', 'image', 'prompt', 'model', 'plugin', 'data',
      'image/png', 'small', 'high', '{}', 1
    );
    INSERT INTO media_generation_jobs (
      id, user_id, provider_job_id, plugin_id, model, prompt, status,
      options_json, gallery_id, error, created_at, updated_at
    ) VALUES (
      'v8-media-job', 'v8-user', 'provider-job', 'plugin', 'model', 'prompt',
      'completed', '{}', 'v8-media', NULL, 1, 2
    );
    INSERT INTO work_policies (
      id, name, image, memory_limit, cpu_limit, pids_limit, network_default,
      workspace_size, idle_timeout_ms, created_at, updated_at
    ) VALUES (
      'v8-policy', 'policy', 'image', '1g', '1', 10, 1, '1g', 1000, 1, 2
    );
    INSERT INTO work_tasks (
      id, user_id, title, model, provider_type, provider_id, status,
      network_enabled, volume_name, container_name, host_path, preview_url,
      preview_status, policy_id, created_at, updated_at
    ) VALUES (
      'v8-task', 'v8-user', 'task', 'model', 'ollama', NULL, 'completed', 1,
      'v8-volume', 'v8-container', NULL, NULL, 'stopped', 'v8-policy', 1, 2
    );
    INSERT INTO work_runs (
      id, task_id, model, provider_type, provider_id, status, error,
      created_at, started_at, finished_at
    ) VALUES (
      'v8-run', 'v8-task', 'model', 'ollama', NULL, 'completed', NULL,
      1, 1, 2
    );
    INSERT INTO work_messages (
      id, task_id, run_id, role, kind, content, metadata, message_index,
      created_at
    ) VALUES (
      'v8-work-message', 'v8-task', 'v8-run', 'assistant', 'text', 'content',
      '{}', 0, 1
    );
    INSERT INTO persona_memories (
      id, user_id, persona_id, content, embedding, timestamp, context,
      importance_score, memory_type, access_count, last_accessed,
      decay_factor, consolidated_from
    ) VALUES (
      'v8-memory', 'v8-user', 'v8-persona', 'memory', X'04', 1, 'context',
      0.5, 'general', 1, 2, 1.0, NULL
    );
    INSERT INTO persona_states (
      persona_id, user_id, runtime_state, mutation_log, last_updated, version
    ) VALUES ('v8-persona', 'v8-user', '{}', '[]', 2, 1);
    INSERT INTO platform_vector_entries (
      namespace, id, owner_user_id, resource_id, model, dimensions,
      embedding_version, source_revision, embedding, created_at, updated_at
    ) VALUES (
      'document-chunk', 'v8-vector', 'v8-user', 'v8-document', 'model', 1,
      '1', '1', X'05', 1, 2
    );
    INSERT INTO platform_vector_acl (
      namespace, owner_user_id, vector_id, principal_type, principal_id
    ) VALUES ('document-chunk', 'v8-user', 'v8-vector', 'user', 'v8-user');
    INSERT INTO platform_vector_attributes (
      namespace, owner_user_id, vector_id, attribute_key, attribute_value
    ) VALUES ('document-chunk', 'v8-user', 'v8-vector', 'key', 'value');
    INSERT INTO platform_blob_references (
      blob_id, owner_user_id, resource_type, resource_id, purpose, created_at
    ) VALUES (
      'v8-blob', 'v8-user', 'document', 'v8-document', 'document-source', 1
    );
    INSERT INTO platform_blob_quota_usage (
      owner_user_id, stored_bytes, reserved_bytes, updated_at
    ) VALUES ('v8-user', 7, 0, 2);
    INSERT INTO platform_blob_quota_reservations (
      id, owner_user_id, purpose, reserved_bytes, consumed_bytes,
      expires_at, created_at, updated_at
    ) VALUES ('v8-reservation', 'v8-user', 'document-source', 7, 0, 3, 1, 2);
    INSERT INTO platform_blob_quota_objects (
      blob_id, owner_user_id, purpose, stored_bytes, created_at
    ) VALUES ('v8-blob', 'v8-user', 'document-source', 7, 1);
    INSERT INTO platform_jobs (
      id, job_type, actor_user_id, state, payload_format, payload,
      idempotency_scope, idempotency_key_hash, request_fingerprint,
      priority, attempt_count, max_attempts, available_at, lease_owner,
      lease_token, lease_expires_at, cancellation_requested_at,
      cancellation_reason, progress_current, progress_total,
      progress_message, result_reference, error_code, error_summary,
      created_at, updated_at, started_at, finished_at
    ) VALUES (
      'v8-job', 'fixture.v1', 'v8-user', 'succeeded', 'encrypted', 'payload',
      'fixture', 'key-hash', '${'a'.repeat(64)}', 0, 1, 3, 1, NULL, 1, NULL,
      NULL, NULL, 100, 100, 'done', 'result', NULL, NULL, 1, 2, 1, 2
    );
    INSERT INTO platform_job_attempts (
      job_id, attempt_number, lease_token, worker_id, started_at,
      last_heartbeat_at, finished_at, outcome, error_code, error_summary
    ) VALUES ('v8-job', 1, 1, 'worker', 1, 2, 2, 'succeeded', NULL, NULL);
    INSERT INTO platform_event_stream_heads (stream_id, last_sequence)
      VALUES ('v8-stream', 1);
    INSERT INTO platform_events (
      event_id, stream_id, stream_sequence, event_type, subject_id,
      actor_user_id, payload_format, payload, occurred_at
    ) VALUES (
      'v8-event', 'v8-stream', 1, 'fixture.created.v1', 'v8-subject',
      'v8-user', 'encrypted', 'payload', 1
    );
  `);

  const preservedTables = [
    'users',
    'personas',
    'sessions',
    'session_messages',
    'session_folders',
    'knowledge_collections',
    'notes',
    'documents',
    'document_chunks',
    'user_preferences',
    'plugin_credentials',
    'plugin_variables',
    'plugin_discovered_models',
    'plugin_discovered_capability_models',
    'plugin_activations',
    'plugin_definition_approvals',
    'plugin_usage_events',
    'voice_profiles',
    'generated_images',
    'media_generation_jobs',
    'work_policies',
    'work_tasks',
    'work_runs',
    'work_messages',
    'persona_memories',
    'persona_states',
    'platform_vector_entries',
    'platform_vector_acl',
    'platform_vector_attributes',
    'platform_blob_references',
    'platform_blob_quota_usage',
    'platform_blob_quota_reservations',
    'platform_blob_quota_objects',
    'platform_jobs',
    'platform_job_attempts',
    'platform_event_stream_heads',
    'platform_events',
  ];
  const before = snapshotTables(database, preservedTables);
  assert.throws(
    () =>
      database.transaction(() => {
        migrations.runSQLiteMigrationCoordinator(database);
      })(),
    /requires foreign keys to be disabled before its transaction begins/i
  );
  assert.equal(database.pragma('foreign_keys', { simple: true }), 1);
  assert.equal(
    database
      .prepare('SELECT MAX(version) AS version FROM _libre_schema_migrations')
      .get().version,
    8
  );
  assertTableSnapshots(database, before);
  database.close();

  const child = startApplicationDatabase(dataDir);
  assert.equal(child.status, 0, `${child.stderr}\n${child.stdout}`);

  const migrated = new Database(databasePath, {
    readonly: true,
    fileMustExist: true,
  });
  t.after(() => migrated.close());
  assert.equal(migrated.pragma('quick_check', { simple: true }), 'ok');
  assert.deepEqual(migrated.pragma('foreign_key_check'), []);
  assertTableSnapshots(migrated, before);
  assert.deepEqual(migrations.preflightSQLiteMigrationLedger(migrated), {
    dialect: 'sqlite',
    status: 'compatible',
    currentVersion: 22,
    targetVersion: 22,
    minimumSupportedVersion: 1,
  });
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
  assert.match(before.reason, /requires migration to version 22/);
  assert.ok(before.missing.includes('platform_vector_entries (table)'));

  const migrated = migrations.runSQLiteMigrationCoordinator(database);
  assert.equal(migrated.currentVersion, 22);
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
    targetVersion: 22,
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
    currentVersion: 22,
    targetVersion: 22,
    minimumSupportedVersion: 1,
  });
  const repaired = database
    .prepare(
      `SELECT version, checksum, applied_at
         FROM _libre_schema_migrations
        ORDER BY version`
    )
    .all();
  assert.equal(repaired.length, 22);
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
    currentVersion: 22,
    targetVersion: 22,
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

test('preflight verification marker tracks schema generation and file identity', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'libre-marker-'));
  try {
    const databasePath = path.join(directory, 'data.sqlite');
    const database = new Database(databasePath);
    database.exec('CREATE TABLE alpha (id INTEGER PRIMARY KEY, value TEXT)');
    database.close();

    const first = databaseHelpers.readSQLitePreflightIdentity(databasePath);
    assert.ok(first);
    assert.ok(Number.isSafeInteger(first.schemaCookie));

    // No marker yet: nothing matches.
    assert.equal(
      databaseHelpers.preflightIdentityMatchesMarker(
        first,
        databaseHelpers.readPreflightVerificationMarker(directory)
      ),
      false
    );

    databaseHelpers.writePreflightVerificationMarker(directory, first);
    assert.equal(
      databaseHelpers.preflightIdentityMatchesMarker(
        databaseHelpers.readSQLitePreflightIdentity(databasePath),
        databaseHelpers.readPreflightVerificationMarker(directory)
      ),
      true
    );

    // Ordinary row writes keep the identity stable.
    const writer = new Database(databasePath);
    writer.prepare('INSERT INTO alpha (value) VALUES (?)').run('row');
    writer.close();
    assert.equal(
      databaseHelpers.preflightIdentityMatchesMarker(
        databaseHelpers.readSQLitePreflightIdentity(databasePath),
        databaseHelpers.readPreflightVerificationMarker(directory)
      ),
      true
    );

    // DDL (a migration) invalidates the marker.
    const migrator = new Database(databasePath);
    migrator.exec('CREATE TABLE beta (id INTEGER PRIMARY KEY)');
    migrator.close();
    assert.equal(
      databaseHelpers.preflightIdentityMatchesMarker(
        databaseHelpers.readSQLitePreflightIdentity(databasePath),
        databaseHelpers.readPreflightVerificationMarker(directory)
      ),
      false
    );

    // Replacing the file invalidates the marker even with identical schema.
    const settled = databaseHelpers.readSQLitePreflightIdentity(databasePath);
    databaseHelpers.writePreflightVerificationMarker(directory, settled);
    const copyPath = `${databasePath}.copy`;
    fs.copyFileSync(databasePath, copyPath);
    fs.rmSync(databasePath);
    fs.renameSync(copyPath, databasePath);
    assert.equal(
      databaseHelpers.preflightIdentityMatchesMarker(
        databaseHelpers.readSQLitePreflightIdentity(databasePath),
        databaseHelpers.readPreflightVerificationMarker(directory)
      ),
      false
    );

    // A corrupt marker reads as absent.
    fs.writeFileSync(
      path.join(directory, '.preflight-verification.json'),
      'not json'
    );
    assert.equal(
      databaseHelpers.readPreflightVerificationMarker(directory),
      null
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
