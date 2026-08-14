/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import ts from 'typescript';

import {
  assertPlatformRuntimeConfig,
  PlatformConfigurationError,
  resolvePlatformRuntimeConfig,
  summarizePlatformRuntimeConfig,
} from '../backend/dist/platform/runtimeConfig.js';
import {
  getOllamaRuntimeConfig,
  normalizeOllamaRuntimeEnvironment,
  OllamaConfigurationError,
  OLLAMA_RUNTIME_DEFAULTS,
  resolveOllamaRuntimeConfig,
} from '../backend/dist/platform/ollamaRuntimeConfig.js';
import {
  CoordinationUnavailableError,
  LocalCoordinator,
  RedisCoordinator,
} from '../backend/dist/platform/coordination/index.js';
import {
  acquireSharedCapacity,
  SharedCapacityExceededError,
  SharedCapacityUnavailableError,
} from '../backend/dist/platform/coordination/sharedAdmission.js';
import { sharedRateLimit } from '../backend/dist/middleware/sharedRateLimit.js';
import { coordinatedRateLimit } from '../backend/dist/middleware/coordinatedRateLimit.js';
import { ensurePrivateRuntimeDirectory } from '../backend/dist/utils/dataDirectory.js';

test('Ollama runtime configuration has one strict normalized contract', () => {
  assert.deepEqual(getOllamaRuntimeConfig({}), {
    ...OLLAMA_RUNTIME_DEFAULTS,
    blockers: [],
  });

  const configured = getOllamaRuntimeConfig({
    OLLAMA_TIMEOUT: ' 1000 ',
    OLLAMA_LONG_OPERATION_TIMEOUT: '3600000',
    OLLAMA_MAX_CONTEXT: '2097152',
  });
  assert.deepEqual(configured, {
    timeoutMs: 1_000,
    longOperationTimeoutMs: 3_600_000,
    maxContext: 2_097_152,
    blockers: [],
  });
  const normalized = {};
  normalizeOllamaRuntimeEnvironment(configured, normalized);
  assert.deepEqual(normalized, {
    OLLAMA_TIMEOUT: '1000',
    OLLAMA_LONG_OPERATION_TIMEOUT: '3600000',
    OLLAMA_MAX_CONTEXT: '2097152',
  });
});

test('Ollama runtime configuration rejects malformed, partial, and out-of-range integers', () => {
  for (const [name, value] of [
    ['OLLAMA_TIMEOUT', '1000ms'],
    ['OLLAMA_TIMEOUT', '1e3'],
    ['OLLAMA_TIMEOUT', '0x1000'],
    ['OLLAMA_TIMEOUT', 'NaN'],
    ['OLLAMA_TIMEOUT', '999'],
    ['OLLAMA_TIMEOUT', '3600001'],
    ['OLLAMA_TIMEOUT', '9007199254740992'],
    ['OLLAMA_LONG_OPERATION_TIMEOUT', '0'],
    ['OLLAMA_LONG_OPERATION_TIMEOUT', '+1000'],
    ['OLLAMA_MAX_CONTEXT', '127'],
    ['OLLAMA_MAX_CONTEXT', '2097153'],
    ['OLLAMA_MAX_CONTEXT', '128tokens'],
  ]) {
    const config = resolveOllamaRuntimeConfig({ [name]: value });
    assert.match(config.blockers.join('\n'), new RegExp(name));
    assert.throws(
      () => getOllamaRuntimeConfig({ [name]: value }),
      OllamaConfigurationError
    );
  }
});

test('Ollama long-operation timeout cannot be shorter than its standard timeout', () => {
  const config = resolveOllamaRuntimeConfig({
    OLLAMA_TIMEOUT: '3000000',
    OLLAMA_LONG_OPERATION_TIMEOUT: '2999999',
  });
  assert.match(
    config.blockers.join('\n'),
    /OLLAMA_LONG_OPERATION_TIMEOUT must be greater than or equal to OLLAMA_TIMEOUT/
  );
  assert.throws(
    () =>
      getOllamaRuntimeConfig({
        OLLAMA_TIMEOUT: '3000000',
        OLLAMA_LONG_OPERATION_TIMEOUT: '2999999',
      }),
    OllamaConfigurationError
  );
});

test('application and external-worker entrypoints reject provider limits before creating state', t => {
  for (const entrypoint of ['main.js', 'worker.js']) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'libre-ollama-config-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const dataDir = path.join(root, 'data');
    const preflightDir = path.join(root, 'preflight');
    const result = spawnSync(
      process.execPath,
      [path.resolve('backend', 'dist', entrypoint)],
      {
        cwd: root,
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          NODE_ENV: 'production',
          DATA_DIR: dataDir,
          PLATFORM_PREFLIGHT_TMP_DIR: preflightDir,
          OLLAMA_TIMEOUT: '1000milliseconds',
          OPEN_BROWSER: 'false',
        },
        encoding: 'utf8',
        timeout: 10_000,
      }
    );
    assert.notEqual(result.status, 0, `${entrypoint} must fail startup`);
    assert.match(
      `${result.stderr}\n${result.stdout}`,
      /Invalid Ollama configuration[\s\S]*OLLAMA_TIMEOUT/
    );
    assert.equal(fs.existsSync(dataDir), false);
    assert.equal(fs.existsSync(preflightDir), false);
  }
});

test('solo profile is local-first and contains no implicit network dependency', () => {
  const config = assertPlatformRuntimeConfig(resolvePlatformRuntimeConfig({}));
  assert.deepEqual(summarizePlatformRuntimeConfig(config), {
    mode: 'solo',
    database: 'sqlite',
    blobs: 'local',
    vectors: 'embedded',
    coordination: 'local',
    jobs: 'embedded',
    configured: {
      databaseUrl: false,
      redisUrl: false,
      s3Bucket: false,
      s3Endpoint: false,
    },
    blockers: [],
  });
});

test('connection URLs never select an unavailable backend implicitly', () => {
  const config = assertPlatformRuntimeConfig(
    resolvePlatformRuntimeConfig({
      DATABASE_URL: 'postgresql://operator:secret@db.example.test/libre',
    })
  );
  assert.equal(config.database.backend, 'sqlite');
  assert.equal(config.database.url?.startsWith('postgresql:'), true);
  assert.equal(config.blockers.length, 0);
});

test('team profile fails closed until every shared dependency is configured', () => {
  const config = resolvePlatformRuntimeConfig({ LIBRE_PLATFORM_MODE: 'team' });
  assert.throws(
    () => assertPlatformRuntimeConfig(config),
    error => {
      assert.ok(error instanceof PlatformConfigurationError);
      assert.match(error.message, /DATABASE_BACKEND=postgres/);
      assert.match(error.message, /BLOB_STORE_BACKEND=s3/);
      assert.match(error.message, /VECTOR_STORE_BACKEND=pgvector/);
      assert.match(error.message, /REDIS_URL is required/);
      assert.match(error.message, /JWT_SECRET/);
      return true;
    }
  );
});

test('a complete team configuration selects every shared adapter without exposing secrets', () => {
  const config = resolvePlatformRuntimeConfig({
    LIBRE_PLATFORM_MODE: 'team',
    DATABASE_BACKEND: 'postgres',
    DATABASE_URL: 'postgresql://operator:secret@db.example.test/libre',
    BLOB_STORE_BACKEND: 's3',
    VECTOR_STORE_BACKEND: 'pgvector',
    COORDINATION_BACKEND: 'redis',
    REDIS_URL: 'rediss://operator:secret@redis.example.test/0',
    JOB_WORKER_MODE: 'external',
    S3_BUCKET: 'libre-team-test',
    S3_REGION: 'us-east-1',
    JWT_SECRET: 'shared-team-jwt-secret',
    AGENT_CLI_MODELS_ENABLED: 'false',
    CODEX_OAUTH_MODELS_ENABLED: 'false',
  });
  const summary = JSON.stringify(summarizePlatformRuntimeConfig(config));
  assert.doesNotMatch(summary, /operator|secret|example\.test/);
  assert.equal(config.coordination.redisUrl?.startsWith('rediss:'), true);
  assert.equal(assertPlatformRuntimeConfig(config), config);
  assert.deepEqual(config.blockers, []);
});

test('team profile rejects node-local durable chat provider credentials', () => {
  const complete = {
    LIBRE_PLATFORM_MODE: 'team',
    DATABASE_BACKEND: 'postgres',
    DATABASE_URL: 'postgresql://operator:secret@db.example.test/libre',
    BLOB_STORE_BACKEND: 's3',
    VECTOR_STORE_BACKEND: 'pgvector',
    COORDINATION_BACKEND: 'redis',
    REDIS_URL: 'rediss://operator:secret@redis.example.test/0',
    JOB_WORKER_MODE: 'external',
    S3_BUCKET: 'libre-team-test',
    S3_REGION: 'us-east-1',
    JWT_SECRET: 'shared-team-jwt-secret',
  };
  for (const env of [
    complete,
    {
      ...complete,
      AGENT_CLI_MODELS_ENABLED: 'true',
      CODEX_OAUTH_MODELS_ENABLED: 'false',
    },
    {
      ...complete,
      AGENT_CLI_MODELS_ENABLED: 'false',
      CODEX_OAUTH_MODELS_ENABLED: 'true',
    },
  ]) {
    const blockers = resolvePlatformRuntimeConfig(env).blockers.join('\n');
    assert.match(
      blockers,
      /AGENT_CLI_MODELS_ENABLED|CODEX_OAUTH_MODELS_ENABLED/
    );
  }
});

test('solo profile can opt into Redis without implying shared persistence', () => {
  const config = assertPlatformRuntimeConfig(
    resolvePlatformRuntimeConfig({
      COORDINATION_BACKEND: 'redis',
      REDIS_URL: 'redis://redis.example.test:6379/0',
    })
  );
  assert.equal(config.mode, 'solo');
  assert.equal(config.database.backend, 'sqlite');
  assert.equal(config.coordination.backend, 'redis');
});

test('invalid selectors and URLs are reported together', () => {
  const config = resolvePlatformRuntimeConfig({
    LIBRE_PLATFORM_MODE: 'cluster',
    DATABASE_BACKEND: 'mysql',
    COORDINATION_BACKEND: 'redis',
    REDIS_URL: 'https://redis.example.test',
    REDIS_CONNECT_TIMEOUT_MS: 'forever',
  });
  assert.ok(config.blockers.length >= 4);
  assert.match(config.blockers.join('\n'), /LIBRE_PLATFORM_MODE/);
  assert.match(config.blockers.join('\n'), /DATABASE_BACKEND/);
  assert.match(config.blockers.join('\n'), /REDIS_URL/);
  assert.match(config.blockers.join('\n'), /REDIS_CONNECT_TIMEOUT_MS/);
});

test('invalid remote profiles fail before creating local state', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'libre-bootstrap-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'data');
  const result = spawnSync(
    process.execPath,
    [path.resolve('backend/dist/main.js')],
    {
      cwd: root,
      env: {
        ...process.env,
        DATA_DIR: dataDir,
        DATABASE_BACKEND: 'postgres',
        VECTOR_STORE_BACKEND: 'embedded',
        DATABASE_URL:
          'postgresql://sentinel-user:sentinel-password@db.example.test/libre',
        OPEN_BROWSER: 'false',
      },
      encoding: 'utf8',
      timeout: 10_000,
    }
  );
  assert.notEqual(result.status, 0);
  assert.match(
    `${result.stderr}\n${result.stdout}`,
    /VECTOR_STORE_BACKEND=embedded|configuration/i
  );
  assert.doesNotMatch(
    `${result.stderr}\n${result.stdout}`,
    /sentinel-user|sentinel-password|db\.example\.test/
  );
  assert.equal(fs.existsSync(dataDir), false);
});

test('the public CLI validates configuration before creating local state', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'libre-cli-bootstrap-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  const result = spawnSync(process.execPath, [path.resolve('bin/cli.js')], {
    cwd: root,
    env: {
      ...process.env,
      HOME: home,
      DATABASE_BACKEND: 'postgres',
      VECTOR_STORE_BACKEND: 'embedded',
      DATABASE_URL:
        'postgresql://sentinel-user:sentinel-password@db.example.test/libre',
      OPEN_BROWSER: 'false',
    },
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.notEqual(result.status, 0);
  assert.match(
    `${result.stderr}\n${result.stdout}`,
    /VECTOR_STORE_BACKEND=embedded|configuration/i
  );
  assert.equal(fs.existsSync(path.join(home, '.libre-webui')), false);
});

test('invalid storage keys fail before creating local state', t => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'libre-storage-bootstrap-')
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'data');
  const result = spawnSync(
    process.execPath,
    [path.resolve('backend/dist/main.js')],
    {
      cwd: root,
      env: {
        ...process.env,
        DATA_DIR: dataDir,
        STORAGE_ENCRYPTION_ACTIVE_KEY_ID: 'active',
        STORAGE_ENCRYPTION_KEYS: '{"active":"secret-sentinel"}',
        OPEN_BROWSER: 'false',
      },
      encoding: 'utf8',
      timeout: 10_000,
    }
  );
  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}\n${result.stdout}`, /storage encryption/i);
  assert.doesNotMatch(`${result.stderr}\n${result.stdout}`, /secret-sentinel/);
  assert.equal(fs.existsSync(dataDir), false);
});

test('team scratch directories are created privately without following symlinks', t => {
  const physicalTempRoot = fs.realpathSync.native(os.tmpdir());
  const root = fs.mkdtempSync(
    path.join(physicalTempRoot, 'libre-team-scratch-')
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const scratch = path.join(root, 'runtime', 'preflight');
  assert.equal(ensurePrivateRuntimeDirectory(scratch), scratch);
  assert.equal(fs.statSync(scratch).mode & 0o777, 0o700);

  const physical = path.join(root, 'physical');
  const alias = path.join(root, 'alias');
  fs.mkdirSync(physical, { mode: 0o700 });
  fs.symlinkSync(physical, alias, 'dir');
  assert.throws(
    () => ensurePrivateRuntimeDirectory(path.join(alias, 'nested')),
    /physical directory/
  );
  assert.equal(fs.existsSync(path.join(physical, 'nested')), false);
});

test('team scratch directories reject unsafe writable ancestors', t => {
  const physicalTempRoot = fs.realpathSync.native(os.tmpdir());
  const root = fs.mkdtempSync(
    path.join(physicalTempRoot, 'libre-team-unsafe-')
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const unsafe = path.join(root, 'shared');
  fs.mkdirSync(unsafe, { mode: 0o777 });
  fs.chmodSync(unsafe, 0o777);

  assert.throws(
    () => ensurePrivateRuntimeDirectory(path.join(unsafe, 'runtime')),
    /unsafe world-writable ancestor/
  );
  assert.equal(fs.existsSync(path.join(unsafe, 'runtime')), false);
});

test('local coordinator provides isolated cache, events, leases, and limits', async () => {
  let now = 1_000;
  const coordinator = new LocalCoordinator(() => now);
  await coordinator.connect();

  const messages = [];
  const unsubscribe = await coordinator.subscribe('users.changed', event => {
    messages.push(event.payload);
  });
  await coordinator.publish('users.changed', { userId: 'user-a' });
  assert.deepEqual(messages, [{ userId: 'user-a' }]);
  await unsubscribe();

  const source = { nested: { value: 1 } };
  await coordinator.setCache('profile:user-a', source, 100);
  source.nested.value = 2;
  assert.deepEqual(await coordinator.getCache('profile:user-a'), {
    nested: { value: 1 },
  });
  await coordinator.setCache('single-use:user-a', { nonce: 7 }, 100);
  assert.deepEqual(await coordinator.consumeCache('single-use:user-a'), {
    nonce: 7,
  });
  assert.equal(await coordinator.consumeCache('single-use:user-a'), null);
  now += 101;
  assert.equal(await coordinator.getCache('profile:user-a'), null);

  const first = await coordinator.acquireLease('job:one', 100);
  assert.ok(first);
  assert.equal(await coordinator.acquireLease('job:one', 100), null);
  assert.equal(await first.extend(100), true);
  assert.equal(await first.release(), true);
  const second = await coordinator.acquireLease('job:one', 100);
  assert.ok(second);
  assert.ok(second.fencingToken > first.fencingToken);

  const firstRateWindow = await coordinator.consumeRateLimit(
    'api:user-a',
    2,
    100
  );
  assert.deepEqual(
    {
      allowed: firstRateWindow.allowed,
      remaining: firstRateWindow.remaining,
      resetAt: firstRateWindow.resetAt,
    },
    { allowed: true, remaining: 1, resetAt: now + 100 }
  );
  assert.equal(typeof firstRateWindow.windowToken, 'string');
  assert.equal(
    (await coordinator.consumeRateLimit('api:user-a', 2, 100)).allowed,
    true
  );
  assert.equal(
    (await coordinator.consumeRateLimit('api:user-a', 2, 100)).allowed,
    false
  );

  const firstPermit = await coordinator.acquireSemaphore('media', 1, 100);
  assert.ok(firstPermit);
  assert.equal(await coordinator.acquireSemaphore('media', 1, 100), null);
  assert.equal(await firstPermit.extend(100), true);
  assert.equal(await firstPermit.release(), true);
  assert.ok(await coordinator.acquireSemaphore('media', 1, 100));

  await coordinator.setPresence('workers', 'worker-b', 100);
  await coordinator.setPresence('workers', 'worker-a', 100);
  assert.deepEqual(await coordinator.listPresence('workers'), [
    'worker-a',
    'worker-b',
  ]);
  await coordinator.clearPresence('workers', 'worker-a');
  assert.deepEqual(await coordinator.listPresence('workers'), ['worker-b']);

  assert.equal(await coordinator.getRevocationEpoch('session:user-a'), 0);
  const revocations = [];
  const unsubscribeRevocations = await coordinator.subscribe(
    'security.revoked',
    event => revocations.push(event.payload)
  );
  assert.equal(await coordinator.revoke('session:user-a'), 1);
  assert.equal(await coordinator.revoke('session:user-a'), 2);
  assert.equal(await coordinator.getRevocationEpoch('session:user-a'), 2);
  assert.deepEqual(revocations, [
    { subject: 'session:user-a', epoch: 1 },
    { subject: 'session:user-a', epoch: 2 },
  ]);
  await unsubscribeRevocations();

  await coordinator.close();
  assert.equal((await coordinator.health()).ready, false);
});

test('rate-limit refunds never decrement a newer fixed window', async () => {
  let now = 1_000;
  const coordinator = new LocalCoordinator(() => now);
  await coordinator.connect();
  const oldWindow = await coordinator.consumeRateLimit('refund-race', 2, 100);
  now = oldWindow.resetAt + 1;
  const newWindow = await coordinator.consumeRateLimit('refund-race', 2, 100);
  assert.notEqual(newWindow.windowToken, oldWindow.windowToken);
  assert.equal(
    await coordinator.refundRateLimit('refund-race', oldWindow.windowToken),
    false
  );
  assert.deepEqual(await coordinator.consumeRateLimit('refund-race', 2, 100), {
    allowed: true,
    remaining: 0,
    resetAt: newWindow.resetAt,
    windowToken: newWindow.windowToken,
  });
  assert.equal(
    await coordinator.refundRateLimit('refund-race', newWindow.windowToken),
    true
  );
  await coordinator.close();
});

test('local coordinator reclaims expired and empty admission state', async () => {
  let now = 1_000;
  const coordinator = new LocalCoordinator(() => now);
  await coordinator.connect();
  for (let index = 0; index < 1_000; index += 1) {
    await coordinator.setCache(`one-off-cache-${index}`, index, 100);
    assert.ok(await coordinator.acquireLease(`one-off-lease-${index}`, 100));
  }
  assert.equal(coordinator.cache.size, 1_000);
  assert.equal(coordinator.leases.size, 1_000);
  now += 101;
  await coordinator.setCache('current-cache', true, 100);
  assert.ok(await coordinator.acquireLease('current-lease', 100));
  assert.equal(coordinator.cache.size, 1);
  assert.equal(coordinator.leases.size, 1);

  for (let index = 0; index < 1_000; index += 1) {
    await coordinator.consumeRateLimit(`one-off-rate-${index}`, 1, 100);
  }
  assert.equal(coordinator.rateLimits.size, 1_000);
  now += 101;
  await coordinator.consumeRateLimit('current-rate', 1, 100);
  assert.equal(coordinator.rateLimits.size, 1);

  const released = await coordinator.acquireSemaphore(
    'released-capacity',
    1,
    100
  );
  assert.ok(released);
  await released.release();
  assert.equal(coordinator.semaphores.has('released-capacity'), false);
  assert.ok(await coordinator.acquireSemaphore('expired-capacity', 1, 100));
  now += 101;
  assert.ok(await coordinator.acquireSemaphore('current-capacity', 1, 100));
  assert.equal(coordinator.semaphores.has('expired-capacity'), false);

  await coordinator.setPresence('expired-presence', 'member-a', 100);
  now += 101;
  await coordinator.setPresence('current-presence', 'member-b', 100);
  assert.equal(coordinator.presence.has('expired-presence'), false);
  await coordinator.clearPresence('current-presence', 'member-b');
  assert.equal(coordinator.presence.has('current-presence'), false);
  await coordinator.close();
});

test('shared capacity rolls back partial admission and aborts on renewal loss', async () => {
  await assert.rejects(
    () =>
      acquireSharedCapacity({
        coordinator: {
          acquireSemaphore: () => new Promise(() => {}),
        },
        operationTimeoutMs: 10,
        limits: [{ scope: 'test-stalled-acquire.global', capacity: 1 }],
      }),
    SharedCapacityUnavailableError
  );

  const coordinator = new LocalCoordinator();
  await coordinator.connect();
  const heldSubject = await acquireSharedCapacity({
    coordinator,
    limits: [{ scope: 'test-partial.subject', subject: 'one', capacity: 1 }],
  });
  await assert.rejects(
    () =>
      acquireSharedCapacity({
        coordinator,
        limits: [
          { scope: 'test-partial.global', capacity: 1 },
          { scope: 'test-partial.subject', subject: 'one', capacity: 1 },
        ],
      }),
    SharedCapacityExceededError
  );
  const globalAfterRollback = await acquireSharedCapacity({
    coordinator,
    limits: [{ scope: 'test-partial.global', capacity: 1 }],
  });
  await globalAfterRollback.release();
  await globalAfterRollback.release();
  await heldSubject.release();
  const subjectAfterRelease = await acquireSharedCapacity({
    coordinator,
    limits: [{ scope: 'test-partial.subject', subject: 'one', capacity: 1 }],
  });
  await subjectAfterRelease.release();
  await coordinator.close();

  const failedCoordinator = new LocalCoordinator();
  await failedCoordinator.connect();
  const renewable = await acquireSharedCapacity({
    coordinator: failedCoordinator,
    ttlMs: 30,
    renewIntervalMs: 5,
    limits: [{ scope: 'test-renewal.global', capacity: 1 }],
  });
  await failedCoordinator.close();
  await Promise.race([
    new Promise(resolve => renewable.signal.addEventListener('abort', resolve)),
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error('Shared-capacity renewal did not fail closed')),
        200
      )
    ),
  ]);
  assert.equal(renewable.signal.aborted, true);
  assert.ok(renewable.signal.reason instanceof SharedCapacityUnavailableError);
  await renewable.release();

  const stalledRenewal = await acquireSharedCapacity({
    coordinator: {
      acquireSemaphore: async key => ({
        key,
        ownerToken: 'stalled-renewal-owner',
        expiresAt: Date.now() + 50,
        extend: () => new Promise(() => {}),
        release: async () => true,
      }),
    },
    ttlMs: 50,
    renewIntervalMs: 5,
    operationTimeoutMs: 10,
    limits: [{ scope: 'test-stalled-renewal.global', capacity: 1 }],
  });
  await Promise.race([
    new Promise(resolve =>
      stalledRenewal.signal.addEventListener('abort', resolve)
    ),
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error('A stalled renewal did not abort before TTL')),
        100
      )
    ),
  ]);
  const releaseStartedAt = Date.now();
  await stalledRenewal.release();
  assert.ok(Date.now() - releaseStartedAt < 50);

  let finishRelease;
  const releaseGate = new Promise(resolve => {
    finishRelease = resolve;
  });
  const coalesced = await acquireSharedCapacity({
    coordinator: {
      acquireSemaphore: async key => ({
        key,
        ownerToken: 'coalesced-release-owner',
        expiresAt: Date.now() + 1_000,
        extend: async () => true,
        release: () => releaseGate.then(() => true),
      }),
    },
    limits: [{ scope: 'test-coalesced-release.global', capacity: 1 }],
  });
  const firstRelease = coalesced.release();
  const secondRelease = coalesced.release();
  assert.equal(firstRelease, secondRelease);
  let secondSettled = false;
  void secondRelease.then(() => {
    secondSettled = true;
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(secondSettled, false);
  finishRelease();
  await Promise.all([firstRelease, secondRelease]);
});

test('shared HTTP rate limits span replica middleware and fail closed', async t => {
  const coordinator = new LocalCoordinator();
  await coordinator.connect();

  const startReplica = async limiter => {
    const app = express();
    app.get('/request', limiter, (_request, response) => {
      response.json({ success: true });
    });
    app.get('/failure', limiter, (_request, response) => {
      response.status(500).json({ success: false });
    });
    const server = createServer(app);
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    t.after(() => new Promise(resolve => server.close(resolve)));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    return `http://127.0.0.1:${address.port}`;
  };

  const firstReplica = await startReplica(
    sharedRateLimit({
      coordinator,
      keyPrefix: 'test-replica-rate',
      windowMs: 1_000,
      max: 2,
      standardHeaders: true,
      legacyHeaders: false,
    })
  );
  const secondReplica = await startReplica(
    sharedRateLimit({
      coordinator,
      keyPrefix: 'test-replica-rate',
      windowMs: 1_000,
      max: 2,
      standardHeaders: true,
      legacyHeaders: false,
    })
  );
  assert.equal((await fetch(`${firstReplica}/request`)).status, 200);
  const second = await fetch(`${secondReplica}/request`);
  assert.equal(second.status, 200);
  assert.equal(second.headers.get('ratelimit-remaining'), '0');
  const limited = await fetch(`${firstReplica}/request`);
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.has('retry-after'), true);

  const refundReplica = await startReplica(
    sharedRateLimit({
      coordinator,
      keyPrefix: 'test-success-refund',
      windowMs: 1_000,
      max: 1,
      skipSuccessfulRequests: true,
    })
  );
  assert.equal((await fetch(`${refundReplica}/request`)).status, 200);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await fetch(`${refundReplica}/request`)).status, 200);

  const failureReplica = await startReplica(
    sharedRateLimit({
      coordinator,
      keyPrefix: 'test-failure-retained',
      windowMs: 1_000,
      max: 1,
      skipSuccessfulRequests: true,
    })
  );
  assert.equal((await fetch(`${failureReplica}/failure`)).status, 500);
  assert.equal((await fetch(`${failureReplica}/request`)).status, 429);

  await coordinator.close();
  const unavailable = await fetch(`${firstReplica}/request`);
  assert.equal(unavailable.status, 503);
  assert.deepEqual(await unavailable.json(), {
    success: false,
    message: 'Request admission is temporarily unavailable',
  });

  const stalledReplica = await startReplica(
    sharedRateLimit({
      coordinator: {
        consumeRateLimit: () => new Promise(() => {}),
      },
      operationTimeoutMs: 10,
      keyPrefix: 'test-stalled-rate',
      windowMs: 1_000,
      max: 1,
    })
  );
  const stalledStartedAt = Date.now();
  assert.equal((await fetch(`${stalledReplica}/request`)).status, 503);
  assert.ok(Date.now() - stalledStartedAt < 200);

  let safetyCoordinatorCalls = 0;
  const safetyReplica = await startReplica(
    sharedRateLimit({
      coordinator: {
        consumeRateLimit: () => {
          safetyCoordinatorCalls += 1;
          return new Promise(() => {});
        },
      },
      operationTimeoutMs: 10,
      keyPrefix: 'test-safety-bypass',
      windowMs: 1_000,
      max: 1,
      skip: request => request.path === '/request',
    })
  );
  assert.equal((await fetch(`${safetyReplica}/request`)).status, 200);
  assert.equal(safetyCoordinatorCalls, 0);
  assert.equal((await fetch(`${safetyReplica}/failure`)).status, 503);
  assert.equal(safetyCoordinatorCalls, 1);
});

test('security rate limits fail closed when coordinator commands stall', async t => {
  const app = express();
  app.get(
    '/login',
    coordinatedRateLimit({
      coordinator: {
        consumeRateLimit: () => new Promise(() => {}),
      },
      operationTimeoutMs: 10,
      keyPrefix: 'test-stalled-security-rate',
      windowMs: 1_000,
      limit: 1,
      message: 'Too many authentication attempts',
    }),
    (_request, response) => response.json({ success: true })
  );
  const server = createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  const startedAt = Date.now();
  const response = await fetch(`http://127.0.0.1:${address.port}/login`);
  assert.equal(response.status, 503);
  assert.ok(Date.now() - startedAt < 200);
  assert.deepEqual(await response.json(), {
    success: false,
    message: 'Authentication protection is temporarily unavailable',
  });
});

test('local leases never release or extend a newer owner', async () => {
  let now = 0;
  const coordinator = new LocalCoordinator(() => now);
  await coordinator.connect();
  const expired = await coordinator.acquireLease('resource', 10);
  assert.ok(expired);
  now = 11;
  const current = await coordinator.acquireLease('resource', 10);
  assert.ok(current);
  assert.equal(await expired.release(), false);
  assert.equal(await expired.extend(10), false);
  assert.equal(await current.release(), true);
});

test('Redis coordinator fails closed and never falls back to local state', async () => {
  class FailedClient {
    isReady = false;
    on() {
      return this;
    }
    async connect() {
      throw new Error('connection refused');
    }
    async close() {}
    destroy() {}
    async ping() {
      throw new Error('not connected');
    }
  }

  const coordinator = new RedisCoordinator({
    url: 'redis://redis.example.test:6379',
    connectTimeoutMs: 100,
    clientFactory: () => ({
      command: new FailedClient(),
      subscriber: new FailedClient(),
    }),
  });
  await assert.rejects(
    coordinator.connect(),
    error => error instanceof CoordinationUnavailableError
  );
  await assert.rejects(
    coordinator.getCache('security:user-a'),
    error => error instanceof CoordinationUnavailableError
  );
  assert.deepEqual(await coordinator.health(), {
    ready: false,
    backend: 'redis',
    latencyMs: 0,
    message: 'connection refused',
  });
});

test('every asynchronous Redis command path has an explicit deadline', () => {
  const filename = path.resolve(
    'backend/src/platform/coordination/redisCoordinator.ts'
  );
  const sourceText = fs.readFileSync(filename, 'utf8');
  const source = ts.createSourceFile(
    filename,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const unbounded = [];
  const pendingOperations = [];

  const isTimeoutCall = node =>
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.expression.kind === ts.SyntaxKind.ThisKeyword &&
    node.expression.name.text === 'withTimeout';

  const visit = node => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isPropertyAccessExpression(node.expression.expression) &&
      node.expression.expression.expression.kind === ts.SyntaxKind.ThisKeyword
    ) {
      const client = node.expression.expression.name.text;
      const method = node.expression.name.text;
      if (
        (client === 'command' || client === 'subscriber') &&
        method !== 'on' &&
        method !== 'destroy'
      ) {
        let ancestor = node.parent;
        let bounded = false;
        while (ancestor && !ts.isStatement(ancestor)) {
          if (isTimeoutCall(ancestor)) bounded = true;
          ancestor = ancestor.parent;
        }
        if (!bounded) {
          const declaration = node.parent;
          if (
            ts.isVariableDeclaration(declaration) &&
            ts.isIdentifier(declaration.name) &&
            ((method === 'eval' &&
              declaration.name.text === 'pendingAcquire') ||
              (method === 'subscribe' &&
                declaration.name.text === 'rawSetup') ||
              (method === 'unsubscribe' &&
                declaration.name.text === 'pendingUnsubscribe'))
          ) {
            pendingOperations.push(node.getStart(source));
          } else {
            const location = source.getLineAndCharacterOfPosition(
              node.getStart(source)
            );
            unbounded.push(`${client}.${method}:${location.line + 1}`);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  assert.deepEqual(unbounded, []);
  assert.equal(pendingOperations.length, 4);
  assert.equal(
    (sourceText.match(/await this\.withTimeout\(\s*pendingAcquire/g) || [])
      .length,
    2
  );
  assert.equal(
    (sourceText.match(/void pendingAcquire\s*\.then/g) || []).length,
    2,
    'timed-out acquisitions must clean up any late lease or permit'
  );
});

test('Redis command blackholes settle fail closed within the configured deadline', async () => {
  const never = () => new Promise(() => {});
  class HangingClient {
    isReady = false;
    on() {
      return this;
    }
    async connect() {
      this.isReady = true;
    }
    async close() {
      this.isReady = false;
    }
    destroy() {
      this.isReady = false;
    }
    async ping() {
      return 'PONG';
    }
    get = never;
    set = never;
    del = never;
    publish = never;
    subscribe = never;
    unsubscribe = never;
    eval = never;
    zAdd = never;
    zRangeByScore = never;
    zRem = never;
  }

  const command = new HangingClient();
  const subscriber = new HangingClient();
  const coordinator = new RedisCoordinator({
    url: 'redis://redis.example.test:6379',
    connectTimeoutMs: 10,
    clientFactory: () => ({ command, subscriber }),
  });
  await coordinator.connect();
  const operations = [
    () => coordinator.publish('blackhole.topic', {}),
    () => coordinator.subscribe('blackhole.topic', async () => undefined),
    () => coordinator.getCache('blackhole-cache'),
    () => coordinator.setCache('blackhole-cache', true, 1_000),
    () => coordinator.consumeCache('blackhole-cache'),
    () => coordinator.deleteCache('blackhole-cache'),
    () => coordinator.acquireLease('blackhole-lease', 1_000),
    () => coordinator.consumeRateLimit('blackhole-rate', 1, 1_000),
    () => coordinator.refundRateLimit('blackhole-rate', randomUUID()),
    () => coordinator.acquireSemaphore('blackhole-semaphore', 1, 1_000),
    () => coordinator.setPresence('blackhole-presence', 'member', 1_000),
    () => coordinator.listPresence('blackhole-presence'),
    () => coordinator.clearPresence('blackhole-presence', 'member'),
    () => coordinator.getRevocationEpoch('blackhole-revocation'),
    () => coordinator.revoke('blackhole-revocation'),
  ];
  for (const operation of operations) {
    const startedAt = Date.now();
    await assert.rejects(operation, CoordinationUnavailableError);
    assert.ok(Date.now() - startedAt < 250);
  }
  await coordinator.close();
});

test('concurrent Redis subscribers share setup and retry only after late cleanup', async () => {
  class CommandClient {
    isReady = false;
    on() {
      return this;
    }
    async connect() {
      this.isReady = true;
    }
    async close() {
      this.isReady = false;
    }
    destroy() {
      this.isReady = false;
    }
    async ping() {
      return 'PONG';
    }
  }
  class DelayedSubscriber extends CommandClient {
    unsubscribeCalls = 0;
    first = true;
    resolveFirst;
    subscribe() {
      if (!this.first) return Promise.resolve();
      this.first = false;
      return new Promise(resolve => {
        this.resolveFirst = resolve;
      });
    }
    async unsubscribe() {
      this.unsubscribeCalls += 1;
    }
  }

  const command = new CommandClient();
  const subscriber = new DelayedSubscriber();
  const coordinator = new RedisCoordinator({
    url: 'redis://redis.example.test:6379',
    connectTimeoutMs: 10,
    clientFactory: () => ({ command, subscriber }),
  });
  await coordinator.connect();
  const firstOpening = coordinator.subscribe(
    'late-subscribe',
    async () => undefined
  );
  const secondOpening = coordinator.subscribe(
    'late-subscribe',
    async () => undefined
  );
  await Promise.all([
    assert.rejects(firstOpening, CoordinationUnavailableError),
    assert.rejects(secondOpening, CoordinationUnavailableError),
  ]);
  assert.equal(subscriber.first, false);
  await assert.rejects(
    coordinator.subscribe('late-subscribe', async () => undefined),
    CoordinationUnavailableError,
    'retry remains fail-closed until the abandoned client command settles'
  );
  subscriber.resolveFirst();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(subscriber.unsubscribeCalls, 1);
  const liveUnsubscribe = await coordinator.subscribe(
    'late-subscribe',
    async () => undefined
  );
  await liveUnsubscribe();
  assert.equal(subscriber.unsubscribeCalls, 2);
  await coordinator.close();
});

test('Redis semaphore expiry uses Redis time instead of replica clocks', async () => {
  const redisNow = 1_900_000_000_000;
  const evalCalls = [];
  class FakeClient {
    isReady = false;
    on() {
      return this;
    }
    async connect() {
      this.isReady = true;
    }
    async close() {
      this.isReady = false;
    }
    destroy() {
      this.isReady = false;
    }
    async ping() {
      return 'PONG';
    }
    async eval(script, options) {
      evalCalls.push({ script, options });
      if (
        script.includes("redis.call('TIME')") &&
        options.arguments.length === 3
      ) {
        return [1, redisNow + Number(options.arguments[0])];
      }
      if (
        script.includes("redis.call('TIME')") &&
        options.arguments.length === 2
      ) {
        return redisNow + Number(options.arguments[1]);
      }
      throw new Error('Unexpected test command');
    }
    async zRem() {
      return 1;
    }
  }

  const command = new FakeClient();
  const subscriber = new FakeClient();
  const coordinator = new RedisCoordinator({
    url: 'redis://redis.example.test:6379',
    now: () => redisNow + 31_536_000_000,
    clientFactory: () => ({ command, subscriber }),
  });
  await coordinator.connect();
  const permit = await coordinator.acquireSemaphore('clock-skew', 1, 5_000);
  assert.ok(permit);
  assert.equal(permit.expiresAt, redisNow + 5_000);
  assert.deepEqual(evalCalls[0].options.arguments.slice(0, 2), ['5000', '1']);
  assert.equal(evalCalls[0].options.arguments.length, 3);
  assert.equal(await permit.extend(7_000), true);
  assert.equal(permit.expiresAt, redisNow + 7_000);
  assert.equal(evalCalls[1].options.arguments.length, 2);
  await coordinator.close();
});

test('Redis subscriptions contain malformed messages and handler failures', async () => {
  class FakeClient {
    isReady = false;
    closeCalls = 0;
    destroyCalls = 0;
    listener;
    on() {
      return this;
    }
    async connect() {
      this.isReady = true;
    }
    async close() {
      this.closeCalls += 1;
      this.isReady = false;
    }
    destroy() {
      this.destroyCalls += 1;
      this.isReady = false;
    }
    async ping() {
      return 'PONG';
    }
    async subscribe(_channel, listener) {
      this.listener = listener;
    }
    async unsubscribe() {}
    async get() {
      return null;
    }
    async set() {
      return 'OK';
    }
    async del() {
      return 1;
    }
    async publish() {
      return 1;
    }
    async eval() {
      return 1;
    }
    async deliver(message) {
      await this.listener?.(message);
    }
  }

  const command = new FakeClient();
  const subscriber = new FakeClient();
  const coordinator = new RedisCoordinator({
    url: 'redis://redis.example.test:6379',
    clientFactory: () => ({ command, subscriber }),
  });
  await coordinator.connect();
  await coordinator.subscribe('events.test', async () => {
    throw new Error('sensitive handler detail');
  });

  await assert.doesNotReject(() => subscriber.deliver('{bad json'));
  await assert.doesNotReject(() =>
    subscriber.deliver(
      JSON.stringify({
        id: 'event-1',
        topic: 'events.test',
        emittedAt: new Date().toISOString(),
        payload: { secret: 'not retained' },
      })
    )
  );

  subscriber.isReady = false;
  await coordinator.close();
  assert.equal(command.closeCalls, 1);
  assert.equal(subscriber.closeCalls, 0);
  assert.equal(subscriber.destroyCalls, 1);
});

test('Redis shutdown drains accepted subscription handlers and gates late delivery', async () => {
  class FakeClient {
    isReady = false;
    closeCalls = 0;
    listener;
    on() {
      return this;
    }
    async connect() {
      this.isReady = true;
    }
    async close() {
      this.closeCalls += 1;
      this.isReady = false;
    }
    destroy() {
      this.isReady = false;
    }
    async ping() {
      return 'PONG';
    }
    async subscribe(_channel, listener) {
      this.listener = listener;
    }
    async unsubscribe() {}
    async get() {
      return null;
    }
    async set() {
      return 'OK';
    }
    async del() {
      return 1;
    }
    async publish() {
      return 1;
    }
    async eval() {
      return 1;
    }
    deliver(message) {
      this.listener?.(message);
    }
  }

  const command = new FakeClient();
  const subscriber = new FakeClient();
  const coordinator = new RedisCoordinator({
    url: 'redis://redis.example.test:6379',
    clientFactory: () => ({ command, subscriber }),
  });
  await coordinator.connect();

  let handlerCalls = 0;
  let handlerStarted;
  const didStartHandler = new Promise(resolve => {
    handlerStarted = resolve;
  });
  let rejectHandler;
  const handlerGate = new Promise((_, reject) => {
    rejectHandler = reject;
  });
  await coordinator.subscribe('events.shutdown', async () => {
    handlerCalls += 1;
    handlerStarted();
    await handlerGate;
  });

  const message = JSON.stringify({
    id: 'event-shutdown-1',
    topic: 'events.shutdown',
    emittedAt: new Date().toISOString(),
    payload: { private: 'must-not-escape' },
  });
  subscriber.deliver(message);
  await didStartHandler;

  const unhandledRejections = [];
  const captureUnhandledRejection = reason => unhandledRejections.push(reason);
  process.on('unhandledRejection', captureUnhandledRejection);
  try {
    let closeSettled = false;
    const close = coordinator.close().then(() => {
      closeSettled = true;
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(closeSettled, false);
    assert.equal(command.closeCalls, 0);
    assert.equal(subscriber.closeCalls, 0);

    subscriber.deliver(message);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(handlerCalls, 1, 'shutdown must reject late deliveries');

    rejectHandler(new Error('late sensitive subscription failure'));
    await close;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(command.closeCalls, 1);
    assert.equal(subscriber.closeCalls, 1);
    assert.deepEqual(unhandledRejections, []);
    assert.equal((await coordinator.health()).ready, false);
  } finally {
    process.off('unhandledRejection', captureUnhandledRejection);
    rejectHandler?.(new Error('test cleanup'));
  }
});

test(
  'real Redis coordinates independent replicas and fails closed after shutdown',
  { skip: !process.env.TEST_REDIS_URL },
  async t => {
    const prefix = `libre-ci:${randomUUID()}`;
    const first = new RedisCoordinator({
      url: process.env.TEST_REDIS_URL,
      keyPrefix: prefix,
    });
    const second = new RedisCoordinator({
      url: process.env.TEST_REDIS_URL,
      keyPrefix: prefix,
    });
    await Promise.all([first.connect(), second.connect()]);
    t.after(() => Promise.allSettled([first.close(), second.close()]));
    assert.equal((await first.health()).ready, true);
    assert.equal((await second.health()).ready, true);

    let delivered;
    const delivery = new Promise(resolve => {
      delivered = resolve;
    });
    const unsubscribe = await second.subscribe('replica.events', event => {
      delivered(event.payload);
    });
    await first.publish('replica.events', { sequence: 1 });
    assert.deepEqual(
      await Promise.race([
        delivery,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Redis pub/sub timed out')), 3_000)
        ),
      ]),
      { sequence: 1 }
    );
    await unsubscribe();

    await first.setCache('replica-cache', { value: 7 }, 5_000);
    assert.deepEqual(await second.getCache('replica-cache'), { value: 7 });
    await first.setCache('replica-single-use', { value: 8 }, 5_000);
    const consumed = await Promise.all([
      first.consumeCache('replica-single-use'),
      second.consumeCache('replica-single-use'),
    ]);
    assert.equal(consumed.filter(Boolean).length, 1);
    assert.deepEqual(consumed.find(Boolean), { value: 8 });

    const sharedRateKey = `replica-rate:${randomUUID()}`;
    const firstRate = await first.consumeRateLimit(sharedRateKey, 2, 5_000);
    const secondRate = await second.consumeRateLimit(sharedRateKey, 2, 5_000);
    assert.equal(firstRate.allowed, true);
    assert.equal(secondRate.remaining, 0);
    assert.equal(
      await second.refundRateLimit(sharedRateKey, firstRate.windowToken),
      true
    );
    assert.equal(
      (await first.consumeRateLimit(sharedRateKey, 2, 5_000)).allowed,
      true
    );
    assert.equal(
      (await second.consumeRateLimit(sharedRateKey, 2, 5_000)).allowed,
      false
    );

    const rotatingRateKey = `rotating-rate:${randomUUID()}`;
    const oldRateWindow = await first.consumeRateLimit(rotatingRateKey, 2, 25);
    await new Promise(resolve => setTimeout(resolve, 40));
    const newRateWindow = await second.consumeRateLimit(
      rotatingRateKey,
      2,
      1_000
    );
    assert.notEqual(newRateWindow.windowToken, oldRateWindow.windowToken);
    assert.equal(
      await first.refundRateLimit(rotatingRateKey, oldRateWindow.windowToken),
      false
    );
    assert.equal(
      (await second.consumeRateLimit(rotatingRateKey, 2, 1_000)).remaining,
      0
    );

    const lease = await first.acquireLease('shared-lock', 5_000);
    assert.ok(lease);
    assert.equal(await second.acquireLease('shared-lock', 5_000), null);
    assert.equal(await lease.release(), true);

    const permits = await Promise.all([
      first.acquireSemaphore('shared-capacity', 2, 5_000),
      second.acquireSemaphore('shared-capacity', 2, 5_000),
    ]);
    assert.ok(permits.every(Boolean));
    assert.equal(
      await first.acquireSemaphore('shared-capacity', 2, 5_000),
      null
    );
    await Promise.all(permits.map(permit => permit.release()));

    const expiringHolder = await first.acquireSemaphore(
      'staggered-capacity',
      2,
      100
    );
    assert.ok(expiringHolder);
    await new Promise(resolve => setTimeout(resolve, 20));
    const laterHolder = await second.acquireSemaphore(
      'staggered-capacity',
      2,
      1_000
    );
    assert.ok(laterHolder);
    await new Promise(resolve => setTimeout(resolve, 120));
    assert.equal(
      await expiringHolder.extend(1_000),
      false,
      'an expired holder must not be resurrected while a later holder keeps the key alive'
    );
    assert.ok(await first.acquireSemaphore('staggered-capacity', 2, 1_000));
    await laterHolder.release();

    const normalClock = new RedisCoordinator({
      url: process.env.TEST_REDIS_URL,
      keyPrefix: prefix,
      now: Date.now,
    });
    const clockAheadReplica = new RedisCoordinator({
      url: process.env.TEST_REDIS_URL,
      keyPrefix: prefix,
      now: () => Date.now() + 31_536_000_000,
    });
    await Promise.all([normalClock.connect(), clockAheadReplica.connect()]);
    t.after(() =>
      Promise.allSettled([normalClock.close(), clockAheadReplica.close()])
    );
    const liveHolder = await normalClock.acquireSemaphore(
      'clock-skew-capacity',
      1,
      5_000
    );
    assert.ok(liveHolder);
    assert.equal(
      await clockAheadReplica.acquireSemaphore('clock-skew-capacity', 1, 5_000),
      null,
      'an app clock that is one year ahead must not evict a live holder'
    );
    await liveHolder.release();

    await normalClock.setPresence('clock-skew-presence', 'normal', 5_000);
    assert.deepEqual(
      await clockAheadReplica.listPresence('clock-skew-presence'),
      ['normal'],
      'an app clock that is one year ahead must not evict live presence'
    );
    await clockAheadReplica.setPresence('clock-skew-presence', 'ahead', 5_000);
    assert.deepEqual(
      await normalClock.listPresence('clock-skew-presence'),
      ['ahead', 'normal'],
      'a skewed publisher must still use the Redis expiry clock'
    );

    await first.setPresence('apps', 'replica-a', 5_000);
    assert.deepEqual(await second.listPresence('apps'), ['replica-a']);
    let revokeDelivered;
    const revokeDelivery = new Promise(resolve => {
      revokeDelivered = resolve;
    });
    const unsubscribeRevocation = await first.subscribe(
      'security.revoked',
      event => revokeDelivered(event.payload)
    );
    const epoch = await second.revoke('user:one');
    assert.equal(await first.getRevocationEpoch('user:one'), epoch);
    assert.deepEqual(
      await Promise.race([
        revokeDelivery,
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error('Redis revoke event timed out')),
            3_000
          )
        ),
      ]),
      { subject: 'user:one', epoch }
    );
    await unsubscribeRevocation();

    await first.close();
    await assert.rejects(
      () => first.getCache('must-fail-closed'),
      CoordinationUnavailableError
    );
  }
);
