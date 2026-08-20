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
import { ApiResponse } from '../types/index.js';
import { authenticate, AuthenticatedRequest } from '../middleware/auth.js';
import { ResourcePolicyError } from '../utils/resourceLimits.js';
import {
  AuthorizationError,
  type AuthzActor,
} from '../services/authorizationService.js';
import {
  createSkill,
  deleteSkill,
  exportSkill,
  getSkill,
  importSkill,
  importSkillFromUrl,
  listSkills,
  listVersions,
  rollbackSkill,
  updateSkill,
  type SkillInput,
} from '../services/skillService.js';

const router = express.Router();
router.use(authenticate);

const userIdOf = (req: AuthenticatedRequest): string =>
  req.user?.userId || 'default';

const actorOf = (req: AuthenticatedRequest): AuthzActor => ({
  userId: userIdOf(req),
  role: req.user?.role,
});

function sendSkillError(
  res: express.Response,
  error: unknown,
  fallback: string
) {
  if (error instanceof ResourcePolicyError) {
    res.status(error.statusCode).json({ success: false, error: error.message });
    return;
  }
  if (error instanceof AuthorizationError) {
    res.status(403).json({ success: false, error: error.message });
    return;
  }
  res.status(500).json({
    success: false,
    error: error instanceof Error ? error.message : fallback,
  } as ApiResponse);
}

const notFound = (res: express.Response) => {
  res
    .status(404)
    .json({ success: false, error: 'Skill not found' } as ApiResponse);
};

const readSkillBody = (body: Record<string, unknown>): SkillInput => ({
  slug: body.slug,
  name: body.name,
  description: body.description,
  instructions: body.instructions,
  enabled: body.enabled,
});

router.get('/', async (req: AuthenticatedRequest, res) => {
  try {
    res.json({
      success: true,
      data: await listSkills(userIdOf(req)),
    } as ApiResponse);
  } catch (error) {
    sendSkillError(res, error, 'Failed to load skills');
  }
});

router.post('/', async (req: AuthenticatedRequest, res) => {
  try {
    const skill = await createSkill(
      userIdOf(req),
      readSkillBody((req.body ?? {}) as Record<string, unknown>)
    );
    res.status(201).json({ success: true, data: skill } as ApiResponse);
  } catch (error) {
    sendSkillError(res, error, 'Failed to create the skill');
  }
});

router.post('/import', async (req: AuthenticatedRequest, res) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const payload = body.skill !== undefined ? body.skill : body;
    const skill = await importSkill(userIdOf(req), payload, {
      overwriteSlug: body.overwriteSlug === true,
    });
    res.status(201).json({ success: true, data: skill } as ApiResponse);
  } catch (error) {
    sendSkillError(res, error, 'Failed to import the skill');
  }
});

router.post('/import-url', async (req: AuthenticatedRequest, res) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.source !== 'string' || !body.source.trim()) {
      res
        .status(400)
        .json({ success: false, error: 'A skill source is required' });
      return;
    }
    const skill = await importSkillFromUrl(userIdOf(req), body.source, {
      overwriteSlug: body.overwriteSlug === true,
    });
    res.status(201).json({ success: true, data: skill } as ApiResponse);
  } catch (error) {
    sendSkillError(res, error, 'Failed to import the skill');
  }
});

router.get('/:skillId', async (req: AuthenticatedRequest, res) => {
  try {
    const skill = await getSkill(req.params.skillId as string, actorOf(req));
    if (!skill) {
      notFound(res);
      return;
    }
    res.json({ success: true, data: skill } as ApiResponse);
  } catch (error) {
    sendSkillError(res, error, 'Failed to load the skill');
  }
});

router.put('/:skillId', async (req: AuthenticatedRequest, res) => {
  try {
    const skill = await updateSkill(
      req.params.skillId as string,
      actorOf(req),
      readSkillBody((req.body ?? {}) as Record<string, unknown>)
    );
    if (!skill) {
      notFound(res);
      return;
    }
    res.json({ success: true, data: skill } as ApiResponse);
  } catch (error) {
    sendSkillError(res, error, 'Failed to update the skill');
  }
});

router.delete('/:skillId', async (req: AuthenticatedRequest, res) => {
  try {
    const deleted = await deleteSkill(
      req.params.skillId as string,
      userIdOf(req)
    );
    if (!deleted) {
      notFound(res);
      return;
    }
    res.json({ success: true, message: 'Skill deleted' } as ApiResponse);
  } catch (error) {
    sendSkillError(res, error, 'Failed to delete the skill');
  }
});

router.get('/:skillId/versions', async (req: AuthenticatedRequest, res) => {
  try {
    const versions = await listVersions(
      req.params.skillId as string,
      actorOf(req)
    );
    if (!versions) {
      notFound(res);
      return;
    }
    res.json({ success: true, data: versions } as ApiResponse);
  } catch (error) {
    sendSkillError(res, error, 'Failed to load the skill history');
  }
});

router.post('/:skillId/rollback', async (req: AuthenticatedRequest, res) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const version =
      typeof body.version === 'string' ? Number(body.version) : body.version;
    if (typeof version !== 'number') {
      throw new ResourcePolicyError('version must be a positive integer', 400);
    }
    const skill = await rollbackSkill(
      req.params.skillId as string,
      actorOf(req),
      version
    );
    if (!skill) {
      notFound(res);
      return;
    }
    res.json({ success: true, data: skill } as ApiResponse);
  } catch (error) {
    sendSkillError(res, error, 'Failed to roll the skill back');
  }
});

router.get('/:skillId/export', async (req: AuthenticatedRequest, res) => {
  try {
    const payload = await exportSkill(
      req.params.skillId as string,
      actorOf(req)
    );
    if (!payload) {
      notFound(res);
      return;
    }
    res.json({ success: true, data: payload } as ApiResponse);
  } catch (error) {
    sendSkillError(res, error, 'Failed to export the skill');
  }
});

export default router;
