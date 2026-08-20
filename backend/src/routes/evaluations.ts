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
 * Evaluation platform (ADMIN-02): message feedback with topic tags and
 * rated snapshots, blind arena votes with an Elo leaderboard, and
 * reusable evaluation sets whose runs execute as durable jobs under the
 * caller's own identity and provider credentials.
 */

import express from 'express';
import rateLimit from '../middleware/sharedRateLimit.js';
import {
  authenticate,
  requireAdmin,
  type AuthenticatedRequest,
} from '../middleware/auth.js';
import evaluationService from '../services/evaluationService.js';
import { budgetGuard } from '../middleware/index.js';
import { randomUUID } from 'crypto';
import { getDurableJobRuntime } from '../platform/jobs/durableJobRuntime.js';
import {
  EVAL_RUN_JOB_TYPE,
  EVAL_RUN_IDEMPOTENCY_SCOPE,
} from '../platform/jobs/domainJobContracts.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('routes:evaluations');
const router = express.Router();

const evaluationsRateLimiter = rateLimit({
  keyPrefix: 'evaluations',
  windowMs: 60_000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
});

router.use(evaluationsRateLimiter, authenticate);

const userId = (req: AuthenticatedRequest): string => {
  if (!req.user) throw new Error('Authenticated user context is required');
  return req.user.userId;
};

const param = (value: string | string[]): string =>
  Array.isArray(value) ? value[0] : value;

const fail = (
  res: express.Response,
  error: unknown,
  fallback: string
): void => {
  const message = error instanceof Error ? error.message : fallback;
  const status = /not found/i.test(message)
    ? 404
    : /required|must be|Unknown|up to|At most|At least/i.test(message)
      ? 400
      : 500;
  if (status === 500) logger.error(fallback, error);
  res.status(status).json({ success: false, message });
};

// ------------------------------------------------------------------ feedback

router.post('/feedback', async (req: AuthenticatedRequest, res) => {
  try {
    const feedback = await evaluationService.upsertFeedback(
      userId(req),
      req.body ?? {}
    );
    res.status(201).json({ success: true, data: feedback });
  } catch (error) {
    fail(res, error, 'Failed to save feedback');
  }
});

router.delete(
  '/feedback/:messageId',
  async (req: AuthenticatedRequest, res) => {
    try {
      const removed = await evaluationService.deleteFeedback(
        userId(req),
        param(req.params.messageId)
      );
      if (!removed) {
        res.status(404).json({ success: false, message: 'Feedback not found' });
        return;
      }
      res.status(204).send();
    } catch (error) {
      fail(res, error, 'Failed to delete feedback');
    }
  }
);

router.get('/feedback', async (req: AuthenticatedRequest, res) => {
  try {
    res.json({
      success: true,
      data: await evaluationService.listFeedback({ userId: userId(req) }),
    });
  } catch (error) {
    fail(res, error, 'Failed to list feedback');
  }
});

/** Instance-wide feedback dataset for administrators. */
router.get('/feedback/all', requireAdmin, async (_req, res) => {
  try {
    res.json({
      success: true,
      data: await evaluationService.listFeedback(),
    });
  } catch (error) {
    fail(res, error, 'Failed to list feedback');
  }
});

// --------------------------------------------------------------------- arena

router.post('/arena/votes', async (req: AuthenticatedRequest, res) => {
  try {
    const recorded = await evaluationService.recordArenaVote(
      userId(req),
      req.body ?? {}
    );
    if (!recorded) {
      res.status(409).json({
        success: false,
        message: 'You already voted on this comparison',
      });
      return;
    }
    res.status(201).json({ success: true, data: { recorded: true } });
  } catch (error) {
    fail(res, error, 'Failed to record the vote');
  }
});

/**
 * Blind arena match: generate the same prompt against two models under the
 * caller\'s credentials and return the candidates in randomized order. The
 * client withholds model identities until the vote lands.
 */
router.post(
  '/arena/matches',
  budgetGuard,
  async (req: AuthenticatedRequest, res) => {
    try {
      const actor = userId(req);
      const { prompt, modelA, modelB, providerIdA, providerIdB } = (req.body ??
        {}) as Record<string, unknown>;
      if (
        typeof prompt !== 'string' ||
        !prompt.trim() ||
        prompt.length > 8000 ||
        typeof modelA !== 'string' ||
        typeof modelB !== 'string' ||
        !modelA.trim() ||
        !modelB.trim()
      ) {
        res.status(400).json({
          success: false,
          message: 'prompt, modelA, and modelB are required',
        });
        return;
      }
      if (modelA === modelB) {
        res.status(400).json({
          success: false,
          message: 'Pick two different models',
        });
        return;
      }
      const { default: chatGenerationService } =
        await import('../services/chatGenerationService.js');
      const compareGroup = randomUUID();
      const now = Date.now();
      const generate = async (model: string, providerId: unknown) => {
        const target = await chatGenerationService.prepareGenerationTarget(
          model,
          actor,
          {},
          typeof providerId === 'string' && providerId
            ? ({ providerType: 'plugin', providerId } as never)
            : undefined
        );
        const messages = [
          {
            id: `${compareGroup}-${model}`,
            role: 'user' as const,
            content: prompt.trim(),
            timestamp: now,
          },
        ];
        const result = await chatGenerationService.executeNonStreaming({
          target,
          ollamaMessages: messages.map(message => ({
            role: message.role,
            content: message.content,
          })),
          pluginMessages: messages,
          userId: actor,
        });
        return result.assistantContent;
      };
      const [outputA, outputB] = await Promise.all([
        generate(modelA, providerIdA),
        generate(modelB, providerIdB),
      ]);
      const candidates = [
        { key: 'a' as const, model: modelA.trim(), output: outputA },
        { key: 'b' as const, model: modelB.trim(), output: outputB },
      ];
      if (Math.random() < 0.5) candidates.reverse();
      res.json({ success: true, data: { compareGroup, candidates } });
    } catch (error) {
      fail(res, error, 'Failed to run the arena match');
    }
  }
);

router.get('/arena/leaderboard', async (_req, res) => {
  try {
    res.json({
      success: true,
      data: await evaluationService.arenaLeaderboard(),
    });
  } catch (error) {
    fail(res, error, 'Failed to compute the leaderboard');
  }
});

// ----------------------------------------------------------------- eval sets

router.get('/sets', async (req: AuthenticatedRequest, res) => {
  try {
    res.json({
      success: true,
      data: await evaluationService.listEvalSets(userId(req)),
    });
  } catch (error) {
    fail(res, error, 'Failed to list evaluation sets');
  }
});

router.post('/sets', async (req: AuthenticatedRequest, res) => {
  try {
    res.status(201).json({
      success: true,
      data: await evaluationService.saveEvalSet(userId(req), req.body ?? {}),
    });
  } catch (error) {
    fail(res, error, 'Failed to save the evaluation set');
  }
});

router.put('/sets/:setId', async (req: AuthenticatedRequest, res) => {
  try {
    res.json({
      success: true,
      data: await evaluationService.saveEvalSet(userId(req), {
        ...(req.body ?? {}),
        id: param(req.params.setId),
      }),
    });
  } catch (error) {
    fail(res, error, 'Failed to save the evaluation set');
  }
});

router.delete('/sets/:setId', async (req: AuthenticatedRequest, res) => {
  try {
    const removed = await evaluationService.deleteEvalSet(
      param(req.params.setId),
      userId(req)
    );
    if (!removed) {
      res
        .status(404)
        .json({ success: false, message: 'Evaluation set not found' });
      return;
    }
    res.status(204).send();
  } catch (error) {
    fail(res, error, 'Failed to delete the evaluation set');
  }
});

// ----------------------------------------------------------------- eval runs

router.get('/runs', async (req: AuthenticatedRequest, res) => {
  try {
    const setId =
      typeof req.query.setId === 'string' ? req.query.setId : undefined;
    res.json({
      success: true,
      data: await evaluationService.listRuns(userId(req), setId),
    });
  } catch (error) {
    fail(res, error, 'Failed to list evaluation runs');
  }
});

router.post('/runs', async (req: AuthenticatedRequest, res) => {
  try {
    const actor = userId(req);
    const run = await evaluationService.createRunRecord(actor, req.body ?? {});
    try {
      await getDurableJobRuntime().service.enqueue({
        jobType: EVAL_RUN_JOB_TYPE,
        actorUserId: actor,
        idempotencyScope: EVAL_RUN_IDEMPOTENCY_SCOPE,
        idempotencyKey: run.id,
        payload: { mode: 'encrypted', value: { runId: run.id } },
        maxAttempts: 2,
      });
    } catch (error) {
      await evaluationService.updateRunStatus(run.id, actor, 'failed', {
        error: 'The evaluation job could not be queued',
      });
      throw error;
    }
    res.status(202).json({
      success: true,
      data: await evaluationService.getRun(run.id, actor),
    });
  } catch (error) {
    fail(res, error, 'Failed to start the evaluation run');
  }
});

router.get('/runs/:runId', async (req: AuthenticatedRequest, res) => {
  try {
    const run = await evaluationService.getRun(
      param(req.params.runId),
      userId(req)
    );
    if (!run) {
      res
        .status(404)
        .json({ success: false, message: 'Evaluation run not found' });
      return;
    }
    res.json({ success: true, data: run });
  } catch (error) {
    fail(res, error, 'Failed to load the evaluation run');
  }
});

router.post('/runs/:runId/cancel', async (req: AuthenticatedRequest, res) => {
  try {
    const actor = userId(req);
    const run = await evaluationService.getRun(param(req.params.runId), actor);
    if (!run) {
      res
        .status(404)
        .json({ success: false, message: 'Evaluation run not found' });
      return;
    }
    const service = getDurableJobRuntime().service;
    const job = await service.getByIdempotency(
      actor,
      EVAL_RUN_IDEMPOTENCY_SCOPE,
      run.id
    );
    if (job) await service.cancel(job.id, actor, 'user-requested');
    res.json({ success: true, data: { cancelled: true } });
  } catch (error) {
    fail(res, error, 'Failed to cancel the evaluation run');
  }
});

router.get('/runs/:runId/export', async (req: AuthenticatedRequest, res) => {
  try {
    const run = await evaluationService.getRun(
      param(req.params.runId),
      userId(req)
    );
    if (!run) {
      res
        .status(404)
        .json({ success: false, message: 'Evaluation run not found' });
      return;
    }
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="eval-run-${run.id}.json"`
    );
    res.send(JSON.stringify(run, null, 2));
  } catch (error) {
    fail(res, error, 'Failed to export the evaluation run');
  }
});

export default router;
