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

import express from 'express';
import rateLimit from '../middleware/sharedRateLimit.js';
import { authenticate, requireAdmin } from '../middleware/auth.js';
import { queryAuditEvents } from '../services/securityAuditService.js';
import { createLogger } from '../utils/logger.js';

const router = express.Router();
const logger = createLogger('audit-routes');

const auditRateLimiter = rateLimit({
  keyPrefix: 'security-audit',
  windowMs: 15 * 60 * 1000,
  max: 120,
  message: { success: false, message: 'Too many requests' },
  standardHeaders: true,
  legacyHeaders: false,
});

router.use(auditRateLimiter, authenticate, requireAdmin);

/** Query the security audit log (admin only, redacted at write time). */
router.get('/', async (req, res) => {
  try {
    const { action, actor, result, targetType, before, after, limit } =
      req.query;
    const parseEpoch = (value: unknown): number | undefined => {
      if (typeof value !== 'string' || !value) return undefined;
      const asNumber = Number(value);
      if (Number.isFinite(asNumber) && asNumber > 0) return asNumber;
      const asDate = Date.parse(value);
      return Number.isFinite(asDate) ? asDate : undefined;
    };
    const isResult = (
      value: unknown
    ): value is 'success' | 'denied' | 'failure' =>
      value === 'success' || value === 'denied' || value === 'failure';

    const events = await queryAuditEvents({
      ...(typeof action === 'string' && action ? { action } : {}),
      ...(typeof actor === 'string' && actor ? { actorUserId: actor } : {}),
      ...(isResult(result) ? { result } : {}),
      ...(typeof targetType === 'string' && targetType ? { targetType } : {}),
      ...(parseEpoch(before) !== undefined
        ? { before: parseEpoch(before)! }
        : {}),
      ...(parseEpoch(after) !== undefined ? { after: parseEpoch(after)! } : {}),
      ...(typeof limit === 'string' && Number.isFinite(Number(limit))
        ? { limit: Number(limit) }
        : {}),
    });

    res.json({
      success: true,
      data: events.map(event => ({
        id: event.id,
        occurredAt: new Date(event.occurred_at).toISOString(),
        actorUserId: event.actor_user_id,
        actorKind: event.actor_kind,
        action: event.action,
        targetType: event.target_type,
        targetId: event.target_id,
        result: event.result,
        requestId: event.request_id,
        details: event.details ? JSON.parse(event.details) : null,
      })),
    });
  } catch (error) {
    logger.error('Audit query error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

export default router;
