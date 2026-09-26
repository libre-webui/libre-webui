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
 * The embedded Strands agent engine. Access management is admin-only; every
 * other route re-checks the live access mode on each request and answers 403
 * when the account may not use the engine.
 */
import express, { NextFunction, Response } from 'express';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import {
  authenticate,
  AuthenticatedRequest,
  requireAdmin,
} from '../middleware/auth.js';
import {
  getStrandsAccess,
  isStrandsAccessMode,
  setStrandsAccessMode,
  strandsAccessLockedByEnv,
  userHasStrandsAccess,
} from '../services/strandsAccessService.js';
import { listStrandsModels, StrandsModelError } from '../strands/catalog.js';
import { getStrandsEngine } from '../strands/runtime.js';
import type { ApiResponse } from '../types/index.js';

const router = express.Router();
router.use(authenticate);

const require = createRequire(import.meta.url);

/**
 * The Strands packages do not export `./package.json`, so find it by walking
 * up from the resolved entry point.
 */
function packageVersion(name: string): string | null {
  try {
    let directory = path.dirname(require.resolve(name));
    for (;;) {
      const manifest = path.join(directory, 'package.json');
      if (fs.existsSync(manifest)) {
        const parsed = JSON.parse(fs.readFileSync(manifest, 'utf8')) as {
          name?: string;
          version?: string;
        };
        if (parsed.name === name) return parsed.version ?? null;
      }
      const parent = path.dirname(directory);
      if (parent === directory) return null;
      directory = parent;
    }
  } catch {
    return null;
  }
}

function errorStatus(error: unknown): number {
  const status = (error as { status?: unknown })?.status;
  return typeof status === 'number' && status >= 400 && status < 600
    ? status
    : 500;
}

function sendError(res: Response, error: unknown): void {
  const status = errorStatus(error);
  const known =
    error instanceof StrandsModelError ||
    (error as { name?: unknown })?.name === 'StrandsEngineError';
  res.status(status).json({
    success: false,
    error:
      known || status < 500
        ? error instanceof Error
          ? error.message
          : String(error)
        : 'The Strands engine could not complete the request.',
  } satisfies ApiResponse);
}

function userId(req: AuthenticatedRequest): string {
  return req.user?.userId ?? '';
}

function sessionParam(req: AuthenticatedRequest): string {
  const value = req.params.sessionId;
  return typeof value === 'string' ? value : '';
}

function optionalString(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return typeof value === 'string' ? value : undefined;
}

router.get('/access', requireAdmin, async (_req, res): Promise<void> => {
  const access = await getStrandsAccess();
  res.json({ success: true, data: access } satisfies ApiResponse);
});

router.put('/access', requireAdmin, async (req, res): Promise<void> => {
  const mode = req.body?.mode;
  if (!isStrandsAccessMode(mode)) {
    res.status(400).json({
      success: false,
      error: 'mode must be disabled, admins, or all-users.',
    } satisfies ApiResponse);
    return;
  }
  if (strandsAccessLockedByEnv()) {
    res.status(409).json({
      success: false,
      error:
        'Strands access is pinned by LIBRE_STRANDS_ACCESS; unset the environment variable to manage it here.',
    } satisfies ApiResponse);
    return;
  }
  await setStrandsAccessMode(mode);
  res.json({
    success: true,
    data: await getStrandsAccess(),
  } satisfies ApiResponse);
});

async function requireStrandsAccess(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const allowed = await userHasStrandsAccess({
    id: req.user?.userId,
    role: req.user?.role,
  }).catch(() => false);
  if (!allowed) {
    res.status(403).json({
      success: false,
      error: 'The Strands engine is not enabled for this account.',
    } satisfies ApiResponse);
    return;
  }
  next();
}

router.use(requireStrandsAccess);

router.get('/health', (_req, res): void => {
  res.json({
    success: true,
    data: {
      available: true,
      harnessVersion: packageVersion('@strands-agents/harness'),
      sdkVersion: packageVersion('@strands-agents/sdk'),
    },
  } satisfies ApiResponse);
});

router.get(
  '/models',
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const models = await listStrandsModels(userId(req));
      res.json({ success: true, data: models } satisfies ApiResponse);
    } catch (error) {
      sendError(res, error);
    }
  }
);

router.get(
  '/sessions',
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const engine = await getStrandsEngine();
      res.json({
        success: true,
        data: await engine.listSessions(userId(req)),
      } satisfies ApiResponse);
    } catch (error) {
      sendError(res, error);
    }
  }
);

router.post(
  '/sessions',
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const title = optionalString(req.body?.title);
    const model = optionalString(req.body?.model);
    try {
      const engine = await getStrandsEngine();
      const session = await engine.createSession(userId(req), {
        ...(title ? { title } : {}),
        ...(model !== undefined ? { model } : {}),
      });
      res
        .status(201)
        .json({ success: true, data: session } satisfies ApiResponse);
    } catch (error) {
      sendError(res, error);
    }
  }
);

router.get(
  '/sessions/:sessionId',
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const engine = await getStrandsEngine();
      const id = userId(req);
      const session = await engine.getSession(id, sessionParam(req));
      const messages = await engine.transcript(id, session.id);
      res.json({
        success: true,
        data: {
          session,
          messages,
          running: engine.isRunning(id, session.id),
        },
      } satisfies ApiResponse);
    } catch (error) {
      sendError(res, error);
    }
  }
);

router.patch(
  '/sessions/:sessionId',
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const title = optionalString(req.body?.title);
    const model = optionalString(req.body?.model);
    try {
      const engine = await getStrandsEngine();
      const session = await engine.updateSession(
        userId(req),
        sessionParam(req),
        {
          ...(typeof title === 'string' ? { title } : {}),
          ...(model !== undefined ? { model } : {}),
        }
      );
      res.json({ success: true, data: session } satisfies ApiResponse);
    } catch (error) {
      sendError(res, error);
    }
  }
);

router.delete(
  '/sessions/:sessionId',
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const engine = await getStrandsEngine();
      await engine.deleteSession(userId(req), sessionParam(req));
      res.json({ success: true } satisfies ApiResponse);
    } catch (error) {
      sendError(res, error);
    }
  }
);

router.post(
  '/sessions/:sessionId/cancel',
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const engine = await getStrandsEngine();
      const id = userId(req);
      await engine.getSession(id, sessionParam(req));
      res.json({
        success: true,
        data: { cancelled: engine.cancel(id, sessionParam(req)) },
      } satisfies ApiResponse);
    } catch (error) {
      sendError(res, error);
    }
  }
);

/**
 * Run one agent turn and stream it back as NDJSON, one StrandsTurnEvent per
 * line. Closing the connection cancels the turn.
 */
router.post(
  '/sessions/:sessionId/messages',
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const text = req.body?.text;
    if (typeof text !== 'string' || !text.trim()) {
      res.status(400).json({
        success: false,
        error: 'text is required.',
      } satisfies ApiResponse);
      return;
    }
    const id = userId(req);
    let engine: Awaited<ReturnType<typeof getStrandsEngine>>;
    try {
      engine = await getStrandsEngine();
      await engine.getSession(id, sessionParam(req));
      if (engine.isRunning(id, sessionParam(req))) {
        res.status(409).json({
          success: false,
          error: 'This session is already running a turn.',
        } satisfies ApiResponse);
        return;
      }
    } catch (error) {
      sendError(res, error);
      return;
    }

    const controller = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) controller.abort(new Error('Client closed'));
    });
    res.status(200);
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const write = (event: unknown) => {
      if (!res.writableEnded) res.write(`${JSON.stringify(event)}\n`);
    };
    try {
      for await (const event of engine.sendMessage(
        id,
        sessionParam(req),
        text,
        controller.signal
      )) {
        write(event);
      }
    } catch (error) {
      const status = errorStatus(error);
      write({
        type: 'error',
        message:
          status < 500 && error instanceof Error
            ? error.message
            : 'The Strands turn failed.',
      });
    } finally {
      res.end();
    }
  }
);

export default router;
