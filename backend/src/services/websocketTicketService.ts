/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { createHash, randomBytes } from 'crypto';
import { getCoordinator } from '../platform/coordination/service.js';
import {
  SHARED_COORDINATION_OPERATION_TIMEOUT_MS,
  withCoordinationTimeout,
} from '../platform/coordination/sharedAdmission.js';
import type { Coordinator } from '../platform/coordination/types.js';

const DEFAULT_TICKET_TTL_MS = 30_000;
const MAX_TICKET_TTL_MS = 60_000;
const MAX_OUTSTANDING_TICKETS_PER_USER = 5;
const MAX_OUTSTANDING_TICKETS = 10_000;
const MAX_SHARED_TICKETS_PER_USER_PER_TTL = 100;

interface TicketRecord {
  userId: string;
  audience: WebSocketTicketAudience;
  resourceId?: string;
  sessionId?: string;
  expiresAt: number;
  sessionExpiresAt: number;
  issuedAt: number;
}

export interface IssuedWebSocketTicket {
  ticket: string;
  expiresAt: string;
}

export interface ConsumedWebSocketTicket {
  userId: string;
  sessionExpiresAt: number;
  /** Auth session backing the ticket; used to close sockets on revocation. */
  sessionId?: string;
}

export type WebSocketTicketAudience = 'chat' | 'work-terminal';

export class WebSocketTicketRateLimitError extends Error {
  constructor() {
    super('Too many WebSocket tickets were requested.');
    this.name = 'WebSocketTicketRateLimitError';
  }
}

export class WebSocketTicketCoordinationError extends Error {
  readonly cause?: unknown;

  constructor(cause?: unknown) {
    super('WebSocket ticket coordination is unavailable.');
    this.name = 'WebSocketTicketCoordinationError';
    this.cause = cause;
  }
}

const positiveInteger = (
  value: string | undefined,
  fallback: number
): number => {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const configuredTicketTtlMs = (): number =>
  Math.min(
    positiveInteger(process.env.WEBSOCKET_TICKET_TTL_MS, DEFAULT_TICKET_TTL_MS),
    MAX_TICKET_TTL_MS
  );

const ticketDigest = (ticket: string): string =>
  createHash('sha256').update(ticket).digest('base64url');

const cacheKey = (digest: string): string => `websocket-ticket:${digest}`;

const isTicketRecord = (value: unknown): value is TicketRecord => {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<TicketRecord>;
  return (
    typeof record.userId === 'string' &&
    record.userId.length > 0 &&
    (record.audience === 'chat' || record.audience === 'work-terminal') &&
    (record.resourceId === undefined ||
      typeof record.resourceId === 'string') &&
    (record.sessionId === undefined || typeof record.sessionId === 'string') &&
    Number.isSafeInteger(record.expiresAt) &&
    Number.isSafeInteger(record.sessionExpiresAt) &&
    Number.isSafeInteger(record.issuedAt)
  );
};

/**
 * Stores one-use WebSocket credentials in the selected coordinator. The
 * browser receives only an opaque random value, and the durable login token
 * never enters a URL. Redis provides cross-replica atomic consumption in the
 * team profile; the private map is retained only for isolated unit instances.
 */
export class WebSocketTicketService {
  private readonly tickets = new Map<string, TicketRecord>();

  constructor(
    private readonly ttlMs = configuredTicketTtlMs(),
    private readonly now: () => number = Date.now,
    private readonly coordinatorProvider?: () => Coordinator,
    private readonly operationTimeoutMs = SHARED_COORDINATION_OPERATION_TIMEOUT_MS
  ) {}

  async issue(
    userId: string,
    sessionExpiresAt: number,
    audience: WebSocketTicketAudience,
    resourceId?: string,
    sessionId?: string
  ): Promise<IssuedWebSocketTicket> {
    const normalizedUserId = userId.trim();
    if (!normalizedUserId) {
      throw new Error('A user ID is required to issue a WebSocket ticket.');
    }

    const now = this.now();
    if (!Number.isSafeInteger(sessionExpiresAt) || sessionExpiresAt <= now) {
      throw new Error(
        'A current session is required to issue a WebSocket ticket.'
      );
    }
    if (audience === 'work-terminal' && !resourceId?.trim()) {
      throw new Error('A task ID is required for a Work terminal ticket.');
    }
    const ticket = randomBytes(32).toString('base64url');
    const expiresAt = Math.min(now + this.ttlMs, sessionExpiresAt);
    const record: TicketRecord = {
      userId: normalizedUserId,
      audience,
      ...(resourceId?.trim() ? { resourceId: resourceId.trim() } : {}),
      ...(sessionId?.trim() ? { sessionId: sessionId.trim() } : {}),
      expiresAt,
      sessionExpiresAt,
      issuedAt: now,
    };
    const digest = ticketDigest(ticket);
    const coordinator = this.coordinatorProvider?.();
    if (coordinator) {
      const [userLimit, globalLimit] = await withCoordinationTimeout(
        Promise.all([
          coordinator.consumeRateLimit(
            `websocket-ticket.user:${normalizedUserId}`,
            MAX_SHARED_TICKETS_PER_USER_PER_TTL,
            this.ttlMs
          ),
          coordinator.consumeRateLimit(
            'websocket-ticket.global',
            MAX_OUTSTANDING_TICKETS,
            this.ttlMs
          ),
        ]),
        this.operationTimeoutMs
      );
      if (!userLimit.allowed || !globalLimit.allowed) {
        throw new WebSocketTicketRateLimitError();
      }
      await withCoordinationTimeout(
        coordinator.setCache(cacheKey(digest), record, expiresAt - now),
        this.operationTimeoutMs
      );
    } else {
      this.pruneExpired(now);
      this.evictOldestForUser(normalizedUserId);
      this.evictOldestGlobal();
      this.tickets.set(digest, record);
    }

    return {
      ticket,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  async consume(
    ticket: string,
    audience: WebSocketTicketAudience,
    resourceId?: string
  ): Promise<ConsumedWebSocketTicket | null> {
    const normalizedTicket = ticket.trim();
    if (!/^[A-Za-z0-9_-]{43}$/.test(normalizedTicket)) return null;

    const digest = ticketDigest(normalizedTicket);
    const coordinator = this.coordinatorProvider?.();
    let record: TicketRecord | null;
    try {
      record = coordinator
        ? await withCoordinationTimeout(
            coordinator.consumeCache<TicketRecord>(cacheKey(digest)),
            this.operationTimeoutMs
          )
        : this.consumeLocal(digest);
    } catch (error) {
      throw new WebSocketTicketCoordinationError(error);
    }
    if (!isTicketRecord(record)) return null;
    if (
      record.expiresAt <= this.now() ||
      record.audience !== audience ||
      record.resourceId !== resourceId?.trim()
    ) {
      return null;
    }

    return {
      userId: record.userId,
      sessionExpiresAt: record.sessionExpiresAt,
      ...(record.sessionId ? { sessionId: record.sessionId } : {}),
    };
  }

  private consumeLocal(digest: string): TicketRecord | null {
    const record = this.tickets.get(digest) ?? null;
    // Delete before evaluating it so replay is impossible even at the expiry
    // boundary or when later authorization checks reject the account.
    this.tickets.delete(digest);
    return record;
  }

  private pruneExpired(now: number): void {
    for (const [digest, record] of this.tickets) {
      if (record.expiresAt <= now) this.tickets.delete(digest);
    }
  }

  private evictOldestForUser(userId: string): void {
    const matching = [...this.tickets.entries()]
      .filter(([, record]) => record.userId === userId)
      .sort(([, left], [, right]) => left.issuedAt - right.issuedAt);

    while (matching.length >= MAX_OUTSTANDING_TICKETS_PER_USER) {
      const oldest = matching.shift();
      if (oldest) this.tickets.delete(oldest[0]);
    }
  }

  private evictOldestGlobal(): void {
    if (this.tickets.size < MAX_OUTSTANDING_TICKETS) return;

    let oldestDigest: string | undefined;
    let oldestIssuedAt = Number.POSITIVE_INFINITY;
    for (const [digest, record] of this.tickets) {
      if (record.issuedAt < oldestIssuedAt) {
        oldestDigest = digest;
        oldestIssuedAt = record.issuedAt;
      }
    }
    if (oldestDigest) this.tickets.delete(oldestDigest);
  }
}

export const websocketTicketService = new WebSocketTicketService(
  configuredTicketTtlMs(),
  Date.now,
  getCoordinator
);
