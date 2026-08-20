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
 * Channel conversations (CHANNEL-01/02): membership-gated CRUD, an
 * idempotent ordered timeline with threads, reactions, pins, and unread
 * cursors, plus a per-channel SSE stream over the durable event ledger
 * with membership re-checked before every delivery.
 */

import express from 'express';
import multer from 'multer';
import rateLimit from '../middleware/sharedRateLimit.js';
import { authenticate, AuthenticatedRequest } from '../middleware/auth.js';
import { MAX_CHANNEL_ATTACHMENT_BYTES } from '../utils/resourceLimits.js';
import { channelService, ChannelError } from '../services/channelService.js';
import { getDurableEventGateway } from '../platform/events/index.js';
import { channelEventStreamId } from '../platform/jobs/domainJobContracts.js';
import type { ChannelTimelineCursor } from '../persistence/resourceTypes.js';
import { createLogger } from '../utils/logger.js';

const router = express.Router();
const logger = createLogger('channel-routes');

const channelRateLimiter = rateLimit({
  keyPrefix: 'channels',
  windowMs: 60 * 1000,
  max: 240,
  message: { success: false, error: 'Too many requests' },
  standardHeaders: true,
  legacyHeaders: false,
});

router.use(channelRateLimiter, authenticate);

const userIdOf = (req: AuthenticatedRequest): string =>
  req.user?.userId || 'default';

const actorOf = (req: AuthenticatedRequest): { userId: string } => ({
  userId: userIdOf(req),
});

const handleError = (
  res: express.Response,
  error: unknown,
  fallback: string
): void => {
  if (error instanceof ChannelError) {
    res.status(error.statusCode).json({ success: false, error: error.message });
    return;
  }
  logger.error(fallback, error);
  res.status(500).json({ success: false, error: fallback });
};

/** Cursor query format: `<createdAt>:<messageId>`. */
const parseCursor = (value: unknown): ChannelTimelineCursor | undefined => {
  if (typeof value !== 'string' || !value) return undefined;
  const separator = value.indexOf(':');
  if (separator <= 0) return undefined;
  const createdAt = Number(value.slice(0, separator));
  const id = value.slice(separator + 1);
  if (!Number.isSafeInteger(createdAt) || !id) return undefined;
  return { created_at: createdAt, id };
};

router.get('/', async (req: AuthenticatedRequest, res) => {
  try {
    res.json({
      success: true,
      data: await channelService.listMine(actorOf(req)),
    });
  } catch (error) {
    handleError(res, error, 'Failed to list channels');
  }
});

router.get('/public', async (req: AuthenticatedRequest, res) => {
  try {
    res.json({
      success: true,
      data: await channelService.listPublic(actorOf(req)),
    });
  } catch (error) {
    handleError(res, error, 'Failed to list public channels');
  }
});

router.post('/', async (req: AuthenticatedRequest, res) => {
  try {
    const { type, name, description, memberIds } = req.body ?? {};
    const channel = await channelService.createChannel(actorOf(req), {
      type,
      name,
      description,
      memberIds: Array.isArray(memberIds)
        ? memberIds.filter(value => typeof value === 'string')
        : undefined,
    });
    res.status(201).json({ success: true, data: channel });
  } catch (error) {
    handleError(res, error, 'Failed to create channel');
  }
});

router.post('/dm', async (req: AuthenticatedRequest, res) => {
  try {
    const { userId } = req.body ?? {};
    if (typeof userId !== 'string' || !userId) {
      res.status(400).json({ success: false, error: 'userId is required' });
      return;
    }
    const channel = await channelService.openDm(actorOf(req), userId);
    res.status(201).json({ success: true, data: channel });
  } catch (error) {
    handleError(res, error, 'Failed to open direct message');
  }
});

router.get('/:channelId', async (req: AuthenticatedRequest, res) => {
  try {
    res.json({
      success: true,
      data: await channelService.getChannel(
        actorOf(req),
        req.params.channelId as string
      ),
    });
  } catch (error) {
    handleError(res, error, 'Failed to load channel');
  }
});

router.patch('/:channelId', async (req: AuthenticatedRequest, res) => {
  try {
    const { name, description, archived } = req.body ?? {};
    res.json({
      success: true,
      data: await channelService.updateChannel(
        actorOf(req),
        req.params.channelId as string,
        {
          ...(typeof name === 'string' ? { name } : {}),
          ...(typeof description === 'string' ? { description } : {}),
          ...(typeof archived === 'boolean' ? { archived } : {}),
        }
      ),
    });
  } catch (error) {
    handleError(res, error, 'Failed to update channel');
  }
});

router.delete('/:channelId', async (req: AuthenticatedRequest, res) => {
  try {
    await channelService.deleteChannel(
      actorOf(req),
      req.params.channelId as string
    );
    res.json({ success: true });
  } catch (error) {
    handleError(res, error, 'Failed to delete channel');
  }
});

router.post('/:channelId/join', async (req: AuthenticatedRequest, res) => {
  try {
    await channelService.join(actorOf(req), req.params.channelId as string);
    res.json({ success: true });
  } catch (error) {
    handleError(res, error, 'Failed to join channel');
  }
});

router.get('/:channelId/members', async (req: AuthenticatedRequest, res) => {
  try {
    res.json({
      success: true,
      data: await channelService.listMembers(
        actorOf(req),
        req.params.channelId as string
      ),
    });
  } catch (error) {
    handleError(res, error, 'Failed to list members');
  }
});

router.post('/:channelId/members', async (req: AuthenticatedRequest, res) => {
  try {
    const { userId } = req.body ?? {};
    if (typeof userId !== 'string' || !userId) {
      res.status(400).json({ success: false, error: 'userId is required' });
      return;
    }
    const member = await channelService.addMember(
      actorOf(req),
      req.params.channelId as string,
      userId
    );
    res.status(201).json({ success: true, data: member });
  } catch (error) {
    handleError(res, error, 'Failed to add member');
  }
});

router.delete(
  '/:channelId/members/:userId',
  async (req: AuthenticatedRequest, res) => {
    try {
      await channelService.removeMember(
        actorOf(req),
        req.params.channelId as string,
        req.params.userId as string
      );
      res.json({ success: true });
    } catch (error) {
      handleError(res, error, 'Failed to remove member');
    }
  }
);

router.get('/:channelId/messages', async (req: AuthenticatedRequest, res) => {
  try {
    const limitValue = Number(req.query.limit ?? 50);
    res.json({
      success: true,
      data: await channelService.listTimeline(
        actorOf(req),
        req.params.channelId as string,
        {
          before: parseCursor(req.query.before),
          after: parseCursor(req.query.after),
          limit: Number.isSafeInteger(limitValue) ? limitValue : 50,
        }
      ),
    });
  } catch (error) {
    handleError(res, error, 'Failed to load messages');
  }
});

router.post('/:channelId/messages', async (req: AuthenticatedRequest, res) => {
  try {
    const {
      id,
      content,
      parentId,
      attachmentIds,
      mentionModel,
      mentionProviderType,
      mentionProviderId,
    } = req.body ?? {};
    const result = await channelService.postUserMessage(
      actorOf(req),
      req.params.channelId as string,
      {
        ...(typeof id === 'string' && id ? { id } : {}),
        content: typeof content === 'string' ? content : '',
        ...(typeof parentId === 'string' && parentId ? { parentId } : {}),
        attachmentIds: Array.isArray(attachmentIds)
          ? attachmentIds.filter(value => typeof value === 'string')
          : [],
        ...(typeof mentionModel === 'string' && mentionModel
          ? { mentionModel }
          : {}),
        ...(typeof mentionProviderType === 'string' && mentionProviderType
          ? { mentionProviderType }
          : {}),
        ...(typeof mentionProviderId === 'string' && mentionProviderId
          ? { mentionProviderId }
          : {}),
      }
    );
    res
      .status(result.created ? 201 : 200)
      .json({ success: true, data: result.message });
  } catch (error) {
    handleError(res, error, 'Failed to post message');
  }
});

const attachmentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_CHANNEL_ATTACHMENT_BYTES, files: 1 },
});

router.post(
  '/:channelId/attachments',
  attachmentUpload.single('attachment'),
  async (req: AuthenticatedRequest, res) => {
    try {
      if (!req.file) {
        res.status(400).json({ success: false, error: 'No file uploaded' });
        return;
      }
      const uploaded = await channelService.uploadAttachment(
        actorOf(req),
        req.params.channelId as string,
        {
          buffer: req.file.buffer,
          filename: req.file.originalname || 'attachment',
          contentType: req.file.mimetype || 'application/octet-stream',
        }
      );
      res.status(201).json({ success: true, data: uploaded });
    } catch (error) {
      handleError(res, error, 'Failed to upload attachment');
    }
  }
);

router.get(
  '/attachments/:attachmentId',
  async (req: AuthenticatedRequest, res) => {
    try {
      const { attachment, body } = await channelService.openAttachment(
        actorOf(req),
        req.params.attachmentId as string
      );
      res.status(200);
      res.set({
        'Content-Type': attachment.contentType,
        'Content-Length': String(attachment.size),
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      body.body.on('error', () => res.destroy());
      body.body.pipe(res);
    } catch (error) {
      handleError(res, error, 'Failed to open attachment');
    }
  }
);

router.get('/:channelId/pins', async (req: AuthenticatedRequest, res) => {
  try {
    res.json({
      success: true,
      data: await channelService.listPinned(
        actorOf(req),
        req.params.channelId as string
      ),
    });
  } catch (error) {
    handleError(res, error, 'Failed to load pinned messages');
  }
});

router.post('/:channelId/read', async (req: AuthenticatedRequest, res) => {
  try {
    const { lastReadAt } = req.body ?? {};
    await channelService.markRead(
      actorOf(req),
      req.params.channelId as string,
      typeof lastReadAt === 'number' ? lastReadAt : undefined
    );
    res.json({ success: true });
  } catch (error) {
    handleError(res, error, 'Failed to mark channel read');
  }
});

router.get(
  '/messages/:messageId/thread',
  async (req: AuthenticatedRequest, res) => {
    try {
      res.json({
        success: true,
        data: await channelService.listThread(
          actorOf(req),
          req.params.messageId as string
        ),
      });
    } catch (error) {
      handleError(res, error, 'Failed to load thread');
    }
  }
);

router.patch('/messages/:messageId', async (req: AuthenticatedRequest, res) => {
  try {
    const { content } = req.body ?? {};
    res.json({
      success: true,
      data: await channelService.editMessage(
        actorOf(req),
        req.params.messageId as string,
        typeof content === 'string' ? content : ''
      ),
    });
  } catch (error) {
    handleError(res, error, 'Failed to edit message');
  }
});

router.delete(
  '/messages/:messageId',
  async (req: AuthenticatedRequest, res) => {
    try {
      await channelService.deleteMessage(
        actorOf(req),
        req.params.messageId as string
      );
      res.json({ success: true });
    } catch (error) {
      handleError(res, error, 'Failed to delete message');
    }
  }
);

router.post(
  '/messages/:messageId/pin',
  async (req: AuthenticatedRequest, res) => {
    try {
      const { pinned } = req.body ?? {};
      res.json({
        success: true,
        data: await channelService.setPinned(
          actorOf(req),
          req.params.messageId as string,
          pinned !== false
        ),
      });
    } catch (error) {
      handleError(res, error, 'Failed to pin message');
    }
  }
);

router.post(
  '/messages/:messageId/reactions',
  async (req: AuthenticatedRequest, res) => {
    try {
      const { emoji } = req.body ?? {};
      await channelService.react(
        actorOf(req),
        req.params.messageId as string,
        typeof emoji === 'string' ? emoji : '',
        true
      );
      res.json({ success: true });
    } catch (error) {
      handleError(res, error, 'Failed to add reaction');
    }
  }
);

router.delete(
  '/messages/:messageId/reactions/:emoji',
  async (req: AuthenticatedRequest, res) => {
    try {
      await channelService.react(
        actorOf(req),
        req.params.messageId as string,
        decodeURIComponent(req.params.emoji as string),
        false
      );
      res.json({ success: true });
    } catch (error) {
      handleError(res, error, 'Failed to remove reaction');
    }
  }
);

const writeSseFrame = (
  res: express.Response,
  cursor: number,
  payload: unknown
): void => {
  res.write(`id: ${cursor}\ndata: ${JSON.stringify(payload)}\n\n`);
};

// Live channel updates over the durable event ledger. Membership is
// re-checked before every delivery so removal fails the stream closed;
// clients catch up past the retention window with the timeline endpoint.
router.get('/:channelId/events', async (req: AuthenticatedRequest, res) => {
  const channelId = String(req.params.channelId || '').trim();
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
  const isMember = async (): Promise<boolean> => {
    try {
      await channelService.requireMember(channelId, userId);
      return true;
    } catch {
      return false;
    }
  };
  if (!(await isMember())) {
    res.status(404).json({ success: false, error: 'Channel not found' });
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
      streamId: channelEventStreamId(channelId),
      batchSize: 100,
      maxReplayEvents: 10_000,
      signal: abort.signal,
      authorize: isMember,
      onEvent: async event => {
        writeSseFrame(res, event.cursor, {
          eventType: event.eventType,
          payload: event.payload,
        });
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

export default router;
