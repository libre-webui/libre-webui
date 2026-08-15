/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import express from 'express';
import { authenticate, type AuthenticatedRequest } from '../middleware/auth.js';
import rateLimit from '../middleware/sharedRateLimit.js';
import {
  DurableJobError,
  getDurableJobRuntime,
  type DurableJobState,
} from '../platform/jobs/index.js';

const router = express.Router();
router.use(authenticate);
router.use(
  rateLimit({
    keyPrefix: 'durable-jobs',
    windowMs: 60_000,
    max: 240,
    keyGenerator: req =>
      (req as AuthenticatedRequest).user?.userId || 'unauthenticated',
    standardHeaders: true,
    legacyHeaders: false,
  })
);

const identity = (
  req: AuthenticatedRequest
): { userId: string; admin: boolean } => {
  if (!req.user) throw new Error('Authenticated user context is required');
  return { userId: req.user.userId, admin: req.user.role === 'admin' };
};

const findVisibleJob = async (req: AuthenticatedRequest, id: string) => {
  const actor = identity(req);
  const job = await getDurableJobRuntime().service.getMetadata(id);
  return job && (actor.admin || job.actorUserId === actor.userId) ? job : null;
};

router.get('/', async (req: AuthenticatedRequest, res) => {
  try {
    const actor = identity(req);
    const state =
      typeof req.query.state === 'string' ? req.query.state : undefined;
    const limit = req.query.limit === undefined ? 50 : Number(req.query.limit);
    const beforeCreatedAt =
      req.query.beforeCreatedAt === undefined
        ? undefined
        : Number(req.query.beforeCreatedAt);
    const jobs = await getDurableJobRuntime().service.listJobs({
      ...(!actor.admin || req.query.mine === 'true'
        ? { actorUserId: actor.userId }
        : {}),
      ...(state ? { state: state as DurableJobState } : {}),
      limit,
      ...(beforeCreatedAt !== undefined ? { beforeCreatedAt } : {}),
    });
    res.json({ success: true, data: jobs });
  } catch (error) {
    res.status(error instanceof DurableJobError ? 400 : 500).json({
      success: false,
      message:
        error instanceof DurableJobError
          ? error.message
          : 'Unable to list durable jobs',
    });
  }
});

router.get('/:jobId', async (req: AuthenticatedRequest, res) => {
  const job = await findVisibleJob(req, String(req.params.jobId));
  if (!job) {
    res.status(404).json({ success: false, message: 'Durable job not found' });
    return;
  }
  res.json({
    success: true,
    data: {
      job,
      attempts: await getDurableJobRuntime().service.listAttempts(job.id),
    },
  });
});

router.get('/:jobId/events', async (req: AuthenticatedRequest, res) => {
  const job = await findVisibleJob(req, String(req.params.jobId));
  if (!job) {
    res.status(404).json({ success: false, message: 'Durable job not found' });
    return;
  }
  try {
    const after = req.query.after === undefined ? 0 : Number(req.query.after);
    const limit = req.query.limit === undefined ? 100 : Number(req.query.limit);
    const events = await getDurableJobRuntime().service.replayEvents(after, {
      streamId: `job:${job.id}`,
      limit,
    });
    res.json({
      success: true,
      data: {
        events,
        cursor: events.length > 0 ? events[events.length - 1].cursor : after,
      },
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      message:
        error instanceof DurableJobError
          ? error.message
          : 'Invalid event replay request',
    });
  }
});

router.post('/:jobId/cancel', async (req: AuthenticatedRequest, res) => {
  const actor = identity(req);
  const job = await findVisibleJob(req, String(req.params.jobId));
  if (!job) {
    res.status(404).json({ success: false, message: 'Durable job not found' });
    return;
  }
  try {
    const cancelled = await getDurableJobRuntime().service.cancel(
      job.id,
      actor.admin ? job.actorUserId : actor.userId,
      'user-requested'
    );
    res.json({ success: true, data: cancelled });
  } catch (error) {
    res
      .status(
        error instanceof DurableJobError && error.code === 'not-found'
          ? 404
          : 400
      )
      .json({
        success: false,
        message:
          error instanceof DurableJobError
            ? error.message
            : 'Unable to cancel durable job',
      });
  }
});

export default router;
