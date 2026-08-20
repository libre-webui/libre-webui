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

import express, { Response } from 'express';
import { randomUUID } from 'node:crypto';
import rateLimit from '../middleware/sharedRateLimit.js';
import { isChatCancellationSafetyRequest } from '../middleware/chatCancellationAdmission.js';
import chatService from '../services/chatService.js';
import ollamaService from '../services/ollamaService.js';
import pluginService from '../services/pluginService.js';
import { personaService } from '../services/personaService.js';
import {
  authenticate,
  requireAdmin,
  AuthenticatedRequest,
} from '../middleware/auth.js';
import {
  getCompactionConfig,
  setCompactionConfig,
} from '../services/contextCompactionService.js';
import { extractStatistics } from '../utils/generationUtils.js';
import agentCliService from '../services/agentCliService.js';
import {
  buildWebSearchEnhancedContent,
  isWebSearchAvailable,
  userCanUseWebSearch,
} from '../services/webSearchService.js';
import { runPlannedWebSearch } from '../services/webSearchPlanService.js';
import { sanitizeRequestedToolSelection } from '../services/toolGatewayService.js';
import { userModel } from '../models/userModel.js';
import chatGenerationService from '../services/chatGenerationService.js';
import preferencesService from '../services/preferencesService.js';
import { ChatRequestService } from '../services/chatRequestService.js';
import { TitleGenerationService } from '../services/titleGenerationService.js';
import { FollowUpService } from '../services/followUpService.js';
import {
  ApiResponse,
  ChatSession,
  ChatMessage,
  getErrorMessage,
} from '../types/index.js';
import { createLogger } from '../utils/logger.js';
import {
  buildChatDocumentContext,
  EMPTY_CHAT_DOCUMENT_CONTEXT,
} from '../utils/chatDocumentContext.js';
import { ChatProviderSelectionError } from '../utils/chatProviderSelection.js';
import { formatPluginStreamToolCalls } from '../utils/pluginStreaming.js';
import { ResourcePolicyError } from '../utils/resourceLimits.js';
import {
  abortChatGenerationOnResponseClose,
  isChatGenerationCancelled,
  throwIfChatGenerationCancelled,
} from '../utils/chatCancellation.js';
import { getDurableEventGateway } from '../platform/events/index.js';
import { chatGenerationIdempotencyScope } from '../platform/jobs/domainJobContracts.js';
import { getDurableJobRuntime } from '../platform/jobs/durableJobRuntime.js';
import { durableEventId } from '../platform/jobs/durableEventIdentity.js';
import { getPlatformRuntimeConfig } from '../platform/coordination/service.js';

const logger = createLogger('routes:chat');
const CHAT_EVENT_MAX_FRAME_BYTES = 128 * 1024;
const CHAT_EVENT_DRAIN_TIMEOUT_MS = 15_000;

const chatStreamId = (sessionId: string): string => `chat:${sessionId}`;

const cancelChatGenerationByIdentity = async (
  userId: string,
  sessionId: string,
  assistantMessageId: string
) => {
  return getDurableJobRuntime().service.requestChatCancellation({
    actorUserId: userId,
    sessionId,
    assistantMessageId,
  });
};

const writeChatSseFrame = async (
  res: Response,
  cursor: number,
  payload: unknown
): Promise<void> => {
  const frame = `id: ${cursor}\ndata: ${JSON.stringify(payload)}\n\n`;
  if (Buffer.byteLength(frame, 'utf8') > CHAT_EVENT_MAX_FRAME_BYTES) {
    throw new Error('Chat event frame exceeds the delivery bound.');
  }
  if (res.writableEnded || res.destroyed) return;
  if (res.write(frame)) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timeout);
      res.off('drain', drained);
      res.off('close', closed);
    };
    const drained = (): void => {
      cleanup();
      resolve();
    };
    const closed = (): void => {
      cleanup();
      reject(new Error('Chat event stream closed during backpressure.'));
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('Chat event stream backpressure timed out.'));
    }, CHAT_EVENT_DRAIN_TIMEOUT_MS);
    timeout.unref?.();
    res.once('drain', drained);
    res.once('close', closed);
  });
};

function sendSessionFolderError(
  res: Response<ApiResponse>,
  error: unknown,
  fallback: string
) {
  if (error instanceof ResourcePolicyError) {
    res.status(error.statusCode).json({ success: false, error: error.message });
    return;
  }
  res.status(500).json({
    success: false,
    error: getErrorMessage(error, fallback),
  });
}

const router = express.Router();

const rejectProcessLocalTeamGeneration = (res: Response): boolean => {
  if (getPlatformRuntimeConfig().mode !== 'team') return false;
  res.status(409).json({
    success: false,
    error:
      'This compatibility endpoint is unavailable in team mode. Queue the generation through /generations and resume it through /events.',
    code: 'DURABLE_CHAT_REQUIRED',
  });
  return true;
};
const titleGenerationService = new TitleGenerationService({
  chatService,
  chatGenerationService,
  pluginService,
  ollamaService,
});
const chatRequestService = new ChatRequestService({
  chatGenerationService,
  personaService,
  preferencesService,
});
const followUpService = new FollowUpService({
  chatService,
  chatGenerationService,
  pluginService,
  ollamaService,
});

// Rate limiter for chat routes: 60 requests per minute (reasonable for chat)
const chatRateLimiter = rateLimit({
  keyPrefix: 'chat-routes',
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 60, // limit each IP to 60 requests per minute
  message: {
    success: false,
    message: 'Too many chat requests, please slow down',
  },
  standardHeaders: true,
  legacyHeaders: false,
  skip: isChatCancellationSafetyRequest,
});

// Apply rate limiter to all chat routes
router.use(chatRateLimiter);

// Apply authentication middleware to all chat routes
router.use(authenticate);

// Get all chat sessions
router.get(
  '/sessions',
  async (
    req: AuthenticatedRequest,
    res: Response<ApiResponse<ChatSession[]>>
  ): Promise<void> => {
    try {
      const userId = req.user?.userId || 'default';
      const sessions = await chatService.getAllSessions(userId);
      res.json({
        success: true,
        data: sessions,
      });
    } catch (error: unknown) {
      res.status(500).json({
        success: false,
        error: getErrorMessage(error, 'Failed to load sessions'),
      });
    }
  }
);

// Create a new chat session
router.post(
  '/sessions',
  async (
    req: AuthenticatedRequest,
    res: Response<ApiResponse<ChatSession>>
  ): Promise<void> => {
    try {
      const { model, title, personaId, providerType, providerId } = req.body;

      if (!model) {
        res.status(400).json({
          success: false,
          error: 'Model is required',
        });
        return;
      }

      const userId = req.user?.userId || 'default';

      // Extract persona ID from model string if it starts with "persona:"
      let extractedPersonaId = personaId;
      if (model.startsWith('persona:') && !extractedPersonaId) {
        extractedPersonaId = model.replace('persona:', '');
      }

      const session = await chatService.createSession(
        model,
        title,
        userId,
        extractedPersonaId,
        { providerType, providerId }
      );
      res.json({
        success: true,
        data: session,
      });
    } catch (error: unknown) {
      res.status(error instanceof ChatProviderSelectionError ? 400 : 500).json({
        success: false,
        error: getErrorMessage(error, 'Failed to create session'),
      });
    }
  }
);

// Get a specific chat session
router.get(
  '/sessions/:sessionId',
  async (
    req: AuthenticatedRequest,
    res: Response<ApiResponse<ChatSession>>
  ): Promise<void> => {
    try {
      const sessionId = req.params.sessionId as string;
      const userId = req.user?.userId || 'default';
      const session = await chatService.getSession(sessionId, userId);

      if (!session) {
        res.status(404).json({
          success: false,
          error: 'Session not found',
        });
        return;
      }

      res.json({
        success: true,
        data: session,
      });
    } catch (error: unknown) {
      res.status(500).json({
        success: false,
        error: getErrorMessage(error, 'Failed to get session'),
      });
    }
  }
);

// Update a chat session
router.put(
  '/sessions/:sessionId',
  async (
    req: AuthenticatedRequest,
    res: Response<ApiResponse<ChatSession>>
  ): Promise<void> => {
    try {
      const sessionId = req.params.sessionId as string;
      const updates = req.body;

      const userId = req.user?.userId || 'default';
      const updatedSession = await chatService.updateSession(
        sessionId,
        updates,
        userId
      );

      if (!updatedSession) {
        res.status(404).json({
          success: false,
          error: 'Session not found',
        });
        return;
      }

      res.json({
        success: true,
        data: updatedSession,
      });
    } catch (error: unknown) {
      res.status(error instanceof ChatProviderSelectionError ? 400 : 500).json({
        success: false,
        error: getErrorMessage(error, 'Failed to update session'),
      });
    }
  }
);

// Update a message in a chat session
router.put(
  '/sessions/:sessionId/messages/:messageId',
  async (
    req: AuthenticatedRequest,
    res: Response<ApiResponse<ChatMessage>>
  ): Promise<void> => {
    try {
      const sessionId = req.params.sessionId as string;
      const messageId = req.params.messageId as string;
      const updates = req.body;
      const userId = req.user?.userId || 'default';

      const updatedMessage = await chatService.updateMessage(
        sessionId,
        messageId,
        updates,
        userId
      );

      if (!updatedMessage) {
        res.status(404).json({
          success: false,
          error: 'Session or message not found',
        });
        return;
      }

      res.json({
        success: true,
        data: updatedMessage,
      });
    } catch (error: unknown) {
      res.status(500).json({
        success: false,
        error: getErrorMessage(error, 'Failed to update message'),
      });
    }
  }
);

// Truncate a session at a message: drop it and everything after it
// (edit-and-resend). The metadata PUT deliberately ignores `messages`,
// so this is the only way a client can shorten the server-side history.
router.post(
  '/sessions/:sessionId/messages/:messageId/truncate',
  async (
    req: AuthenticatedRequest,
    res: Response<ApiResponse<ChatSession>>
  ): Promise<void> => {
    try {
      const sessionId = req.params.sessionId as string;
      const messageId = req.params.messageId as string;
      const userId = req.user?.userId || 'default';

      const updatedSession = await chatService.truncateMessagesFrom(
        sessionId,
        messageId,
        userId
      );

      if (!updatedSession) {
        res.status(404).json({
          success: false,
          error: 'Session or message not found',
        });
        return;
      }

      res.json({
        success: true,
        data: updatedSession,
      });
    } catch (error: unknown) {
      res.status(500).json({
        success: false,
        error: getErrorMessage(error, 'Failed to truncate session'),
      });
    }
  }
);

// Delete a chat session
router.delete(
  '/sessions/:sessionId',
  async (
    req: AuthenticatedRequest,
    res: Response<ApiResponse>
  ): Promise<void> => {
    try {
      const sessionId = req.params.sessionId as string;
      const userId = req.user?.userId || 'default';
      const deleted = await chatService.deleteSession(sessionId, userId);

      if (!deleted) {
        res.status(404).json({
          success: false,
          error: 'Session not found',
        });
        return;
      }

      res.json({
        success: true,
        message: 'Session deleted successfully',
      });
    } catch (error: unknown) {
      res.status(500).json({
        success: false,
        error: getErrorMessage(error, 'Failed to delete session'),
      });
    }
  }
);

// Clear all chat sessions
router.delete(
  '/sessions',
  async (
    req: AuthenticatedRequest,
    res: Response<ApiResponse>
  ): Promise<void> => {
    try {
      const userId = req.user?.userId || 'default';
      await chatService.clearAllSessions(userId);
      res.json({
        success: true,
        message: 'All chat sessions cleared successfully',
      });
    } catch (error: unknown) {
      res.status(500).json({
        success: false,
        error: getErrorMessage(error, 'Failed to clear sessions'),
      });
    }
  }
);

// Add a message to a session
router.post(
  '/sessions/:sessionId/messages',
  async (
    req: AuthenticatedRequest,
    res: Response<ApiResponse<ChatMessage>>
  ): Promise<void> => {
    try {
      const sessionId = req.params.sessionId as string;
      const { role, content, id, model } = req.body;

      if (!role || !content) {
        res.status(400).json({
          success: false,
          error: 'Role and content are required',
        });
        return;
      }

      const userId = req.user?.userId || 'default';
      const session = await chatService.getSession(sessionId, userId);
      if (!session) {
        res.status(404).json({
          success: false,
          error: 'Session not found',
        });
        return;
      }

      const message = await chatService.addMessage(
        sessionId,
        {
          role,
          content,
          model,
          id, // Use provided ID if available
        },
        userId
      );

      if (!message) {
        res.status(500).json({
          success: false,
          error: 'Failed to add message',
        });
        return;
      }
      res.json({
        success: true,
        data: message,
      });
    } catch (error: unknown) {
      res.status(500).json({
        success: false,
        error: getErrorMessage(error, 'Failed to add message'),
      });
    }
  }
);

// Generate a chat response
router.post(
  '/sessions/:sessionId/generate',
  async (
    req: AuthenticatedRequest,
    res: Response<ApiResponse<ChatMessage>>
  ): Promise<void> => {
    if (rejectProcessLocalTeamGeneration(res)) return;
    const { controller, cleanup } = abortChatGenerationOnResponseClose(res);
    const signal = controller.signal;
    try {
      const sessionId = req.params.sessionId as string;
      const { message, options = {} } = req.body;

      if (!message) {
        res.status(400).json({
          success: false,
          error: 'Message is required',
        });
        return;
      }
      const userId = req.user?.userId || 'default';
      const session = await chatService.getSession(sessionId, userId);
      if (!session) {
        res.status(404).json({
          success: false,
          error: 'Session not found',
        });
        return;
      }

      // Add user message to session
      const userMessage = await chatService.addMessage(
        sessionId,
        {
          role: 'user',
          content: message,
        },
        userId
      );

      if (!userMessage) {
        res.status(500).json({
          success: false,
          error: 'Failed to add user message',
        });
        return;
      }

      let documentContext = EMPTY_CHAT_DOCUMENT_CONTEXT(message);
      try {
        documentContext = await buildChatDocumentContext(
          message,
          sessionId,
          userId,
          signal
        );
      } catch (error) {
        throwIfChatGenerationCancelled(signal);
        logger.error('Error during document search:', error);
      }

      // Requested web search composes on top of any document context; a
      // failed search degrades to a normal reply rather than failing it.
      let webSearchSources: Array<{ title: string; url: string }> | undefined;
      let enhancedContent = documentContext.enhancedContent;
      let hasRelevantContext = documentContext.hasRelevantContext;
      if (
        req.body?.webSearch === true &&
        (await isWebSearchAvailable()) &&
        (await userCanUseWebSearch(await userModel.getUserById(userId)))
      ) {
        try {
          const { results } = await runPlannedWebSearch({
            message,
            session,
            userId,
            signal,
          });
          if (results.length > 0) {
            enhancedContent = buildWebSearchEnhancedContent(
              enhancedContent,
              results,
              message
            );
            hasRelevantContext = true;
            webSearchSources = results.map(({ title, url }) => ({
              title,
              url,
            }));
          }
        } catch (error) {
          throwIfChatGenerationCancelled(signal);
          logger.error('Web search failed; answering without it:', error);
        }
      }

      const preparedGeneration =
        await chatRequestService.prepareGenerationRequest({
          session,
          userId,
          options,
          persistedMessages: await chatService.getMessagesForContext(
            sessionId,
            userId,
            undefined,
            signal
          ),
          content: message,
          hasRelevantContext,
          enhancedContent,
          signal,
        });

      const generationResult = await chatGenerationService.executeNonStreaming({
        target: preparedGeneration.target,
        ollamaMessages: preparedGeneration.ollamaMessages,
        pluginMessages: preparedGeneration.pluginMessages,
        userId,
        pluginFallbackPolicy: 'allow',
        signal,
      });

      throwIfChatGenerationCancelled(signal);

      if (generationResult.pluginError) {
        logger.error(
          'Plugin failed, falling back to Ollama:',
          generationResult.pluginError
        );
      }

      // Add assistant response to session with statistics
      const statistics = extractStatistics(generationResult.response);
      const assistantMessage = await chatService.addMessage(
        sessionId,
        {
          role: 'assistant',
          content: generationResult.assistantContent,
          thinking: generationResult.assistantThinking,
          model: session.model,
          statistics,
          providerMetadata:
            webSearchSources?.length || documentContext.sources.length > 0
              ? {
                  ...(generationResult.response.message.providerMetadata ?? {}),
                  ...(webSearchSources?.length ? { webSearchSources } : {}),
                  ...(documentContext.sources.length > 0
                    ? { ragSources: documentContext.sources }
                    : {}),
                }
              : generationResult.response.message.providerMetadata,
        },
        userId,
        {
          assertPersistenceAllowed: () =>
            throwIfChatGenerationCancelled(signal),
        }
      );

      if (!assistantMessage) {
        res.status(500).json({
          success: false,
          error: 'Failed to add assistant message',
        });
        return;
      }

      res.json({
        success: true,
        data: assistantMessage,
      });
    } catch (error: unknown) {
      if (isChatGenerationCancelled(error, signal)) {
        if (!res.writableEnded) res.status(499).end();
        return;
      }
      res.status(error instanceof ChatProviderSelectionError ? 400 : 500).json({
        success: false,
        error: getErrorMessage(error, 'Failed to generate response'),
      });
    } finally {
      cleanup();
    }
  }
);

// Resume any persisted chat stream from any application replica. SQL is the
// ordered source of truth; Redis only wakes the subscriber after a commit.
router.post(
  '/sessions/:sessionId/generations',
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const sessionId = String(req.params.sessionId || '').trim();
    const userId = req.user?.userId || 'default';
    const message =
      typeof req.body?.message === 'string' ? req.body.message : '';
    const images = Array.isArray(req.body?.images)
      ? req.body.images.filter(
          (image: unknown): image is string =>
            typeof image === 'string' && image.length > 0
        )
      : undefined;
    const userMessageId =
      typeof req.body?.userMessageId === 'string'
        ? req.body.userMessageId.trim()
        : randomUUID();
    const assistantMessageId =
      typeof req.body?.assistantMessageId === 'string'
        ? req.body.assistantMessageId.trim()
        : randomUUID();
    const options =
      req.body?.options &&
      typeof req.body.options === 'object' &&
      !Array.isArray(req.body.options)
        ? (req.body.options as Record<string, unknown>)
        : {};
    const regenerate = req.body?.regenerate === true;
    const originalMessageId =
      typeof req.body?.originalMessageId === 'string'
        ? req.body.originalMessageId.trim()
        : undefined;
    if (
      !sessionId ||
      (!message.trim() && !images?.length) ||
      !userMessageId ||
      !assistantMessageId ||
      (regenerate && !originalMessageId)
    ) {
      res.status(400).json({
        success: false,
        error: 'Session, message, and message identifiers are required',
      });
      return;
    }

    let responseFinished = false;
    let prematureClose = req.aborted || res.destroyed;
    let queuedJobId: string | undefined;
    let disconnectCancellation: Promise<unknown> | undefined;
    const cancelCommittedJob = (): Promise<unknown> => {
      if (disconnectCancellation) return disconnectCancellation;
      disconnectCancellation = cancelChatGenerationByIdentity(
        userId,
        sessionId,
        assistantMessageId
      );
      return disconnectCancellation;
    };
    const onPrematureClose = (): void => {
      if (responseFinished) return;
      prematureClose = true;
      if (queuedJobId) {
        void cancelCommittedJob().catch(error =>
          logger.error('Failed to cancel disconnected chat generation:', error)
        );
      }
    };
    const cleanupCloseFence = (): void => {
      req.off('aborted', onPrematureClose);
      req.socket.off('close', onPrematureClose);
      res.off('close', onPrematureClose);
      res.off('finish', onResponseFinished);
    };
    const onResponseFinished = (): void => {
      responseFinished = true;
      cleanupCloseFence();
    };
    // Arm before enqueue: the SQL transaction may commit while the client
    // closes before receiving its 202. That close becomes cancellation intent
    // against the exact deterministic generation identity.
    req.once('aborted', onPrematureClose);
    req.socket.once('close', onPrematureClose);
    res.once('close', onPrematureClose);
    res.once('finish', onResponseFinished);
    try {
      const queued = await chatService.queueDurableGeneration({
        sessionId,
        userId,
        userMessageId,
        assistantMessageId,
        message,
        images,
        options,
        webSearch: req.body?.webSearch === true,
        tools: req.body?.tools === true,
        ...(req.body?.toolSelection
          ? {
              toolSelection: sanitizeRequestedToolSelection(
                req.body.toolSelection
              ),
            }
          : {}),
        regenerate,
        originalMessageId,
      });
      if (!queued) {
        cleanupCloseFence();
        res.status(404).json({ success: false, error: 'Session not found' });
        return;
      }
      queuedJobId = queued.jobId;
      if (
        prematureClose ||
        req.aborted ||
        req.socket.destroyed ||
        res.destroyed
      ) {
        prematureClose = true;
        await cancelCommittedJob();
        cleanupCloseFence();
        return;
      }
      res.status(202).json({
        success: true,
        data: {
          jobId: queued.jobId,
          userMessage: queued.userMessage,
          assistantMessageId,
          eventStream: `/api/chat/sessions/${encodeURIComponent(sessionId)}/events?generation=${encodeURIComponent(assistantMessageId)}`,
        },
      });
    } catch (error) {
      if (
        prematureClose ||
        req.aborted ||
        req.socket.destroyed ||
        res.destroyed
      ) {
        prematureClose = true;
        await cancelCommittedJob().catch(cancellationError =>
          logger.error(
            'Failed to resolve disconnected chat generation:',
            cancellationError
          )
        );
        cleanupCloseFence();
        return;
      }
      res.status(409).json({
        success: false,
        error: getErrorMessage(error, 'Unable to queue chat generation'),
      });
    }
  }
);

router.post(
  '/sessions/:sessionId/generations/:assistantMessageId/cancel',
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const sessionId = String(req.params.sessionId || '').trim();
    const assistantMessageId = String(
      req.params.assistantMessageId || ''
    ).trim();
    const userId = req.user?.userId || 'default';
    if (!sessionId || !assistantMessageId) {
      res.status(400).json({ success: false, error: 'Generation is required' });
      return;
    }
    if (!(await chatService.getSession(sessionId, userId))) {
      res.status(404).json({ success: false, error: 'Session not found' });
      return;
    }

    // This is one SQL decision: completion already committed, or cancellation
    // intent plus any existing natural-key job cancellation commit together.
    // When the job is not present yet, enqueue consumes the durable intent and
    // creates it directly in a terminal cancelled state.
    const decision = await cancelChatGenerationByIdentity(
      userId,
      sessionId,
      assistantMessageId
    );
    res.status(202).json({
      success: true,
      data:
        decision.outcome === 'completion-won'
          ? { completed: true }
          : decision.job
            ? { jobId: decision.job.id, state: decision.job.state }
            : { pending: true },
    });
  }
);

router.get(
  '/sessions/:sessionId/events',
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const sessionId = String(req.params.sessionId || '').trim();
    const userId = req.user?.userId || 'default';
    const generationId =
      typeof req.query.generation === 'string'
        ? req.query.generation.trim()
        : undefined;
    const afterValue =
      req.query.after ??
      (typeof req.get('Last-Event-ID') === 'string'
        ? req.get('Last-Event-ID')
        : undefined) ??
      0;
    const afterCursor = Number(afterValue);
    if (!Number.isSafeInteger(afterCursor) || afterCursor < 0) {
      res.status(400).json({ success: false, error: 'Invalid event cursor' });
      return;
    }
    if (!(await chatService.getSession(sessionId, userId))) {
      res.status(404).json({ success: false, error: 'Session not found' });
      return;
    }
    const generationJob = generationId
      ? await getDurableJobRuntime().service.getByIdempotency(
          userId,
          chatGenerationIdempotencyScope(sessionId),
          generationId
        )
      : null;
    if (generationId && !generationJob) {
      res.status(404).json({ success: false, error: 'Generation not found' });
      return;
    }

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const abort = new AbortController();
    let subscription:
      | Awaited<
          ReturnType<ReturnType<typeof getDurableEventGateway>['subscribe']>
        >
      | undefined;
    let heartbeat: NodeJS.Timeout | undefined;
    let heartbeatBusy = false;
    let terminal = false;
    const close = (): void => {
      abort.abort();
      if (heartbeat) clearInterval(heartbeat);
      void subscription?.close();
      if (!res.writableEnded && !res.destroyed) res.end();
    };
    res.once('close', close);
    try {
      subscription = await getDurableEventGateway().subscribe({
        afterCursor,
        streamId: chatStreamId(sessionId),
        ...(generationId ? { subjectId: generationId } : {}),
        batchSize: 100,
        maxReplayEvents: 10_000,
        signal: abort.signal,
        authorize: async () =>
          Boolean(await chatService.getSession(sessionId, userId)),
        onEvent: async event => {
          if (generationId && event.subjectId !== generationId) return;
          await writeChatSseFrame(res, event.cursor, event.payload);
          terminal =
            event.eventType === 'chat.done.v1' ||
            event.eventType === 'chat.error.v1';
          if (terminal) queueMicrotask(close);
        },
        onError: () => close(),
      });
      if (terminal) {
        close();
        return;
      }
      heartbeat = setInterval(() => {
        if (res.writableEnded || res.destroyed) {
          close();
          return;
        }
        if (heartbeatBusy) return;
        heartbeatBusy = true;
        void (async () => {
          if (generationJob) {
            const current = await getDurableJobRuntime().service.getMetadata(
              generationJob.id
            );
            if (
              current?.state === 'cancelled' ||
              current?.state === 'dead_letter'
            ) {
              await writeChatSseFrame(
                res,
                subscription?.cursor ?? afterCursor,
                {
                  type: 'error',
                  error:
                    current.state === 'cancelled'
                      ? 'Chat generation was cancelled'
                      : current.errorSummary || 'Chat generation failed',
                }
              );
              close();
              return;
            }
          }
          res.write(`: heartbeat ${Date.now()}\n\n`);
        })()
          .catch(close)
          .finally(() => {
            heartbeatBusy = false;
          });
      }, 15_000);
      heartbeat.unref?.();
    } catch {
      close();
    }
  }
);

// Generate a chat response with streaming
router.post(
  '/sessions/:sessionId/generate/stream',
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    if (rejectProcessLocalTeamGeneration(res)) return;
    const { controller, cleanup } = abortChatGenerationOnResponseClose(res);
    const signal = controller.signal;
    let emitDurable:
      ((payload: Record<string, unknown>) => Promise<void>) | undefined;
    try {
      const sessionId = req.params.sessionId as string;
      const { message, options = {} } = req.body;

      if (!message) {
        res.status(400).json({
          success: false,
          error: 'Message is required',
        });
        return;
      }
      const userId = req.user?.userId || 'default';
      const session = await chatService.getSession(sessionId, userId);
      if (!session) {
        res.status(404).json({
          success: false,
          error: 'Session not found',
        });
        return;
      }

      // Set up SSE headers
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('Access-Control-Allow-Origin', '*');

      // Event identity is a per-request nonce plus a monotonic sequence.
      // Deriving it from payload content silently deduplicated repeated
      // identical deltas out of the durable log and rejected payloads over
      // the identity component bound.
      let eventTail: Promise<{ cursor: number } | undefined> =
        Promise.resolve(undefined);
      let eventFailure: unknown;
      const requestNonce = randomUUID();
      let eventSequence = 0;
      emitDurable = async payload => {
        if (eventFailure) throw eventFailure;
        const type =
          payload.type === 'done'
            ? 'chat.done.v1'
            : payload.type === 'error'
              ? 'chat.error.v1'
              : 'chat.stream.v1';
        const occurrence = String(++eventSequence);
        const operation = eventTail.then(() =>
          getDurableEventGateway().append({
            eventId: durableEventId(
              'legacy-chat-route',
              sessionId,
              requestNonce,
              occurrence
            ),
            streamId: chatStreamId(sessionId),
            eventType: type,
            subjectId: sessionId,
            actorUserId: userId,
            payload: { mode: 'encrypted', value: payload },
          })
        );
        eventTail = operation.catch(error => {
          eventFailure = error;
          return undefined;
        });
        if (type === 'chat.stream.v1') {
          // The direct response is the transport of record for this route;
          // the durable append continues behind it so a slow event write
          // cannot throttle delivery.
          await writeChatSseFrame(res, 0, payload);
          return;
        }
        // Terminal events commit durably before the response settles so
        // `/events` replay consumers always observe an ordered terminal.
        const appended = await operation;
        await writeChatSseFrame(res, appended.cursor, payload);
      };

      // Add user message to session
      const userMessage = await chatService.addMessage(
        sessionId,
        {
          role: 'user',
          content: message,
        },
        userId
      );

      if (!userMessage) {
        await emitDurable({
          type: 'error',
          error: 'Failed to add user message',
        });
        res.end();
        return;
      }

      // Document context first, matching the WebSocket and non-stream
      // paths; search composes on top of it.
      let documentContext = EMPTY_CHAT_DOCUMENT_CONTEXT(message);
      try {
        documentContext = await buildChatDocumentContext(
          message,
          sessionId,
          userId,
          signal
        );
      } catch (contextError) {
        throwIfChatGenerationCancelled(signal);
        logger.error('Error during document search:', contextError);
      }

      // Requested web search runs before generation and reports its own
      // progress so the interface can show a searching state; failure
      // degrades to a normal reply.
      let webSearchSources: Array<{ title: string; url: string }> | undefined;
      let searchEnhancedContent: string | undefined;
      if (
        req.body?.webSearch === true &&
        (await isWebSearchAvailable()) &&
        (await userCanUseWebSearch(await userModel.getUserById(userId)))
      ) {
        await emitDurable({ type: 'search', status: 'searching' });
        try {
          const { results } = await runPlannedWebSearch({
            message,
            session,
            userId,
            signal,
          });
          if (results.length > 0) {
            searchEnhancedContent = buildWebSearchEnhancedContent(
              documentContext.enhancedContent,
              results,
              message
            );
            webSearchSources = results.map(({ title, url }) => ({
              title,
              url,
            }));
          }
          await emitDurable({
            type: 'search',
            status: 'done',
            sources: webSearchSources ?? [],
          });
        } catch (searchError) {
          throwIfChatGenerationCancelled(signal);
          logger.error('Web search failed; answering without it:', searchError);
          await emitDurable({
            type: 'search',
            status: 'failed',
            error: getErrorMessage(searchError, 'Web search failed.'),
          });
        }
      }
      const withSearchSources = (
        metadata: Record<string, unknown> | undefined
      ): Record<string, unknown> | undefined => {
        const extras: Record<string, unknown> = {};
        if (webSearchSources?.length) {
          extras.webSearchSources = webSearchSources;
        }
        if (documentContext.sources.length > 0) {
          extras.ragSources = documentContext.sources;
        }
        return Object.keys(extras).length > 0
          ? { ...(metadata ?? {}), ...extras }
          : metadata;
      };

      const preparedGeneration =
        await chatRequestService.prepareGenerationRequest({
          session,
          userId,
          options,
          persistedMessages: await chatService.getMessagesForContext(
            sessionId,
            userId,
            undefined,
            signal
          ),
          content: message,
          enhancedContent:
            searchEnhancedContent ?? documentContext.enhancedContent,
          hasRelevantContext: Boolean(
            searchEnhancedContent ?? documentContext.hasRelevantContext
          ),
          signal,
        });
      throwIfChatGenerationCancelled(signal);
      const {
        target,
        actualModelName,
        mergedOptions,
        activePlugin,
        ollamaMessages,
        pluginMessages,
        shouldStreamPlugin,
      } = preparedGeneration;

      const chatRequest = {
        model: actualModelName,
        messages: ollamaMessages,
        stream: true,
        options: mergedOptions as Record<string, unknown>,
      };

      let fullResponse = '';
      let fullThinking = '';
      let assistantProviderMetadata: Record<string, unknown> | undefined;
      // Token counts a provider reported, in either the streaming or the
      // non-streaming branch, so the statistics strip is not empty for them.
      let streamedUsage:
        { promptTokens?: number; completionTokens?: number } | undefined;
      let streamedTimings:
        { promptMs?: number; predictedMs?: number } | undefined;

      if (target.providerType === 'agent' && target.providerId) {
        for await (const chunk of agentCliService.executeAgentStreamRequest(
          target.providerId,
          pluginMessages,
          userId,
          { model: target.actualModelName, signal }
        )) {
          if (chunk.type === 'content' && chunk.content) {
            fullResponse += chunk.content;
            await emitDurable({
              type: 'chunk',
              content: chunk.content,
              done: false,
            });
          } else if (chunk.type === 'reasoning' && chunk.content) {
            fullThinking += chunk.content;
            await emitDurable({
              type: 'reasoning',
              content: chunk.content,
              done: false,
            });
          } else if (chunk.type === 'done' && chunk.providerMetadata) {
            assistantProviderMetadata = chunk.providerMetadata;
          }
        }

        throwIfChatGenerationCancelled(signal);

        if (fullResponse || fullThinking) {
          await chatService.addMessage(
            sessionId,
            {
              role: 'assistant',
              content: fullResponse,
              thinking: fullThinking || undefined,
              model: session.model,
              providerMetadata: withSearchSources(assistantProviderMetadata),
            },
            userId,
            {
              assertPersistenceAllowed: () =>
                throwIfChatGenerationCancelled(signal),
            }
          );
        }
        await emitDurable({ type: 'done' });
        res.end();
        return;
      }

      if (activePlugin) {
        if (shouldStreamPlugin) {
          const toolCalls: Array<{
            id: string;
            name: string;
            arguments: string;
          }> = [];
          for await (const chunk of pluginService.executePluginStreamRequest(
            actualModelName,
            pluginMessages,
            mergedOptions,
            userId,
            activePlugin.id,
            signal
          )) {
            if (chunk.type === 'content' && chunk.content) {
              fullResponse += chunk.content;
              await emitDurable({
                type: 'chunk',
                content: chunk.content,
                done: false,
              });
            } else if (chunk.type === 'reasoning' && chunk.content) {
              fullThinking += chunk.content;
              await emitDurable({
                type: 'reasoning',
                content: chunk.content,
                done: false,
              });
            } else if (chunk.type === 'tool_call' && chunk.toolCall) {
              toolCalls.push(chunk.toolCall);
            } else if (chunk.type === 'usage') {
              if (chunk.usage) {
                streamedUsage = { ...streamedUsage, ...chunk.usage };
              }
              if (chunk.timings) {
                streamedTimings = { ...streamedTimings, ...chunk.timings };
              }
            } else if (chunk.type === 'done') {
              if (chunk.doneReason?.startsWith('incomplete:')) {
                const reason =
                  chunk.doneReason.slice('incomplete:'.length) || 'unknown';
                throw new Error(
                  `Provider returned an incomplete response (${reason})`
                );
              }
              assistantProviderMetadata = chunk.providerMetadata
                ? {
                    ...assistantProviderMetadata,
                    ...chunk.providerMetadata,
                  }
                : assistantProviderMetadata;
            }
          }

          throwIfChatGenerationCancelled(signal);

          const toolContent = formatPluginStreamToolCalls(toolCalls);
          if (toolContent) {
            fullResponse += toolContent;
            await emitDurable({
              type: 'chunk',
              content: toolContent,
              done: false,
            });
          }
        } else {
          const generationResult =
            await chatGenerationService.executeNonStreaming({
              target,
              ollamaMessages,
              pluginMessages,
              userId,
              pluginFallbackPolicy: 'allow',
              signal,
            });
          fullResponse = generationResult.assistantContent;
          fullThinking = generationResult.assistantThinking || '';
          streamedUsage = {
            ...(generationResult.response.prompt_eval_count !== undefined
              ? { promptTokens: generationResult.response.prompt_eval_count }
              : {}),
            ...(generationResult.response.eval_count !== undefined
              ? { completionTokens: generationResult.response.eval_count }
              : {}),
          };
          assistantProviderMetadata =
            generationResult.response.message.providerMetadata;
          if (fullThinking) {
            await emitDurable({
              type: 'reasoning',
              content: fullThinking,
              done: false,
            });
          }
          await emitDurable({
            type: 'chunk',
            content: fullResponse,
            done: false,
          });
        }

        throwIfChatGenerationCancelled(signal);

        if (fullResponse || fullThinking) {
          await chatService.addMessage(
            sessionId,
            {
              role: 'assistant',
              content: fullResponse,
              thinking: fullThinking || undefined,
              model: session.model,
              providerMetadata: withSearchSources(assistantProviderMetadata),
              ...(streamedUsage?.promptTokens !== undefined ||
              streamedUsage?.completionTokens !== undefined
                ? {
                    statistics: {
                      ...(streamedUsage.promptTokens !== undefined
                        ? { prompt_eval_count: streamedUsage.promptTokens }
                        : {}),
                      ...(streamedUsage.completionTokens !== undefined
                        ? { eval_count: streamedUsage.completionTokens }
                        : {}),
                      ...(streamedTimings?.promptMs !== undefined
                        ? {
                            prompt_eval_duration:
                              streamedTimings.promptMs * 1e6,
                          }
                        : {}),
                      ...(streamedTimings?.predictedMs !== undefined
                        ? {
                            eval_duration: streamedTimings.predictedMs * 1e6,
                          }
                        : {}),
                      ...(streamedTimings?.promptMs !== undefined &&
                      streamedTimings?.predictedMs !== undefined
                        ? {
                            total_duration:
                              (streamedTimings.promptMs +
                                streamedTimings.predictedMs) *
                              1e6,
                          }
                        : {}),
                      ...(streamedUsage.completionTokens !== undefined &&
                      streamedTimings?.predictedMs
                        ? {
                            tokens_per_second:
                              Math.round(
                                (streamedUsage.completionTokens /
                                  (streamedTimings.predictedMs / 1000)) *
                                  100
                              ) / 100,
                          }
                        : {}),
                      model: session.model,
                    },
                  }
                : {}),
            },
            userId,
            {
              assertPersistenceAllowed: () =>
                throwIfChatGenerationCancelled(signal),
            }
          );
        }
        await emitDurable({ type: 'done' });
        res.end();
        return;
      }

      // Generate streaming response using Ollama
      await ollamaService.generateChatStreamResponse(
        chatRequest,
        chunk => {
          const thinkingDelta = chunk.message.thinking || '';
          if (thinkingDelta) {
            fullThinking += thinkingDelta;
            void emitDurable!({
              type: 'reasoning',
              content: thinkingDelta,
              done: false,
            }).catch(() => controller.abort());
          }

          void emitDurable!({
            type: 'chunk',
            content: chunk.message.content || '',
            done: chunk.done,
          }).catch(() => controller.abort());

          // Accumulate response content
          if (chunk.message.content) {
            fullResponse += chunk.message.content;
          }
        },
        error => {
          if (signal.aborted || res.writableEnded) return;
          void emitDurable!({ type: 'error', error: error.message })
            .catch(() => undefined)
            .finally(() => res.end());
        },
        () => {
          if (signal.aborted || res.writableEnded) return;
          void (async () => {
            if (fullResponse || fullThinking) {
              await chatService.addMessage(
                sessionId,
                {
                  role: 'assistant',
                  content: fullResponse,
                  thinking: fullThinking || undefined,
                  model: session.model,
                  providerMetadata: withSearchSources(undefined),
                },
                userId,
                {
                  assertPersistenceAllowed: () =>
                    throwIfChatGenerationCancelled(signal),
                }
              );
            }
            if (signal.aborted || res.writableEnded) return;
            await emitDurable!({ type: 'done' });
            res.end();
          })().catch(error => {
            if (signal.aborted || res.writableEnded) return;
            void emitDurable!({
              type: 'error',
              error: getErrorMessage(error, 'Failed to save response'),
            })
              .catch(() => undefined)
              .finally(() => res.end());
          });
        },
        signal,
        { userId }
      );
    } catch (error: unknown) {
      if (isChatGenerationCancelled(error, signal)) {
        if (!res.writableEnded) res.end();
        return;
      }
      if (!res.headersSent) {
        res
          .status(error instanceof ChatProviderSelectionError ? 400 : 500)
          .json({
            success: false,
            error: getErrorMessage(error, 'Failed to generate stream response'),
          });
        return;
      }
      if (emitDurable) {
        await emitDurable({
          type: 'error',
          error: getErrorMessage(error, 'Failed to generate stream response'),
        }).catch(() => undefined);
      }
      res.end();
    } finally {
      cleanup();
    }
  }
);

// Generate a title for a chat session based on the first message
router.post(
  '/sessions/:sessionId/generate-title',
  async (
    req: AuthenticatedRequest,
    res: Response<
      ApiResponse<{
        title: string;
        source: 'plugin' | 'ollama' | 'fallback';
        updatedAt: number;
      }>
    >
  ): Promise<void> => {
    try {
      const sessionId = req.params.sessionId as string;
      const { model, message, providerType, providerId } = req.body;

      if (!model) {
        res.status(400).json({
          success: false,
          error: 'Model is required for title generation',
        });
        return;
      }

      if (!message) {
        res.status(400).json({
          success: false,
          error: 'Message is required for title generation',
        });
        return;
      }

      const userId = req.user?.userId || 'default';
      const titleResult = await titleGenerationService.generateTitleForSession({
        sessionId,
        requestedModel: model,
        message,
        userId,
        providerType,
        providerId,
      });

      if (!titleResult) {
        res.status(404).json({
          success: false,
          error: 'Session not found',
        });
        return;
      }

      res.json({
        success: true,
        data: {
          title: titleResult.title,
          source: titleResult.source,
          updatedAt: titleResult.session.updatedAt,
        },
      });
    } catch (error: unknown) {
      res.status(error instanceof ChatProviderSelectionError ? 400 : 500).json({
        success: false,
        error: getErrorMessage(error, 'Failed to generate title'),
      });
    }
  }
);

// Session folders
router.get(
  '/folders',
  async (req: AuthenticatedRequest, res: Response<ApiResponse>) => {
    try {
      const userId = req.user?.userId || 'default';
      res.json({
        success: true,
        data: await chatService.getSessionFolders(userId),
      });
    } catch (error: unknown) {
      res.status(500).json({
        success: false,
        error: getErrorMessage(error, 'Failed to load folders'),
      });
    }
  }
);

router.post(
  '/folders',
  async (req: AuthenticatedRequest, res: Response<ApiResponse>) => {
    try {
      const { name } = req.body as { name?: unknown };
      const userId = req.user?.userId || 'default';
      res.json({
        success: true,
        data: await chatService.createSessionFolder(name, userId),
      });
    } catch (error: unknown) {
      sendSessionFolderError(res, error, 'Failed to create folder');
    }
  }
);

router.put(
  '/folders/:folderId',
  async (req: AuthenticatedRequest, res: Response<ApiResponse>) => {
    try {
      const { name } = req.body as { name?: unknown };
      const userId = req.user?.userId || 'default';
      const folder = await chatService.renameSessionFolder(
        req.params.folderId as string,
        name,
        userId
      );
      if (!folder) {
        res.status(404).json({ success: false, error: 'Folder not found' });
        return;
      }
      res.json({ success: true, data: folder });
    } catch (error: unknown) {
      sendSessionFolderError(res, error, 'Failed to rename folder');
    }
  }
);

router.delete(
  '/folders/:folderId',
  async (req: AuthenticatedRequest, res: Response<ApiResponse>) => {
    try {
      const userId = req.user?.userId || 'default';
      const deleted = await chatService.deleteSessionFolder(
        req.params.folderId as string,
        userId
      );
      if (!deleted) {
        res.status(404).json({ success: false, error: 'Folder not found' });
        return;
      }
      res.json({ success: true, message: 'Folder deleted' });
    } catch (error: unknown) {
      res.status(500).json({
        success: false,
        error: getErrorMessage(error, 'Failed to delete folder'),
      });
    }
  }
);

// Suggest follow-up messages for the latest exchange in a session
router.post(
  '/sessions/:sessionId/followups',
  async (
    req: AuthenticatedRequest,
    res: Response<ApiResponse<{ suggestions: string[] }>>
  ): Promise<void> => {
    try {
      const sessionId = req.params.sessionId as string;
      const userId = req.user?.userId || 'default';

      const suggestions = await followUpService.generateFollowUpsForSession(
        sessionId,
        userId
      );

      if (suggestions === null) {
        res.status(404).json({
          success: false,
          error: 'Session not found',
        });
        return;
      }

      res.json({
        success: true,
        data: { suggestions },
      });
    } catch (error: unknown) {
      res.status(500).json({
        success: false,
        error: getErrorMessage(error, 'Failed to generate follow-ups'),
      });
    }
  }
);

/**
 * Switch to a different branch of a message
 * POST /api/chat/sessions/:sessionId/messages/:messageId/branch
 */
router.post(
  '/sessions/:sessionId/messages/:messageId/branch',
  authenticate,
  chatRateLimiter,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const sessionId = req.params.sessionId as string;
      const messageId = req.params.messageId as string;
      const { branchIndex } = req.body;
      const userId = req.user?.userId || 'default';

      if (typeof branchIndex !== 'number') {
        res.status(400).json({
          success: false,
          error: 'branchIndex is required and must be a number',
        });
        return;
      }

      const updatedMessage = await chatService.switchMessageBranch(
        sessionId,
        messageId,
        branchIndex,
        userId
      );

      if (!updatedMessage) {
        res.status(404).json({
          success: false,
          error: 'Message or branch not found',
        });
        return;
      }

      // Return the updated session
      const session = await chatService.getSession(sessionId, userId);
      res.json({
        success: true,
        data: session,
      });
    } catch (error) {
      logger.error('Switch branch error:', error);
      res.status(500).json({
        success: false,
        error: getErrorMessage(error, 'Failed to switch branch'),
      });
    }
  }
);

/**
 * Get all branches for a message
 * GET /api/chat/sessions/:sessionId/messages/:messageId/branches
 */
router.get(
  '/sessions/:sessionId/messages/:messageId/branches',
  authenticate,
  chatRateLimiter,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const sessionId = req.params.sessionId as string;
      const messageId = req.params.messageId as string;
      const userId = req.user?.userId || 'default';

      const branches = await chatService.getMessageBranches(
        sessionId,
        messageId,
        userId
      );

      res.json({
        success: true,
        data: branches,
      });
    } catch (error) {
      logger.error('Get branches error:', error);
      res.status(500).json({
        success: false,
        error: getErrorMessage(error, 'Failed to get branches'),
      });
    }
  }
);

/**
 * Create a new branch for a message (for regeneration)
 * POST /api/chat/sessions/:sessionId/messages/:messageId/branches
 */
router.post(
  '/sessions/:sessionId/messages/:messageId/branches',
  authenticate,
  chatRateLimiter,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const sessionId = req.params.sessionId as string;
      const messageId = req.params.messageId as string;
      const userId = req.user?.userId || 'default';
      const messageData = req.body;

      if (!messageData || !messageData.role || !messageData.content) {
        res.status(400).json({
          success: false,
          error: 'Message data with role and content is required',
        });
        return;
      }

      const newBranch = await chatService.createMessageBranch(
        sessionId,
        messageId,
        messageData,
        userId
      );

      if (!newBranch) {
        res.status(404).json({
          success: false,
          error: 'Failed to create branch - session or message not found',
        });
        return;
      }

      res.json({
        success: true,
        data: newBranch,
      });
    } catch (error) {
      logger.error('Create branch error:', error);
      res.status(500).json({
        success: false,
        error: getErrorMessage(error, 'Failed to create branch'),
      });
    }
  }
);

/**
 * Undo one compaction: the summary knows exactly which messages it replaced,
 * so restoring is reactivating them and removing the summary.
 */
router.post(
  '/sessions/:sessionId/compaction/:messageId/restore',
  authenticate,
  chatRateLimiter,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const sessionId = req.params.sessionId as string;
      const messageId = req.params.messageId as string;
      const userId = req.user?.userId || 'default';

      const session = await chatService.restoreCompaction(
        sessionId,
        userId,
        messageId
      );
      if (!session) {
        res.status(404).json({
          success: false,
          error: 'No restorable summary with that id in this session',
        });
        return;
      }

      res.json({ success: true, data: session });
    } catch (error) {
      logger.error('Restore compaction error:', error);
      res.status(500).json({
        success: false,
        error: getErrorMessage(error, 'Failed to restore compacted messages'),
      });
    }
  }
);

/**
 * The rolling window every conversation runs with, for any signed-in user:
 * the context meter needs the real message count to mirror what is sent.
 * Deliberately narrow — none of the admin compaction configuration (prompt,
 * model, thresholds) leaves this endpoint.
 */
router.get('/context-policy', async (_req, res) => {
  try {
    const compaction = await getCompactionConfig();
    res.json({
      success: true,
      data: {
        windowMessages: compaction.enabled
          ? Math.max(10, compaction.keepRecentMessages)
          : 10,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: getErrorMessage(error, 'Failed to load context policy'),
    });
  }
});

/** Context compaction settings: admin-only in both directions — the custom
 * summarizer prompt is administrator configuration, not user data. */
router.get('/compaction-config', requireAdmin, async (_req, res) => {
  try {
    res.json({ success: true, data: await getCompactionConfig() });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: getErrorMessage(error, 'Failed to load compaction settings'),
    });
  }
});

router.put('/compaction-config', requireAdmin, async (req, res) => {
  try {
    const { enabled, thresholdTokens, keepRecentMessages, model, prompt } =
      req.body ?? {};
    const data = await setCompactionConfig({
      ...(typeof enabled === 'boolean' ? { enabled } : {}),
      ...(typeof thresholdTokens === 'number' ? { thresholdTokens } : {}),
      ...(typeof keepRecentMessages === 'number' ? { keepRecentMessages } : {}),
      ...(typeof model === 'string' ? { model } : {}),
      ...(typeof prompt === 'string' ? { prompt } : {}),
    });
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: getErrorMessage(error, 'Failed to update compaction settings'),
    });
  }
});

export default router;
