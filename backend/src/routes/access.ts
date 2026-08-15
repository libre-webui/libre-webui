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
 * Resource-grant management (IAM-03). Owners (and grant-admins) manage
 * shares on their own resources; a user can always list what is shared
 * with them and leave a share.
 */

import express from 'express';
import rateLimit from '../middleware/sharedRateLimit.js';
import { authenticate, AuthenticatedRequest } from '../middleware/auth.js';
import {
  createGrant,
  deleteGrant,
  listGrantsForActor,
  listGrantsForResource,
  ResourceGrantError,
} from '../services/resourceGrantService.js';
import type { AuthzActor } from '../services/authorizationService.js';
import { createLogger } from '../utils/logger.js';

const router = express.Router();
const logger = createLogger('access-routes');

const accessRateLimiter = rateLimit({
  keyPrefix: 'resource-access',
  windowMs: 15 * 60 * 1000,
  max: 240,
  message: { success: false, message: 'Too many requests' },
  standardHeaders: true,
  legacyHeaders: false,
});

router.use(accessRateLimiter, authenticate);

const actorOf = (req: AuthenticatedRequest): AuthzActor => ({
  userId: req.user!.userId,
  role: req.user!.role,
});

const handleError = (
  res: express.Response,
  error: unknown,
  fallback: string
): void => {
  if (error instanceof ResourceGrantError) {
    res
      .status(error.statusCode)
      .json({ success: false, message: error.message });
    return;
  }
  logger.error(fallback, error);
  res.status(500).json({ success: false, message: 'Internal server error' });
};

const publicGrant = (grant: {
  id: string;
  resource_type: string;
  resource_id: string;
  principal_type: string;
  principal_id: string;
  permission: string;
  created_at: number;
}) => ({
  id: grant.id,
  resourceType: grant.resource_type,
  resourceId: grant.resource_id,
  principalType: grant.principal_type,
  principalId: grant.principal_id,
  permission: grant.permission,
  createdAt: new Date(grant.created_at).toISOString(),
});

/** Grants on one of the caller's resources. */
router.get('/grants', async (req: AuthenticatedRequest, res) => {
  try {
    const { type, id } = req.query;
    if (typeof type !== 'string' || typeof id !== 'string') {
      res
        .status(400)
        .json({ success: false, message: 'type and id are required' });
      return;
    }
    const grants = await listGrantsForResource(actorOf(req), type, id);
    res.json({ success: true, data: grants.map(publicGrant) });
  } catch (error) {
    handleError(res, error, 'Grant list error:');
  }
});

/** Share a resource with a user or group. */
router.post('/grants', async (req: AuthenticatedRequest, res) => {
  try {
    const { resourceType, resourceId, principalType, principalId, permission } =
      req.body ?? {};
    for (const [field, value] of Object.entries({
      resourceType,
      resourceId,
      principalType,
      principalId,
      permission,
    })) {
      if (typeof value !== 'string' || !value) {
        res
          .status(400)
          .json({ success: false, message: `${field} is required` });
        return;
      }
    }
    const grant = await createGrant(actorOf(req), {
      resourceType,
      resourceId,
      principalType,
      principalId,
      permission,
    });
    res.status(201).json({ success: true, data: publicGrant(grant) });
  } catch (error) {
    handleError(res, error, 'Grant create error:');
  }
});

/** Remove a grant (owner, grant-admin, or the granted user leaving). */
router.delete('/grants/:id', async (req: AuthenticatedRequest, res) => {
  try {
    const deleted = await deleteGrant(actorOf(req), req.params.id as string);
    if (!deleted) {
      res.status(404).json({ success: false, message: 'Grant not found' });
      return;
    }
    res.json({ success: true });
  } catch (error) {
    handleError(res, error, 'Grant delete error:');
  }
});

/** Everything shared with the caller, directly or via groups. */
router.get('/shared-with-me', async (req: AuthenticatedRequest, res) => {
  try {
    const grants = await listGrantsForActor(actorOf(req));
    res.json({ success: true, data: grants.map(publicGrant) });
  } catch (error) {
    handleError(res, error, 'Shared list error:');
  }
});

export default router;
