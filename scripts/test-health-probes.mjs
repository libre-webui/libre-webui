import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import Database from 'better-sqlite3';

const repoRoot = path.resolve(import.meta.dirname, '..');
const testSource = process.env.LIBRE_OPERATIONAL_TEST_SOURCE === '1';
const backendArtifact = relativePath =>
  pathToFileURL(
    path.join(
      repoRoot,
      'backend',
      testSource ? 'src' : 'dist',
      testSource ? relativePath.replace(/\.js$/, '.ts') : relativePath
    )
  ).href;
const healthModule = await import(backendArtifact('services/healthService.js'));
const migrationModule = await import(
  backendArtifact('persistence/sqliteMigrations.js')
);
const appVersion = JSON.parse(
  fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')
).version;

const createHealthyDatabase = dataDir => {
  const child = spawnSync(
    process.execPath,
    [
      ...(testSource ? ['--import', 'tsx'] : []),
      '--input-type=module',
      '-e',
      `const database = await import(${JSON.stringify(
        backendArtifact('db.js')
      )}); database.getDatabase(); database.closeDatabase();`,
    ],
    {
      cwd: repoRoot,
      env: { ...process.env, DATA_DIR: dataDir },
      encoding: 'utf8',
    }
  );
  assert.equal(child.status, 0, `${child.stderr}\n${child.stdout}`);
  return new Database(path.join(dataDir, 'data.sqlite'));
};

test('liveness does not depend on storage or optional providers', () => {
  const service = new healthModule.HealthService({
    getDatabase: () => null,
    getDataDir: () => '/definitely/missing',
    now: () => new Date('2026-08-13T12:00:00.000Z'),
  });
  assert.deepEqual(service.liveness(), {
    status: 'alive',
    timestamp: '2026-08-13T12:00:00.000Z',
    version: appVersion,
  });
});

test('readiness verifies the database, schema, and writable data path', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'libre-health-'));
  const database = createHealthyDatabase(dataDir);
  t.after(() => {
    database.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const service = new healthModule.HealthService({
    getDatabase: () => database,
    getDataDir: () => dataDir,
  });
  const report = await service.readiness();
  assert.equal(report.status, 'ready');
  assert.deepEqual(
    report.checks.map(check => [check.id, check.status]),
    [
      ['database', 'pass'],
      ['schema', 'pass'],
      ['data_storage', 'pass'],
    ]
  );

  const publicReport = service.toPublicReport(report);
  assert.equal(publicReport.status, 'ready');
  assert.doesNotMatch(
    JSON.stringify(publicReport),
    /message|details|missingTables/
  );
});

test('readiness fails closed for a missing database or schema', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'libre-health-'));
  const incomplete = new Database(':memory:');
  incomplete.exec('CREATE TABLE users (id TEXT PRIMARY KEY)');
  t.after(() => {
    incomplete.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const missingDatabase = new healthModule.HealthService({
    getDatabase: () => null,
    getDataDir: () => dataDir,
  });
  const unavailableReport = await missingDatabase.readiness();
  assert.equal(unavailableReport.status, 'not_ready');
  assert.equal(
    unavailableReport.checks.find(check => check.id === 'database')?.status,
    'fail'
  );

  const missingSchema = new healthModule.HealthService({
    getDatabase: () => incomplete,
    getDataDir: () => dataDir,
  });
  const schemaReport = await missingSchema.readiness();
  assert.equal(schemaReport.status, 'not_ready');
  const schemaCheck = schemaReport.checks.find(check => check.id === 'schema');
  assert.equal(schemaCheck?.status, 'fail');
  assert.ok(
    schemaCheck?.details.missing.some(item => item.startsWith('sessions'))
  );
});

test('readiness fails closed while a valid older schema awaits migration', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'libre-health-'));
  const database = createHealthyDatabase(dataDir);
  database.pragma('foreign_keys = OFF');
  database.exec(`
    CREATE TABLE users__health_v2 (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('admin', 'user')),
      account_status TEXT NOT NULL DEFAULT 'active'
        CHECK(account_status IN ('pending', 'active')),
      approved_at INTEGER,
      approved_by TEXT,
      avatar TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    INSERT INTO users__health_v2 (
      id, username, email, password_hash, role, account_status, approved_at,
      approved_by, avatar, created_at, updated_at
    )
    SELECT id, username, email, password_hash, role, account_status,
           approved_at, approved_by, avatar, created_at, updated_at
      FROM users;
    DROP TABLE users;
    ALTER TABLE users__health_v2 RENAME TO users;
    DROP INDEX idx_plugin_definitions_updated;
    DROP TABLE plugin_definitions;
    DROP INDEX idx_voice_profiles_name_lookup;
    ALTER TABLE voice_profiles DROP COLUMN name_lookup;
    DROP INDEX idx_platform_blob_references_resource;
    DROP INDEX idx_platform_blob_references_owner;
    DROP INDEX idx_platform_blob_quota_reservations_expiry;
    DROP INDEX idx_platform_blob_quota_reservations_owner;
    DROP INDEX idx_platform_blob_quota_objects_owner;
    DROP TABLE platform_blob_references;
    DROP TABLE platform_blob_quota_reservations;
    DROP TABLE platform_blob_quota_objects;
    DROP TABLE platform_blob_quota_usage;
    DROP TABLE platform_resource_deletion_tombstones;
    ALTER TABLE work_tasks DROP COLUMN preview_upstream_port;
    ALTER TABLE work_tasks DROP COLUMN preview_upstream_host;
    DROP TABLE platform_events;
    DROP TABLE platform_event_stream_heads;
    DROP TABLE platform_job_attempts;
    DROP TABLE platform_jobs;
    DROP TABLE skill_files;
    DROP TABLE skill_versions;
    DROP TABLE skills;
    DROP TABLE prompt_versions;
    DROP TABLE prompts;
    DROP TABLE tool_approvals;
    DROP TABLE tool_server_credentials;
    DROP TABLE tool_server_tools;
    DROP TABLE tool_servers;
    ALTER TABLE personas DROP COLUMN bindings;
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
    DELETE FROM _libre_schema_migrations WHERE version = 17;
    DELETE FROM _libre_schema_migrations WHERE version = 16;
    DELETE FROM _libre_schema_migrations WHERE version = 15;
    DELETE FROM _libre_schema_migrations WHERE version = 14;
    DELETE FROM _libre_schema_migrations WHERE version = 13;
    DELETE FROM _libre_schema_migrations WHERE version = 12;
    DELETE FROM _libre_schema_migrations WHERE version = 11;
    DELETE FROM _libre_schema_migrations WHERE version = 10;
    DELETE FROM _libre_schema_migrations WHERE version = 9;
    DELETE FROM _libre_schema_migrations WHERE version = 8;
    DELETE FROM _libre_schema_migrations WHERE version = 7;
    DELETE FROM _libre_schema_migrations WHERE version = 6;
    DELETE FROM _libre_schema_migrations WHERE version = 5;
    DELETE FROM _libre_schema_migrations WHERE version = 4;
    DELETE FROM _libre_schema_migrations WHERE version = 3;
  `);
  database.pragma('foreign_keys = ON');
  t.after(() => {
    database.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const inspection = migrationModule.inspectSQLiteSchema(database);
  assert.equal(inspection.status, 'migrating');
  assert.equal(inspection.compatible, false);
  const service = new healthModule.HealthService({
    getDatabase: () => database,
    getDataDir: () => dataDir,
  });
  const report = await service.readiness();
  assert.equal(report.status, 'not_ready');
  assert.equal(
    report.checks.find(check => check.id === 'schema')?.status,
    'fail'
  );
});

test('deep health aggregates optional providers without delaying or failing readiness', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'libre-health-'));
  const database = createHealthyDatabase(dataDir);
  t.after(() => {
    database.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const service = new healthModule.HealthService({
    getDatabase: () => database,
    getDataDir: () => dataDir,
  });
  let optionalCalls = 0;
  service.registerDependencyCheck({
    id: 'optional_provider',
    required: false,
    depths: ['deep'],
    check: async () => {
      optionalCalls += 1;
      throw new Error('provider endpoint and credential detail');
    },
  });
  let report = await service.readiness();
  assert.equal(report.status, 'ready');
  assert.equal(optionalCalls, 0);
  assert.equal(
    report.checks.some(check => check.id === 'optional_provider'),
    false
  );

  report = await service.readiness('deep');
  assert.equal(report.status, 'ready');
  assert.equal(optionalCalls, 1);
  assert.equal(
    report.checks.find(check => check.id === 'optional_provider')?.status,
    'warn'
  );
  assert.doesNotMatch(
    JSON.stringify(service.toPublicReport(report)),
    /credential|endpoint/
  );

  service.registerDependencyCheck({
    id: 'required_coordination',
    required: true,
    check: async () => ({ status: 'fail', message: 'unavailable' }),
  });
  report = await service.readiness();
  assert.equal(report.status, 'not_ready');
});

test('dependency registrations reject empty, duplicate, or unknown depths', () => {
  const service = new healthModule.HealthService({
    getDatabase: () => null,
    getDataDir: () => '/definitely/missing',
  });
  const check = async () => ({ status: 'pass' });
  assert.throws(
    () =>
      service.registerDependencyCheck({
        id: 'empty_depths',
        required: false,
        depths: [],
        check,
      }),
    /Invalid health dependency depths/
  );
  assert.throws(
    () =>
      service.registerDependencyCheck({
        id: 'duplicate_depths',
        required: false,
        depths: ['deep', 'deep'],
        check,
      }),
    /Invalid health dependency depths/
  );
  assert.throws(
    () =>
      service.registerDependencyCheck({
        id: 'unknown_depth',
        required: false,
        depths: ['provider'],
        check,
      }),
    /Invalid health dependency depths/
  );
});

test('public readiness deduplicates concurrent storage checks', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'libre-health-'));
  const database = createHealthyDatabase(dataDir);
  t.after(() => {
    database.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const service = new healthModule.HealthService({
    getDatabase: () => database,
    getDataDir: () => dataDir,
  });
  let calls = 0;
  service.registerDependencyCheck({
    id: 'dedupe_probe',
    required: true,
    check: async () => {
      calls += 1;
      await new Promise(resolve => setTimeout(resolve, 20));
      return { status: 'pass' };
    },
  });
  const reports = await Promise.all(
    Array.from({ length: 12 }, () => service.readiness())
  );
  assert.equal(calls, 1);
  assert.ok(reports.every(report => report.status === 'ready'));
});

test('deep health runs integrity checks and the route requires a current admin', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'libre-health-'));
  const database = createHealthyDatabase(dataDir);
  t.after(() => {
    database.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const service = new healthModule.HealthService({
    getDatabase: () => database,
    getDataDir: () => dataDir,
  });
  const report = await service.readiness('deep');
  assert.equal(report.status, 'ready');
  assert.equal(
    report.checks.find(check => check.id === 'database')?.details.quickCheck,
    'ok'
  );

  const routeSource = fs.readFileSync(
    path.join(repoRoot, 'backend', 'src', 'routes', 'health.ts'),
    'utf8'
  );
  assert.match(
    routeSource,
    /router\.get\(['"]\/deep['"], authenticate, requireAdmin/
  );
  assert.match(routeSource, /Cache-Control['"], ['"]no-store/);
  assert.match(routeSource, /\/ready/);

  const serverSource = fs.readFileSync(
    path.join(repoRoot, 'backend', 'src', 'index.ts'),
    'utf8'
  );
  assert.match(serverSource, /id: 'ollama-provider'/);
  assert.match(serverSource, /depths: \['deep'\]/);
  assert.match(serverSource, /ollamaService\.isHealthy\(\)/);
});
