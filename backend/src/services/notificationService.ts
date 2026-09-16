/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at:
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Durable in-app notifications and outbound webhooks (NOTIFY-01).
 *
 * Notifications are SQL rows first (encrypted title/body, per-user cap,
 * source-key deduplication) and only then fanned out: live delivery rides
 * the per-user durable event stream `notify:<userId>`, and admin-managed
 * webhook targets receive a redacted envelope through durable delivery
 * jobs with bounded retries. Webhook payloads never include notification
 * bodies, and targets pass the same egress guard as tool servers, so a
 * webhook cannot be pointed at private infrastructure.
 */

import { createHmac, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { getPersistence } from '../persistence/index.js';
import {
  PersistenceResourceLimitError,
  type StoredNotificationRecord,
  type StoredWebhookTargetRecord,
} from '../persistence/resourceTypes.js';
import { encryptionService } from './encryptionService.js';
import { getDurableEventGateway } from '../platform/events/index.js';
import {
  notificationEventStreamId,
  PUSH_DELIVER_IDEMPOTENCY_SCOPE,
  PUSH_DELIVER_JOB_TYPE,
  WEBHOOK_DELIVER_IDEMPOTENCY_SCOPE,
  WEBHOOK_DELIVER_JOB_TYPE,
} from '../platform/jobs/domainJobContracts.js';
import { getDurableJobRuntime } from '../platform/jobs/durableJobRuntime.js';
import {
  isAllowlistedPrivateHost,
  validateToolServerUrl,
} from '../utils/toolEgress.js';
import { isPublicIpAddress } from '../utils/webpageFetcher.js';
import { createLogger } from '../utils/logger.js';
import {
  MAX_AUTOMATIONS_PER_USER,
  MAX_NOTIFICATION_BODY_LENGTH,
  MAX_NOTIFICATION_PAGE_SIZE,
  MAX_NOTIFICATION_TITLE_LENGTH,
  MAX_NOTIFICATIONS_PER_USER,
  MAX_WEBHOOK_NAME_LENGTH,
  MAX_WEBHOOK_SECRET_LENGTH,
  MAX_WEBHOOK_TARGETS,
  MAX_WEBHOOK_URL_LENGTH,
} from '../utils/resourceLimits.js';
import { eventTriggerMatches } from '../utils/automationSchedule.js';
import type {
  AutomationTrigger,
  NotificationType,
  NotificationView,
  WebhookTargetView,
} from '../types/index.js';

const logger = createLogger('notifications');

/** Source-key prefix of the notice an automation publishes when a run fails. */
const AUTOMATION_RUN_FAILURE_PREFIX = 'automation-run-failed:';

/**
 * Minimum gap between two event fires of the same automation. A chatty
 * event stream (a busy channel, a burst of media jobs) must not turn into a
 * burst of runs, so each automation fires at most once per window.
 */
export const AUTOMATION_EVENT_COOLDOWN_MS = 60_000;

const lastEventFireAt = new Map<string, number>();

/** Claim an event fire for an automation, or refuse it while cooling down. */
const claimEventFire = (automationId: string, now: number): boolean => {
  const previous = lastEventFireAt.get(automationId);
  if (previous !== undefined && now - previous < AUTOMATION_EVENT_COOLDOWN_MS) {
    return false;
  }
  lastEventFireAt.set(automationId, now);
  return true;
};

/** Test seam: forget every cooldown so a suite can fire back to back. */
export const resetAutomationEventCooldowns = (): void => {
  lastEventFireAt.clear();
};

export class NotificationError extends Error {
  constructor(
    message: string,
    readonly statusCode: number
  ) {
    super(message);
    this.name = 'NotificationError';
  }
}

const NOTIFICATION_TYPES: readonly NotificationType[] = [
  'channel-mention',
  'channel-dm',
  'channel-invite',
  'share',
  'automation-failed',
  'calendar-reminder',
  'media-ready',
  'media-failed',
  'budget-alert',
  'work-run-finished',
  'work-run-attention',
  'work-takeover',
  'work-approval',
  'system',
];

const isNotificationType = (value: unknown): value is NotificationType =>
  (NOTIFICATION_TYPES as readonly string[]).includes(value as string);

const repositories = () =>
  getPersistence(encryptionService).repositories.resources;

const decryptOptional = (value: string | null): string | undefined => {
  if (!value) return undefined;
  try {
    return encryptionService.decrypt(value);
  } catch {
    return undefined;
  }
};

const mapNotification = (row: StoredNotificationRecord): NotificationView => ({
  id: row.id,
  type: isNotificationType(row.type) ? row.type : 'system',
  title: decryptOptional(row.title) ?? '',
  ...(row.body ? { body: decryptOptional(row.body) } : {}),
  ...(row.href ? { href: row.href } : {}),
  createdAt: row.created_at,
  ...(row.read_at ? { readAt: row.read_at } : {}),
});

const mapWebhookTarget = (
  row: StoredWebhookTargetRecord
): WebhookTargetView => ({
  id: row.id,
  name: row.name,
  url: row.url,
  hasSecret: Boolean(row.secret),
  events: parseEvents(row.events),
  enabled: row.enabled === 1,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const parseEvents = (value: string): string[] => {
  try {
    const decoded = JSON.parse(value) as unknown;
    return Array.isArray(decoded)
      ? decoded.filter((entry): entry is string => typeof entry === 'string')
      : [];
  } catch {
    return [];
  }
};

export interface PublishNotificationInput {
  userId: string;
  type: NotificationType;
  title: string;
  body?: string;
  href?: string;
  /** Stable identity: repeated publications collapse into one row. */
  sourceKey?: string;
}

class NotificationService {
  /**
   * Persists the notification (deduplicated by source key), then fans it
   * out live and to subscribed webhooks. Fan-out is best effort — the SQL
   * row is the source of truth for the bell.
   */
  async publish(input: PublishNotificationInput): Promise<boolean> {
    if (!input.title.trim()) return false;
    const record: StoredNotificationRecord = {
      id: randomUUID(),
      user_id: input.userId,
      type: input.type,
      title: encryptionService.encrypt(
        input.title.slice(0, MAX_NOTIFICATION_TITLE_LENGTH)
      ),
      body: input.body
        ? encryptionService.encrypt(
            input.body.slice(0, MAX_NOTIFICATION_BODY_LENGTH)
          )
        : null,
      href: input.href ?? null,
      source_key: input.sourceKey ?? null,
      created_at: Date.now(),
      read_at: null,
    };
    const inserted = await repositories().notifications.insertWithLimit(
      record,
      MAX_NOTIFICATIONS_PER_USER
    );
    if (!inserted) return false;
    try {
      await getDurableEventGateway().append({
        eventId: randomUUID(),
        streamId: notificationEventStreamId(input.userId),
        eventType: 'notify.item.v1',
        subjectId: record.id,
        actorUserId: input.userId,
        payload: {
          mode: 'encrypted',
          value: {
            type: 'notification',
            notification: mapNotification(record),
          },
        },
      });
    } catch (error) {
      logger.warn('Notification fan-out failed; the bell recovers on read', {
        error,
      });
    }
    await this.dispatchWebhooks(record).catch(error => {
      logger.warn('Webhook dispatch failed', { error });
    });
    await this.dispatchPush(record).catch(error => {
      logger.warn('Push dispatch failed', { error });
    });
    if (record.type === 'channel-mention') {
      // Email is opt-in per user and only leaves once the row exists, so a
      // deduplicated mention never produces a second message.
      const { emailService } = await import('./emailService.js');
      await emailService.notifyChannelMention({
        userId: input.userId,
        title: input.title,
        ...(input.body ? { preview: input.body } : {}),
        ...(input.href ? { href: input.href } : {}),
        notificationId: record.id,
      });
    }
    await this.dispatchAutomationTriggers(record, input).catch(error => {
      logger.warn('Automation event trigger dispatch failed', { error });
    });
    return true;
  }

  /**
   * Fires the owner's event-triggered automations. Best effort and never
   * thrown to the caller: the notification is already durable, and a routine
   * that could not start is a missed convenience, not a lost record.
   */
  private async dispatchAutomationTriggers(
    record: StoredNotificationRecord,
    input: PublishNotificationInput
  ): Promise<void> {
    const rows = await repositories().automations.listByOwner(
      record.user_id,
      MAX_AUTOMATIONS_PER_USER
    );
    const candidates = rows.filter(row => row.status === 'active');
    if (candidates.length === 0) return;
    // Loop guard: a run's own failure notice must never re-fire the routine
    // that produced it. Event triggers cannot name `automation-failed` in
    // the first place, so this only catches hand-edited trigger rows.
    let selfAutomationId: string | undefined;
    if (input.sourceKey?.startsWith(AUTOMATION_RUN_FAILURE_PREFIX)) {
      const failedRunId = input.sourceKey.slice(
        AUTOMATION_RUN_FAILURE_PREFIX.length
      );
      try {
        const { default: automationService } =
          await import('./automationService.js');
        const run = await automationService.getRunRecord(
          failedRunId,
          record.user_id
        );
        selfAutomationId = run?.automation_id;
      } catch {
        // Unresolvable: fall through and let the cooldown bound the damage.
      }
    }
    const title = decryptOptional(record.title) ?? '';
    const type = isNotificationType(record.type) ? record.type : 'system';
    for (const row of candidates) {
      if (row.id === selfAutomationId) continue;
      let triggers: AutomationTrigger[];
      try {
        triggers = JSON.parse(row.triggers) as AutomationTrigger[];
      } catch {
        continue;
      }
      if (
        !triggers.some(trigger => eventTriggerMatches(trigger, type, title))
      ) {
        continue;
      }
      if (!claimEventFire(row.id, record.created_at)) continue;
      try {
        const { default: automationSchedulerService } =
          await import('./automationSchedulerService.js');
        await automationSchedulerService.runNow(row.id, row.user_id, {
          payload: {
            event: type,
            title,
            ...(record.body ? { body: decryptOptional(record.body) } : {}),
            ...(record.href ? { href: record.href } : {}),
          },
        });
      } catch (error) {
        logger.warn(`Event trigger could not start automation ${row.id}`, {
          error,
        });
      }
    }
  }

  /**
   * Enqueues one durable Web Push delivery per registered browser device.
   * Best effort like webhooks: the inbox row is already the source of truth.
   */
  private async dispatchPush(record: StoredNotificationRecord): Promise<void> {
    const subscriptions = await repositories().pushSubscriptions.listByUser(
      record.user_id
    );
    if (subscriptions.length === 0) return;
    const message = {
      title: decryptOptional(record.title) ?? '',
      ...(record.body ? { body: decryptOptional(record.body) } : {}),
      ...(record.href ? { href: record.href } : {}),
      type: record.type,
    };
    const service = getDurableJobRuntime().service;
    for (const subscription of subscriptions) {
      await service.enqueue({
        jobType: PUSH_DELIVER_JOB_TYPE,
        actorUserId: record.user_id,
        payload: {
          mode: 'encrypted',
          value: { subscriptionId: subscription.id, message },
        },
        idempotencyScope: PUSH_DELIVER_IDEMPOTENCY_SCOPE,
        idempotencyKey: `${subscription.id}:${record.id}`,
        maxAttempts: 3,
      });
    }
  }

  async list(
    userId: string,
    options: { before?: number; limit?: number; unreadOnly?: boolean }
  ): Promise<NotificationView[]> {
    const limit = Math.min(
      Math.max(options.limit ?? 50, 1),
      MAX_NOTIFICATION_PAGE_SIZE
    );
    const rows = await repositories().notifications.listByOwner(userId, {
      ...(options.before !== undefined ? { before: options.before } : {}),
      limit,
      ...(options.unreadOnly ? { unreadOnly: true } : {}),
    });
    return rows.map(mapNotification);
  }

  async countUnread(userId: string): Promise<number> {
    return repositories().notifications.countUnread(userId);
  }

  async markRead(userId: string, notificationId: string): Promise<boolean> {
    return repositories().notifications.markRead(
      notificationId,
      userId,
      Date.now()
    );
  }

  async markAllRead(userId: string): Promise<number> {
    return repositories().notifications.markAllRead(userId, Date.now());
  }

  async delete(userId: string, notificationId: string): Promise<boolean> {
    return repositories().notifications.deleteByOwner(notificationId, userId);
  }

  /**
   * Enqueues one durable delivery per enabled target subscribed to this
   * notification type. The webhook envelope is redacted: type, title, and
   * identifiers only — never the notification body.
   */
  private async dispatchWebhooks(
    record: StoredNotificationRecord
  ): Promise<void> {
    const targets =
      await repositories().webhookTargets.list(MAX_WEBHOOK_TARGETS);
    const subscribed = targets.filter(target => {
      if (target.enabled !== 1) return false;
      const events = parseEvents(target.events);
      return events.includes('*') || events.includes(record.type);
    });
    if (subscribed.length === 0) return;
    const service = getDurableJobRuntime().service;
    for (const target of subscribed) {
      await service.enqueue({
        jobType: WEBHOOK_DELIVER_JOB_TYPE,
        actorUserId: record.user_id,
        payload: {
          mode: 'encrypted',
          value: {
            targetId: target.id,
            event: {
              event: 'notification.created',
              notificationId: record.id,
              notificationType: record.type,
              title: decryptOptional(record.title) ?? '',
              userId: record.user_id,
              createdAt: record.created_at,
            },
          },
        },
        idempotencyScope: WEBHOOK_DELIVER_IDEMPOTENCY_SCOPE,
        idempotencyKey: `${target.id}:${record.id}`,
        maxAttempts: 5,
      });
    }
  }

  // ------------------------------------------------------------------
  // Admin-managed webhook targets
  // ------------------------------------------------------------------

  async listWebhookTargets(): Promise<WebhookTargetView[]> {
    const rows = await repositories().webhookTargets.list(MAX_WEBHOOK_TARGETS);
    return rows.map(mapWebhookTarget);
  }

  async saveWebhookTarget(
    actorUserId: string,
    input: {
      id?: string;
      name: string;
      url: string;
      secret?: string;
      events: readonly string[];
      enabled?: boolean;
    }
  ): Promise<WebhookTargetView> {
    const name = (input.name ?? '').trim();
    if (!name || name.length > MAX_WEBHOOK_NAME_LENGTH) {
      throw new NotificationError('Webhook name is required', 400);
    }
    if (!input.url || input.url.length > MAX_WEBHOOK_URL_LENGTH) {
      throw new NotificationError('Webhook URL is required', 400);
    }
    // The same egress contract as tool servers: exact destination, no
    // private or link-local addresses unless explicitly allowlisted. IP
    // literals fail fast here; hostnames are re-resolved and re-checked on
    // every delivery, which is the defense that matters against rebinding.
    const url = validateToolServerUrl(input.url);
    const literalHost = url.hostname.replace(/^\[|\]$/g, '');
    if (
      isIP(literalHost) !== 0 &&
      !isAllowlistedPrivateHost(url.hostname) &&
      !isPublicIpAddress(literalHost)
    ) {
      throw new NotificationError(
        'Webhook URLs cannot target private or local addresses',
        400
      );
    }
    if ((input.secret?.length ?? 0) > MAX_WEBHOOK_SECRET_LENGTH) {
      throw new NotificationError('Webhook secret is too long', 400);
    }
    const events = [...new Set(input.events)].filter(
      event => event === '*' || isNotificationType(event)
    );
    if (events.length === 0) {
      throw new NotificationError(
        'A webhook must subscribe to at least one event',
        400
      );
    }
    const existing = input.id
      ? await repositories().webhookTargets.findById(input.id)
      : null;
    const now = Date.now();
    const record: StoredWebhookTargetRecord = {
      id: existing?.id ?? input.id ?? randomUUID(),
      name,
      url: input.url,
      secret:
        input.secret !== undefined
          ? input.secret
            ? encryptionService.encrypt(input.secret)
            : null
          : (existing?.secret ?? null),
      events: JSON.stringify(events),
      enabled: (input.enabled ?? true) ? 1 : 0,
      created_by: existing?.created_by ?? actorUserId,
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    try {
      await repositories().webhookTargets.replaceWithLimit(
        record,
        MAX_WEBHOOK_TARGETS
      );
    } catch (error) {
      if (error instanceof PersistenceResourceLimitError) {
        throw new NotificationError(
          `At most ${MAX_WEBHOOK_TARGETS} webhook targets are supported`,
          409
        );
      }
      throw error;
    }
    return mapWebhookTarget(record);
  }

  async deleteWebhookTarget(targetId: string): Promise<boolean> {
    return repositories().webhookTargets.delete(targetId);
  }

  /** Signed delivery used by the durable webhook job. */
  async deliverWebhook(
    targetId: string,
    event: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<{ delivered: boolean; status?: number }> {
    const target = await repositories().webhookTargets.findById(targetId);
    if (!target || target.enabled !== 1) return { delivered: false };
    const body = JSON.stringify(event);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    const secret = decryptOptional(target.secret);
    if (secret) {
      headers['X-Libre-Signature'] =
        'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
    }
    const { secureToolRequest } = await import('../utils/toolEgress.js');
    const response = await secureToolRequest({
      url: target.url,
      method: 'POST',
      headers,
      body,
      maxResponseBytes: 64 * 1024,
      timeoutMs: 10_000,
      ...(signal ? { signal } : {}),
    });
    return { delivered: response.status < 300, status: response.status };
  }
}

export const notificationService = new NotificationService();
