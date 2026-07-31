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

import express, { NextFunction, Response } from 'express';
import {
  authenticate,
  requireAdmin,
  AuthenticatedRequest,
} from '../middleware/auth.js';
import workAgentService from '../services/workAgentService.js';
import workEventService, {
  WORK_EVENT_MAX_RESUME_CURSOR,
} from '../services/workEventService.js';
import workModelProviderService from '../services/workModelProviderService.js';
import workRuntimeService from '../services/workRuntimeService.js';
import workTaskService, {
  WorkNotFoundError,
} from '../services/workTaskService.js';
import {
  WorkCapabilities,
  WorkLiveEvent,
  WorkMessagePage,
  WorkProviderSelection,
  WorkRunStatus,
  WorkTaskDetail,
  WorkTaskRecord,
  WorkTaskSummary,
} from '../types/work.js';
import { ApiResponse } from '../types/index.js';

const router = express.Router();
const WORK_SSE_MAX_PENDING_BYTES = 1_000_000;
const WORK_SSE_BACKPRESSURE_TIMEOUT_MS = 15_000;
router.use(authenticate);
router.use(requireAdmin);

router.get(
  '/capabilities',
  async (
    req: AuthenticatedRequest,
    res: Response<ApiResponse<WorkCapabilities>>
  ): Promise<void> => {
    const userId = requireUserId(req);
    const [dockerAvailable, providers] = await Promise.all([
      workRuntimeService.isDockerAvailable(),
      workModelProviderService.availability(userId),
    ]);
    const providerAvailable =
      providers.ollamaAvailable || providers.pluginAvailable;
    const recoveryPending = workRuntimeService.recoveryPending;
    const available = dockerAvailable && !recoveryPending && providerAvailable;
    const reason = recoveryPending
      ? `Work is safely retrying ${workRuntimeService.recoveryPendingCount} container cleanup(s). New operations remain blocked until Docker proves they are stopped.`
      : !dockerAvailable
        ? workRuntimeService.dockerUnavailableReason ||
          'Docker is not available to the Libre WebUI backend.'
        : !providerAvailable
          ? 'No Ollama or configured plugin model provider is available.'
          : undefined;
    sendSuccess(res, {
      available,
      runtime: 'docker',
      image: workRuntimeService.image,
      dockerAvailable,
      ollamaAvailable: providers.ollamaAvailable,
      pluginAvailable: providers.pluginAvailable,
      runtimeImage: workRuntimeService.image,
      reason,
      limits: workRuntimeService.limits,
    });
  }
);

router.use(
  (
    req: AuthenticatedRequest,
    res: Response<ApiResponse>,
    next: NextFunction
  ): void => {
    const readOnlyTaskRoute =
      req.method === 'GET' &&
      (/^\/tasks(?:\/[^/]+)?$/.test(req.path) ||
        /^\/tasks\/[^/]+\/messages$/.test(req.path) ||
        /^\/tasks\/[^/]+\/runs\/[^/]+\/events$/.test(req.path));
    const teardownRoute =
      (req.method === 'POST' &&
        (/^\/tasks\/[^/]+\/cancel$/.test(req.path) ||
          /^\/tasks\/[^/]+\/preview\/stop$/.test(req.path))) ||
      (req.method === 'DELETE' && /^\/tasks\/[^/]+$/.test(req.path));
    if (readOnlyTaskRoute || teardownRoute) {
      next();
      return;
    }
    try {
      workRuntimeService.assertAcceptingWork();
      next();
    } catch (error) {
      sendError(res, error);
    }
  }
);

router.get(
  '/tasks',
  async (
    req: AuthenticatedRequest,
    res: Response<ApiResponse<WorkTaskSummary[]>>
  ): Promise<void> => {
    try {
      const userId = requireUserId(req);
      const previews = workTaskService
        .listTaskRecords(userId)
        .filter(
          task =>
            task.previewStatus === 'starting' ||
            task.previewStatus === 'running'
        );
      await Promise.allSettled(
        previews.map(async task => {
          if (!(await workRuntimeService.isPreviewRunning(task))) {
            workTaskService.updatePreview(task.id, 'stopped');
          }
        })
      );
      sendSuccess(res, workTaskService.listTasks(userId));
    } catch (error) {
      sendError(res, error);
    }
  }
);

router.post(
  '/tasks',
  async (
    req: AuthenticatedRequest,
    res: Response<ApiResponse<WorkTaskDetail>>
  ): Promise<void> => {
    try {
      const message = requireBodyString(req.body?.message, 'message', 65_536);
      const model = requireBodyString(req.body?.model, 'model', 500);
      const userId = requireUserId(req);
      const provider = readProviderSelection(req.body);
      await workModelProviderService.assertModelSupportsTools(
        model,
        provider,
        userId
      );
      const detail = workTaskService.createTaskWithRun(
        userId,
        message,
        model,
        true,
        provider
      );
      const runId = detail.activeRun?.id;
      if (!runId) {
        throw new Error('Work run was not created.');
      }
      workAgentService.start(detail.id, runId, userId);
      res.status(201).json({ success: true, data: detail });
    } catch (error) {
      sendError(res, error);
    }
  }
);

router.get(
  '/tasks/:id',
  async (
    req: AuthenticatedRequest,
    res: Response<ApiResponse<WorkTaskDetail>>
  ): Promise<void> => {
    try {
      const taskId = readTaskId(req);
      const userId = requireUserId(req);
      const task = workTaskService.requireTaskRecord(taskId, userId);
      if (
        task.previewStatus === 'running' ||
        task.previewStatus === 'starting'
      ) {
        const running = await workRuntimeService.isPreviewRunning(task);
        if (!running) workTaskService.updatePreview(taskId, 'stopped');
      }
      sendSuccess(res, workTaskService.requireTaskDetail(taskId, userId));
    } catch (error) {
      sendError(res, error);
    }
  }
);

router.get(
  '/tasks/:id/messages',
  (
    req: AuthenticatedRequest,
    res: Response<ApiResponse<WorkMessagePage>>
  ): void => {
    try {
      const taskId = readTaskId(req);
      const userId = requireUserId(req);
      workTaskService.requireTaskRecord(taskId, userId);
      const before = optionalNonNegativeInteger(req.query.before, 'before');
      const limit = optionalPositiveInteger(req.query.limit, 'limit') ?? 200;
      sendSuccess(
        res,
        workTaskService.getMessagePage(taskId, before, Math.min(limit, 200))
      );
    } catch (error) {
      sendError(res, error);
    }
  }
);

router.get(
  '/tasks/:taskId/runs/:runId/events',
  (req: AuthenticatedRequest, res: Response): void => {
    let unsubscribe = (): void => undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let backpressureTimer: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    let writeBlocked = false;
    let queuedBytes = 0;
    let latestEventId = 0;
    let doneQueued = false;
    const queuedFrames: Array<{
      value: string;
      bytes: number;
      terminal: boolean;
    }> = [];

    const cleanup = (): boolean => {
      if (closed) return false;
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      if (backpressureTimer) clearTimeout(backpressureTimer);
      res.off('drain', flushQueuedFrames);
      unsubscribe();
      queuedFrames.length = 0;
      queuedBytes = 0;
      return true;
    };

    const close = (): void => {
      if (!cleanup()) return;
      if (!res.writableEnded && !res.destroyed) res.end();
    };

    const forceDisconnect = (): void => {
      if (!cleanup()) return;
      if (!res.destroyed) res.destroy();
    };

    const waitForDrain = (): void => {
      writeBlocked = true;
      if (backpressureTimer) clearTimeout(backpressureTimer);
      backpressureTimer = setTimeout(
        forceDisconnect,
        WORK_SSE_BACKPRESSURE_TIMEOUT_MS
      );
      backpressureTimer.unref?.();
      res.once('drain', flushQueuedFrames);
    };

    const writeFrame = (value: string, terminal = false): void => {
      if (closed || res.writableEnded || res.destroyed) {
        close();
        return;
      }
      const bytes = Buffer.byteLength(value, 'utf8');
      if (writeBlocked || queuedFrames.length > 0) {
        if (queuedBytes + bytes > WORK_SSE_MAX_PENDING_BYTES) {
          forceDisconnect();
          return;
        }
        queuedFrames.push({ value, bytes, terminal });
        queuedBytes += bytes;
        return;
      }
      try {
        const accepted = res.write(value);
        if (terminal) {
          close();
          return;
        }
        if (!accepted) {
          waitForDrain();
        }
      } catch {
        close();
      }
    };

    function flushQueuedFrames(): void {
      if (closed || res.writableEnded || res.destroyed) {
        close();
        return;
      }
      writeBlocked = false;
      if (backpressureTimer) {
        clearTimeout(backpressureTimer);
        backpressureTimer = undefined;
      }
      while (queuedFrames.length > 0) {
        const frame = queuedFrames.shift();
        if (!frame) break;
        queuedBytes -= frame.bytes;
        try {
          const accepted = res.write(frame.value);
          if (frame.terminal) {
            close();
            return;
          }
          if (!accepted) {
            waitForDrain();
            return;
          }
        } catch {
          close();
          return;
        }
      }
    }

    try {
      const taskId = String(req.params.taskId || '').trim();
      const runId = String(req.params.runId || '').trim();
      const userId = requireUserId(req);
      workTaskService.requireTaskRecord(taskId, userId);
      const run = workTaskService.getRun(runId);
      if (!run || run.taskId !== taskId) {
        throw new WorkNotFoundError('Work run not found.');
      }
      const after = optionalNonNegativeInteger(req.query.after, 'after') ?? 0;
      if (after > WORK_EVENT_MAX_RESUME_CURSOR) {
        throw new WorkRouteError(
          'Query parameter "after" is outside the resumable cursor range.',
          400
        );
      }

      res.status(200);
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();

      const writeEvent = (event: WorkLiveEvent): void => {
        if (closed || res.writableEnded) return;
        latestEventId = Math.max(latestEventId, event.id);
        const terminal = event.type === 'done';
        if (terminal) doneQueued = true;
        writeFrame(
          `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
          terminal
        );
      };

      res.once('close', close);
      let replaying = true;
      const bufferedLiveEvents: WorkLiveEvent[] = [];
      workEventService.advanceCursor(taskId, runId, after);
      unsubscribe = workEventService.subscribe(taskId, runId, event => {
        if (replaying) {
          bufferedLiveEvents.push(event);
          return;
        }
        writeEvent(event);
      });
      const task = workTaskService.requireTaskDetail(taskId, userId);
      const replay = workEventService.replay(taskId, runId, after);
      const snapshotRun = workTaskService.getRun(runId) ?? run;
      const snapshotStatus = replay.snapshot.status ?? snapshotRun.status;
      const snapshotTerminal =
        replay.snapshot.terminal || isTerminalWorkRunStatus(snapshotStatus);
      workEventService.emitSnapshot(
        taskId,
        runId,
        replay.latestEventId,
        {
          task,
          liveRun: {
            ...replay.snapshot,
            status: snapshotStatus,
            phase: replay.snapshot.phase ?? snapshotStatus,
            error: replay.snapshot.error ?? snapshotRun.error,
            terminal: snapshotTerminal,
          },
          replayTruncated: replay.truncated,
        },
        writeEvent
      );
      replaying = false;
      for (const event of bufferedLiveEvents
        .filter(event => event.id > replay.latestEventId)
        .sort((left, right) => left.id - right.id)) {
        writeEvent(event);
        if (closed) return;
      }

      const currentRun = workTaskService.getRun(runId) ?? snapshotRun;
      const terminalStatus = isTerminalWorkRunStatus(replay.snapshot.status)
        ? replay.snapshot.status
        : isTerminalWorkRunStatus(currentRun.status)
          ? currentRun.status
          : undefined;
      if (terminalStatus && !doneQueued) {
        writeEvent({
          id: latestEventId + 1,
          type: 'done',
          taskId,
          runId,
          timestamp: Date.now(),
          data: {
            status: terminalStatus,
            error: replay.snapshot.error ?? currentRun.error,
            budgetReason: replay.snapshot.budgetReason,
          },
        });
      }
      if (doneQueued || closed) return;

      heartbeat = setInterval(() => {
        if (closed || res.writableEnded) {
          close();
          return;
        }
        writeFrame(`: heartbeat ${Date.now()}\n\n`);
      }, 15_000);
      heartbeat.unref?.();
    } catch (error) {
      if (res.headersSent) {
        close();
        return;
      }
      sendError(res, error);
    }
  }
);

router.patch(
  '/tasks/:id',
  async (
    req: AuthenticatedRequest,
    res: Response<ApiResponse<WorkTaskDetail>>
  ): Promise<void> => {
    try {
      const taskId = readTaskId(req);
      const userId = requireUserId(req);
      const before = workTaskService.requireMutableTaskRecord(taskId, userId);
      const networkEnabled =
        typeof req.body?.networkEnabled === 'boolean'
          ? req.body.networkEnabled
          : undefined;
      const model =
        typeof req.body?.model === 'string'
          ? requireBodyString(req.body.model, 'model', 500)
          : undefined;
      const providerChanged =
        req.body?.providerType !== undefined ||
        req.body?.providerId !== undefined;
      const provider =
        model !== undefined || providerChanged
          ? readProviderSelection(req.body, before)
          : undefined;
      if (provider) {
        await workModelProviderService.assertModelSupportsTools(
          model ?? before.model,
          provider,
          userId
        );
      }
      workTaskService.assertTaskMutationAllowed(taskId, userId);
      if (networkEnabled !== undefined) {
        const current = workTaskService.beginNetworkPolicyChange(
          taskId,
          userId
        );
        try {
          const desired = { ...current, networkEnabled };
          await workRuntimeService.changeNetworkPolicy(current, desired, () => {
            workTaskService.commitNetworkChange(taskId, userId, {
              title:
                typeof req.body?.title === 'string'
                  ? req.body.title
                  : undefined,
              model,
              providerType: provider?.providerType,
              providerId: provider?.providerId,
              networkEnabled: desired.networkEnabled,
            });
          });
        } finally {
          workTaskService.releaseNetworkPolicyChange(taskId);
        }
        sendSuccess(res, workTaskService.requireTaskDetail(taskId, userId));
        return;
      }
      const detail = workTaskService.updateTask(taskId, userId, {
        title: typeof req.body?.title === 'string' ? req.body.title : undefined,
        model,
        providerType: provider?.providerType,
        providerId: provider?.providerId,
        networkEnabled,
      });
      sendSuccess(res, detail);
    } catch (error) {
      sendError(res, error);
    }
  }
);

router.delete(
  '/tasks/:id',
  async (
    req: AuthenticatedRequest,
    res: Response<ApiResponse<{ id: string; deleted: true }>>
  ): Promise<void> => {
    try {
      const taskId = readTaskId(req);
      const userId = requireUserId(req);
      await workAgentService.removeTask(taskId, userId);
      sendSuccess(res, { id: taskId, deleted: true });
    } catch (error) {
      sendError(res, error);
    }
  }
);

router.post(
  '/tasks/:id/runs',
  async (
    req: AuthenticatedRequest,
    res: Response<ApiResponse<WorkTaskDetail>>
  ): Promise<void> => {
    try {
      const taskId = readTaskId(req);
      const userId = requireUserId(req);
      const message = requireBodyString(req.body?.message, 'message', 65_536);
      const current = workTaskService.requireMutableTaskRecord(taskId, userId);
      const model =
        typeof req.body?.model === 'string' && req.body.model.trim()
          ? req.body.model.trim()
          : current.model;
      const provider = readProviderSelection(req.body, current);
      await workModelProviderService.assertModelSupportsTools(
        model,
        provider,
        userId
      );
      const detail = workTaskService.createRun(
        taskId,
        userId,
        message,
        model,
        provider
      );
      const runId = detail.activeRun?.id;
      if (!runId) throw new Error('Work run was not created.');
      workAgentService.start(taskId, runId, userId);
      res.status(202).json({ success: true, data: detail });
    } catch (error) {
      sendError(res, error);
    }
  }
);

router.post(
  '/tasks/:id/cancel',
  async (
    req: AuthenticatedRequest,
    res: Response<ApiResponse<WorkTaskDetail>>
  ): Promise<void> => {
    try {
      sendSuccess(
        res,
        await workAgentService.cancel(readTaskId(req), requireUserId(req))
      );
    } catch (error) {
      sendError(res, error);
    }
  }
);

router.get(
  '/tasks/:id/files',
  async (
    req: AuthenticatedRequest,
    res: Response<ApiResponse>
  ): Promise<void> => {
    try {
      const task = workTaskService.requireMutableTaskRecord(
        readTaskId(req),
        requireUserId(req)
      );
      sendSuccess(
        res,
        await workRuntimeService.listFiles(task, String(req.query.path || '.'))
      );
    } catch (error) {
      sendError(res, error);
    }
  }
);

router.get(
  '/tasks/:id/file',
  async (
    req: AuthenticatedRequest,
    res: Response<ApiResponse>
  ): Promise<void> => {
    try {
      const task = workTaskService.requireMutableTaskRecord(
        readTaskId(req),
        requireUserId(req)
      );
      sendSuccess(
        res,
        await workRuntimeService.readFile(task, String(req.query.path || ''))
      );
    } catch (error) {
      sendError(res, error);
    }
  }
);

router.put(
  '/tasks/:id/file',
  async (
    req: AuthenticatedRequest,
    res: Response<ApiResponse>
  ): Promise<void> => {
    try {
      const task = workTaskService.requireMutableTaskRecord(
        readTaskId(req),
        requireUserId(req)
      );
      const content =
        typeof req.body?.content === 'string' ? req.body.content : undefined;
      if (content === undefined) {
        throw new WorkRouteError('Field "content" must be a string.', 400);
      }
      const expectedUpdatedAt =
        typeof req.body?.expectedUpdatedAt === 'number'
          ? req.body.expectedUpdatedAt
          : typeof req.body?.expectedModifiedAt === 'number'
            ? req.body.expectedModifiedAt
            : undefined;
      sendSuccess(
        res,
        await workRuntimeService.writeFile(
          task,
          String(req.query.path || ''),
          content,
          expectedUpdatedAt
        )
      );
    } catch (error) {
      sendError(res, error);
    }
  }
);

router.post(
  '/tasks/:id/preview/start',
  async (
    req: AuthenticatedRequest,
    res: Response<ApiResponse<WorkTaskDetail>>
  ): Promise<void> => {
    const taskId = readTaskId(req);
    const userId = requireUserId(req);
    try {
      const task = workTaskService.requireMutableTaskRecord(taskId, userId);
      await workRuntimeService.startPreview(
        task,
        typeof req.body?.command === 'string' ? req.body.command : undefined,
        {
          onStarting: () => workTaskService.beginPreview(taskId, userId),
          onRunning: url =>
            workTaskService.updatePreview(taskId, 'running', url),
          onFailed: () => workTaskService.updatePreview(taskId, 'failed'),
        }
      );
      sendSuccess(res, workTaskService.requireTaskDetail(taskId, userId));
    } catch (error) {
      sendError(res, error);
    }
  }
);

router.post(
  '/tasks/:id/preview/stop',
  async (
    req: AuthenticatedRequest,
    res: Response<ApiResponse<WorkTaskDetail>>
  ): Promise<void> => {
    try {
      const taskId = readTaskId(req);
      const userId = requireUserId(req);
      const task = workTaskService.requireMutableTaskRecord(taskId, userId);
      await workRuntimeService.stopPreview(task, {
        onStopped: () => workTaskService.updatePreview(taskId, 'stopped'),
      });
      sendSuccess(res, workTaskService.requireTaskDetail(taskId, userId));
    } catch (error) {
      sendError(res, error);
    }
  }
);

class WorkRouteError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

function requireUserId(req: AuthenticatedRequest): string {
  if (!req.user?.userId) {
    throw new WorkRouteError('Authentication required.', 401);
  }
  return req.user.userId;
}

function readTaskId(req: AuthenticatedRequest): string {
  return String(req.params.id || '').trim();
}

function readProviderSelection(
  body: unknown,
  fallback?: Pick<WorkTaskRecord, 'providerType' | 'providerId'>
): WorkProviderSelection {
  const record =
    body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const rawType = record.providerType ?? fallback?.providerType ?? 'ollama';
  if (rawType !== 'ollama' && rawType !== 'plugin') {
    throw new WorkRouteError(
      'Field "providerType" must be "ollama" or "plugin".',
      400
    );
  }
  if (rawType === 'ollama') {
    if (
      record.providerId !== undefined &&
      record.providerId !== null &&
      String(record.providerId).trim()
    ) {
      throw new WorkRouteError(
        'Field "providerId" is only valid for plugin providers.',
        400
      );
    }
    return { providerType: 'ollama' };
  }

  const rawProviderId = record.providerId ?? fallback?.providerId;
  if (typeof rawProviderId !== 'string' || !rawProviderId.trim()) {
    throw new WorkRouteError(
      'Field "providerId" is required for plugin providers.',
      400
    );
  }
  if (rawProviderId.length > 200) {
    throw new WorkRouteError(
      'Field "providerId" exceeds the 200 character limit.',
      413
    );
  }
  return { providerType: 'plugin', providerId: rawProviderId.trim() };
}

function requireBodyString(
  value: unknown,
  name: string,
  maxLength: number
): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new WorkRouteError(`Field "${name}" is required.`, 400);
  }
  if (
    value.length > maxLength ||
    Buffer.byteLength(value, 'utf8') > maxLength
  ) {
    throw new WorkRouteError(
      `Field "${name}" exceeds the ${maxLength} character limit.`,
      413
    );
  }
  return value.trim();
}

function optionalNonNegativeInteger(
  value: unknown,
  name: string
): number | undefined {
  if (value === undefined) return undefined;
  const parsed =
    typeof value === 'string' && /^\d+$/.test(value)
      ? Number(value)
      : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new WorkRouteError(
      `Query parameter "${name}" must be a non-negative integer.`,
      400
    );
  }
  return parsed;
}

function optionalPositiveInteger(
  value: unknown,
  name: string
): number | undefined {
  const parsed = optionalNonNegativeInteger(value, name);
  if (parsed === undefined) return undefined;
  if (parsed < 1) {
    throw new WorkRouteError(
      `Query parameter "${name}" must be a positive integer.`,
      400
    );
  }
  return parsed;
}

function isTerminalWorkRunStatus(
  status: WorkRunStatus | undefined
): status is Extract<
  WorkRunStatus,
  'completed' | 'needs_input' | 'failed' | 'cancelled'
> {
  return (
    status === 'completed' ||
    status === 'needs_input' ||
    status === 'failed' ||
    status === 'cancelled'
  );
}

function sendSuccess<T>(res: Response<ApiResponse<T>>, data: T): void {
  res.json({ success: true, data });
}

function sendError<T>(res: Response<ApiResponse<T>>, error: unknown): void {
  const candidate = error as {
    status?: unknown;
    code?: unknown;
    message?: unknown;
  };
  const status = typeof candidate?.status === 'number' ? candidate.status : 500;
  const message =
    typeof candidate?.message === 'string'
      ? candidate.message
      : 'Work request failed.';
  res.status(status).json({
    success: false,
    error: message,
    ...(typeof candidate?.code === 'string' ? { message: candidate.code } : {}),
  });
}

export default router;
