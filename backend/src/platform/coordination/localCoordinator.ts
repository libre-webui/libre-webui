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
  private readonly leases = new Map<string, LocalLeaseRecord>();
  private readonly rateLimits = new Map<
    string,
    { count: number; resetAt: number }
  >();
  private readonly semaphores = new Map<
    string,
    Map<string, { expiresAt: number }>
  >();
  private readonly presence = new Map<string, Map<string, number>>();
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
    this.leases.clear();
    this.rateLimits.clear();
    this.semaphores.clear();
    this.presence.clear();
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
    const normalizedKey = assertCoordinationName(key, 'Cache key');
    const entry = this.cache.get(normalizedKey);
    if (!entry) return null;
    if (entry.expiresAt <= this.now()) {
      this.cache.delete(normalizedKey);
      return null;
    }
    return structuredClone(entry.value) as T;
  }

  async setCache<T>(key: string, value: T, ttlMs: number): Promise<void> {
    this.requireConnected();
    const normalizedKey = assertCoordinationName(key, 'Cache key');
    this.cache.set(normalizedKey, {
      value: structuredClone(value),
      expiresAt: this.now() + assertTtl(ttlMs),
    });
  }

  async consumeCache<T>(key: string): Promise<T | null> {
    this.requireConnected();
    const normalizedKey = assertCoordinationName(key, 'Cache key');
    const entry = this.cache.get(normalizedKey);
    if (!entry) return null;

    // Delete before checking expiry or returning the value so concurrent and
    // invalid consumers can never replay a one-use credential.
    this.cache.delete(normalizedKey);
    if (entry.expiresAt <= this.now()) return null;
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
    const existing = this.leases.get(normalizedKey);
    if (existing && existing.expiresAt > this.now()) return null;

    const ownerToken = randomBytes(24).toString('base64url');
    const record: LocalLeaseRecord = {
      ownerToken,
      fencingToken: ++this.fencingToken,
      expiresAt: this.now() + ttl,
    };
    this.leases.set(normalizedKey, record);

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
    let bucket = this.rateLimits.get(normalizedKey);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + window };
      this.rateLimits.set(normalizedKey, bucket);
    }
    bucket.count += 1;
    return {
      allowed: bucket.count <= limit,
      remaining: Math.max(0, limit - bucket.count),
      resetAt: bucket.resetAt,
    };
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
    const holders = this.semaphores.get(normalizedKey) || new Map();
    for (const [token, record] of holders) {
      if (record.expiresAt <= now) holders.delete(token);
    }
    if (holders.size >= capacity) return null;
    const ownerToken = randomBytes(24).toString('base64url');
    const record = { expiresAt: now + ttl };
    holders.set(ownerToken, record);
    this.semaphores.set(normalizedKey, holders);
    const permit: CoordinationPermit = {
      key: normalizedKey,
      ownerToken,
      expiresAt: record.expiresAt,
      extend: async nextTtl => {
        const current = holders.get(ownerToken);
        if (!current || current.expiresAt <= this.now()) {
          holders.delete(ownerToken);
          return false;
        }
        current.expiresAt = this.now() + assertTtl(nextTtl);
        permit.expiresAt = current.expiresAt;
        return true;
      },
      release: async () => holders.delete(ownerToken),
    };
    return permit;
  }

  async setPresence(
    scope: string,
    memberId: string,
    ttlMs: number
  ): Promise<void> {
    this.requireConnected();
    const normalizedScope = assertCoordinationName(scope, 'Presence scope');
    const normalizedMember = assertCoordinationName(
      memberId,
      'Presence member ID'
    );
    const members = this.presence.get(normalizedScope) || new Map();
    members.set(normalizedMember, this.now() + assertTtl(ttlMs));
    this.presence.set(normalizedScope, members);
  }

  async listPresence(scope: string): Promise<string[]> {
    this.requireConnected();
    const normalizedScope = assertCoordinationName(scope, 'Presence scope');
    const members = this.presence.get(normalizedScope);
    if (!members) return [];
    const now = this.now();
    for (const [member, expiresAt] of members) {
      if (expiresAt <= now) members.delete(member);
    }
    return [...members.keys()].sort();
  }

  async clearPresence(scope: string, memberId: string): Promise<void> {
    this.requireConnected();
    const normalizedScope = assertCoordinationName(scope, 'Presence scope');
    const normalizedMember = assertCoordinationName(
      memberId,
      'Presence member ID'
    );
    this.presence.get(normalizedScope)?.delete(normalizedMember);
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
}
