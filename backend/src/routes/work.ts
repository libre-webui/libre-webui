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
import { userModel } from '../models/userModel.js';
import {
  getWorkAccessMode,
  isWorkAccessMode,
  setWorkAccessMode,
  userHasWorkAccess,
  type WorkAccessMode,
} from '../services/workAccessService.js';
import {
  buildWorkAdminOverview,
  type WorkAdminOverview,
} from '../services/workAdminService.js';
import workAgentService from '../services/workAgentService.js';
import workEventService, {
  WORK_EVENT_MAX_RESUME_CURSOR,
} from '../services/workEventService.js';
import workModelProviderService from '../services/workModelProviderService.js';
import workPolicyService, {
  type WorkPolicyRecord,
} from '../services/workPolicyService.js';
import workRuntimeService from '../services/workRuntimeService.js';
import workScreenControlService, {
  WORK_SCREEN_CONTROL_TTL_MS,
} from '../services/workScreenControlService.js';
import workComputerTeachService from '../services/workComputerTeachService.js';
import workTerminalService from '../services/workTerminalService.js';
import workHostWorkspaceService, {
  WorkHostWorkspaceError,
} from '../services/workHostWorkspaceService.js';
import workTaskService, {
  WorkConflictError,
  WorkNotFoundError,
} from '../services/workTaskService.js';
import {
  WorkCapabilities,
  WorkGitDiff,
  WorkGitStatus,
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

/**
 * Work access follows the persisted access mode: administrators always
 * pass, other active accounts pass when an administrator has opened Work
 * to all users. Like requireAdmin, authorization follows current database
 * state rather than the role cached in a still-valid JWT, so a demotion or
 * a mode change takes effect immediately.
 */
const requireWorkAccess = async (
  req: AuthenticatedRequest,
  res: Response<ApiResponse>,
  next: NextFunction
): Promise<void> => {
  if (!req.user) {
    res.status(403).json({ success: false, message: 'Work access required' });
    return;
  }
  try {
    const currentUser = await userModel.getUserById(req.user.userId);
    if (
      !currentUser ||
      currentUser.status !== 'active' ||
      !(await userHasWorkAccess(currentUser))
    ) {
      res.status(403).json({ success: false, message: 'Work access required' });
      return;
    }
    req.user = {
      ...req.user,
      username: currentUser.username,
      role: currentUser.role,
    };
    next();
  } catch (_error) {
    res.status(500).json({
      success: false,
      message: 'Authorization check failed',
    });
  }
};

// Readable by every authenticated user: the interface needs to know whether
// to offer Work before it may call anything behind requireWorkAccess.
router.get(
  '/access',
  async (
    req: AuthenticatedRequest,
    res: Response<ApiResponse<{ mode: WorkAccessMode; allowed: boolean }>>
  ): Promise<void> => {
    try {
      const currentUser = req.user
        ? await userModel.getUserById(req.user.userId)
        : undefined;
      sendSuccess(res, {
        mode: await getWorkAccessMode(),
        allowed: Boolean(
          currentUser &&
          currentUser.status === 'active' &&
          (await userHasWorkAccess(currentUser))
        ),
      });
    } catch (error) {
      sendError(res, error);
    }
  }
);

router.put(
  '/access',
  requireAdmin,
  async (
    req: AuthenticatedRequest,
    res: Response<ApiResponse<{ mode: WorkAccessMode }>>
  ): Promise<void> => {
    try {
      const mode: unknown = req.body?.mode;
      if (!isWorkAccessMode(mode)) {
        throw new WorkRouteError(
          'Field "mode" must be "admins" or "all-users".',
          400
        );
      }
      await setWorkAccessMode(mode);
      sendSuccess(res, { mode });
    } catch (error) {
      sendError(res, error);
    }
  }
);

router.use(requireWorkAccess);

router.get(
  '/capabilities',
  async (
    req: AuthenticatedRequest,
    res: Response<ApiResponse<WorkCapabilities>>
  ): Promise<void> => {
    const userId = requireUserId(req);
    const [runtimeAvailable, providers] = await Promise.all([
      workRuntimeService.isRuntimeAvailable(),
      workModelProviderService.availability(userId),
    ]);
    const providerAvailable =
      providers.ollamaAvailable || providers.pluginAvailable;
    const recoveryPending = workRuntimeService.recoveryPending;
    const available = runtimeAvailable && !recoveryPending && providerAvailable;
    const reason = recoveryPending
      ? `Work is safely retrying ${workRuntimeService.recoveryPendingCount} sandbox cleanup(s). New operations remain blocked until the configured runtime proves they are stopped.`
      : !runtimeAvailable
        ? workRuntimeService.runtimeUnavailableReason ||
          `The ${workRuntimeService.runtimeKind} runtime is not available to the Libre WebUI backend.`
        : !providerAvailable
          ? 'No Ollama or configured plugin model provider is available.'
          : undefined;
    sendSuccess(res, {
      available,
      runtime: workRuntimeService.runtimeKind,
      image: workRuntimeService.image,
      runtimeAvailable,
      ollamaAvailable: providers.ollamaAvailable,
      pluginAvailable: providers.pluginAvailable,
      runtimeImage: workRuntimeService.image,
      reason,
      limits: workRuntimeService.limits,
      activeRuntimes: workRuntimeService.activeRuntimeCounts(userId),
      terminal: {
        available: runtimeAvailable && !workTerminalService.unavailableReason(),
        reason: workTerminalService.unavailableReason() ?? undefined,
        maxSessionsPerTask: workTerminalService.maxSessionsPerTask,
        idleTimeoutMs: workTerminalService.idleTimeoutMs,
      },
      hostWorkspaces: {
        // Admin-only regardless of the access mode: host folders bind-mount
        // server paths.
        enabled:
          workHostWorkspaceService.isEnabled() && req.user?.role === 'admin',
        roots:
          req.user?.role === 'admin'
            ? workHostWorkspaceService.listRoots()
            : [],
      },
    });
  }
);

// Named runtime policies. Reading is open to every Work user (the picker at
// task creation needs the list); mutations are admin-only. Registered before
// the fail-closed gate: policies are configuration, not runtime mutations.
router.get(
  '/policies',
  async (
    _req: AuthenticatedRequest,
    res: Response<ApiResponse<WorkPolicyRecord[]>>
  ): Promise<void> => {
    try {
      sendSuccess(res, await workPolicyService.list());
    } catch (error) {
      sendError(res, error);
    }
  }
);

router.post(
  '/policies',
  requireAdmin,
  async (
    req: AuthenticatedRequest,
    res: Response<ApiResponse<WorkPolicyRecord>>
  ): Promise<void> => {
    try {
      res.status(201).json({
        success: true,
        data: await workPolicyService.create(req.body),
      });
    } catch (error) {
      sendError(res, error);
    }
  }
);

router.put(
  '/policies/:id',
  requireAdmin,
  async (
    req: AuthenticatedRequest,
    res: Response<ApiResponse<WorkPolicyRecord>>
  ): Promise<void> => {
    try {
      sendSuccess(
        res,
        await workPolicyService.update(String(req.params.id || ''), req.body)
      );
    } catch (error) {
      sendError(res, error);
    }
  }
);

router.delete(
  '/policies/:id',
  requireAdmin,
  async (
    req: AuthenticatedRequest,
    res: Response<ApiResponse<{ id: string; deleted: true }>>
  ): Promise<void> => {
    try {
      const id = String(req.params.id || '');
      await workPolicyService.remove(id);
      sendSuccess(res, { id, deleted: true });
    } catch (error) {
      sendError(res, error);
    }
  }
);

// Registered before the fail-closed gate below: the overview is exactly
// what an administrator needs while Work is blocked on recovery.
router.get(
  '/admin/overview',
  requireAdmin,
  async (
    req: AuthenticatedRequest,
    res: Response<ApiResponse<WorkAdminOverview>>
  ): Promise<void> => {
    try {
      sendSuccess(res, await buildWorkAdminOverview());
    } catch (error) {
      sendError(res, error);
    }
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
      const previews = (await workTaskService.listTaskRecords(userId)).filter(
        task =>
          task.previewStatus === 'starting' || task.previewStatus === 'running'
      );
      await Promise.allSettled(
        previews.map(async task => {
          if (!(await workRuntimeService.isPreviewRunning(task))) {
            await workTaskService.updatePreview(task.id, 'stopped');
          }
        })
      );
      sendSuccess(res, await workTaskService.listTasks(userId));
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
      const model = requirePostgresBodyString(req.body?.model, 'model', 500);
      const userId = requireUserId(req);
      const provider = readProviderSelection(req.body);
      const requestedHostPath =
        typeof req.body?.hostPath === 'string' ? req.body.hostPath.trim() : '';
      // Host folders bind-mount server paths, so they stay admin-only even
      // when Work itself is open to all users.
      if (requestedHostPath && req.user?.role !== 'admin') {
        throw new WorkRouteError(
          'Host-folder workspaces require administrator access.',
          403
        );
      }
      const hostPath = requestedHostPath
        ? workHostWorkspaceService.resolveWorkspacePath(requestedHostPath)
        : undefined;
      const requestedPolicyId =
        typeof req.body?.policyId === 'string' ? req.body.policyId.trim() : '';
      let policy: WorkPolicyRecord | undefined;
      if (requestedPolicyId) {
        policy = await workPolicyService.get(requestedPolicyId);
        if (!policy) {
          throw new WorkRouteError(
            'The selected Work policy no longer exists.',
            400
          );
        }
      }
      await workModelProviderService.assertModelSupportsTools(
        model,
        provider,
        userId
      );
      const detail = await workTaskService.createTaskWithRun(
        userId,
        message,
        model,
        policy?.networkDefault ?? true,
        provider,
        hostPath,
        policy?.id
      );
      const runId = detail.activeRun?.id;
      if (!runId) {
        throw new Error('Work run was not created.');
      }
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
      const task = await workTaskService.requireTaskRecord(taskId, userId);
      if (
        task.previewStatus === 'running' ||
        task.previewStatus === 'starting'
      ) {
        const running = await workRuntimeService.isPreviewRunning(task);
        if (!running) await workTaskService.updatePreview(taskId, 'stopped');
      }
      sendSuccess(res, await workTaskService.requireTaskDetail(taskId, userId));
    } catch (error) {
      sendError(res, error);
    }
  }
);

router.get(
  '/tasks/:id/messages',
  async (
    req: AuthenticatedRequest,
    res: Response<ApiResponse<WorkMessagePage>>
  ): Promise<void> => {
    try {
      const taskId = readTaskId(req);
      const userId = requireUserId(req);
      await workTaskService.requireTaskRecord(taskId, userId);
      const before = optionalNonNegativeInteger(req.query.before, 'before');
      const limit = optionalPositiveInteger(req.query.limit, 'limit') ?? 200;
      sendSuccess(
        res,
        await workTaskService.getMessagePage(
          taskId,
          before,
          Math.min(limit, 200)
        )
      );
    } catch (error) {
      sendError(res, error);
    }
  }
);

router.get(
  '/tasks/:taskId/runs/:runId/events',
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    let unsubscribe = async (): Promise<void> => undefined;
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
      void unsubscribe();
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
      await workTaskService.requireTaskRecord(taskId, userId);
      const run = await workTaskService.getRun(runId);
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
      const checkpoint = await workEventService.checkpoint(taskId, runId);
      const authorize = async (): Promise<boolean> => {
        try {
          const current = await workTaskService.requireTaskRecord(
            taskId,
            userId
          );
          const currentRun = await workTaskService.getRun(runId);
          return current.id === taskId && currentRun?.taskId === taskId;
        } catch {
          return false;
        }
      };
      let replayingLocal = !checkpoint.durable;
      const bufferedLocalEvents: WorkLiveEvent[] = [];
      if (!checkpoint.durable) {
        // A process-local stream has no SQL catch-up query. Subscribe before
        // taking its compact snapshot and buffer the live edge so the snapshot
        // boundary cannot lose an event.
        const localUnsubscribe = await workEventService.subscribeDurable(
          taskId,
          runId,
          after,
          authorize,
          event => {
            if (replayingLocal) bufferedLocalEvents.push(event);
            else if (event.id > latestEventId) writeEvent(event);
          },
          () => close()
        );
        unsubscribe = localUnsubscribe;
        if (closed) {
          await localUnsubscribe();
          return;
        }
      }

      // In durable mode, compact every committed event through this exact SQL
      // checkpoint into one authoritative persistence snapshot. The gateway
      // subscribes from that cursor after the snapshot is written; SQL replay
      // covers every commit in the intervening gap without replaying history.
      const task = await workTaskService.requireTaskDetail(taskId, userId);
      const snapshotRun = (await workTaskService.getRun(runId)) ?? run;
      const localReplay = checkpoint.durable
        ? undefined
        : workEventService.replay(taskId, runId, after);
      const snapshotCursor = checkpoint.durable
        ? Math.max(after, checkpoint.cursor)
        : localReplay!.latestEventId;
      const compactSnapshot = checkpoint.durable
        ? workEventService.snapshotFromPersistence(task, snapshotRun)
        : localReplay!.snapshot;
      const snapshotStatus = compactSnapshot.status ?? snapshotRun.status;
      const snapshotTerminal =
        compactSnapshot.terminal || isTerminalWorkRunStatus(snapshotStatus);
      workEventService.emitSnapshot(
        taskId,
        runId,
        snapshotCursor,
        {
          task,
          liveRun: {
            ...compactSnapshot,
            status: snapshotStatus,
            phase: compactSnapshot.phase ?? snapshotStatus,
            error: compactSnapshot.error ?? snapshotRun.error,
            terminal: snapshotTerminal,
          },
          replayTruncated: checkpoint.durable
            ? checkpoint.cursor > after
            : localReplay!.truncated,
        },
        writeEvent
      );
      if (closed) return;

      if (checkpoint.durable) {
        const connectedUnsubscribe = await workEventService.subscribeDurable(
          taskId,
          runId,
          snapshotCursor,
          authorize,
          event => {
            if (event.id > latestEventId) writeEvent(event);
          },
          () => close()
        );
        unsubscribe = connectedUnsubscribe;
        if (closed) {
          await connectedUnsubscribe();
          return;
        }
      } else {
        replayingLocal = false;
        for (const event of bufferedLocalEvents
          .filter(event => event.id > snapshotCursor)
          .sort((left, right) => left.id - right.id)) {
          writeEvent(event);
          if (closed) return;
        }
      }

      const currentRun = (await workTaskService.getRun(runId)) ?? snapshotRun;
      const terminalStatus = isTerminalWorkRunStatus(compactSnapshot.status)
        ? compactSnapshot.status
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
            error: compactSnapshot.error ?? currentRun.error,
            budgetReason: compactSnapshot.budgetReason,
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
      const title =
        typeof req.body?.title === 'string'
          ? rejectPostgresTextNul(req.body.title, 'title')
          : undefined;
      const before = await workTaskService.requireMutableTaskRecord(
        taskId,
        userId
      );
      const networkEnabled =
        typeof req.body?.networkEnabled === 'boolean'
          ? req.body.networkEnabled
          : undefined;
      const model =
        typeof req.body?.model === 'string'
          ? requirePostgresBodyString(req.body.model, 'model', 500)
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
      await workTaskService.assertTaskMutationAllowed(taskId, userId);
      if (networkEnabled !== undefined) {
        const current = await workTaskService.beginNetworkPolicyChange(
          taskId,
          userId
        );
        try {
          const desired = { ...current, networkEnabled };
          await workRuntimeService.changeNetworkPolicy(current, desired, () => {
            return workTaskService.commitNetworkChange(taskId, userId, {
              title,
              model,
              providerType: provider?.providerType,
              providerId: provider?.providerId,
              networkEnabled: desired.networkEnabled,
            });
          });
        } finally {
          workTaskService.releaseNetworkPolicyChange(taskId);
        }
        sendSuccess(
          res,
          await workTaskService.requireTaskDetail(taskId, userId)
        );
        return;
      }
      const detail = await workTaskService.updateTask(taskId, userId, {
        title,
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
      const current = await workTaskService.requireMutableTaskRecord(
        taskId,
        userId
      );
      const model =
        typeof req.body?.model === 'string' && req.body.model.trim()
          ? requirePostgresBodyString(req.body.model, 'model', 500)
          : current.model;
      const provider = readProviderSelection(req.body, current);
      await workModelProviderService.assertModelSupportsTools(
        model,
        provider,
        userId
      );
      const detail = await workTaskService.createRun(
        taskId,
        userId,
        message,
        model,
        provider
      );
      const runId = detail.activeRun?.id;
      if (!runId) throw new Error('Work run was not created.');
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
      const task = await workTaskService.requireMutableTaskRecord(
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
      const task = await workTaskService.requireMutableTaskRecord(
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
      const task = await workTaskService.requireMutableTaskRecord(
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

router.get(
  '/tasks/:id/git',
  async (
    req: AuthenticatedRequest,
    res: Response<ApiResponse<WorkGitStatus>>
  ): Promise<void> => {
    try {
      const task = await workTaskService.requireMutableTaskRecord(
        readTaskId(req),
        requireUserId(req)
      );
      sendSuccess(res, await workRuntimeService.getGitStatus(task));
    } catch (error) {
      sendError(res, error);
    }
  }
);

router.get(
  '/tasks/:id/git/diff',
  async (
    req: AuthenticatedRequest,
    res: Response<ApiResponse<WorkGitDiff>>
  ): Promise<void> => {
    try {
      const task = await workTaskService.requireMutableTaskRecord(
        readTaskId(req),
        requireUserId(req)
      );
      const requestedPath =
        typeof req.query.path === 'string' ? req.query.path : undefined;
      sendSuccess(
        res,
        await workRuntimeService.getGitDiff(task, requestedPath)
      );
    } catch (error) {
      sendError(res, error);
    }
  }
);

router.post(
  '/tasks/:id/git/init',
  async (
    req: AuthenticatedRequest,
    res: Response<ApiResponse<WorkGitStatus>>
  ): Promise<void> => {
    try {
      const task = await requireIdleGitTask(req);
      sendSuccess(res, await workRuntimeService.initializeGit(task));
    } catch (error) {
      sendError(res, error);
    }
  }
);

router.post(
  '/tasks/:id/git/stage',
  async (
    req: AuthenticatedRequest,
    res: Response<ApiResponse<WorkGitStatus>>
  ): Promise<void> => {
    try {
      if (
        !Array.isArray(req.body?.paths) ||
        req.body.paths.some((value: unknown) => typeof value !== 'string')
      ) {
        throw new WorkRouteError('Field "paths" must be a string array.', 400);
      }
      const task = await requireIdleGitTask(req);
      sendSuccess(
        res,
        await workRuntimeService.stageGitPaths(task, req.body.paths)
      );
    } catch (error) {
      sendError(res, error);
    }
  }
);

router.post(
  '/tasks/:id/git/commit',
  async (
    req: AuthenticatedRequest,
    res: Response<ApiResponse<WorkGitStatus>>
  ): Promise<void> => {
    try {
      const userId = requireUserId(req);
      const task = await requireIdleGitTask(req);
      const user = await userModel.getUserById(userId);
      if (!user) throw new WorkRouteError('User account was not found.', 404);
      sendSuccess(
        res,
        await workRuntimeService.commitGit(
          task,
          requireBodyString(req.body?.message, 'message', 4_000),
          {
            name: user.username,
            email: user.email || `${user.id}@users.noreply.libre-webui.local`,
          }
        )
      );
    } catch (error) {
      sendError(res, error);
    }
  }
);

router.post(
  '/tasks/:id/git/branches',
  async (
    req: AuthenticatedRequest,
    res: Response<ApiResponse<WorkGitStatus>>
  ): Promise<void> => {
    try {
      const task = await requireIdleGitTask(req);
      sendSuccess(
        res,
        await workRuntimeService.createGitBranch(
          task,
          requireBodyString(req.body?.name, 'name', 200)
        )
      );
    } catch (error) {
      sendError(res, error);
    }
  }
);

router.post(
  '/tasks/:id/git/switch',
  async (
    req: AuthenticatedRequest,
    res: Response<ApiResponse<WorkGitStatus>>
  ): Promise<void> => {
    try {
      const task = await requireIdleGitTask(req);
      sendSuccess(
        res,
        await workRuntimeService.switchGitBranch(
          task,
          requireBodyString(req.body?.name, 'name', 200)
        )
      );
    } catch (error) {
      sendError(res, error);
    }
  }
);

router.post(
  '/tasks/:id/computer/start',
  async (
    req: AuthenticatedRequest,
    res: Response<ApiResponse<{ ready: boolean; viewOnlyPassword?: string }>>
  ): Promise<void> => {
    const taskId = readTaskId(req);
    const userId = requireUserId(req);
    try {
      const task = await workTaskService.requireMutableTaskRecord(
        taskId,
        userId
      );
      await workRuntimeService.startComputer(task);
      // Watch access needs the session's view-only VNC password. Absent on
      // a GUI image built before takeover support (its VNC has no auth).
      const credentials = await workRuntimeService.computerCredentials(task);
      sendSuccess(res, {
        ready: true,
        ...(credentials ? { viewOnlyPassword: credentials.view } : {}),
      });
    } catch (error) {
      sendError(res, error);
    }
  }
);

// Who is driving this task's Work Computer, and is the agent asking for a
// human? Polled by the Screen pane while it is open.
router.get(
  '/tasks/:id/computer/control',
  async (
    req: AuthenticatedRequest,
    res: Response<
      ApiResponse<{
        holder?: { you: boolean; username?: string; expiresAt: number };
        agentWaiting: boolean;
        agentWaitingReason?: string;
      }>
    >
  ): Promise<void> => {
    const taskId = readTaskId(req);
    const userId = requireUserId(req);
    try {
      await workTaskService.requireTaskRecord(taskId, userId);
      const [holder, assist] = await Promise.all([
        workScreenControlService.current(taskId),
        workScreenControlService.assistState(taskId),
      ]);
      const holderUser = holder
        ? await userModel.getUserById(holder.userId)
        : undefined;
      sendSuccess(res, {
        ...(holder
          ? {
              holder: {
                you: holder.userId === userId,
                ...(holderUser?.username
                  ? { username: holderUser.username }
                  : {}),
                expiresAt: holder.expiresAt,
              },
            }
          : {}),
        agentWaiting: assist !== undefined && assist.phase !== 'released',
        ...(assist && assist.phase !== 'released'
          ? { agentWaitingReason: assist.reason.slice(0, 500) }
          : {}),
      });
    } catch (error) {
      sendError(res, error);
    }
  }
);

// Take over (or renew a held takeover of) the task's screen. Work access is
// re-checked through the task lookup; the control VNC password in the
// response is what actually unlocks input on the session.
router.post(
  '/tasks/:id/computer/control',
  async (
    req: AuthenticatedRequest,
    res: Response<ApiResponse<{ controlPassword: string; expiresAt: number }>>
  ): Promise<void> => {
    const taskId = readTaskId(req);
    const userId = requireUserId(req);
    try {
      const task = await workTaskService.requireMutableTaskRecord(
        taskId,
        userId
      );
      const credentials = await workRuntimeService.computerCredentials(task);
      if (!credentials) {
        throw new WorkConflictError(
          'This Work Computer image predates takeover support. Rebuild the GUI image from deploy/work-computer/.'
        );
      }
      const holder = await workScreenControlService.acquire(
        taskId,
        userId,
        WORK_SCREEN_CONTROL_TTL_MS
      );
      sendSuccess(res, {
        controlPassword: credentials.control,
        expiresAt: holder.expiresAt,
      });
    } catch (error) {
      sendError(res, error);
    }
  }
);

// Save a recorded demonstration as a taught skill: the deterministic
// playbook builder turns raw pointer/key events from the Screen pane's
// teach mode into a reusable natural-language procedure.
router.post(
  '/tasks/:id/computer/teach',
  async (
    req: AuthenticatedRequest,
    res: Response<
      ApiResponse<{
        skill: { id: string; slug: string; name: string };
        steps: number;
        redactions: number;
      }>
    >
  ): Promise<void> => {
    const taskId = readTaskId(req);
    const userId = requireUserId(req);
    try {
      const task = await workTaskService.requireMutableTaskRecord(
        taskId,
        userId
      );
      if (!(await workRuntimeService.computerToolsAvailable(task))) {
        throw new WorkConflictError(
          'Teaching requires a task whose policy enables the Work Computer.'
        );
      }
      const { skill, playbook } =
        await workComputerTeachService.saveDemonstration(userId, {
          name: req.body?.name,
          events: req.body?.events,
          screenWidth: req.body?.screenWidth,
          screenHeight: req.body?.screenHeight,
        });
      sendSuccess(res, {
        skill: { id: skill.id, slug: skill.slug, name: skill.name },
        steps: playbook.steps.length,
        redactions: playbook.redactions,
      });
    } catch (error) {
      sendError(res, error);
    }
  }
);

// "I'm done": hand the screen back to the agent.
router.delete(
  '/tasks/:id/computer/control',
  async (
    req: AuthenticatedRequest,
    res: Response<ApiResponse<{ released: boolean }>>
  ): Promise<void> => {
    const taskId = readTaskId(req);
    const userId = requireUserId(req);
    try {
      await workTaskService.requireTaskRecord(taskId, userId);
      await workScreenControlService.release(taskId, userId);
      sendSuccess(res, { released: true });
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
      const task = await workTaskService.requireMutableTaskRecord(
        taskId,
        userId
      );
      await workRuntimeService.startPreview(
        task,
        typeof req.body?.command === 'string' ? req.body.command : undefined,
        {
          onStarting: () => workTaskService.beginPreview(taskId, userId),
          onRunning: (url, endpoint) =>
            workTaskService.updatePreview(taskId, 'running', url, endpoint),
          onFailed: () => workTaskService.updatePreview(taskId, 'failed'),
        }
      );
      sendSuccess(res, await workTaskService.requireTaskDetail(taskId, userId));
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
      const task = await workTaskService.requireMutableTaskRecord(
        taskId,
        userId
      );
      await workRuntimeService.stopPreview(task, {
        onStopped: () => workTaskService.updatePreview(taskId, 'stopped'),
      });
      sendSuccess(res, await workTaskService.requireTaskDetail(taskId, userId));
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

async function requireIdleGitTask(
  req: AuthenticatedRequest
): Promise<WorkTaskRecord> {
  const taskId = readTaskId(req);
  const task = await workTaskService.requireMutableTaskRecord(
    taskId,
    requireUserId(req)
  );
  if (await workTaskService.getActiveRun(taskId)) {
    throw new WorkRouteError(
      'Stop the active Work run before changing Git state.',
      409
    );
  }
  return task;
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

function rejectPostgresTextNul(value: string, name: string): string {
  if (value.includes('\u0000')) {
    throw new WorkRouteError(`Field "${name}" cannot contain U+0000.`, 400);
  }
  return value;
}

function requirePostgresBodyString(
  value: unknown,
  name: string,
  maxLength: number
): string {
  return rejectPostgresTextNul(requireBodyString(value, name, maxLength), name);
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
  const status =
    error instanceof WorkHostWorkspaceError
      ? 400
      : typeof candidate?.status === 'number'
        ? candidate.status
        : 500;
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
