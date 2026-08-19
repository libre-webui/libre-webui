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
  createPrompt,
  deletePrompt,
  exportPrompt,
  getPrompt,
  importPrompt,
  listPrompts,
  listVersions,
  rollbackPrompt,
  updatePrompt,
  type PromptInput,
} from '../services/promptService.js';

const router = express.Router();
router.use(authenticate);

const userIdOf = (req: AuthenticatedRequest): string =>
  req.user?.userId || 'default';

const actorOf = (req: AuthenticatedRequest): AuthzActor => ({
  userId: userIdOf(req),
  role: req.user?.role,
});

function sendPromptError(
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
    .json({ success: false, error: 'Prompt not found' } as ApiResponse);
};

const readPromptBody = (body: Record<string, unknown>): PromptInput => ({
  slug: body.slug,
  title: body.title,
  description: body.description,
  content: body.content,
  variables: body.variables,
  tags: body.tags,
});

router.get('/', async (req: AuthenticatedRequest, res) => {
  try {
    res.json({
      success: true,
      data: await listPrompts(userIdOf(req)),
    } as ApiResponse);
  } catch (error) {
    sendPromptError(res, error, 'Failed to load prompts');
  }
});

router.post('/', async (req: AuthenticatedRequest, res) => {
  try {
    const prompt = await createPrompt(
      userIdOf(req),
      readPromptBody((req.body ?? {}) as Record<string, unknown>)
    );
    res.status(201).json({ success: true, data: prompt } as ApiResponse);
  } catch (error) {
    sendPromptError(res, error, 'Failed to create the prompt');
  }
});

router.post('/import', async (req: AuthenticatedRequest, res) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const payload = body.prompt !== undefined ? body.prompt : body;
    const prompt = await importPrompt(userIdOf(req), payload, {
      overwriteSlug: body.overwriteSlug === true,
    });
    res.status(201).json({ success: true, data: prompt } as ApiResponse);
  } catch (error) {
    sendPromptError(res, error, 'Failed to import the prompt');
  }
});

router.get('/:promptId', async (req: AuthenticatedRequest, res) => {
  try {
    const prompt = await getPrompt(req.params.promptId as string, actorOf(req));
    if (!prompt) {
      notFound(res);
      return;
    }
    res.json({ success: true, data: prompt } as ApiResponse);
  } catch (error) {
    sendPromptError(res, error, 'Failed to load the prompt');
  }
});

router.put('/:promptId', async (req: AuthenticatedRequest, res) => {
  try {
    const prompt = await updatePrompt(
      req.params.promptId as string,
      actorOf(req),
      readPromptBody((req.body ?? {}) as Record<string, unknown>)
    );
    if (!prompt) {
      notFound(res);
      return;
    }
    res.json({ success: true, data: prompt } as ApiResponse);
  } catch (error) {
    sendPromptError(res, error, 'Failed to update the prompt');
  }
});

router.delete('/:promptId', async (req: AuthenticatedRequest, res) => {
  try {
    const deleted = await deletePrompt(
      req.params.promptId as string,
      userIdOf(req)
    );
    if (!deleted) {
      notFound(res);
      return;
    }
    res.json({ success: true, message: 'Prompt deleted' } as ApiResponse);
  } catch (error) {
    sendPromptError(res, error, 'Failed to delete the prompt');
  }
});

router.get('/:promptId/versions', async (req: AuthenticatedRequest, res) => {
  try {
    const versions = await listVersions(
      req.params.promptId as string,
      actorOf(req)
    );
    if (!versions) {
      notFound(res);
      return;
    }
    res.json({ success: true, data: versions } as ApiResponse);
  } catch (error) {
    sendPromptError(res, error, 'Failed to load the prompt history');
  }
});

router.post('/:promptId/rollback', async (req: AuthenticatedRequest, res) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const version =
      typeof body.version === 'string' ? Number(body.version) : body.version;
    if (typeof version !== 'number') {
      throw new ResourcePolicyError('version must be a positive integer', 400);
    }
    const prompt = await rollbackPrompt(
      req.params.promptId as string,
      actorOf(req),
      version
    );
    if (!prompt) {
      notFound(res);
      return;
    }
    res.json({ success: true, data: prompt } as ApiResponse);
  } catch (error) {
    sendPromptError(res, error, 'Failed to roll the prompt back');
  }
});

router.get('/:promptId/export', async (req: AuthenticatedRequest, res) => {
  try {
    const payload = await exportPrompt(
      req.params.promptId as string,
      actorOf(req)
    );
    if (!payload) {
      notFound(res);
      return;
    }
    res.json({ success: true, data: payload } as ApiResponse);
  } catch (error) {
    sendPromptError(res, error, 'Failed to export the prompt');
  }
});

export default router;
