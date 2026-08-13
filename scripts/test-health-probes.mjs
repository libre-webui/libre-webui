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
  database.exec(`
    DROP INDEX idx_users_email_lookup;
    ALTER TABLE users DROP COLUMN email_lookup;
    DROP TABLE platform_events;
    DROP TABLE platform_event_stream_heads;
    DROP TABLE platform_job_attempts;
    DROP TABLE platform_jobs;
    DELETE FROM _libre_schema_migrations WHERE version = 4;
    DELETE FROM _libre_schema_migrations WHERE version = 3;
  `);
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

test('registered dependencies are injectable and required checks fail readiness', async t => {
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
  const unregisterOptional = service.registerDependencyCheck({
    id: 'optional_provider',
    required: false,
    check: async () => {
      throw new Error('provider endpoint and credential detail');
    },
  });
  let report = await service.readiness();
  assert.equal(report.status, 'ready');
  assert.equal(
    report.checks.find(check => check.id === 'optional_provider')?.status,
    'warn'
  );
  assert.doesNotMatch(
    JSON.stringify(service.toPublicReport(report)),
    /credential|endpoint/
  );
  unregisterOptional();

  service.registerDependencyCheck({
    id: 'required_coordination',
    required: true,
    check: async () => ({ status: 'fail', message: 'unavailable' }),
  });
  report = await service.readiness();
  assert.equal(report.status, 'not_ready');
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
});
