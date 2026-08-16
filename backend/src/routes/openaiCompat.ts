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
 * OpenAI-compatible API (`/v1`).
 *
 * Lets standard OpenAI SDKs and tools talk to Libre WebUI with a scoped
 * personal API key (`lwk_…`) as the bearer token. Requests route through
 * the same provider selection as Chat — a model name resolves to local
 * Ollama or to one of the caller's active provider connections — without
 * touching any stored conversation: completions here are one-shot and
 * nothing is persisted.
 *
 * Supported today: `GET /v1/models` and `POST /v1/chat/completions`
 * (streaming and non-streaming, text content only). Provider failures are
 * surfaced as OpenAI-style error objects instead of falling back silently.
 */

import express from 'express';
import { randomUUID } from 'node:crypto';
import rateLimit from '../middleware/sharedRateLimit.js';
import { authenticate, AuthenticatedRequest } from '../middleware/auth.js';
import chatGenerationService from '../services/chatGenerationService.js';
import { ChatRequestService } from '../services/chatRequestService.js';
import pluginService from '../services/pluginService.js';
import agentCliService from '../services/agentCliService.js';
import ollamaService from '../services/ollamaService.js';
import { listChatModels } from '../services/modelCatalogService.js';
import type { ChatContextMessage } from '../utils/chatContext.js';
import type { OllamaChatResponse } from '../types/index.js';
import { createLogger } from '../utils/logger.js';

const router = express.Router();
const logger = createLogger('openai-compat-routes');

const compatRateLimiter = rateLimit({
  keyPrefix: 'openai-compat',
  windowMs: 5 * 60 * 1000,
  max: 600,
  message: {
    error: {
      message: 'Too many requests, please try again later',
      type: 'rate_limit_error',
      code: 'rate_limit_exceeded',
    },
  },
  standardHeaders: true,
  legacyHeaders: false,
});

router.use(compatRateLimiter, authenticate);

// No persona/preferences dependencies: /v1 requests carry their own full
// context and must not be rewritten by the caller's vision-model preference.
const chatRequestService = new ChatRequestService({ chatGenerationService });

interface OpenAiErrorBody {
  error: {
    message: string;
    type: string;
    code: string | null;
  };
}

const openAiError = (
  res: express.Response,
  status: number,
  message: string,
  type = 'invalid_request_error',
  code: string | null = null
): void => {
  const body: OpenAiErrorBody = { error: { message, type, code } };
  if (!res.headersSent) {
    res.status(status).json(body);
    return;
  }
  if (!res.writableEnded) {
    res.write(`data: ${JSON.stringify(body)}\n\n`);
    res.end();
  }
};

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

/** GET /v1/models — every chat-capable model the caller can use. */
router.get('/models', async (req: AuthenticatedRequest, res) => {
  try {
    const models = await listChatModels(req.user!.userId);
    res.json({
      object: 'list',
      data: models.map(model => ({
        id: model.id,
        object: 'model',
        created: nowSeconds(),
        owned_by: model.ownedBy,
      })),
    });
  } catch (error) {
    logger.error('Model listing failed:', error);
    openAiError(res, 500, 'The model list is unavailable', 'server_error');
  }
});

interface IncomingMessage {
  role: string;
  content: unknown;
}

/** Flatten OpenAI content (string or part array) to plain text. */
const flattenContent = (content: unknown): string | null => {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const part of content) {
      if (part && typeof part === 'object') {
        const typed = part as { type?: unknown; text?: unknown };
        if (typed.type === 'text' && typeof typed.text === 'string') {
          parts.push(typed.text);
          continue;
        }
        // Non-text parts (images, audio) are not supported on this surface.
        return null;
      }
      return null;
    }
    return parts.join('');
  }
  if (content === null || content === undefined) return '';
  return null;
};

const parseMessages = (
  raw: unknown
):
  | { messages: Array<{ role: string; content: string }> }
  | { error: string } => {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { error: "'messages' must be a non-empty array" };
  }
  const messages: Array<{ role: string; content: string }> = [];
  for (const item of raw as IncomingMessage[]) {
    if (!item || typeof item !== 'object' || typeof item.role !== 'string') {
      return { error: 'Every message needs a role' };
    }
    if (!['system', 'user', 'assistant'].includes(item.role)) {
      return {
        error: `Unsupported message role '${item.role}'; supported roles are system, user, and assistant`,
      };
    }
    const content = flattenContent(item.content);
    if (content === null) {
      return {
        error:
          'Only text content is supported on this endpoint; image and audio parts are not',
      };
    }
    messages.push({ role: item.role, content });
  }
  return { messages };
};

const numberOption = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

/** POST /v1/chat/completions — one-shot, nothing persisted. */
router.post('/chat/completions', async (req: AuthenticatedRequest, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const model = typeof body.model === 'string' ? body.model.trim() : '';
  if (!model) {
    openAiError(res, 400, "'model' is required");
    return;
  }
  const parsed = parseMessages(body.messages);
  if ('error' in parsed) {
    openAiError(res, 400, parsed.error);
    return;
  }
  const stream = body.stream === true;
  const includeUsage =
    stream &&
    Boolean(
      (body.stream_options as { include_usage?: unknown } | undefined)
        ?.include_usage === true
    );

  const controller = new AbortController();
  res.on('close', () => controller.abort(new Error('client disconnected')));

  const userId = req.user!.userId;
  const completionId = `chatcmpl-${randomUUID()}`;
  const created = nowSeconds();

  try {
    const last = parsed.messages[parsed.messages.length - 1];
    const regenerate = last.role !== 'user';
    const history: ChatContextMessage[] = (
      regenerate ? parsed.messages : parsed.messages.slice(0, -1)
    ).map(message => ({
      role: message.role as ChatContextMessage['role'],
      content: message.content,
    }));

    const options = {
      ...(numberOption(body.temperature) !== undefined
        ? { temperature: numberOption(body.temperature) }
        : {}),
      ...(numberOption(body.top_p) !== undefined
        ? { top_p: numberOption(body.top_p) }
        : {}),
      ...(numberOption(body.max_tokens) !== undefined
        ? { num_predict: numberOption(body.max_tokens) }
        : {}),
      ...(numberOption(body.max_completion_tokens) !== undefined
        ? { num_predict: numberOption(body.max_completion_tokens) }
        : {}),
      ...(typeof body.stop === 'string'
        ? { stop: [body.stop] }
        : Array.isArray(body.stop)
          ? {
              stop: (body.stop as unknown[]).filter(
                (item): item is string => typeof item === 'string'
              ),
            }
          : {}),
    };

    const prepared = await chatRequestService.prepareGenerationRequest({
      session: { model },
      userId,
      options,
      isPrivate: true,
      persistedMessages: [],
      messageHistory: history,
      regenerate,
      content: regenerate ? '' : last.content,
      includePersonaPrompt: false,
      signal: controller.signal,
    });
    const target = prepared.target;

    if (!stream) {
      const result = await chatGenerationService.executeNonStreaming({
        target,
        ollamaMessages: prepared.ollamaMessages,
        pluginMessages: prepared.pluginMessages,
        userId,
        signal: controller.signal,
      });
      const promptTokens = result.response.prompt_eval_count;
      const completionTokens = result.response.eval_count;
      res.json({
        id: completionId,
        object: 'chat.completion',
        created,
        model,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: result.assistantContent,
              ...(result.assistantThinking
                ? { reasoning_content: result.assistantThinking }
                : {}),
            },
            finish_reason: 'stop',
          },
        ],
        ...(typeof promptTokens === 'number' ||
        typeof completionTokens === 'number'
          ? {
              usage: {
                prompt_tokens: promptTokens ?? 0,
                completion_tokens: completionTokens ?? 0,
                total_tokens: (promptTokens ?? 0) + (completionTokens ?? 0),
              },
            }
          : {}),
      });
      return;
    }

    // Streaming: OpenAI chunk frames ending with `data: [DONE]`.
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const sendChunk = (
      delta: Record<string, unknown>,
      finishReason: string | null,
      usage?: Record<string, number>
    ): void => {
      if (res.writableEnded) return;
      res.write(
        `data: ${JSON.stringify({
          id: completionId,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [{ index: 0, delta, finish_reason: finishReason }],
          ...(usage ? { usage } : {}),
        })}\n\n`
      );
    };

    sendChunk({ role: 'assistant' }, null);

    let promptTokens: number | undefined;
    let completionTokens: number | undefined;

    if (target.providerType === 'agent' && target.providerId) {
      for await (const chunk of agentCliService.executeAgentStreamRequest(
        target.providerId,
        prepared.pluginMessages,
        userId,
        { model: target.actualModelName, signal: controller.signal }
      )) {
        if (chunk.type === 'content' && chunk.content) {
          sendChunk({ content: chunk.content }, null);
        } else if (chunk.type === 'reasoning' && chunk.content) {
          sendChunk({ reasoning_content: chunk.content }, null);
        }
      }
    } else if (target.activePlugin) {
      for await (const chunk of pluginService.executePluginStreamRequest(
        target.actualModelName,
        prepared.pluginMessages,
        target.mergedOptions,
        userId,
        target.activePlugin.id,
        controller.signal
      )) {
        if (chunk.type === 'content' && chunk.content) {
          sendChunk({ content: chunk.content }, null);
        } else if (chunk.type === 'reasoning' && chunk.content) {
          sendChunk({ reasoning_content: chunk.content }, null);
        } else if (chunk.type === 'usage') {
          promptTokens = chunk.usage.promptTokens ?? promptTokens;
          completionTokens = chunk.usage.completionTokens ?? completionTokens;
        } else if (chunk.type === 'done') {
          if (chunk.doneReason?.startsWith('incomplete:')) {
            throw new Error(
              `The provider returned an incomplete response (${chunk.doneReason})`
            );
          }
        }
      }
    } else {
      await new Promise<void>((resolve, reject) => {
        void ollamaService.generateChatStreamResponse(
          {
            model: target.actualModelName,
            messages: prepared.ollamaMessages,
            stream: true,
            options: target.mergedOptions as Record<string, unknown>,
          },
          (chunk: OllamaChatResponse) => {
            if (chunk.message?.content) {
              sendChunk({ content: chunk.message.content }, null);
            }
            if (chunk.message?.thinking) {
              sendChunk({ reasoning_content: chunk.message.thinking }, null);
            }
            if (chunk.done) {
              promptTokens = chunk.prompt_eval_count ?? promptTokens;
              completionTokens = chunk.eval_count ?? completionTokens;
            }
          },
          reject,
          resolve,
          controller.signal,
          { userId }
        );
      });
    }

    sendChunk(
      {},
      'stop',
      includeUsage
        ? {
            prompt_tokens: promptTokens ?? 0,
            completion_tokens: completionTokens ?? 0,
            total_tokens: (promptTokens ?? 0) + (completionTokens ?? 0),
          }
        : undefined
    );
    if (!res.writableEnded) {
      res.write('data: [DONE]\n\n');
      res.end();
    }
  } catch (error) {
    if (controller.signal.aborted) {
      if (!res.writableEnded) res.end();
      return;
    }
    const message =
      error instanceof Error ? error.message : 'Generation failed';
    logger.error('Chat completion failed:', error);
    openAiError(res, 502, message, 'server_error', 'generation_failed');
  }
});

export default router;
