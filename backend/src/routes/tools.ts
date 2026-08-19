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
import { ApiResponse } from '../types/index.js';
import {
  authenticate,
  requireAdmin,
  AuthenticatedRequest,
} from '../middleware/auth.js';
import { ResourcePolicyError } from '../utils/resourceLimits.js';
import { ToolEgressError } from '../utils/toolEgress.js';
import {
  AuthorizationError,
  type AuthzActor,
} from '../services/authorizationService.js';
import { McpClientError } from '../services/mcpClientService.js';
import { OpenApiSpecError } from '../services/openApiToolService.js';
import {
  getToolAccessMode,
  isToolAccessMode,
  setToolAccessMode,
  toolAccessModeLockedByEnv,
} from '../services/toolAccessService.js';
import {
  decideApproval,
  listPendingApprovals,
  listStandingApprovals,
  revokeApproval,
} from '../services/toolApprovalService.js';
import {
  actorCanUseTools,
  buildToolCatalog,
} from '../services/toolGatewayService.js';
import {
  actorCanUseServer,
  deleteToolServer,
  deleteToolServerCredential,
  getToolServer,
  hasToolServerCredential,
  listServerTools,
  listToolServers,
  listVisibleToolServers,
  overrideServerTool,
  refreshToolServer,
  registerToolServer,
  setToolServerCredential,
  updateToolServer,
  type ToolServerInput,
  type ToolServerUpdate,
} from '../services/toolServerService.js';
import type { ToolServer } from '../types/tools.js';

const router = express.Router();
router.use(authenticate);

const userIdOf = (req: AuthenticatedRequest): string =>
  req.user?.userId || 'default';

const actorOf = (req: AuthenticatedRequest): AuthzActor => ({
  userId: userIdOf(req),
  role: req.user?.role,
});

function sendToolError(
  res: express.Response,
  error: unknown,
  fallback: string
) {
  if (error instanceof ResourcePolicyError) {
    res.status(error.statusCode).json({ success: false, error: error.message });
    return;
  }
  if (error instanceof AuthorizationError) {
    res.status(403).json({ success: false, error: error.message });
    return;
  }
  if (
    error instanceof ToolEgressError ||
    error instanceof McpClientError ||
    error instanceof OpenApiSpecError
  ) {
    res.status(400).json({ success: false, error: error.message });
    return;
  }
  res.status(500).json({
    success: false,
    error: error instanceof Error ? error.message : fallback,
  } as ApiResponse);
}

const notFound = (res: express.Response) => {
  res.status(404).json({ success: false, error: 'Not found' } as ApiResponse);
};

/** The reduced server view a non-admin needs to use and authenticate a server. */
const publicServerView = (server: ToolServer, hasCredential: boolean) => ({
  id: server.id,
  name: server.name,
  ...(server.description ? { description: server.description } : {}),
  kind: server.kind,
  authMode: server.authMode,
  enabled: server.enabled,
  specRevision: server.specRevision,
  hasCredential,
});

const adminServerView = (server: ToolServer, hasCredential: boolean) => ({
  ...publicServerView(server, hasCredential),
  baseUrl: server.baseUrl,
  ...(server.specDigest ? { specDigest: server.specDigest } : {}),
  ...(server.authHeader ? { authHeader: server.authHeader } : {}),
  accessMode: server.accessMode,
  timeoutMs: server.timeoutMs,
  maxResponseBytes: server.maxResponseBytes,
  createdAt: server.createdAt,
  updatedAt: server.updatedAt,
});

router.get('/access', requireAdmin, async (_req, res) => {
  try {
    res.json({
      success: true,
      data: {
        mode: await getToolAccessMode(),
        lockedByEnv: toolAccessModeLockedByEnv(),
      },
    } as ApiResponse);
  } catch (error) {
    sendToolError(res, error, 'Failed to read the tool access mode');
  }
});

router.put('/access', requireAdmin, async (req: AuthenticatedRequest, res) => {
  try {
    if (toolAccessModeLockedByEnv()) {
      res.status(409).json({
        success: false,
        error: 'TOOLS_ACCESS_MODE pins this setting',
      } as ApiResponse);
      return;
    }
    const mode = (req.body as { mode?: unknown })?.mode;
    if (!isToolAccessMode(mode)) {
      res
        .status(400)
        .json({ success: false, error: 'Invalid tool access mode' });
      return;
    }
    await setToolAccessMode(mode);
    res.json({ success: true, data: { mode } } as ApiResponse);
  } catch (error) {
    sendToolError(res, error, 'Failed to update the tool access mode');
  }
});

router.get('/servers', async (req: AuthenticatedRequest, res) => {
  try {
    const actor = actorOf(req);
    const isAdmin = actor.role === 'admin';
    const servers = isAdmin
      ? await listToolServers()
      : await listVisibleToolServers(actor);
    const data = [];
    for (const server of servers) {
      const hasCredential =
        server.authMode === 'none'
          ? true
          : await hasToolServerCredential(actor.userId, server.id);
      data.push(
        isAdmin
          ? adminServerView(server, hasCredential)
          : publicServerView(server, hasCredential)
      );
    }
    res.json({ success: true, data } as ApiResponse);
  } catch (error) {
    sendToolError(res, error, 'Failed to list tool servers');
  }
});

router.post(
  '/servers',
  requireAdmin,
  async (req: AuthenticatedRequest, res) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const server = await registerToolServer(
        userIdOf(req),
        body as unknown as ToolServerInput
      );
      res.status(201).json({
        success: true,
        data: adminServerView(server, false),
      } as ApiResponse);
    } catch (error) {
      sendToolError(res, error, 'Failed to register the tool server');
    }
  }
);

router.get('/servers/:id', async (req: AuthenticatedRequest, res) => {
  try {
    const actor = actorOf(req);
    const server = await getToolServer(req.params.id as string);
    if (!server) return notFound(res);
    const isAdmin = actor.role === 'admin';
    if (!isAdmin && !(await actorCanUseServer(actor, server))) {
      return notFound(res);
    }
    const hasCredential =
      server.authMode === 'none'
        ? true
        : await hasToolServerCredential(actor.userId, server.id);
    const tools = await listServerTools(server.id);
    res.json({
      success: true,
      data: {
        server: isAdmin
          ? adminServerView(server, hasCredential)
          : publicServerView(server, hasCredential),
        tools: tools.map(tool => ({
          name: tool.name,
          ...(tool.description ? { description: tool.description } : {}),
          sideEffect: tool.sideEffect,
          enabled: tool.enabled,
        })),
      },
    } as ApiResponse);
  } catch (error) {
    sendToolError(res, error, 'Failed to read the tool server');
  }
});

router.put(
  '/servers/:id',
  requireAdmin,
  async (req: AuthenticatedRequest, res) => {
    try {
      const server = await updateToolServer(
        userIdOf(req),
        req.params.id as string,
        (req.body ?? {}) as ToolServerUpdate
      );
      if (!server) return notFound(res);
      res.json({
        success: true,
        data: adminServerView(server, false),
      } as ApiResponse);
    } catch (error) {
      sendToolError(res, error, 'Failed to update the tool server');
    }
  }
);

router.delete(
  '/servers/:id',
  requireAdmin,
  async (req: AuthenticatedRequest, res) => {
    try {
      const deleted = await deleteToolServer(
        userIdOf(req),
        req.params.id as string
      );
      if (!deleted) return notFound(res);
      res.json({ success: true, data: { deleted: true } } as ApiResponse);
    } catch (error) {
      sendToolError(res, error, 'Failed to delete the tool server');
    }
  }
);

router.post(
  '/servers/:id/refresh',
  requireAdmin,
  async (req: AuthenticatedRequest, res) => {
    try {
      const server = await refreshToolServer(
        userIdOf(req),
        req.params.id as string
      );
      if (!server) return notFound(res);
      res.json({
        success: true,
        data: adminServerView(server, false),
      } as ApiResponse);
    } catch (error) {
      sendToolError(res, error, 'Failed to refresh the tool server');
    }
  }
);

router.put(
  '/servers/:id/tools/:toolName',
  requireAdmin,
  async (req: AuthenticatedRequest, res) => {
    try {
      const body = (req.body ?? {}) as {
        enabled?: unknown;
        sideEffect?: unknown;
      };
      const tool = await overrideServerTool(
        userIdOf(req),
        req.params.id as string,
        req.params.toolName as string,
        {
          ...(typeof body.enabled === 'boolean'
            ? { enabled: body.enabled }
            : {}),
          ...(typeof body.sideEffect === 'boolean'
            ? { sideEffect: body.sideEffect }
            : {}),
        }
      );
      if (!tool) return notFound(res);
      res.json({
        success: true,
        data: {
          name: tool.name,
          sideEffect: tool.sideEffect,
          enabled: tool.enabled,
        },
      } as ApiResponse);
    } catch (error) {
      sendToolError(res, error, 'Failed to update the tool');
    }
  }
);

router.put(
  '/servers/:id/credential',
  async (req: AuthenticatedRequest, res) => {
    try {
      const actor = actorOf(req);
      const server = await getToolServer(req.params.id as string);
      if (!server || !(await actorCanUseServer(actor, server))) {
        return notFound(res);
      }
      const secret = (req.body as { secret?: unknown })?.secret;
      if (typeof secret !== 'string') {
        res
          .status(400)
          .json({ success: false, error: 'A credential secret is required' });
        return;
      }
      await setToolServerCredential(actor.userId, server.id, secret);
      res.json({ success: true, data: { stored: true } } as ApiResponse);
    } catch (error) {
      sendToolError(res, error, 'Failed to store the credential');
    }
  }
);

router.delete(
  '/servers/:id/credential',
  async (req: AuthenticatedRequest, res) => {
    try {
      const deleted = await deleteToolServerCredential(
        userIdOf(req),
        req.params.id as string
      );
      if (!deleted) return notFound(res);
      res.json({ success: true, data: { deleted: true } } as ApiResponse);
    } catch (error) {
      sendToolError(res, error, 'Failed to delete the credential');
    }
  }
);

router.get('/approvals', async (req: AuthenticatedRequest, res) => {
  try {
    const userId = userIdOf(req);
    const [pending, standing] = await Promise.all([
      listPendingApprovals(userId),
      listStandingApprovals(userId),
    ]);
    res.json({ success: true, data: { pending, standing } } as ApiResponse);
  } catch (error) {
    sendToolError(res, error, 'Failed to list approvals');
  }
});

router.post('/approvals/:id', async (req: AuthenticatedRequest, res) => {
  try {
    const body = (req.body ?? {}) as { approve?: unknown; scope?: unknown };
    if (typeof body.approve !== 'boolean') {
      res
        .status(400)
        .json({ success: false, error: 'An approve boolean is required' });
      return;
    }
    const scope =
      body.scope === 'session' || body.scope === 'always' ? body.scope : 'once';
    const approval = await decideApproval(
      userIdOf(req),
      req.params.id as string,
      {
        approve: body.approve,
        scope,
      }
    );
    if (!approval) return notFound(res);
    res.json({ success: true, data: approval } as ApiResponse);
  } catch (error) {
    sendToolError(res, error, 'Failed to record the decision');
  }
});

router.delete('/approvals/:id', async (req: AuthenticatedRequest, res) => {
  try {
    const deleted = await revokeApproval(
      userIdOf(req),
      req.params.id as string
    );
    if (!deleted) return notFound(res);
    res.json({ success: true, data: { deleted: true } } as ApiResponse);
  } catch (error) {
    sendToolError(res, error, 'Failed to revoke the approval');
  }
});

router.get('/catalog', async (req: AuthenticatedRequest, res) => {
  try {
    const actor = actorOf(req);
    if (!(await actorCanUseTools(actor))) {
      res.json({
        success: true,
        data: { available: false, tools: [] },
      } as ApiResponse);
      return;
    }
    const catalog = await buildToolCatalog(actor, {});
    res.json({
      success: true,
      data: {
        available: true,
        tools: catalog.tools.map(tool => ({
          name: tool.name,
          ...(tool.description ? { description: tool.description } : {}),
          sideEffect: tool.sideEffect,
          source: tool.source,
          ...(tool.serverId ? { serverId: tool.serverId } : {}),
          ...(tool.serverName ? { serverName: tool.serverName } : {}),
        })),
      },
    } as ApiResponse);
  } catch (error) {
    sendToolError(res, error, 'Failed to build the tool catalog');
  }
});

export default router;
