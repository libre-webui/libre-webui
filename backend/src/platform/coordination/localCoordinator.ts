/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import { randomBytes, randomUUID } from 'crypto';
import {
  assertCoordinationName,
  assertTtl,
  type CoordinationEvent,
  type CoordinationEventHandler,
  type CoordinationHealth,
  type CoordinationLease,
  type CoordinationPermit,
  type CoordinationUnsubscribe,
  type Coordinator,
  type RateLimitResult,
} from './types.js';

interface ExpiringValue {
  value: unknown;
  expiresAt: number;
}

interface LocalLeaseRecord {
  ownerToken: string;
  fencingToken: number;
  expiresAt: number;
}

/**
 * In-process coordinator for the supported one-replica solo profile.
 * It is intentionally never selected as a fallback for a failed Redis client.
 */
export class LocalCoordinator implements Coordinator {
  readonly backend = 'local' as const;
  private readonly cache = new Map<string, ExpiringValue>();
  private nextCacheExpiry = Number.POSITIVE_INFINITY;
  private readonly leases = new Map<string, LocalLeaseRecord>();
  private nextLeaseExpiry = Number.POSITIVE_INFINITY;
  private readonly rateLimits = new Map<
    string,
    { count: number; resetAt: number; windowToken: string }
  >();
  private nextRateLimitExpiry = Number.POSITIVE_INFINITY;
  private readonly semaphores = new Map<
    string,
    Map<string, { expiresAt: number }>
  >();
  private nextSemaphoreExpiry = Number.POSITIVE_INFINITY;
  private readonly presence = new Map<string, Map<string, number>>();
  private nextPresenceExpiry = Number.POSITIVE_INFINITY;
  private readonly revocations = new Map<string, number>();
  private readonly handlers = new Map<
    string,
    Set<CoordinationEventHandler<unknown>>
  >();
  private fencingToken = 0;
  private connected = false;

  constructor(private readonly now: () => number = Date.now) {}

  async connect(): Promise<void> {
    this.connected = true;
  }

  async close(): Promise<void> {
    this.connected = false;
    this.cache.clear();
    this.nextCacheExpiry = Number.POSITIVE_INFINITY;
    this.leases.clear();
    this.nextLeaseExpiry = Number.POSITIVE_INFINITY;
    this.rateLimits.clear();
    this.nextRateLimitExpiry = Number.POSITIVE_INFINITY;
    this.semaphores.clear();
    this.nextSemaphoreExpiry = Number.POSITIVE_INFINITY;
    this.presence.clear();
    this.nextPresenceExpiry = Number.POSITIVE_INFINITY;
    this.revocations.clear();
    this.handlers.clear();
  }

  async health(): Promise<CoordinationHealth> {
    return {
      ready: this.connected,
      backend: this.backend,
      latencyMs: 0,
      ...(!this.connected
        ? { message: 'Local coordinator is not connected.' }
        : {}),
    };
  }

  async publish<T>(topic: string, payload: T): Promise<CoordinationEvent<T>> {
    this.requireConnected();
    const normalizedTopic = assertCoordinationName(topic, 'Topic');
    const event: CoordinationEvent<T> = {
      id: randomUUID(),
      topic: normalizedTopic,
      emittedAt: new Date(this.now()).toISOString(),
      payload,
    };
    const handlers = [...(this.handlers.get(normalizedTopic) || [])];
    await Promise.all(handlers.map(handler => handler(event)));
    return event;
  }

  async subscribe<T>(
    topic: string,
    handler: CoordinationEventHandler<T>
  ): Promise<CoordinationUnsubscribe> {
    this.requireConnected();
    const normalizedTopic = assertCoordinationName(topic, 'Topic');
    const handlers = this.handlers.get(normalizedTopic) || new Set();
    const untypedHandler = handler as CoordinationEventHandler<unknown>;
    handlers.add(untypedHandler);
    this.handlers.set(normalizedTopic, handlers);
    return async () => {
      handlers.delete(untypedHandler);
      if (handlers.size === 0) this.handlers.delete(normalizedTopic);
    };
  }

  async getCache<T>(key: string): Promise<T | null> {
    this.requireConnected();
    this.sweepExpiredCache(this.now());
    const normalizedKey = assertCoordinationName(key, 'Cache key');
    const entry = this.cache.get(normalizedKey);
    if (!entry) return null;
    return structuredClone(entry.value) as T;
  }

  async setCache<T>(key: string, value: T, ttlMs: number): Promise<void> {
    this.requireConnected();
    const normalizedKey = assertCoordinationName(key, 'Cache key');
    const now = this.now();
    this.sweepExpiredCache(now);
    const expiresAt = now + assertTtl(ttlMs);
    this.cache.set(normalizedKey, {
      value: structuredClone(value),
      expiresAt,
    });
    this.nextCacheExpiry = Math.min(this.nextCacheExpiry, expiresAt);
  }

  async consumeCache<T>(key: string): Promise<T | null> {
    this.requireConnected();
    const now = this.now();
    this.sweepExpiredCache(now);
    const normalizedKey = assertCoordinationName(key, 'Cache key');
    const entry = this.cache.get(normalizedKey);
    if (!entry) return null;

    // Delete before checking expiry or returning the value so concurrent and
    // invalid consumers can never replay a one-use credential.
    this.cache.delete(normalizedKey);
    return structuredClone(entry.value) as T;
  }

  async deleteCache(key: string): Promise<void> {
    this.requireConnected();
    this.cache.delete(assertCoordinationName(key, 'Cache key'));
  }

  async acquireLease(
    key: string,
    ttlMs: number
  ): Promise<CoordinationLease | null> {
    this.requireConnected();
    const normalizedKey = assertCoordinationName(key, 'Lease key');
    const ttl = assertTtl(ttlMs);
    this.sweepExpiredLeases(this.now());
    const existing = this.leases.get(normalizedKey);
    if (existing && existing.expiresAt > this.now()) return null;

    const ownerToken = randomBytes(24).toString('base64url');
    const record: LocalLeaseRecord = {
      ownerToken,
      fencingToken: ++this.fencingToken,
      expiresAt: this.now() + ttl,
    };
    this.leases.set(normalizedKey, record);
    this.nextLeaseExpiry = Math.min(this.nextLeaseExpiry, record.expiresAt);

    return {
      key: normalizedKey,
      ownerToken,
      fencingToken: record.fencingToken,
      expiresAt: record.expiresAt,
      extend: async nextTtl => {
        const current = this.leases.get(normalizedKey);
        if (
          !current ||
          current.ownerToken !== ownerToken ||
          current.expiresAt <= this.now()
        ) {
          return false;
        }
        current.expiresAt = this.now() + assertTtl(nextTtl);
        this.nextLeaseExpiry = Math.min(
          this.nextLeaseExpiry,
          current.expiresAt
        );
        return true;
      },
      release: async () => {
        const current = this.leases.get(normalizedKey);
        if (!current || current.ownerToken !== ownerToken) return false;
        this.leases.delete(normalizedKey);
        return true;
      },
    };
  }

  async consumeRateLimit(
    key: string,
    limit: number,
    windowMs: number
  ): Promise<RateLimitResult> {
    this.requireConnected();
    const normalizedKey = assertCoordinationName(key, 'Rate-limit key');
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new Error('Rate-limit capacity must be a positive integer.');
    }
    const window = assertTtl(windowMs);
    const now = this.now();
    this.sweepExpiredRateLimits(now);
    let bucket = this.rateLimits.get(normalizedKey);
    if (!bucket || bucket.resetAt <= now) {
      bucket = {
        count: 0,
        resetAt: now + window,
        windowToken: randomUUID(),
      };
      this.rateLimits.set(normalizedKey, bucket);
      this.nextRateLimitExpiry = Math.min(
        this.nextRateLimitExpiry,
        bucket.resetAt
      );
    }
    bucket.count += 1;
    return {
      allowed: bucket.count <= limit,
      remaining: Math.max(0, limit - bucket.count),
      resetAt: bucket.resetAt,
      windowToken: bucket.windowToken,
    };
  }

  async refundRateLimit(key: string, windowToken: string): Promise<boolean> {
    this.requireConnected();
    const normalizedKey = assertCoordinationName(key, 'Rate-limit key');
    const normalizedWindowToken = assertCoordinationName(
      windowToken,
      'Rate-limit window token'
    );
    this.sweepExpiredRateLimits(this.now());
    const bucket = this.rateLimits.get(normalizedKey);
    if (!bucket) return false;
    if (bucket.windowToken !== normalizedWindowToken) return false;
    bucket.count -= 1;
    if (bucket.count <= 0) this.rateLimits.delete(normalizedKey);
    return true;
  }

  async acquireSemaphore(
    key: string,
    capacity: number,
    ttlMs: number
  ): Promise<CoordinationPermit | null> {
    this.requireConnected();
    const normalizedKey = assertCoordinationName(key, 'Semaphore key');
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 10_000) {
      throw new Error('Semaphore capacity must be an integer from 1 to 10000.');
    }
    const ttl = assertTtl(ttlMs);
    const now = this.now();
    this.sweepExpiredSemaphores(now);
    const holders = this.semaphores.get(normalizedKey) || new Map();
    for (const [token, record] of holders) {
      if (record.expiresAt <= now) holders.delete(token);
    }
    if (holders.size >= capacity) return null;
    const ownerToken = randomBytes(24).toString('base64url');
    const record = { expiresAt: now + ttl };
    holders.set(ownerToken, record);
    this.semaphores.set(normalizedKey, holders);
    this.nextSemaphoreExpiry = Math.min(
      this.nextSemaphoreExpiry,
      record.expiresAt
    );
    const permit: CoordinationPermit = {
      key: normalizedKey,
      ownerToken,
      expiresAt: record.expiresAt,
      extend: async nextTtl => {
        this.requireConnected();
        const current = holders.get(ownerToken);
        if (!current || current.expiresAt <= this.now()) {
          holders.delete(ownerToken);
          if (
            holders.size === 0 &&
            this.semaphores.get(normalizedKey) === holders
          ) {
            this.semaphores.delete(normalizedKey);
          }
          return false;
        }
        current.expiresAt = this.now() + assertTtl(nextTtl);
        this.nextSemaphoreExpiry = Math.min(
          this.nextSemaphoreExpiry,
          current.expiresAt
        );
        permit.expiresAt = current.expiresAt;
        return true;
      },
      release: async () => {
        this.requireConnected();
        const deleted = holders.delete(ownerToken);
        if (
          holders.size === 0 &&
          this.semaphores.get(normalizedKey) === holders
        ) {
          this.semaphores.delete(normalizedKey);
        }
        return deleted;
      },
    };
    return permit;
  }

  async setPresence(
    scope: string,
    memberId: string,
    ttlMs: number
  ): Promise<void> {
    this.requireConnected();
    const now = this.now();
    this.sweepExpiredPresence(now);
    const normalizedScope = assertCoordinationName(scope, 'Presence scope');
    const normalizedMember = assertCoordinationName(
      memberId,
      'Presence member ID'
    );
    const members = this.presence.get(normalizedScope) || new Map();
    const expiresAt = now + assertTtl(ttlMs);
    members.set(normalizedMember, expiresAt);
    this.presence.set(normalizedScope, members);
    this.nextPresenceExpiry = Math.min(this.nextPresenceExpiry, expiresAt);
  }

  async listPresence(scope: string): Promise<string[]> {
    this.requireConnected();
    this.sweepExpiredPresence(this.now());
    const normalizedScope = assertCoordinationName(scope, 'Presence scope');
    const members = this.presence.get(normalizedScope);
    if (!members) return [];
    return [...members.keys()].sort();
  }

  async clearPresence(scope: string, memberId: string): Promise<void> {
    this.requireConnected();
    const normalizedScope = assertCoordinationName(scope, 'Presence scope');
    const normalizedMember = assertCoordinationName(
      memberId,
      'Presence member ID'
    );
    const members = this.presence.get(normalizedScope);
    members?.delete(normalizedMember);
    if (members?.size === 0) this.presence.delete(normalizedScope);
  }

  async getRevocationEpoch(subject: string): Promise<number> {
    this.requireConnected();
    return (
      this.revocations.get(
        assertCoordinationName(subject, 'Revocation subject')
      ) ?? 0
    );
  }

  async revoke(subject: string): Promise<number> {
    this.requireConnected();
    const normalized = assertCoordinationName(subject, 'Revocation subject');
    const next = (this.revocations.get(normalized) ?? 0) + 1;
    if (!Number.isSafeInteger(next)) {
      throw new Error('Revocation epoch exceeded the supported range.');
    }
    this.revocations.set(normalized, next);
    await this.publish('security.revoked', {
      subject: normalized,
      epoch: next,
    });
    return next;
  }

  private requireConnected(): void {
    if (!this.connected) throw new Error('Local coordinator is not connected.');
  }

  private sweepExpiredRateLimits(now: number): void {
    if (now < this.nextRateLimitExpiry) return;
    this.nextRateLimitExpiry = Number.POSITIVE_INFINITY;
    for (const [key, bucket] of this.rateLimits) {
      if (bucket.resetAt <= now) this.rateLimits.delete(key);
      else {
        this.nextRateLimitExpiry = Math.min(
          this.nextRateLimitExpiry,
          bucket.resetAt
        );
      }
    }
  }

  private sweepExpiredCache(now: number): void {
    if (now < this.nextCacheExpiry) return;
    this.nextCacheExpiry = Number.POSITIVE_INFINITY;
    for (const [key, entry] of this.cache) {
      if (entry.expiresAt <= now) this.cache.delete(key);
      else {
        this.nextCacheExpiry = Math.min(this.nextCacheExpiry, entry.expiresAt);
      }
    }
  }

  private sweepExpiredLeases(now: number): void {
    if (now < this.nextLeaseExpiry) return;
    this.nextLeaseExpiry = Number.POSITIVE_INFINITY;
    for (const [key, lease] of this.leases) {
      if (lease.expiresAt <= now) this.leases.delete(key);
      else {
        this.nextLeaseExpiry = Math.min(this.nextLeaseExpiry, lease.expiresAt);
      }
    }
  }

  private sweepExpiredSemaphores(now: number): void {
    if (now < this.nextSemaphoreExpiry) return;
    this.nextSemaphoreExpiry = Number.POSITIVE_INFINITY;
    for (const [key, holders] of this.semaphores) {
      for (const [token, record] of holders) {
        if (record.expiresAt <= now) holders.delete(token);
        else {
          this.nextSemaphoreExpiry = Math.min(
            this.nextSemaphoreExpiry,
            record.expiresAt
          );
        }
      }
      if (holders.size === 0) this.semaphores.delete(key);
    }
  }

  private sweepExpiredPresence(now: number): void {
    if (now < this.nextPresenceExpiry) return;
    this.nextPresenceExpiry = Number.POSITIVE_INFINITY;
    for (const [scope, members] of this.presence) {
      for (const [member, expiresAt] of members) {
        if (expiresAt <= now) members.delete(member);
        else {
          this.nextPresenceExpiry = Math.min(
            this.nextPresenceExpiry,
            expiresAt
          );
        }
      }
      if (members.size === 0) this.presence.delete(scope);
    }
  }
}
