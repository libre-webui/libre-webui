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

import {
  assertPlatformRuntimeConfig,
  PlatformConfigurationError,
  resolvePlatformRuntimeConfig,
  summarizePlatformRuntimeConfig,
} from '../backend/dist/platform/runtimeConfig.js';
import {
  CoordinationUnavailableError,
  LocalCoordinator,
  RedisCoordinator,
} from '../backend/dist/platform/coordination/index.js';

test('solo profile is local-first and contains no implicit network dependency', () => {
  const config = assertPlatformRuntimeConfig(resolvePlatformRuntimeConfig({}));
  assert.deepEqual(summarizePlatformRuntimeConfig(config), {
    mode: 'solo',
    database: 'sqlite',
    blobs: 'local',
    vectors: 'embedded',
    coordination: 'local',
    jobs: 'embedded',
    configured: { databaseUrl: false, redisUrl: false },
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
      return true;
    }
  );
});

test('team configuration stays blocked until every selected adapter is implemented', () => {
  const config = resolvePlatformRuntimeConfig({
    LIBRE_PLATFORM_MODE: 'team',
    DATABASE_BACKEND: 'postgres',
    DATABASE_URL: 'postgresql://operator:secret@db.example.test/libre',
    BLOB_STORE_BACKEND: 's3',
    VECTOR_STORE_BACKEND: 'pgvector',
    COORDINATION_BACKEND: 'redis',
    REDIS_URL: 'rediss://operator:secret@redis.example.test/0',
    JOB_WORKER_MODE: 'external',
  });
  const summary = JSON.stringify(summarizePlatformRuntimeConfig(config));
  assert.doesNotMatch(summary, /operator|secret|example\.test/);
  assert.equal(config.coordination.redisUrl?.startsWith('rediss:'), true);
  assert.throws(
    () => assertPlatformRuntimeConfig(config),
    error => {
      assert.ok(error instanceof PlatformConfigurationError);
      assert.match(error.message, /PostgreSQL repositories/);
      assert.match(error.message, /tested S3 adapter/);
      assert.match(error.message, /tested PGVector adapter/);
      assert.match(error.message, /external worker runtime/);
      return true;
    }
  );
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
        DATABASE_URL:
          'postgresql://sentinel-user:sentinel-password@db.example.test/libre',
        OPEN_BROWSER: 'false',
      },
      encoding: 'utf8',
      timeout: 10_000,
    }
  );
  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}\n${result.stdout}`, /unavailable/i);
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
      DATABASE_URL:
        'postgresql://sentinel-user:sentinel-password@db.example.test/libre',
      OPEN_BROWSER: 'false',
    },
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}\n${result.stdout}`, /unavailable/i);
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
