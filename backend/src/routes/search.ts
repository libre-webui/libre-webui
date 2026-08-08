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
import {
  getWebSearchConfig,
  setWebSearchConfig,
  webSearch,
} from '../services/webSearchService.js';
import { getErrorMessage } from '../types/index.js';

const router = express.Router();

router.use(authenticate);

/**
 * Whether search is available. Open to any authenticated user so the chat
 * composer knows whether to offer the toggle; the SearXNG URL itself is
 * admin configuration and only returned to administrators.
 */
router.get('/config', (req: Request, res: Response): void => {
  const config = getWebSearchConfig();
  const role = (req as { user?: { role?: string } }).user?.role;
  res.json({
    success: true,
    data: {
      enabled: config.enabled,
      available: config.available,
      ...(role === 'admin' ? { url: config.url } : {}),
    },
  });
});

router.put('/config', requireAdmin, (req: Request, res: Response): void => {
  const enabled = req.body?.enabled;
  const url = req.body?.url;
  if (typeof enabled !== 'boolean' || typeof url !== 'string') {
    res.status(400).json({
      success: false,
      error: 'enabled (boolean) and url (string) are required.',
    });
    return;
  }
  try {
    const config = setWebSearchConfig({ enabled, url });
    res.json({
      success: true,
      data: {
        enabled: config.enabled,
        available: config.available,
        url: config.url,
      },
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: getErrorMessage(error, 'Could not update the search settings.'),
    });
  }
});

/** Admin connectivity probe: run a tiny query against the configured instance. */
router.post(
  '/test',
  requireAdmin,
  async (_req: Request, res: Response): Promise<void> => {
    try {
      const results = await webSearch('libre webui', 3);
      res.json({ success: true, data: { ok: true, results: results.length } });
    } catch (error) {
      res.status(502).json({
        success: false,
        error: getErrorMessage(error, 'Search test failed.'),
      });
    }
  }
);

export default router;
