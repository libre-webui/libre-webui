/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const source = process.env.LIBRE_OPERATIONAL_TEST_SOURCE === '1';
const encryptionKey = 'b7'.repeat(32);
// Recovery imports storage contracts. Keep the test hermetic so an import can
// never provision or inspect a developer's persistent application key.
process.env.ENCRYPTION_KEY = encryptionKey;
const recovery = await import(
  pathToFileURL(
    path.join(
      root,
      'backend',
      source ? 'src' : 'dist',
      'platform',
      'recovery',
      source ? 'index.ts' : 'index.js'
    )
  ).href
);

const env = {
  ...process.env,
  ENCRYPTION_KEY: encryptionKey,
  JWT_SECRET: 'integrated-backup-jwt-secret',
  SESSION_SECRET: 'integrated-backup-session-secret',
  NODE_ENV: 'production',
  LIBRE_PLATFORM_MODE: 'solo',
  DATABASE_BACKEND: 'sqlite',
  BLOB_STORE_BACKEND: 'local',
  VECTOR_STORE_BACKEND: 'embedded',
  COORDINATION_BACKEND: 'local',
  JOB_WORKER_MODE: 'embedded',
  POSTGRES_POOL_MAX: '17',
  POSTGRES_CONNECT_TIMEOUT_MS: '4100',
  POSTGRES_IDLE_TIMEOUT_MS: '31000',
  POSTGRES_STATEMENT_TIMEOUT_MS: '32000',
  POSTGRES_MIGRATION_LOCK_TIMEOUT_MS: '62000',
  REDIS_CONNECT_TIMEOUT_MS: '5100',
  BLOB_QUOTA_BYTES_PER_USER: '8589934592',
  BLOB_QUOTA_RESERVATION_TTL_MS: '7200000',
};

const createDatabase = dataDir => {
  const artifact = pathToFileURL(
    path.join(
      root,
      'backend',
      source ? 'src' : 'dist',
      source ? 'db.ts' : 'db.js'
    )
  ).href;
  const result = spawnSync(
    process.execPath,
    [
      ...(source ? ['--import', 'tsx'] : []),
      '--input-type=module',
      '-e',
      `const db = await import(${JSON.stringify(artifact)}); db.getDatabase(); db.closeDatabase();`,
    ],
    {
      cwd: root,
      env: { ...env, DATA_DIR: dataDir },
      encoding: 'utf8',
    }
  );
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
};

test('backup CLI help and argument rejection are import-safe', t => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'libre-backup-cli-test-')
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const childEnvironment = { ...process.env, DATA_DIR: directory };
  delete childEnvironment.ENCRYPTION_KEY;
  const cli = path.join(root, 'backend', 'dist', 'cli', 'recoveryBackup.js');
  const help = spawnSync(process.execPath, [cli, '--help'], {
    cwd: root,
    env: childEnvironment,
    encoding: 'utf8',
  });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /^Usage:/);
  assert.equal(fs.existsSync(path.join(directory, '.encryption_key')), false);
  assert.equal(fs.existsSync(path.join(directory, 'data.sqlite')), false);

  const invalid = spawnSync(
    process.execPath,
    [cli, 'inspect', '--archive', '/does-not-exist', '--unknown', 'value'],
    { cwd: root, env: childEnvironment, encoding: 'utf8' }
  );
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /Unexpected option/);
  assert.doesNotMatch(invalid.stderr, /No ENCRYPTION_KEY|Generated encryption/);
  assert.equal(fs.existsSync(path.join(directory, '.encryption_key')), false);
});

test('integrated backup is signed, encrypted, tamper-evident, and clean-restorable', async t => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'libre-integrated-backup-')
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const dataDir = path.join(directory, 'source-data');
  fs.mkdirSync(dataDir, { mode: 0o700 });
  createDatabase(dataDir);
  fs.writeFileSync(
    path.join(dataDir, 'operator-marker'),
    'private restore marker',
    {
      mode: 0o600,
    }
  );
  const testEnv = {
    ...env,
    DATA_DIR: dataDir,
    PLUGINS_DIR: path.join(dataDir, 'plugins'),
  };

  const keyPaths = recovery.generateBackupKeys(path.join(directory, 'keys'));
  const archivePath = path.join(directory, 'backup.lwb');
  const created = await recovery.createBackupArchive({
    dataDir,
    outputPath: archivePath,
    encryptionKeyPath: keyPaths.encryptionKeyPath,
    signingPrivateKeyPath: keyPaths.signingPrivateKeyPath,
    offline: true,
    env: testEnv,
    now: new Date('2026-08-13T12:00:00.000Z'),
  });
  assert.equal(created.signatureVerified, true);
  assert.equal(created.ciphertextVerified, true);
  assert.equal(created.payloadVerified, true);
  assert.equal(created.header.manifest.createdAt, '2026-08-13T12:00:00.000Z');
  assert.equal(
    fs
      .readFileSync(archivePath)
      .includes(Buffer.from('private restore marker')),
    false
  );
  assert.doesNotMatch(
    JSON.stringify(created.header),
    /integrated-backup-jwt-secret/
  );

  const metadataOnly = recovery.verifyBackupArchive({
    archivePath,
    signingPublicKeyPath: keyPaths.signingPublicKeyPath,
  });
  assert.equal(metadataOnly.payloadVerified, false);
  const full = recovery.verifyBackupArchive({
    archivePath,
    signingPublicKeyPath: keyPaths.signingPublicKeyPath,
    encryptionKeyPath: keyPaths.encryptionKeyPath,
  });
  assert.equal(full.payloadVerified, true);

  const tampered = path.join(directory, 'tampered.lwb');
  fs.copyFileSync(archivePath, tampered);
  const descriptor = fs.openSync(tampered, 'r+');
  try {
    const stat = fs.fstatSync(descriptor);
    const byte = Buffer.alloc(1);
    fs.readSync(descriptor, byte, 0, 1, stat.size - 1);
    byte[0] ^= 0xff;
    fs.writeSync(descriptor, byte, 0, 1, stat.size - 1);
  } finally {
    fs.closeSync(descriptor);
  }
  assert.throws(
    () =>
      recovery.verifyBackupArchive({
        archivePath: tampered,
        signingPublicKeyPath: keyPaths.signingPublicKeyPath,
      }),
    /checksum verification failed/
  );

  const preflightTarget = path.join(directory, 'preflight-target');
  const preflight = await recovery.restoreBackupArchive({
    archivePath,
    targetDirectory: preflightTarget,
    signingPublicKeyPath: keyPaths.signingPublicKeyPath,
    encryptionKeyPath: keyPaths.encryptionKeyPath,
    apply: false,
    env: testEnv,
  });
  assert.equal(preflight.applied, false);
  assert.equal(preflight.inventory.restoreReady, true);
  assert.equal(fs.existsSync(preflightTarget), false);

  const restored = path.join(directory, 'restored');
  const applied = await recovery.restoreBackupArchive({
    archivePath,
    targetDirectory: restored,
    signingPublicKeyPath: keyPaths.signingPublicKeyPath,
    encryptionKeyPath: keyPaths.encryptionKeyPath,
    apply: true,
    env: testEnv,
  });
  assert.equal(applied.applied, true);
  assert.equal(
    fs.readFileSync(path.join(restored, 'data', 'operator-marker'), 'utf8'),
    'private restore marker'
  );
  const restoredRuntimePath = path.join(
    restored,
    'configuration',
    'runtime.json'
  );
  assert.equal(fs.statSync(restoredRuntimePath).mode & 0o777, 0o600);
  const restoredRuntime = JSON.parse(
    fs.readFileSync(restoredRuntimePath, 'utf8')
  );
  for (const name of [
    'POSTGRES_POOL_MAX',
    'POSTGRES_CONNECT_TIMEOUT_MS',
    'POSTGRES_IDLE_TIMEOUT_MS',
    'POSTGRES_STATEMENT_TIMEOUT_MS',
    'POSTGRES_MIGRATION_LOCK_TIMEOUT_MS',
    'REDIS_CONNECT_TIMEOUT_MS',
    'BLOB_QUOTA_BYTES_PER_USER',
    'BLOB_QUOTA_RESERVATION_TTL_MS',
  ]) {
    assert.equal(restoredRuntime[name], env[name]);
  }
  const verified = await recovery.verifyRestoredBackup(restored, testEnv);
  assert.equal(verified.restoreReady, true);
  assert.equal(
    verified.database.schema.fingerprint,
    created.header.manifest.inventory.schemaFingerprint
  );
});
