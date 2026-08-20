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
 * Notifications (NOTIFY-01): the durable per-user inbox with live SSE
 * delivery over the `notify:<userId>` event stream, plus admin-managed
 * outbound webhook targets.
 */

import express from 'express';
import rateLimit from '../middleware/sharedRateLimit.js';
import {
  authenticate,
  requireAdmin,
  AuthenticatedRequest,
} from '../middleware/auth.js';
import {
  notificationService,
  NotificationError,
} from '../services/notificationService.js';
import { getDurableEventGateway } from '../platform/events/index.js';
import { notificationEventStreamId } from '../platform/jobs/domainJobContracts.js';
import { createLogger } from '../utils/logger.js';

const router = express.Router();
const logger = createLogger('notification-routes');

const notificationRateLimiter = rateLimit({
  keyPrefix: 'notifications',
  windowMs: 60 * 1000,
  max: 240,
  message: { success: false, error: 'Too many requests' },
  standardHeaders: true,
  legacyHeaders: false,
});

router.use(notificationRateLimiter, authenticate);

const userIdOf = (req: AuthenticatedRequest): string =>
  req.user?.userId || 'default';

const handleError = (
  res: express.Response,
  error: unknown,
  fallback: string
): void => {
  if (error instanceof NotificationError) {
    res.status(error.statusCode).json({ success: false, error: error.message });
    return;
  }
  logger.error(fallback, error);
  res.status(500).json({ success: false, error: fallback });
};

router.get('/', async (req: AuthenticatedRequest, res) => {
  try {
    const before = Number(req.query.before);
    const limit = Number(req.query.limit);
    res.json({
      success: true,
      data: await notificationService.list(userIdOf(req), {
        ...(Number.isSafeInteger(before) ? { before } : {}),
        ...(Number.isSafeInteger(limit) ? { limit } : {}),
        ...(req.query.unread === 'true' ? { unreadOnly: true } : {}),
      }),
    });
  } catch (error) {
    handleError(res, error, 'Failed to list notifications');
  }
});

router.get('/unread-count', async (req: AuthenticatedRequest, res) => {
  try {
    res.json({
      success: true,
      data: { count: await notificationService.countUnread(userIdOf(req)) },
    });
  } catch (error) {
    handleError(res, error, 'Failed to count notifications');
  }
});

router.post('/read-all', async (req: AuthenticatedRequest, res) => {
  try {
    await notificationService.markAllRead(userIdOf(req));
    res.json({ success: true });
  } catch (error) {
    handleError(res, error, 'Failed to mark notifications read');
  }
});

router.post('/:notificationId/read', async (req: AuthenticatedRequest, res) => {
  try {
    await notificationService.markRead(
      userIdOf(req),
      req.params.notificationId as string
    );
    res.json({ success: true });
  } catch (error) {
    handleError(res, error, 'Failed to mark notification read');
  }
});

router.delete('/:notificationId', async (req: AuthenticatedRequest, res) => {
  try {
    const deleted = await notificationService.delete(
      userIdOf(req),
      req.params.notificationId as string
    );
    if (!deleted) {
      res.status(404).json({ success: false, error: 'Notification not found' });
      return;
    }
    res.json({ success: true });
  } catch (error) {
    handleError(res, error, 'Failed to delete notification');
  }
});

// Live inbox updates. The stream is strictly per-user: the stream id is
// derived from the authenticated identity, never from client input.
router.get('/events', async (req: AuthenticatedRequest, res) => {
  const userId = userIdOf(req);
  const afterValue =
    req.query.after ??
    (typeof req.get('Last-Event-ID') === 'string'
      ? req.get('Last-Event-ID')
      : undefined) ??
    0;
  const afterCursor = Number(afterValue);
  if (!Number.isSafeInteger(afterCursor) || afterCursor < 0) {
    res.status(400).json({ success: false, error: 'Invalid event cursor' });
    return;
  }
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const abort = new AbortController();
  let subscription:
    | Awaited<
        ReturnType<ReturnType<typeof getDurableEventGateway>['subscribe']>
      >
    | undefined;
  let heartbeat: NodeJS.Timeout | undefined;
  const close = (): void => {
    abort.abort();
    if (heartbeat) clearInterval(heartbeat);
    void subscription?.close();
    if (!res.writableEnded && !res.destroyed) res.end();
  };
  res.once('close', close);
  try {
    subscription = await getDurableEventGateway().subscribe({
      afterCursor,
      streamId: notificationEventStreamId(userId),
      batchSize: 100,
      maxReplayEvents: 5_000,
      signal: abort.signal,
      authorize: async () => true,
      onEvent: async event => {
        res.write(
          `id: ${event.cursor}\ndata: ${JSON.stringify(event.payload)}\n\n`
        );
      },
      onError: () => close(),
    });
    heartbeat = setInterval(() => {
      if (res.writableEnded || res.destroyed) {
        close();
        return;
      }
      res.write(`: heartbeat ${Date.now()}\n\n`);
    }, 15_000);
    heartbeat.unref?.();
  } catch {
    close();
  }
});

// ---------------------------------------------------------------------
// Admin-managed webhook targets
// ---------------------------------------------------------------------

router.get(
  '/webhooks',
  requireAdmin,
  async (_req: AuthenticatedRequest, res) => {
    try {
      res.json({
        success: true,
        data: await notificationService.listWebhookTargets(),
      });
    } catch (error) {
      handleError(res, error, 'Failed to list webhook targets');
    }
  }
);

router.post(
  '/webhooks',
  requireAdmin,
  async (req: AuthenticatedRequest, res) => {
    try {
      const { id, name, url, secret, events, enabled } = req.body ?? {};
      const target = await notificationService.saveWebhookTarget(
        userIdOf(req),
        {
          ...(typeof id === 'string' && id ? { id } : {}),
          name: typeof name === 'string' ? name : '',
          url: typeof url === 'string' ? url : '',
          ...(typeof secret === 'string' ? { secret } : {}),
          events: Array.isArray(events)
            ? events.filter(value => typeof value === 'string')
            : [],
          ...(typeof enabled === 'boolean' ? { enabled } : {}),
        }
      );
      res.status(201).json({ success: true, data: target });
    } catch (error) {
      handleError(res, error, 'Failed to save webhook target');
    }
  }
);

router.delete(
  '/webhooks/:targetId',
  requireAdmin,
  async (req: AuthenticatedRequest, res) => {
    try {
      const deleted = await notificationService.deleteWebhookTarget(
        req.params.targetId as string
      );
      if (!deleted) {
        res.status(404).json({ success: false, error: 'Webhook not found' });
        return;
      }
      res.json({ success: true });
    } catch (error) {
      handleError(res, error, 'Failed to delete webhook target');
    }
  }
);

export default router;
