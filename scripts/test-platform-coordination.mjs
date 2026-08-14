/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

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

  assert.deepEqual(await coordinator.consumeRateLimit('api:user-a', 2, 100), {
    allowed: true,
    remaining: 1,
    resetAt: now + 100,
  });
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
  assert.equal(await coordinator.revoke('session:user-a'), 1);
  assert.equal(await coordinator.revoke('session:user-a'), 2);
  assert.equal(await coordinator.getRevocationEpoch('session:user-a'), 2);

  await coordinator.close();
  assert.equal((await coordinator.health()).ready, false);
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

    await first.setPresence('apps', 'replica-a', 5_000);
    assert.deepEqual(await second.listPresence('apps'), ['replica-a']);
    const epoch = await second.revoke('user:one');
    assert.equal(await first.getRevocationEpoch('user:one'), epoch);

    await first.close();
    await assert.rejects(
      () => first.getCache('must-fail-closed'),
      CoordinationUnavailableError
    );
  }
);
