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
  getWebSearchAccessMode,
  getWebSearchConfig,
  isWebSearchAccessMode,
  setWebSearchAccessMode,
  setWebSearchConfig,
  userCanUseWebSearch,
  webSearch,
} from '../services/webSearchService.js';
import { userModel } from '../models/userModel.js';
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
  const userId = (req as { user?: { userId?: string } }).user?.userId;
  const currentUser = userId ? userModel.getUserById(userId) : null;
  // Authorization follows current database state, like requireAdmin.
  const isAdmin =
    currentUser?.status === 'active' && currentUser.role === 'admin';
  res.json({
    success: true,
    data: {
      enabled: config.enabled,
      available: config.available,
      // Whether this account may use search right now — drives the
      // composer toggle. The backend re-checks on every request.
      allowed: config.available && userCanUseWebSearch(currentUser),
      ...(isAdmin
        ? {
            url: config.url,
            access: getWebSearchAccessMode(),
            maxResults: config.maxResults,
            safeSearch: config.safeSearch,
          }
        : {}),
    },
  });
});

/**
 * Who may use web search. Read is open to authenticated users; changing
 * the mode is admin-only and lives in User Management next to the other
 * access controls.
 */
router.get('/access', (req: Request, res: Response): void => {
  const userId = (req as { user?: { userId?: string } }).user?.userId;
  const currentUser = userId ? userModel.getUserById(userId) : null;
  res.json({
    success: true,
    data: {
      mode: getWebSearchAccessMode(),
      allowed:
        getWebSearchConfig().available && userCanUseWebSearch(currentUser),
    },
  });
});

router.put('/access', requireAdmin, (req: Request, res: Response): void => {
  const mode = req.body?.mode;
  if (!isWebSearchAccessMode(mode)) {
    res.status(400).json({
      success: false,
      error: 'mode must be "admins" or "all-users".',
    });
    return;
  }
  setWebSearchAccessMode(mode);
  res.json({ success: true, data: { mode: getWebSearchAccessMode() } });
});

router.put('/config', requireAdmin, (req: Request, res: Response): void => {
  const enabled = req.body?.enabled;
  const url = req.body?.url;
  const maxResults = req.body?.maxResults;
  const safeSearch = req.body?.safeSearch;
  if (typeof enabled !== 'boolean' || typeof url !== 'string') {
    res.status(400).json({
      success: false,
      error: 'enabled (boolean) and url (string) are required.',
    });
    return;
  }
  if (
    maxResults !== undefined &&
    (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 10)
  ) {
    res.status(400).json({
      success: false,
      error: 'maxResults must be an integer between 1 and 10.',
    });
    return;
  }
  if (safeSearch !== undefined && typeof safeSearch !== 'boolean') {
    res.status(400).json({
      success: false,
      error: 'safeSearch must be a boolean.',
    });
    return;
  }
  try {
    const config = setWebSearchConfig({ enabled, url, maxResults, safeSearch });
    res.json({
      success: true,
      data: {
        enabled: config.enabled,
        available: config.available,
        url: config.url,
        maxResults: config.maxResults,
        safeSearch: config.safeSearch,
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
