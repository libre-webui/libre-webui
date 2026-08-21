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
 * Browser Web Push subscriptions: the VAPID public key for
 * `pushManager.subscribe`, and per-device registration bound to the caller's
 * auth session so revoking the session also silences its device.
 */

import express from 'express';
import rateLimit from '../middleware/sharedRateLimit.js';
import { authenticate, type AuthenticatedRequest } from '../middleware/auth.js';
import {
  WebPushError,
  getVapidPublicKey,
  listSubscriptionsForUser,
  subscribe,
  unsubscribe,
} from '../services/webPushService.js';
import { createLogger } from '../utils/logger.js';

const router = express.Router();
const logger = createLogger('push-routes');

const pushRateLimiter = rateLimit({
  keyPrefix: 'push',
  windowMs: 60_000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});

router.use(pushRateLimiter, authenticate);

const handleFailure = (
  res: express.Response,
  error: unknown,
  fallback: string
): void => {
  if (error instanceof WebPushError) {
    res
      .status(error.statusCode)
      .json({ success: false, message: error.message });
    return;
  }
  logger.error('Push endpoint error:', error);
  res.status(500).json({ success: false, message: fallback });
};

/** The VAPID application server key for pushManager.subscribe. */
router.get('/public-key', async (_req: AuthenticatedRequest, res) => {
  try {
    res.json({ success: true, data: { publicKey: await getVapidPublicKey() } });
  } catch (error) {
    handleFailure(res, error, 'Web Push is not available');
  }
});

/** This account's registered devices (metadata only). */
router.get('/subscriptions', async (req: AuthenticatedRequest, res) => {
  try {
    const rows = await listSubscriptionsForUser(req.user!.userId);
    res.json({
      success: true,
      data: rows.map(row => ({
        id: row.id,
        userAgent: row.user_agent,
        createdAt: row.created_at,
        lastUsedAt: row.last_used_at,
        current:
          req.auth?.kind === 'session' && row.session_id === req.auth.sessionId,
      })),
    });
  } catch (error) {
    handleFailure(res, error, 'Failed to list push subscriptions');
  }
});

/** Register (or refresh) this browser's push subscription. */
router.post('/subscriptions', async (req: AuthenticatedRequest, res) => {
  try {
    const result = await subscribe(
      req.user!.userId,
      req.auth?.kind === 'session' ? req.auth.sessionId : null,
      req.body ?? {},
      typeof req.headers['user-agent'] === 'string'
        ? req.headers['user-agent']
        : null
    );
    res.json({ success: true, data: result });
  } catch (error) {
    handleFailure(res, error, 'Failed to register the push subscription');
  }
});

/** Remove this browser's push subscription by its endpoint URL. */
router.delete('/subscriptions', async (req: AuthenticatedRequest, res) => {
  try {
    const endpoint = req.body?.endpoint;
    if (typeof endpoint !== 'string' || !endpoint) {
      res
        .status(400)
        .json({ success: false, message: 'A push endpoint is required' });
      return;
    }
    const removed = await unsubscribe(req.user!.userId, endpoint);
    res.json({ success: true, data: { removed } });
  } catch (error) {
    handleFailure(res, error, 'Failed to remove the push subscription');
  }
});

export default router;
