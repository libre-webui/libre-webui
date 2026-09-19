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
 * HTTP surface for the embedded Cordis/DSH engine.
 *
 * Everything here consumes the `libreDshEngine` contract only; no handler knows
 * that DSH exists. That is what allows the whole engine to be swapped or
 * removed through the composition document without touching a route.
 *
 * Authentication is not optional: the engine can run tools with real
 * filesystem access, so an unauthenticated endpoint would be a remote code
 * execution surface. Every route requires an authenticated session.
 *
 * @module routes/cordis
 */

import express from 'express';

import { authenticate, requireAdmin } from '../middleware/auth.js';
import {
  cordisAccessState,
  getCordisEngine,
  isCordisBridgeEnabled,
  stopCordisHost,
} from '../cordis/runtime.js';
import { setCordisEnabled } from '../services/cordisAccessService.js';
import { getCordisModelCatalog } from '../cordis/dsh/provider-handler.js';
import type { EngineSessionSettings } from '../cordis/contracts.js';
const router = express.Router();

/** Status code and payload for a bridge that cannot serve a request. */
function unavailable(
  status: 'disabled' | 'starting' | 'failed',
  detail?: string
) {
  if (status === 'disabled') {
    return {
      status: 503,
      body: {
        success: false,
        error: 'The Cordis bridge is not enabled.',
        code: 'CORDIS_DISABLED',
      },
    };
  }
  if (status === 'starting') {
    return {
      status: 503,
      body: {
        success: false,
        error: 'The Cordis bridge is still starting.',
        code: 'CORDIS_STARTING',
      },
    };
  }
  return {
    status: 503,
    body: {
      success: false,
      error: detail ?? 'The Cordis bridge failed to start.',
      code: 'CORDIS_UNAVAILABLE',
    },
  };
}

router.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

// Health is reachable without a session so an operator can tell "disabled"
// apart from a broken one before they have credentials to hand.
router.get('/health', async (_req, res) => {
  if (!(await isCordisBridgeEnabled())) {
    res.json({ success: true, enabled: false, ready: false });
    return;
  }
  const result = await getCordisEngine();
  if (!result.ok) {
    const { status, body } = unavailable(result.reason, result.detail);
    res.status(status).json({ enabled: true, ready: false, ...body });
    return;
  }
  res.json({
    success: true,
    enabled: true,
    ready: true,
    services: result.engine.status(),
  });
});

/**
 * Read the administrator opt-in.
 *
 * Administrator-only: the answer decides whether the engine's page exists for
 * this deployment, and the setting is a deployment-wide switch rather than a
 * per-user preference.
 */
router.get('/access', authenticate, requireAdmin, async (_req, res) => {
  const access = await cordisAccessState();
  res.json({ success: true, ...access });
});

/**
 * Set the administrator opt-in.
 *
 * Enabling starts the engine on its next request; disabling stops it
 * immediately so the decision takes effect without a restart. Disposal is what
 * withdraws the engine's services and releases its listeners, so turning the
 * feature off does not leave a running engine behind a hidden page.
 */
router.put('/access', authenticate, requireAdmin, async (req, res) => {
  const { enabled } = req.body ?? {};
  if (typeof enabled !== 'boolean') {
    res
      .status(400)
      .json({ success: false, error: 'enabled must be a boolean.' });
    return;
  }
  const access = await cordisAccessState();
  if (access.lockedByEnv) {
    res.status(409).json({
      success: false,
      error:
        access.lockedBy === 'env'
          ? 'The Cordis engine is pinned by LIBRE_CORDIS_ENABLED; unset the environment variable to manage it here.'
          : 'The Cordis engine is pinned by features.enabled in cordis.config.yml; remove that key to manage it here.',
    });
    return;
  }
  await setCordisEnabled(enabled);
  if (!enabled) await stopCordisHost();
  res.json({ success: true, enabled, lockedByEnv: false });
});

// The host engine is an administrator console with deployment-wide sessions.
// Navigation visibility is not an authorization boundary.
router.use(authenticate, requireAdmin);

/** Validate only choices advertised for the authenticated administrator. */
async function sessionSettings(
  body: unknown,
  userId: string
): Promise<Partial<EngineSessionSettings>> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('Session settings must be an object.');
  }
  const input = body as Record<string, unknown>;
  const settings: {
    model?: string;
    permissionMode?: 'read-only' | 'workspace-write';
  } = {};
  if (input.model !== undefined) {
    if (
      typeof input.model !== 'string' ||
      !input.model.trim() ||
      input.model.length > 2048
    ) {
      throw new Error('Choose an available engine model.');
    }
    const catalog = await getCordisModelCatalog(userId);
    if (!catalog.models.some(model => model.id === input.model)) {
      throw new Error(
        'The selected engine model is not available to this account.'
      );
    }
    settings.model = input.model;
  }
  if (input.permissionMode !== undefined) {
    if (
      input.permissionMode !== 'read-only' &&
      input.permissionMode !== 'workspace-write'
    ) {
      throw new Error('Permission mode must be read-only or workspace-write.');
    }
    settings.permissionMode = input.permissionMode;
  }
  return settings;
}

router.get('/models', async (req, res) => {
  if (!(await isCordisBridgeEnabled())) {
    const response = unavailable('disabled');
    res.status(response.status).json(response.body);
    return;
  }
  const catalog = await getCordisModelCatalog(req.user!.userId);
  res.json({ success: true, ...catalog });
});

router.get('/sessions', async (_req, res) => {
  const result = await getCordisEngine();
  if (!result.ok) {
    const { status, body } = unavailable(result.reason, result.detail);
    res.status(status).json(body);
    return;
  }
  res.json({ success: true, sessions: await result.engine.listSessions() });
});

router.post('/sessions', async (req, res) => {
  const result = await getCordisEngine();
  if (!result.ok) {
    const { status, body } = unavailable(result.reason, result.detail);
    res.status(status).json(body);
    return;
  }
  const cwd =
    typeof req.body?.cwd === 'string' && req.body.cwd.trim() !== ''
      ? req.body.cwd
      : undefined;
  const title =
    typeof req.body?.title === 'string' && req.body.title.trim() !== ''
      ? req.body.title
      : undefined;
  try {
    // The engine resolves an omitted cwd to its configured workspace, so the
    // route never invents one.
    const settings = await sessionSettings(req.body ?? {}, req.user!.userId);
    const session = await result.engine.createSession({
      cwd: cwd ?? '',
      ...(title === undefined ? {} : { title }),
      ...settings,
      userId: req.user!.userId,
    });
    res.status(201).json({ success: true, session });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

router.get('/sessions/:id', async (req, res) => {
  const result = await getCordisEngine();
  if (!result.ok) {
    const { status, body } = unavailable(result.reason, result.detail);
    res.status(status).json(body);
    return;
  }
  const session = await result.engine.getSession(req.params.id);
  if (!session) {
    res.status(404).json({ success: false, error: 'Session not found.' });
    return;
  }
  res.json({ success: true, session });
});

router.patch('/sessions/:id/settings', async (req, res) => {
  const result = await getCordisEngine();
  if (!result.ok) {
    const response = unavailable(result.reason, result.detail);
    res.status(response.status).json(response.body);
    return;
  }
  try {
    const settings = await sessionSettings(req.body, req.user!.userId);
    if (Object.keys(settings).length === 0) {
      res.status(400).json({
        success: false,
        error: 'Choose a model or permission mode to update.',
      });
      return;
    }
    if (!(await result.engine.getSession(req.params.id))) {
      res.status(404).json({ success: false, error: 'Session not found.' });
      return;
    }
    const session = await result.engine.updateSessionSettings(
      req.params.id,
      settings,
      { userId: req.user!.userId }
    );
    res.json({ success: true, session });
  } catch (error) {
    const code = (error as { code?: unknown })?.code;
    res.status(code === 'CORDIS_SESSION_BUSY' ? 409 : 400).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
      ...(typeof code === 'string' ? { code } : {}),
    });
  }
});

router.post('/sessions/:id/approvals/:approvalId', async (req, res) => {
  const decision = req.body?.decision;
  if (decision !== 'allowed-once' && decision !== 'rejected') {
    res.status(400).json({
      success: false,
      error: 'Choose allow once or reject for this approval.',
    });
    return;
  }
  const result = await getCordisEngine();
  if (!result.ok) {
    const response = unavailable(result.reason, result.detail);
    res.status(response.status).json(response.body);
    return;
  }
  const accepted = await result.engine.decideApproval(
    req.params.id,
    req.params.approvalId,
    decision
  );
  if (!accepted) {
    res.status(409).json({
      success: false,
      error: 'This approval is no longer pending for this session.',
    });
    return;
  }
  res.json({ success: true });
});

router.delete('/sessions/:id', async (req, res) => {
  const result = await getCordisEngine();
  if (!result.ok) {
    const { status, body } = unavailable(result.reason, result.detail);
    res.status(status).json(body);
    return;
  }
  const deleted = await result.engine.deleteSession(req.params.id);
  res.status(deleted ? 200 : 404).json({ success: deleted });
});

router.get('/agents', async (_req, res) => {
  const result = await getCordisEngine();
  if (!result.ok) {
    const { status, body } = unavailable(result.reason, result.detail);
    res.status(status).json(body);
    return;
  }
  res.json({ success: true, agents: await result.engine.listAgents() });
});

router.get('/tools', async (_req, res) => {
  const result = await getCordisEngine();
  if (!result.ok) {
    const { status, body } = unavailable(result.reason, result.detail);
    res.status(status).json(body);
    return;
  }
  res.json({ success: true, tools: await result.engine.listTools() });
});

/**
 * Send a chat message and stream the agent response as newline-delimited JSON.
 *
 * NDJSON is chosen over WebSocket deliberately: an agent turn is a single
 * server-to-client sequence with no client-to-server frames after the request,
 * so a streaming POST keeps the whole turn inside one authenticated request and
 * needs no separate handshake, ticket, or reconnect protocol.
 */
router.post('/sessions/:id/messages', async (req, res) => {
  const result = await getCordisEngine();
  if (!result.ok) {
    const { status, body } = unavailable(result.reason, result.detail);
    res.status(status).json(body);
    return;
  }
  const text = typeof req.body?.text === 'string' ? req.body.text : '';
  if (text.trim() === '') {
    res
      .status(400)
      .json({ success: false, error: 'A message text is required.' });
    return;
  }

  if (text.length > 100_000) {
    res.status(400).json({
      success: false,
      error: 'Message text exceeds 100000 characters.',
    });
    return;
  }

  let disconnected = false;
  const onDisconnect = () => {
    disconnected = true;
    void result.engine.cancel(req.params.id).catch(() => undefined);
  };
  res.once('close', onDisconnect);
  let stream;
  try {
    stream = await result.engine.sendMessage(req.params.id, text, {
      userId: req.user!.userId,
    });
    if (disconnected) {
      await result.engine.cancel(req.params.id);
      stream.close();
      return;
    }
  } catch (error) {
    // A failure here is caller-visible (unknown session, a turn already in
    // flight, streaming disabled), so it is a request error rather than a
    // bridge outage.
    res.off('close', onDisconnect);
    if (!res.destroyed)
      res.status(400).json({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    return;
  }

  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-store');
  // The response must not be buffered by an intermediary: the point of the
  // endpoint is that chunks reach the client as the model produces them.
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  let closed = false;
  let subscription: { unsubscribe(): void } | undefined;

  const finish = () => {
    if (closed) return;
    closed = true;
    res.off('close', onDisconnect);
    subscription?.unsubscribe();
    res.end();
  };

  // Subscribing replays whatever the model already produced, so a fast first
  // token cannot be lost between the engine starting the turn and this handler
  // attaching its listener.
  subscription = stream.subscribe(chunk => {
    if (closed) return;
    res.write(`${JSON.stringify(chunk)}\n`);
    if (res.writableLength > 1_048_576) {
      onDisconnect();
      finish();
      return;
    }
    // `done` is the terminal chunk of one turn, so the response ends here
    // rather than waiting for the client to close it.
    if (chunk.type === 'done') finish();
  });

  if (closed) subscription.unsubscribe();

  // Disconnecting cancels model and tool work, as well as releasing the reader.
  res.on('close', () => {
    if (closed) return;
    closed = true;
    subscription?.unsubscribe();
    stream.close();
  });
});

router.post('/sessions/:id/cancel', async (req, res) => {
  const result = await getCordisEngine();
  if (!result.ok) {
    const { status, body } = unavailable(result.reason, result.detail);
    res.status(status).json(body);
    return;
  }
  res.json({ success: await result.engine.cancel(req.params.id) });
});

// Keep corrupt legacy sessions visible as a recoverable conflict. Never bypass
// the engine's event validator or discard a transcript to make it readable.
const sessionErrorHandler: express.ErrorRequestHandler = (
  error,
  _req,
  res,
  next
) => {
  if (
    error instanceof Error &&
    error.name === 'SessionPersistenceCorruptionError'
  ) {
    res.status(409).json({
      success: false,
      code: 'CORDIS_SESSION_INVALID',
      error:
        'This saved session has an invalid event log. Preserve the original files and use the Cordis session repair tool before reopening it.',
    });
    return;
  }
  next(error);
};
router.use(sessionErrorHandler);

export default router;
