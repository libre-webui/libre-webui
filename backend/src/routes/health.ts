/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
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

import { authenticate, requireAdmin } from '../middleware/auth.js';
import healthService from '../services/healthService.js';

const router = express.Router();

const noStore = (
  _req: express.Request,
  res: express.Response,
  next: express.NextFunction
) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
};

router.use(noStore);

// Compatibility endpoint: process liveness only. It intentionally does not
// make optional providers, databases, or other dependencies restart the app.
router.get('/', (_req, res) => {
  res.json({ success: true, ...healthService.liveness() });
});

router.get('/live', (_req, res) => {
  res.json({ success: true, ...healthService.liveness() });
});

router.get('/ready', async (_req, res) => {
  const report = await healthService.readiness('ready');
  res.status(report.status === 'ready' ? 200 : 503).json({
    success: report.status === 'ready',
    ...healthService.toPublicReport(report),
  });
});

// Error messages, schema names, and dependency diagnostics are operational
// detail. Require the current database-backed administrator role before they
// leave the process.
router.get('/deep', authenticate, requireAdmin, async (_req, res) => {
  const report = await healthService.readiness('deep');
  res.status(report.status === 'ready' ? 200 : 503).json({
    success: report.status === 'ready',
    ...report,
  });
});

export default router;
