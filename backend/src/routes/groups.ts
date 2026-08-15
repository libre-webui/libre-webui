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
import {
  authenticate,
  requireAdmin,
  AuthenticatedRequest,
} from '../middleware/auth.js';
import {
  addGroupMember,
  createGroup,
  deleteGroup,
  getGroup,
  GroupError,
  listGroupsWithMembers,
  removeGroupMember,
  updateGroup,
} from '../services/groupService.js';
import { explainEffectiveAccess } from '../services/authorizationService.js';
import { userModel } from '../models/userModel.js';
import { createLogger } from '../utils/logger.js';

const router = express.Router();
const logger = createLogger('groups-routes');

const groupsRateLimiter = rateLimit({
  keyPrefix: 'groups-admin',
  windowMs: 15 * 60 * 1000,
  max: 120,
  message: { success: false, message: 'Too many requests' },
  standardHeaders: true,
  legacyHeaders: false,
});

router.use(groupsRateLimiter, authenticate, requireAdmin);

const handleError = (
  res: express.Response,
  error: unknown,
  fallback: string
): void => {
  if (error instanceof GroupError) {
    res
      .status(error.statusCode)
      .json({ success: false, message: error.message });
    return;
  }
  logger.error(fallback, error);
  res.status(500).json({ success: false, message: 'Internal server error' });
};

/** List groups with members. */
router.get('/', async (_req, res) => {
  try {
    const groups = await listGroupsWithMembers();
    res.json({ success: true, data: groups });
  } catch (error) {
    handleError(res, error, 'Group list error:');
  }
});

/** Create a group. */
router.post('/', async (req: AuthenticatedRequest, res) => {
  try {
    const { name, description } = req.body ?? {};
    if (typeof name !== 'string') {
      res.status(400).json({ success: false, message: 'name is required' });
      return;
    }
    const group = await createGroup(
      {
        name,
        description: typeof description === 'string' ? description : null,
      },
      req.user!.userId
    );
    res.status(201).json({ success: true, data: group });
  } catch (error) {
    handleError(res, error, 'Group create error:');
  }
});

/** Update a group's name or description. */
router.patch('/:id', async (req: AuthenticatedRequest, res) => {
  try {
    const { name, description } = req.body ?? {};
    const group = await updateGroup(
      req.params.id as string,
      {
        ...(typeof name === 'string' ? { name } : {}),
        ...(description !== undefined
          ? {
              description: typeof description === 'string' ? description : null,
            }
          : {}),
      },
      req.user!.userId
    );
    if (!group) {
      res.status(404).json({ success: false, message: 'Group not found' });
      return;
    }
    res.json({ success: true, data: group });
  } catch (error) {
    handleError(res, error, 'Group update error:');
  }
});

/** Delete a group; its grants and memberships go with it. */
router.delete('/:id', async (req: AuthenticatedRequest, res) => {
  try {
    const deleted = await deleteGroup(
      req.params.id as string,
      req.user!.userId
    );
    if (!deleted) {
      res.status(404).json({ success: false, message: 'Group not found' });
      return;
    }
    res.json({ success: true });
  } catch (error) {
    handleError(res, error, 'Group delete error:');
  }
});

/** Add a member. */
router.post('/:id/members', async (req: AuthenticatedRequest, res) => {
  try {
    const { userId } = req.body ?? {};
    if (typeof userId !== 'string' || !userId) {
      res.status(400).json({ success: false, message: 'userId is required' });
      return;
    }
    const added = await addGroupMember(
      req.params.id as string,
      userId,
      req.user!.userId
    );
    res.status(added ? 201 : 200).json({ success: true, data: { added } });
  } catch (error) {
    handleError(res, error, 'Group member add error:');
  }
});

/** Remove a member; access via this group's grants ends immediately. */
router.delete(
  '/:id/members/:userId',
  async (req: AuthenticatedRequest, res) => {
    try {
      if (!(await getGroup(req.params.id as string))) {
        res.status(404).json({ success: false, message: 'Group not found' });
        return;
      }
      const removed = await removeGroupMember(
        req.params.id as string,
        req.params.userId as string,
        req.user!.userId
      );
      res.json({ success: true, data: { removed } });
    } catch (error) {
      handleError(res, error, 'Group member remove error:');
    }
  }
);

/**
 * Effective access for one user: role, groups, feature gates, and every
 * grant reaching them — the "why can this user access this?" view.
 */
router.get('/effective/:userId', async (req, res) => {
  try {
    const user = await userModel.getUserById(req.params.userId);
    if (!user) {
      res.status(404).json({ success: false, message: 'User not found' });
      return;
    }
    const view = await explainEffectiveAccess({
      id: user.id,
      role: user.role,
      status: user.status,
    });
    res.json({ success: true, data: { ...view, username: user.username } });
  } catch (error) {
    handleError(res, error, 'Effective access error:');
  }
});

export default router;
