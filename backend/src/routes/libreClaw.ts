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

import express, { Request, Response } from 'express';
import { authenticate, requireAdmin } from '../middleware/auth.js';
import libreClawService, {
  LibreClawPermissionResolution,
  LibreClawRunRequest,
  LibreClawServiceError,
} from '../services/libreClawService.js';
import { ApiResponse } from '../types/index.js';

const router = express.Router();

router.use(authenticate, requireAdmin);

router.get('/status', async (_req: Request, res: Response): Promise<void> => {
  const status = await libreClawService.status();
  sendSuccess(res, status);
});

router.get('/health', async (_req: Request, res: Response): Promise<void> => {
  await sendLibreClaw(res, () => libreClawService.health());
});

router.get('/dashboard', (_req: Request, res: Response): void => {
  sendSuccess(res, { url: libreClawService.dashboardUrl() });
});

router.get(
  '/config/model',
  async (_req: Request, res: Response): Promise<void> => {
    await sendLibreClaw(res, () => libreClawService.currentModel());
  }
);

router.patch(
  '/config/model',
  async (req: Request, res: Response): Promise<void> => {
    await sendLibreClaw(res, () =>
      libreClawService.updateModel({
        provider: String(req.body?.provider || '').trim(),
        model: String(req.body?.model || '').trim(),
        persist_global: Boolean(req.body?.persist_global),
      })
    );
  }
);

router.get(
  '/config/fallback',
  async (_req: Request, res: Response): Promise<void> => {
    await sendLibreClaw(res, () => libreClawService.currentFallback());
  }
);

router.patch(
  '/config/fallback',
  async (req: Request, res: Response): Promise<void> => {
    await sendLibreClaw(res, () =>
      libreClawService.updateFallback(req.body || {})
    );
  }
);

router.patch(
  '/config/theme',
  async (req: Request, res: Response): Promise<void> => {
    await sendLibreClaw(res, () =>
      libreClawService.updateTheme({
        theme: String(req.body?.theme || '').trim(),
        persist_global: req.body?.persist_global !== false,
      })
    );
  }
);

router.get('/runs', async (req: Request, res: Response): Promise<void> => {
  await sendLibreClaw(res, () =>
    libreClawService.listRuns(readLimit(req, 20, 100))
  );
});

router.post('/runs', async (req: Request, res: Response): Promise<void> => {
  const payload = req.body as Partial<LibreClawRunRequest>;
  await sendLibreClaw(
    res,
    () =>
      libreClawService.startRun({
        message: String(payload?.message || '').trim(),
        kind: payload?.kind === 'goal' ? 'goal' : 'chat',
        provider: cleanOptionalString(payload?.provider),
        model: cleanOptionalString(payload?.model),
        surface: 'libre-webui',
        session: payload?.session,
        attachments: payload?.attachments,
      }),
    202
  );
});

router.get(
  '/runs/:runId',
  async (req: Request, res: Response): Promise<void> => {
    await sendLibreClaw(res, () =>
      libreClawService.getRun(readParam(req, 'runId'))
    );
  }
);

router.get(
  '/runs/:runId/events',
  async (req: Request, res: Response): Promise<void> => {
    await sendLibreClaw(res, () =>
      libreClawService.getEvents(readParam(req, 'runId'), readAfter(req))
    );
  }
);

router.post(
  '/runs/:runId/cancel',
  async (req: Request, res: Response): Promise<void> => {
    await sendLibreClaw(res, () =>
      libreClawService.cancelRun(readParam(req, 'runId'))
    );
  }
);

router.post(
  '/runs/:runId/permissions/:toolCallId',
  async (req: Request, res: Response): Promise<void> => {
    const resolution = String(req.body?.resolution || 'deny');
    const payload: LibreClawPermissionResolution = {
      resolution: isPermissionResolution(resolution) ? resolution : 'deny',
    };
    await sendLibreClaw(res, () =>
      libreClawService.resolvePermission(
        readParam(req, 'runId'),
        readParam(req, 'toolCallId'),
        payload
      )
    );
  }
);

router.get('/usage', async (req: Request, res: Response): Promise<void> => {
  await sendLibreClaw(res, () =>
    libreClawService.usage(
      String(req.query.provider || '').trim(),
      readLimit(req, 250, 1000)
    )
  );
});

router.get(
  '/automations',
  async (req: Request, res: Response): Promise<void> => {
    await sendLibreClaw(res, () =>
      libreClawService.listAutomations(readLimit(req, 50, 200))
    );
  }
);

router.post(
  '/automations',
  async (req: Request, res: Response): Promise<void> => {
    await sendLibreClaw(
      res,
      () => libreClawService.createAutomation(req.body || {}),
      201
    );
  }
);

router.get(
  '/automations/:automationId',
  async (req: Request, res: Response): Promise<void> => {
    await sendLibreClaw(res, () =>
      libreClawService.getAutomation(readParam(req, 'automationId'))
    );
  }
);

router.patch(
  '/automations/:automationId',
  async (req: Request, res: Response): Promise<void> => {
    await sendLibreClaw(res, () =>
      libreClawService.updateAutomation(
        readParam(req, 'automationId'),
        req.body || {}
      )
    );
  }
);

router.put(
  '/automations/:automationId',
  async (req: Request, res: Response): Promise<void> => {
    await sendLibreClaw(res, () =>
      libreClawService.updateAutomation(
        readParam(req, 'automationId'),
        req.body || {}
      )
    );
  }
);

router.post(
  '/automations/:automationId/pause',
  async (req: Request, res: Response): Promise<void> => {
    await sendLibreClaw(res, () =>
      libreClawService.pauseAutomation(readParam(req, 'automationId'))
    );
  }
);

router.post(
  '/automations/:automationId/resume',
  async (req: Request, res: Response): Promise<void> => {
    await sendLibreClaw(res, () =>
      libreClawService.resumeAutomation(readParam(req, 'automationId'))
    );
  }
);

router.post(
  '/automations/:automationId/run',
  async (req: Request, res: Response): Promise<void> => {
    await sendLibreClaw(res, () =>
      libreClawService.runAutomationNow(readParam(req, 'automationId'))
    );
  }
);

router.delete(
  '/automations/:automationId',
  async (req: Request, res: Response): Promise<void> => {
    await sendLibreClaw(res, () =>
      libreClawService.deleteAutomation(readParam(req, 'automationId'))
    );
  }
);

const sendLibreClaw = async <T>(
  res: Response<ApiResponse<T>>,
  action: () => Promise<T>,
  successStatus = 200
): Promise<void> => {
  try {
    const data = await action();
    res.status(successStatus).json({ success: true, data });
  } catch (error) {
    const status = error instanceof LibreClawServiceError ? error.status : 500;
    const message =
      error instanceof Error ? error.message : 'Libre Claw request failed';
    res.status(status).json({
      success: false,
      error: message,
    });
  }
};

const sendSuccess = <T>(res: Response<ApiResponse<T>>, data: T): void => {
  res.json({ success: true, data });
};

const readLimit = (req: Request, fallback: number, max: number): number => {
  const raw = Number(req.query.limit);
  if (!Number.isFinite(raw)) {
    return fallback;
  }
  return Math.max(1, Math.min(max, Math.floor(raw)));
};

const readAfter = (req: Request): number => {
  const raw = Number(req.query.after);
  if (!Number.isFinite(raw)) {
    return 0;
  }
  return Math.max(0, Math.floor(raw));
};

const readParam = (req: Request, name: string): string =>
  String(req.params[name] || '').trim();

const cleanOptionalString = (value: unknown): string | undefined => {
  const cleaned = String(value || '').trim();
  return cleaned || undefined;
};

const isPermissionResolution = (
  value: string
): value is LibreClawPermissionResolution['resolution'] =>
  value === 'allow_once' ||
  value === 'deny' ||
  value === 'always_allow_tool' ||
  value === 'always_allow_call';

export default router;
