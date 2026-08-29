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
import automationService, {
  webhookSecretMatches,
} from '../services/automationService.js';
import automationSchedulerService from '../services/automationSchedulerService.js';
import type { AutomationInput } from '../services/automationService.js';
import { ApiResponse, Automation, AutomationRun } from '../types/index.js';
import { authenticate, AuthenticatedRequest } from '../middleware/auth.js';
import { ResourcePolicyError } from '../utils/resourceLimits.js';
import {
  InvalidTriggerError,
  occurrencesBetween,
} from '../utils/automationSchedule.js';

const router = express.Router();

// Inbound webhook firing, declared before the router-wide authenticate so
// external systems (CI, cron services, home automation) can fire with only
// the per-automation secret. The constant-time hash comparison IS the
// authentication; a missing automation and a wrong secret answer
// identically so the endpoint is not an automation-id oracle.
router.post('/:automationId/webhook', async (req, res) => {
  try {
    const automationId = String(req.params.automationId || '');
    const authorization = req.headers.authorization;
    const headerSecret = req.headers['x-libre-webhook-secret'];
    const presented =
      typeof headerSecret === 'string' && headerSecret
        ? headerSecret
        : typeof authorization === 'string' &&
            authorization.startsWith('Bearer ')
          ? authorization.slice('Bearer '.length)
          : '';
    const record =
      await automationService.getAutomationRecordById(automationId);
    if (
      !record ||
      !webhookSecretMatches(record.webhook_secret_hash, presented)
    ) {
      res
        .status(401)
        .json({ success: false, error: 'Invalid webhook credentials' });
      return;
    }
    // A pause means pause: unlike the owner's Run now, an external caller
    // cannot fire a paused automation.
    if (record.status !== 'active') {
      res
        .status(409)
        .json({ success: false, error: 'This automation is paused' });
      return;
    }
    const runId = await automationSchedulerService.runNow(
      automationId,
      record.user_id
    );
    res.status(202).json({ success: true, data: { runId } });
  } catch (error) {
    sendAutomationError(res, error, 'Failed to fire the automation webhook');
  }
});

router.use(authenticate);

const userIdOf = (req: AuthenticatedRequest): string =>
  req.user?.userId || 'default';

/** Occurrence projections span at most 62 days per request. */
const MAX_OCCURRENCE_RANGE_MS = 62 * 24 * 60 * 60 * 1000;

function sendAutomationError(
  res: express.Response,
  error: unknown,
  fallback: string
) {
  if (
    error instanceof ResourcePolicyError ||
    error instanceof InvalidTriggerError
  ) {
    const statusCode =
      error instanceof ResourcePolicyError ? error.statusCode : 400;
    res.status(statusCode).json({ success: false, error: error.message });
    return;
  }
  res.status(500).json({
    success: false,
    error: error instanceof Error ? error.message : fallback,
  } as ApiResponse);
}

function readEpoch(value: unknown, field: string): number {
  const parsed = typeof value === 'string' ? Number(value) : value;
  if (
    typeof parsed !== 'number' ||
    !Number.isSafeInteger(parsed) ||
    parsed < 0
  ) {
    throw new ResourcePolicyError(`${field} must be an epoch-ms integer`, 400);
  }
  return parsed;
}

function readAutomationBody(body: Record<string, unknown>): AutomationInput {
  const provider =
    typeof body.provider === 'string' && body.provider
      ? body.provider
      : undefined;
  const model =
    typeof body.model === 'string' && body.model ? body.model : undefined;
  const workPolicyId =
    typeof body.workPolicyId === 'string' && body.workPolicyId
      ? body.workPolicyId
      : undefined;
  const workTaskId =
    typeof body.workTaskId === 'string' && body.workTaskId
      ? body.workTaskId
      : undefined;
  return {
    name: typeof body.name === 'string' ? body.name : '',
    instructions:
      typeof body.instructions === 'string' ? body.instructions : '',
    triggers: body.triggers,
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    notify: body.notify === 'off' ? 'off' : 'app',
    target: body.target === 'work' ? 'work' : 'chat',
    ...(workPolicyId ? { workPolicyId } : {}),
    ...(workTaskId ? { workTaskId } : {}),
  };
}

router.get('/', async (req: AuthenticatedRequest, res) => {
  try {
    res.json({
      success: true,
      data: await automationService.getAutomations(userIdOf(req)),
    } as ApiResponse<Automation[]>);
  } catch (error) {
    sendAutomationError(res, error, 'Failed to load automations');
  }
});

router.post('/', async (req: AuthenticatedRequest, res) => {
  try {
    const automation = await automationService.createAutomation(
      readAutomationBody((req.body ?? {}) as Record<string, unknown>),
      userIdOf(req)
    );
    res.json({ success: true, data: automation } as ApiResponse<Automation>);
  } catch (error) {
    sendAutomationError(res, error, 'Failed to create automation');
  }
});

/** Upcoming computed occurrences across the caller's active automations. */
router.get('/occurrences', async (req: AuthenticatedRequest, res) => {
  try {
    const from = readEpoch(req.query.from, 'from');
    const to = readEpoch(req.query.to, 'to');
    if (to <= from || to - from > MAX_OCCURRENCE_RANGE_MS) {
      throw new ResourcePolicyError(
        'The requested range must be positive and span at most 62 days',
        400
      );
    }
    const automations = await automationService.getAutomations(userIdOf(req));
    const occurrences = automations
      .filter(automation => automation.status === 'active')
      .flatMap(automation =>
        occurrencesBetween(automation.triggers, from, to, 200).map(at => ({
          automationId: automation.id,
          name: automation.name,
          at,
        }))
      )
      .sort((left, right) => left.at - right.at);
    res.json({ success: true, data: occurrences } as ApiResponse);
  } catch (error) {
    sendAutomationError(res, error, 'Failed to project occurrences');
  }
});

router.get('/runs', async (req: AuthenticatedRequest, res) => {
  try {
    const options: { automationId?: string; from?: number; to?: number } = {};
    if (typeof req.query.automationId === 'string') {
      options.automationId = req.query.automationId;
    }
    if (req.query.from !== undefined) {
      options.from = readEpoch(req.query.from, 'from');
    }
    if (req.query.to !== undefined) {
      options.to = readEpoch(req.query.to, 'to');
    }
    res.json({
      success: true,
      data: await automationService.listRuns(userIdOf(req), options),
    } as ApiResponse<AutomationRun[]>);
  } catch (error) {
    sendAutomationError(res, error, 'Failed to load automation runs');
  }
});

router.get('/runs/summary', async (req: AuthenticatedRequest, res) => {
  try {
    res.json({
      success: true,
      data: await automationService.runsSummary(userIdOf(req)),
    } as ApiResponse);
  } catch (error) {
    sendAutomationError(res, error, 'Failed to load the run summary');
  }
});

router.post('/runs/seen', async (req: AuthenticatedRequest, res) => {
  try {
    const marked = await automationService.markRunsSeen(userIdOf(req));
    res.json({ success: true, data: { marked } } as ApiResponse);
  } catch (error) {
    sendAutomationError(res, error, 'Failed to mark runs as seen');
  }
});

router.get('/:automationId', async (req: AuthenticatedRequest, res) => {
  try {
    const automation = await automationService.getAutomation(
      req.params.automationId as string,
      userIdOf(req)
    );
    if (!automation) {
      res.status(404).json({
        success: false,
        error: 'Automation not found',
      } as ApiResponse);
      return;
    }
    res.json({ success: true, data: automation } as ApiResponse<Automation>);
  } catch (error) {
    sendAutomationError(res, error, 'Failed to load the automation');
  }
});

router.put('/:automationId', async (req: AuthenticatedRequest, res) => {
  try {
    const automation = await automationService.updateAutomation(
      req.params.automationId as string,
      readAutomationBody((req.body ?? {}) as Record<string, unknown>),
      userIdOf(req)
    );
    if (!automation) {
      res.status(404).json({
        success: false,
        error: 'Automation not found',
      } as ApiResponse);
      return;
    }
    res.json({ success: true, data: automation } as ApiResponse<Automation>);
  } catch (error) {
    sendAutomationError(res, error, 'Failed to update the automation');
  }
});

router.delete('/:automationId', async (req: AuthenticatedRequest, res) => {
  try {
    const deleted = await automationService.deleteAutomation(
      req.params.automationId as string,
      userIdOf(req)
    );
    if (!deleted) {
      res.status(404).json({
        success: false,
        error: 'Automation not found',
      } as ApiResponse);
      return;
    }
    res.json({ success: true, message: 'Automation deleted' } as ApiResponse);
  } catch (error) {
    sendAutomationError(res, error, 'Failed to delete the automation');
  }
});

const setStatus = async (
  req: AuthenticatedRequest,
  res: express.Response,
  status: 'active' | 'paused'
) => {
  try {
    const automation = await automationService.setAutomationStatus(
      req.params.automationId as string,
      userIdOf(req),
      status
    );
    if (!automation) {
      res.status(404).json({
        success: false,
        error: 'Automation not found',
      } as ApiResponse);
      return;
    }
    res.json({ success: true, data: automation } as ApiResponse<Automation>);
  } catch (error) {
    sendAutomationError(res, error, 'Failed to change the automation status');
  }
};

router.post('/:automationId/pause', (req: AuthenticatedRequest, res) =>
  setStatus(req, res, 'paused')
);

router.post('/:automationId/resume', (req: AuthenticatedRequest, res) =>
  setStatus(req, res, 'active')
);

router.post('/:automationId/run', async (req: AuthenticatedRequest, res) => {
  try {
    const userId = userIdOf(req);
    const automation = await automationService.getAutomation(
      req.params.automationId as string,
      userId
    );
    if (!automation) {
      res.status(404).json({
        success: false,
        error: 'Automation not found',
      } as ApiResponse);
      return;
    }
    const runId = await automationSchedulerService.runNow(
      automation.id,
      userId
    );
    res.status(202).json({ success: true, data: { runId } } as ApiResponse);
  } catch (error) {
    sendAutomationError(res, error, 'Failed to start the automation run');
  }
});

// Generate or rotate the inbound webhook secret. The plaintext is returned
// exactly once; only its hash is stored.
router.post('/:automationId/webhook-secret', async (req, res) => {
  try {
    const userId = userIdOf(req as AuthenticatedRequest);
    const automationId = req.params.automationId as string;
    const secret = await automationService.rotateWebhookSecret(
      automationId,
      userId
    );
    if (!secret) {
      res.status(404).json({
        success: false,
        error: 'Automation not found',
      } as ApiResponse);
      return;
    }
    res.json({
      success: true,
      data: {
        secret,
        path: `/api/automations/${encodeURIComponent(automationId)}/webhook`,
      },
    } as ApiResponse);
  } catch (error) {
    sendAutomationError(res, error, 'Failed to rotate the webhook secret');
  }
});

router.delete('/:automationId/webhook-secret', async (req, res) => {
  try {
    const userId = userIdOf(req as AuthenticatedRequest);
    const disabled = await automationService.disableWebhook(
      req.params.automationId as string,
      userId
    );
    if (!disabled) {
      res.status(404).json({
        success: false,
        error: 'Automation not found',
      } as ApiResponse);
      return;
    }
    res.json({ success: true, data: { webhookEnabled: false } } as ApiResponse);
  } catch (error) {
    sendAutomationError(res, error, 'Failed to disable the webhook');
  }
});

export default router;
