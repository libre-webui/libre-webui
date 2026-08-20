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
 * Cost and quota governance administration (ADMIN-01): versioned tariffs,
 * budgets, cost analytics computed from the usage ledger, and a CSV export
 * for external accounting. Administrator-only; the underlying usage events
 * carry no prompt or response content.
 */

import express from 'express';
import rateLimit from '../middleware/sharedRateLimit.js';
import {
  authenticate,
  requireAdmin,
  type AuthenticatedRequest,
} from '../middleware/auth.js';
import costGovernanceService from '../services/costGovernanceService.js';
import { recordAuditEvent } from '../services/securityAuditService.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('routes:costs');
const router = express.Router();

const costsRateLimiter = rateLimit({
  keyPrefix: 'costs',
  windowMs: 60_000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
});

router.use(costsRateLimiter, authenticate, requireAdmin);

const param = (value: string | string[]): string =>
  Array.isArray(value) ? value[0] : value;

const parseDays = (value: unknown): number => {
  const days = Number.parseInt(String(value ?? '30'), 10);
  if (!Number.isInteger(days) || days < 1 || days > 365) return 30;
  return days;
};

const fail = (
  res: express.Response,
  error: unknown,
  fallback: string
): void => {
  const message = error instanceof Error ? error.message : fallback;
  const status = /required|must be|Unknown|not found|up to/i.test(message)
    ? 400
    : 500;
  if (status === 500) logger.error(fallback, error);
  res.status(status).json({ success: false, message });
};

router.get('/tariffs', async (_req, res) => {
  try {
    res.json({
      success: true,
      data: await costGovernanceService.listTariffs(),
    });
  } catch (error) {
    fail(res, error, 'Failed to list tariffs');
  }
});

router.post('/tariffs', async (req: AuthenticatedRequest, res) => {
  try {
    const tariff = await costGovernanceService.createTariff(
      req.body ?? {},
      req.user?.userId ?? 'unknown'
    );
    recordAuditEvent({
      actorUserId: req.user?.userId,
      action: 'cost.tariff.create',
      targetType: 'tariff',
      targetId: tariff.id,
      result: 'success',
      details: { pluginId: tariff.plugin_id, model: tariff.model },
    });
    res.status(201).json({ success: true, data: tariff });
  } catch (error) {
    fail(res, error, 'Failed to create the tariff');
  }
});

router.delete('/tariffs/:tariffId', async (req: AuthenticatedRequest, res) => {
  try {
    const removed = await costGovernanceService.deleteTariff(
      param(req.params.tariffId)
    );
    if (!removed) {
      res.status(404).json({ success: false, message: 'Tariff not found' });
      return;
    }
    recordAuditEvent({
      actorUserId: req.user?.userId,
      action: 'cost.tariff.delete',
      targetType: 'tariff',
      targetId: param(req.params.tariffId),
      result: 'success',
    });
    res.status(204).send();
  } catch (error) {
    fail(res, error, 'Failed to delete the tariff');
  }
});

router.get('/budgets', async (_req, res) => {
  try {
    res.json({
      success: true,
      data: await costGovernanceService.listBudgets(),
    });
  } catch (error) {
    fail(res, error, 'Failed to list budgets');
  }
});

router.post('/budgets', async (req: AuthenticatedRequest, res) => {
  try {
    const budget = await costGovernanceService.saveBudget(
      req.body ?? {},
      req.user?.userId ?? 'unknown'
    );
    recordAuditEvent({
      actorUserId: req.user?.userId,
      action: 'cost.budget.create',
      targetType: 'budget',
      targetId: budget.id,
      result: 'success',
      details: { mode: budget.mode, period: budget.period },
    });
    res.status(201).json({ success: true, data: budget });
  } catch (error) {
    fail(res, error, 'Failed to create the budget');
  }
});

router.put('/budgets/:budgetId', async (req: AuthenticatedRequest, res) => {
  try {
    const budget = await costGovernanceService.saveBudget(
      req.body ?? {},
      req.user?.userId ?? 'unknown',
      param(req.params.budgetId)
    );
    recordAuditEvent({
      actorUserId: req.user?.userId,
      action: 'cost.budget.update',
      targetType: 'budget',
      targetId: budget.id,
      result: 'success',
      details: { mode: budget.mode, period: budget.period },
    });
    res.json({ success: true, data: budget });
  } catch (error) {
    fail(res, error, 'Failed to update the budget');
  }
});

router.delete('/budgets/:budgetId', async (req: AuthenticatedRequest, res) => {
  try {
    const removed = await costGovernanceService.deleteBudget(
      param(req.params.budgetId)
    );
    if (!removed) {
      res.status(404).json({ success: false, message: 'Budget not found' });
      return;
    }
    recordAuditEvent({
      actorUserId: req.user?.userId,
      action: 'cost.budget.delete',
      targetType: 'budget',
      targetId: param(req.params.budgetId),
      result: 'success',
    });
    res.status(204).send();
  } catch (error) {
    fail(res, error, 'Failed to delete the budget');
  }
});

router.get('/analytics', async (req, res) => {
  try {
    res.json({
      success: true,
      data: await costGovernanceService.getCostAnalytics(
        parseDays(req.query.days)
      ),
    });
  } catch (error) {
    fail(res, error, 'Failed to compute cost analytics');
  }
});

router.get('/export', async (req, res) => {
  try {
    const csv = await costGovernanceService.exportCostsCsv(
      parseDays(req.query.days)
    );
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      'attachment; filename="libre-webui-costs.csv"'
    );
    res.send(csv);
  } catch (error) {
    fail(res, error, 'Failed to export costs');
  }
});

export default router;
