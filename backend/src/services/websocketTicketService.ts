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

const DEFAULT_TICKET_TTL_MS = 30_000;
const MAX_TICKET_TTL_MS = 60_000;
const MAX_OUTSTANDING_TICKETS_PER_USER = 5;
const MAX_OUTSTANDING_TICKETS = 10_000;

interface TicketRecord {
  userId: string;
  audience: WebSocketTicketAudience;
  resourceId?: string;
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
}

export type WebSocketTicketAudience = 'chat' | 'work-terminal';

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

/**
 * Keeps one-use WebSocket credentials in process memory. The browser receives
 * only an opaque random value, and the durable login token never enters a URL.
 * The process-local store is intentional while Libre requires one replica.
 */
export class WebSocketTicketService {
  private readonly tickets = new Map<string, TicketRecord>();

  constructor(
    private readonly ttlMs = configuredTicketTtlMs(),
    private readonly now: () => number = Date.now
  ) {}

  issue(
    userId: string,
    sessionExpiresAt: number,
    audience: WebSocketTicketAudience,
    resourceId?: string
  ): IssuedWebSocketTicket {
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
    this.pruneExpired(now);
    this.evictOldestForUser(normalizedUserId);
    this.evictOldestGlobal();

    const ticket = randomBytes(32).toString('base64url');
    const expiresAt = Math.min(now + this.ttlMs, sessionExpiresAt);
    this.tickets.set(ticketDigest(ticket), {
      userId: normalizedUserId,
      audience,
      ...(resourceId?.trim() ? { resourceId: resourceId.trim() } : {}),
      expiresAt,
      sessionExpiresAt,
      issuedAt: now,
    });

    return {
      ticket,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  consume(
    ticket: string,
    audience: WebSocketTicketAudience,
    resourceId?: string
  ): ConsumedWebSocketTicket | null {
    const normalizedTicket = ticket.trim();
    if (!/^[A-Za-z0-9_-]{43}$/.test(normalizedTicket)) return null;

    const digest = ticketDigest(normalizedTicket);
    const record = this.tickets.get(digest);
    if (!record) return null;

    // Delete before evaluating it so replay is impossible even at the expiry
    // boundary or when later authorization checks reject the account.
    this.tickets.delete(digest);
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
    };
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

export const websocketTicketService = new WebSocketTicketService();
