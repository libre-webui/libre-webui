/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import { createHash, randomBytes, randomUUID } from 'crypto';
import { createClient } from 'redis';
import {
  assertCoordinationName,
  assertTtl,
  CoordinationUnavailableError,
  type CoordinationEvent,
  type CoordinationEventHandler,
  type CoordinationHealth,
  type CoordinationLease,
  type CoordinationPermit,
  type CoordinationUnsubscribe,
  type Coordinator,
  type RateLimitResult,
} from './types.js';

const MAX_COORDINATION_PAYLOAD_BYTES = 256 * 1024;

interface RedisClientLike {
  isReady: boolean;
  connect(): Promise<unknown>;
  close(): Promise<unknown>;
  destroy(): void;
  on(event: 'error', listener: (error: Error) => void): RedisClientLike;
  ping(): Promise<string>;
  get(key: string): Promise<string | null>;
  set(
    key: string,
    value: string,
    options?: { PX?: number; NX?: boolean }
  ): Promise<string | null>;
  del(key: string): Promise<number>;
  publish(channel: string, message: string): Promise<number>;
  subscribe(
    channel: string,
    listener: (message: string) => void | Promise<void>
  ): Promise<void>;
  unsubscribe(channel: string): Promise<void>;
  eval(
    script: string,
    options: { keys: string[]; arguments: string[] }
  ): Promise<unknown>;
  zAdd(
    key: string,
    members: Array<{ score: number; value: string }>
  ): Promise<number>;
  zRangeByScore(key: string, min: number, max: number): Promise<string[]>;
  zRem(key: string, member: string): Promise<number>;
}

interface RedisSubscriptionState {
  readonly rawSetup: Promise<void>;
  ready: Promise<void>;
  failed: boolean;
  teardown?: Promise<void>;
}

export interface RedisCoordinatorOptions {
  url: string;
  keyPrefix?: string;
  connectTimeoutMs?: number;
  clientFactory?: () => {
    command: RedisClientLike;
    subscriber: RedisClientLike;
  };
  now?: () => number;
}

const ACQUIRE_LEASE_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then
  local fence = redis.call('INCR', KEYS[2])
  redis.call('PSETEX', KEYS[1], ARGV[1], ARGV[2] .. ':' .. fence)
  return fence
end
return 0
`;

const EXTEND_LEASE_SCRIPT = `
local value = redis.call('GET', KEYS[1])
if value and value == ARGV[1] then
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
  return 1
end
return 0
`;

const RELEASE_LEASE_SCRIPT = `
local value = redis.call('GET', KEYS[1])
if value and value == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

const RATE_LIMIT_SCRIPT = `
local token = redis.call('GET', KEYS[2])
if redis.call('EXISTS', KEYS[1]) == 0 or not token then
  token = ARGV[2]
  redis.call('PSETEX', KEYS[1], ARGV[1], 1)
  redis.call('PSETEX', KEYS[2], ARGV[1], token)
  return { 1, tonumber(ARGV[1]), token }
end
local count = redis.call('INCR', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
return { count, ttl, token }
`;

const REFUND_RATE_LIMIT_SCRIPT = `
if redis.call('GET', KEYS[2]) ~= ARGV[1] or redis.call('EXISTS', KEYS[1]) == 0 then
  return 0
end
local count = redis.call('DECR', KEYS[1])
if count <= 0 then
  redis.call('DEL', KEYS[1], KEYS[2])
end
return 1
`;

const CONSUME_CACHE_SCRIPT = `
local value = redis.call('GET', KEYS[1])
if value then
  redis.call('DEL', KEYS[1])
end
return value
`;

const ACQUIRE_SEMAPHORE_SCRIPT = `
local redisTime = redis.call('TIME')
local now = tonumber(redisTime[1]) * 1000 + math.floor(tonumber(redisTime[2]) / 1000)
local ttl = tonumber(ARGV[1])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[2]) then
  return { 0, now }
end
local expiresAt = now + ttl
redis.call('ZADD', KEYS[1], expiresAt, ARGV[3])
local latest = redis.call('ZREVRANGE', KEYS[1], 0, 0, 'WITHSCORES')
if latest[2] then redis.call('PEXPIREAT', KEYS[1], math.floor(latest[2])) end
return { 1, expiresAt }
`;

const EXTEND_SEMAPHORE_SCRIPT = `
local redisTime = redis.call('TIME')
local now = tonumber(redisTime[1]) * 1000 + math.floor(tonumber(redisTime[2]) / 1000)
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
if redis.call('ZSCORE', KEYS[1], ARGV[1]) then
  local expiresAt = now + tonumber(ARGV[2])
  redis.call('ZADD', KEYS[1], expiresAt, ARGV[1])
  local latest = redis.call('ZREVRANGE', KEYS[1], 0, 0, 'WITHSCORES')
  if latest[2] then redis.call('PEXPIREAT', KEYS[1], math.floor(latest[2])) end
  return expiresAt
end
return 0
`;

const SET_PRESENCE_SCRIPT = `
local redisTime = redis.call('TIME')
local now = tonumber(redisTime[1]) * 1000 + math.floor(tonumber(redisTime[2]) / 1000)
local expiresAt = now + tonumber(ARGV[1])
redis.call('ZADD', KEYS[1], expiresAt, ARGV[2])
local latest = redis.call('ZREVRANGE', KEYS[1], 0, 0, 'WITHSCORES')
if latest[2] then redis.call('PEXPIREAT', KEYS[1], math.floor(latest[2])) end
return expiresAt
`;

const LIST_PRESENCE_SCRIPT = `
local redisTime = redis.call('TIME')
local now = tonumber(redisTime[1]) * 1000 + math.floor(tonumber(redisTime[2]) / 1000)
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
local members = redis.call('ZRANGE', KEYS[1], 0, -1)
local latest = redis.call('ZREVRANGE', KEYS[1], 0, 0, 'WITHSCORES')
if latest[2] then redis.call('PEXPIREAT', KEYS[1], math.floor(latest[2])) end
return members
`;

const REVOKE_SCRIPT = `
local epoch = redis.call('INCR', KEYS[1])
local event = cjson.encode({
  id = ARGV[1],
  topic = ARGV[2],
  emittedAt = ARGV[3],
  payload = { subject = ARGV[4], epoch = epoch }
})
redis.call('PUBLISH', KEYS[2], event)
return epoch
`;

/** Redis coordination for shared deployments. Durable state remains in SQL. */
export class RedisCoordinator implements Coordinator {
  readonly backend = 'redis' as const;
  private readonly command: RedisClientLike;
  private readonly subscriber: RedisClientLike;
  private readonly handlers = new Map<
    string,
    Set<CoordinationEventHandler<unknown>>
  >();
  private readonly subscriptionStates = new Map<
    string,
    RedisSubscriptionState
  >();
  private readonly now: () => number;
  private readonly prefix: string;
  private readonly connectTimeoutMs: number;
  private readonly activeSubscriptionDispatches = new Set<Promise<void>>();
  private closing = false;
  private closePromise?: Promise<void>;
  private lastError?: Error;

  constructor(options: RedisCoordinatorOptions) {
    this.prefix = options.keyPrefix?.trim() || 'libre';
    this.connectTimeoutMs = options.connectTimeoutMs || 5_000;
    this.now = options.now || Date.now;
    const clients =
      options.clientFactory?.() || this.createClients(options.url);
    this.command = clients.command;
    this.subscriber = clients.subscriber;
    this.command.on('error', error => {
      this.lastError = error;
    });
    this.subscriber.on('error', error => {
      this.lastError = error;
    });
  }

  async connect(): Promise<void> {
    if (this.closing) {
      throw this.unavailable('Redis coordination is closing.', this.lastError);
    }
    try {
      await this.withTimeout(
        Promise.all([this.command.connect(), this.subscriber.connect()]),
        this.connectTimeoutMs,
        'Redis connection timed out.'
      );
      await this.withTimeout(
        this.command.ping(),
        this.connectTimeoutMs,
        'Redis readiness ping timed out.'
      );
      this.lastError = undefined;
    } catch (error) {
      this.command.destroy();
      this.subscriber.destroy();
      throw this.unavailable('Redis coordination is unavailable.', error);
    }
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.handlers.clear();
    this.subscriptionStates.clear();
    this.closePromise = (async () => {
      // A subscriber callback can still be awaiting an application handler
      // after node-redis has delivered the message. Keep Redis and any
      // persistence dependencies alive until every accepted dispatch settles.
      while (this.activeSubscriptionDispatches.size > 0) {
        await Promise.allSettled([...this.activeSubscriptionDispatches]);
      }
      await Promise.allSettled([
        this.closeClient(this.command),
        this.closeClient(this.subscriber),
      ]);
    })();
    return this.closePromise;
  }

  async health(): Promise<CoordinationHealth> {
    const started = this.now();
    if (!this.command.isReady || !this.subscriber.isReady) {
      return {
        ready: false,
        backend: this.backend,
        latencyMs: 0,
        message: this.lastError?.message || 'Redis clients are not ready.',
      };
    }
    try {
      await this.withTimeout(
        this.command.ping(),
        1_000,
        'Redis ping timed out.'
      );
      return {
        ready: true,
        backend: this.backend,
        latencyMs: Math.max(0, this.now() - started),
      };
    } catch (error) {
      return {
        ready: false,
        backend: this.backend,
        latencyMs: Math.max(0, this.now() - started),
        message: error instanceof Error ? error.message : 'Redis ping failed.',
      };
    }
  }

  async publish<T>(topic: string, payload: T): Promise<CoordinationEvent<T>> {
    this.requireReady();
    const normalizedTopic = assertCoordinationName(topic, 'Topic');
    const event: CoordinationEvent<T> = {
      id: randomUUID(),
      topic: normalizedTopic,
      emittedAt: new Date(this.now()).toISOString(),
      payload,
    };
    const serialized = this.serialize(event);
    try {
      await this.withTimeout(
        this.command.publish(
          this.redisKey('event', normalizedTopic),
          serialized
        ),
        this.connectTimeoutMs,
        'Redis publish timed out.'
      );
      return event;
    } catch (error) {
      throw this.unavailable('Redis publish failed.', error);
    }
  }

  async subscribe<T>(
    topic: string,
    handler: CoordinationEventHandler<T>
  ): Promise<CoordinationUnsubscribe> {
    this.requireReady();
    const normalizedTopic = assertCoordinationName(topic, 'Topic');
    const channel = this.redisKey('event', normalizedTopic);
    const tearingDown = this.subscriptionStates.get(channel)?.teardown;
    if (tearingDown) {
      try {
        await tearingDown;
      } catch (error) {
        throw this.unavailable('Redis subscription teardown failed.', error);
      }
      this.requireReady();
    }
    const handlers = this.handlers.get(channel) || new Set();
    const untypedHandler = handler as CoordinationEventHandler<unknown>;
    handlers.add(untypedHandler);
    this.handlers.set(channel, handlers);
    let state = this.subscriptionStates.get(channel);
    if (!state) {
      const rawSetup = this.subscriber.subscribe(channel, message => {
        if (this.closing) return;
        // node-redis does not observe rejected async listener promises.
        // Contain malformed events and individual handler failures here so
        // a hostile/corrupt pub-sub message cannot become an unhandled
        // process rejection.
        let dispatch: Promise<void>;
        dispatch = this.dispatchSubscriptionMessage(
          channel,
          normalizedTopic,
          message
        )
          .catch(() => {
            this.lastError = new Error(
              'Redis subscription event processing failed.'
            );
          })
          .finally(() => this.activeSubscriptionDispatches.delete(dispatch));
        this.activeSubscriptionDispatches.add(dispatch);
      });
      const created = {
        rawSetup,
        failed: false,
      } as RedisSubscriptionState;
      created.ready = this.withTimeout(
        rawSetup,
        this.connectTimeoutMs,
        'Redis subscription timed out.'
      ).catch(error => {
        created.failed = true;
        void rawSetup
          .then(() =>
            this.withTimeout(
              this.subscriber.unsubscribe(channel),
              this.connectTimeoutMs,
              'Redis late subscription cleanup timed out.'
            )
              .catch(() => undefined)
              .finally(() => {
                if (this.subscriptionStates.get(channel) === created) {
                  this.subscriptionStates.delete(channel);
                }
              })
          )
          .catch(() => {
            if (this.subscriptionStates.get(channel) === created) {
              this.subscriptionStates.delete(channel);
            }
          });
        throw error;
      });
      state = created;
      this.subscriptionStates.set(channel, state);
    }
    try {
      if (state.failed) {
        throw new Error('Redis subscription setup previously failed.');
      }
      await state.ready;
      if (this.closing) {
        throw new Error('Redis coordinator is closing.');
      }
    } catch (error) {
      handlers.delete(untypedHandler);
      if (handlers.size === 0) this.handlers.delete(channel);
      throw this.unavailable('Redis subscription failed.', error);
    }

    return async () => {
      const current = this.handlers.get(channel);
      current?.delete(untypedHandler);
      if (current && current.size === 0) {
        this.handlers.delete(channel);
        const currentState = this.subscriptionStates.get(channel);
        if (!currentState || currentState.failed) return;
        const pendingUnsubscribe = this.subscriber.unsubscribe(channel);
        currentState.teardown = this.withTimeout(
          pendingUnsubscribe,
          this.connectTimeoutMs,
          'Redis unsubscribe timed out.'
        )
          .then(() => {
            if (this.subscriptionStates.get(channel) === currentState) {
              this.subscriptionStates.delete(channel);
            }
          })
          .catch(error => {
            currentState.failed = true;
            void pendingUnsubscribe
              .then(() => {
                if (this.subscriptionStates.get(channel) === currentState) {
                  this.subscriptionStates.delete(channel);
                }
              })
              .catch(() => undefined);
            throw error;
          });
        try {
          await currentState.teardown;
          if (this.subscriptionStates.get(channel) === currentState) {
            this.subscriptionStates.delete(channel);
          }
        } catch (error) {
          throw this.unavailable('Redis unsubscribe failed.', error);
        }
      }
    };
  }

  async getCache<T>(key: string): Promise<T | null> {
    this.requireReady();
    try {
      const value = await this.withTimeout(
        this.command.get(
          this.redisKey('cache', assertCoordinationName(key, 'Cache key'))
        ),
        this.connectTimeoutMs,
        'Redis cache read timed out.'
      );
      return value === null ? null : this.parse<T>(value);
    } catch (error) {
      if (error instanceof CoordinationUnavailableError) throw error;
      throw this.unavailable('Redis cache read failed.', error);
    }
  }

  async setCache<T>(key: string, value: T, ttlMs: number): Promise<void> {
    this.requireReady();
    try {
      await this.withTimeout(
        this.command.set(
          this.redisKey('cache', assertCoordinationName(key, 'Cache key')),
          this.serialize(value),
          { PX: assertTtl(ttlMs) }
        ),
        this.connectTimeoutMs,
        'Redis cache write timed out.'
      );
    } catch (error) {
      throw this.unavailable('Redis cache write failed.', error);
    }
  }

  async consumeCache<T>(key: string): Promise<T | null> {
    this.requireReady();
    try {
      const value = await this.withTimeout(
        this.command.eval(CONSUME_CACHE_SCRIPT, {
          keys: [
            this.redisKey('cache', assertCoordinationName(key, 'Cache key')),
          ],
          arguments: [],
        }),
        this.connectTimeoutMs,
        'Redis cache consume timed out.'
      );
      if (value === null) return null;
      if (typeof value !== 'string') {
        throw new Error('Redis returned an invalid consumed cache value.');
      }
      return this.parse<T>(value);
    } catch (error) {
      if (error instanceof CoordinationUnavailableError) throw error;
      throw this.unavailable('Redis cache consume failed.', error);
    }
  }

  async deleteCache(key: string): Promise<void> {
    this.requireReady();
    try {
      await this.withTimeout(
        this.command.del(
          this.redisKey('cache', assertCoordinationName(key, 'Cache key'))
        ),
        this.connectTimeoutMs,
        'Redis cache delete timed out.'
      );
    } catch (error) {
      throw this.unavailable('Redis cache delete failed.', error);
    }
  }

  async acquireLease(
    key: string,
    ttlMs: number
  ): Promise<CoordinationLease | null> {
    this.requireReady();
    const normalizedKey = assertCoordinationName(key, 'Lease key');
    const ttl = assertTtl(ttlMs);
    const ownerToken = randomBytes(24).toString('base64url');
    const leaseKey = this.redisKey('lease', normalizedKey);
    const fenceKey = this.redisKey('fence', normalizedKey);
    try {
      let abandoned = false;
      const pendingAcquire = this.command.eval(ACQUIRE_LEASE_SCRIPT, {
        keys: [leaseKey, fenceKey],
        arguments: [String(ttl), ownerToken],
      });
      void pendingAcquire
        .then(value => {
          const fencingToken = Number(value);
          if (
            !abandoned ||
            !Number.isSafeInteger(fencingToken) ||
            fencingToken <= 0
          ) {
            return;
          }
          void this.withTimeout(
            this.command.eval(RELEASE_LEASE_SCRIPT, {
              keys: [leaseKey],
              arguments: [`${ownerToken}:${fencingToken}`],
            }),
            this.connectTimeoutMs,
            'Redis late lease cleanup timed out.'
          ).catch(() => undefined);
        })
        .catch(() => undefined);
      let acquired: unknown;
      try {
        acquired = await this.withTimeout(
          pendingAcquire,
          this.connectTimeoutMs,
          'Redis lease acquisition timed out.'
        );
      } catch (error) {
        abandoned = true;
        throw error;
      }
      const result = Number(acquired);
      if (!Number.isSafeInteger(result) || result <= 0) return null;
      const storedValue = `${ownerToken}:${result}`;
      const lease: CoordinationLease = {
        key: normalizedKey,
        ownerToken,
        fencingToken: result,
        expiresAt: this.now() + ttl,
        extend: async nextTtl => {
          const next = assertTtl(nextTtl);
          try {
            const extended = Number(
              await this.withTimeout(
                this.command.eval(EXTEND_LEASE_SCRIPT, {
                  keys: [leaseKey],
                  arguments: [storedValue, String(next)],
                }),
                this.connectTimeoutMs,
                'Redis lease renewal timed out.'
              )
            );
            if (extended === 1) lease.expiresAt = this.now() + next;
            return extended === 1;
          } catch (error) {
            throw this.unavailable('Redis lease renewal failed.', error);
          }
        },
        release: async () => {
          try {
            return (
              Number(
                await this.withTimeout(
                  this.command.eval(RELEASE_LEASE_SCRIPT, {
                    keys: [leaseKey],
                    arguments: [storedValue],
                  }),
                  this.connectTimeoutMs,
                  'Redis lease release timed out.'
                )
              ) === 1
            );
          } catch (error) {
            throw this.unavailable('Redis lease release failed.', error);
          }
        },
      };
      return lease;
    } catch (error) {
      throw this.unavailable('Redis lease operation failed.', error);
    }
  }

  async consumeRateLimit(
    key: string,
    limit: number,
    windowMs: number
  ): Promise<RateLimitResult> {
    this.requireReady();
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new Error('Rate-limit capacity must be a positive integer.');
    }
    const window = assertTtl(windowMs);
    try {
      const result = (await this.withTimeout(
        this.command.eval(RATE_LIMIT_SCRIPT, {
          keys: [
            this.redisKey(
              'rate',
              assertCoordinationName(key, 'Rate-limit key')
            ),
            this.redisKey(
              'rate-window',
              assertCoordinationName(key, 'Rate-limit key')
            ),
          ],
          arguments: [String(window), randomUUID()],
        }),
        this.connectTimeoutMs,
        'Redis rate-limit operation timed out.'
      )) as [number | string, number | string, string];
      const count = Number(result[0]);
      const remainingTtl = Math.max(0, Number(result[1]));
      return {
        allowed: count <= limit,
        remaining: Math.max(0, limit - count),
        resetAt: this.now() + remainingTtl,
        windowToken: result[2],
      };
    } catch (error) {
      throw this.unavailable('Redis rate-limit operation failed.', error);
    }
  }

  async refundRateLimit(key: string, windowToken: string): Promise<boolean> {
    this.requireReady();
    try {
      const normalizedKey = assertCoordinationName(key, 'Rate-limit key');
      const normalizedWindowToken = assertCoordinationName(
        windowToken,
        'Rate-limit window token'
      );
      return (
        Number(
          await this.withTimeout(
            this.command.eval(REFUND_RATE_LIMIT_SCRIPT, {
              keys: [
                this.redisKey('rate', normalizedKey),
                this.redisKey('rate-window', normalizedKey),
              ],
              arguments: [normalizedWindowToken],
            }),
            this.connectTimeoutMs,
            'Redis rate-limit refund timed out.'
          )
        ) === 1
      );
    } catch (error) {
      throw this.unavailable('Redis rate-limit refund failed.', error);
    }
  }

  async acquireSemaphore(
    key: string,
    capacity: number,
    ttlMs: number
  ): Promise<CoordinationPermit | null> {
    this.requireReady();
    const normalizedKey = assertCoordinationName(key, 'Semaphore key');
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 10_000) {
      throw new Error('Semaphore capacity must be an integer from 1 to 10000.');
    }
    const ttl = assertTtl(ttlMs);
    const ownerToken = randomBytes(24).toString('base64url');
    const semaphoreKey = this.redisKey('semaphore', normalizedKey);
    try {
      let abandoned = false;
      const pendingAcquire = this.command.eval(ACQUIRE_SEMAPHORE_SCRIPT, {
        keys: [semaphoreKey],
        arguments: [String(ttl), String(capacity), ownerToken],
      });
      void pendingAcquire
        .then(value => {
          const late = value as [number | string, number | string];
          if (!abandoned || Number(late[0]) !== 1) return;
          void this.withTimeout(
            this.command.zRem(semaphoreKey, ownerToken),
            this.connectTimeoutMs,
            'Redis late semaphore cleanup timed out.'
          ).catch(() => undefined);
        })
        .catch(() => undefined);
      let acquired: unknown;
      try {
        acquired = await this.withTimeout(
          pendingAcquire,
          this.connectTimeoutMs,
          'Redis semaphore acquisition timed out.'
        );
      } catch (error) {
        abandoned = true;
        throw error;
      }
      const result = acquired as [number | string, number | string];
      if (Number(result[0]) !== 1) return null;
      const expiresAt = Number(result[1]);
      const permit: CoordinationPermit = {
        key: normalizedKey,
        ownerToken,
        expiresAt,
        extend: async nextTtl => {
          const next = assertTtl(nextTtl);
          const nextExpiry = Number(
            await this.withTimeout(
              this.command.eval(EXTEND_SEMAPHORE_SCRIPT, {
                keys: [semaphoreKey],
                arguments: [ownerToken, String(next)],
              }),
              this.connectTimeoutMs,
              'Redis semaphore renewal timed out.'
            )
          );
          if (nextExpiry > 0) permit.expiresAt = nextExpiry;
          return nextExpiry > 0;
        },
        release: async () =>
          (await this.withTimeout(
            this.command.zRem(semaphoreKey, ownerToken),
            this.connectTimeoutMs,
            'Redis semaphore release timed out.'
          )) === 1,
      };
      return permit;
    } catch (error) {
      throw this.unavailable('Redis semaphore operation failed.', error);
    }
  }

  async setPresence(
    scope: string,
    memberId: string,
    ttlMs: number
  ): Promise<void> {
    this.requireReady();
    const key = this.redisKey(
      'presence',
      assertCoordinationName(scope, 'Presence scope')
    );
    const member = assertCoordinationName(memberId, 'Presence member ID');
    try {
      await this.withTimeout(
        this.command.eval(SET_PRESENCE_SCRIPT, {
          keys: [key],
          arguments: [String(assertTtl(ttlMs)), member],
        }),
        this.connectTimeoutMs,
        'Redis presence update timed out.'
      );
    } catch (error) {
      throw this.unavailable('Redis presence update failed.', error);
    }
  }

  async listPresence(scope: string): Promise<string[]> {
    this.requireReady();
    const key = this.redisKey(
      'presence',
      assertCoordinationName(scope, 'Presence scope')
    );
    try {
      const members = (await this.withTimeout(
        this.command.eval(LIST_PRESENCE_SCRIPT, {
          keys: [key],
          arguments: [],
        }),
        this.connectTimeoutMs,
        'Redis presence read timed out.'
      )) as string[];
      return members.sort();
    } catch (error) {
      throw this.unavailable('Redis presence read failed.', error);
    }
  }

  async clearPresence(scope: string, memberId: string): Promise<void> {
    this.requireReady();
    const key = this.redisKey(
      'presence',
      assertCoordinationName(scope, 'Presence scope')
    );
    try {
      await this.withTimeout(
        this.command.zRem(
          key,
          assertCoordinationName(memberId, 'Presence member ID')
        ),
        this.connectTimeoutMs,
        'Redis presence removal timed out.'
      );
    } catch (error) {
      throw this.unavailable('Redis presence removal failed.', error);
    }
  }

  async getRevocationEpoch(subject: string): Promise<number> {
    this.requireReady();
    try {
      const value = await this.withTimeout(
        this.command.get(
          this.redisKey(
            'revocation',
            assertCoordinationName(subject, 'Revocation subject')
          )
        ),
        this.connectTimeoutMs,
        'Redis revocation read timed out.'
      );
      const epoch = value === null ? 0 : Number(value);
      if (!Number.isSafeInteger(epoch) || epoch < 0) {
        throw new Error('Invalid revocation epoch.');
      }
      return epoch;
    } catch (error) {
      throw this.unavailable('Redis revocation read failed.', error);
    }
  }

  async revoke(subject: string): Promise<number> {
    this.requireReady();
    const normalized = assertCoordinationName(subject, 'Revocation subject');
    const topic = 'security.revoked';
    try {
      const epoch = Number(
        await this.withTimeout(
          this.command.eval(REVOKE_SCRIPT, {
            keys: [
              this.redisKey('revocation', normalized),
              this.redisKey('event', topic),
            ],
            arguments: [
              randomUUID(),
              topic,
              new Date(this.now()).toISOString(),
              normalized,
            ],
          }),
          this.connectTimeoutMs,
          'Redis revocation update timed out.'
        )
      );
      if (!Number.isSafeInteger(epoch) || epoch < 1) {
        throw new Error('Invalid revocation epoch.');
      }
      return epoch;
    } catch (error) {
      throw this.unavailable('Redis revocation update failed.', error);
    }
  }

  private createClients(url: string) {
    const command = createClient({ url });
    return {
      command: command as unknown as RedisClientLike,
      subscriber: command.duplicate() as unknown as RedisClientLike,
    };
  }

  private async closeClient(client: RedisClientLike): Promise<void> {
    if (!client.isReady) {
      client.destroy();
      return;
    }
    try {
      await this.withTimeout(
        client.close(),
        this.connectTimeoutMs,
        'Redis client close timed out.'
      );
    } catch {
      client.destroy();
    }
  }

  private async dispatchSubscriptionMessage(
    channel: string,
    expectedTopic: string,
    message: string
  ): Promise<void> {
    try {
      const event = this.parse<CoordinationEvent<unknown>>(message);
      if (
        !event ||
        typeof event !== 'object' ||
        typeof event.id !== 'string' ||
        event.id.length < 1 ||
        event.id.length > 128 ||
        event.topic !== expectedTopic ||
        typeof event.emittedAt !== 'string' ||
        !Number.isFinite(Date.parse(event.emittedAt)) ||
        !Object.prototype.hasOwnProperty.call(event, 'payload')
      ) {
        throw new Error('Invalid coordination event envelope.');
      }
      const outcomes = await Promise.allSettled(
        [...(this.handlers.get(channel) || [])].map(callback => callback(event))
      );
      if (outcomes.some(outcome => outcome.status === 'rejected')) {
        throw new Error('A coordination event handler failed.');
      }
    } catch {
      // Preserve only a redacted diagnostic. Never retain payloads, handler
      // errors, Redis URLs, or credentials in coordinator health state.
      this.lastError = new Error('Redis subscription event processing failed.');
    }
  }

  private redisKey(kind: string, input: string): string {
    const digest = createHash('sha256').update(input).digest('base64url');
    return `${this.prefix}:${kind}:${digest}`;
  }

  private serialize(value: unknown): string {
    const serialized = JSON.stringify(value);
    if (
      Buffer.byteLength(serialized, 'utf8') > MAX_COORDINATION_PAYLOAD_BYTES
    ) {
      throw new Error('Coordination payload exceeds 256 KiB.');
    }
    return serialized;
  }

  private parse<T>(value: string): T {
    if (Buffer.byteLength(value, 'utf8') > MAX_COORDINATION_PAYLOAD_BYTES) {
      throw new Error('Coordination payload exceeds 256 KiB.');
    }
    return JSON.parse(value) as T;
  }

  private requireReady(): void {
    if (this.closing || !this.command.isReady || !this.subscriber.isReady) {
      throw this.unavailable(
        'Redis coordination is not ready.',
        this.lastError
      );
    }
  }

  private unavailable(
    message: string,
    cause: unknown
  ): CoordinationUnavailableError {
    const error =
      cause instanceof Error ? cause : new Error(String(cause || message));
    this.lastError = error;
    return new CoordinationUnavailableError(message, error);
  }

  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    message: string
  ): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(message)), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
