/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
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
 * The public OpenAI-compatible API (API-01): `GET /v1/models` and
 * `POST /v1/chat/completions`, stateless by design. Callers authenticate
 * with a scoped API token (or an ordinary session) and are governed by the
 * per-token rate limits; conversations are the caller's to keep. Stateful
 * chats, tools, and replayable events remain on the native `/api/chat`
 * event API.
 */

import express, { Response } from 'express';
import { randomUUID } from 'node:crypto';
import { authenticate, AuthenticatedRequest } from '../middleware/auth.js';
import chatGenerationService from '../services/chatGenerationService.js';
import ollamaService from '../services/ollamaService.js';
import pluginService from '../services/pluginService.js';
import type {
  ChatMessage,
  GenerationOptions,
  OllamaChatMessage,
} from '../types/index.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('routes:openai-compat');

const router = express.Router();
router.use(authenticate);

const MAX_COMPLETION_MESSAGES = 200;
const MAX_MESSAGE_CONTENT_CHARS = 200_000;

const sendError = (
  res: Response,
  status: number,
  message: string,
  type = 'invalid_request_error'
): void => {
  res.status(status).json({ error: { message, type, code: null } });
};

const userIdOf = (req: AuthenticatedRequest): string =>
  req.user?.userId || 'default';

router.get('/models', async (req: AuthenticatedRequest, res) => {
  try {
    const userId = userIdOf(req);
    const models: Array<{ id: string; owned_by: string }> = [];
    try {
      for (const model of await ollamaService.getModels()) {
        models.push({ id: model.name, owned_by: 'ollama' });
      }
    } catch {
      // A missing local Ollama simply contributes no models.
    }
    for (const plugin of await pluginService.getActivePlugins(userId)) {
      if (plugin.type !== 'chat' && plugin.type !== 'completion') continue;
      for (const model of plugin.model_map) {
        models.push({ id: model, owned_by: plugin.id });
      }
    }
    const created = Math.floor(Date.now() / 1000);
    res.json({
      object: 'list',
      data: models.map(model => ({
        id: model.id,
        object: 'model',
        created,
        owned_by: model.owned_by,
      })),
    });
  } catch (error) {
    logger.error('Model listing failed:', error);
    sendError(res, 500, 'Failed to list models', 'server_error');
  }
});

interface CompletionRequestMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

const readMessages = (value: unknown): CompletionRequestMessage[] | string => {
  if (!Array.isArray(value) || value.length === 0) {
    return 'messages must be a non-empty array';
  }
  if (value.length > MAX_COMPLETION_MESSAGES) {
    return `messages may hold at most ${MAX_COMPLETION_MESSAGES} entries`;
  }
  const messages: CompletionRequestMessage[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') return 'messages are invalid';
    const { role, content } = entry as { role?: unknown; content?: unknown };
    if (role !== 'system' && role !== 'user' && role !== 'assistant') {
      return 'message roles must be system, user, or assistant';
    }
    // Multimodal content arrays: keep the text parts.
    let text: string;
    if (typeof content === 'string') text = content;
    else if (Array.isArray(content)) {
      text = content
        .map(part =>
          part &&
          typeof part === 'object' &&
          (part as { type?: unknown }).type === 'text' &&
          typeof (part as { text?: unknown }).text === 'string'
            ? ((part as { text: string }).text as string)
            : ''
        )
        .join('');
    } else return 'message content must be a string';
    if (text.length > MAX_MESSAGE_CONTENT_CHARS) {
      return 'message content is too long';
    }
    messages.push({ role, content: text });
  }
  return messages;
};

const readSamplingOptions = (
  body: Record<string, unknown>
): GenerationOptions | string => {
  const options: Record<string, unknown> = {};
  const numeric = (name: string, min: number, max: number): string | null => {
    const value = body[name];
    if (value === undefined || value === null) return null;
    if (typeof value !== 'number' || value < min || value > max) {
      return `${name} must be a number between ${min} and ${max}`;
    }
    return null;
  };
  for (const [name, min, max, mapped] of [
    ['temperature', 0, 2, 'temperature'],
    ['top_p', 0, 1, 'top_p'],
    ['max_tokens', 1, 1_000_000, 'num_predict'],
    ['max_completion_tokens', 1, 1_000_000, 'num_predict'],
    ['seed', -2_147_483_648, 2_147_483_647, 'seed'],
  ] as const) {
    const problem = numeric(name, min, max);
    if (problem) return problem;
    if (body[name] !== undefined && body[name] !== null) {
      options[mapped] = body[name];
    }
  }
  const stop = body.stop;
  if (typeof stop === 'string') options.stop = [stop];
  else if (Array.isArray(stop)) {
    if (!stop.every(entry => typeof entry === 'string') || stop.length > 8) {
      return 'stop must be a string or up to 8 strings';
    }
    if (stop.length > 0) options.stop = stop;
  } else if (stop !== undefined && stop !== null) {
    return 'stop must be a string or an array of strings';
  }
  return options as GenerationOptions;
};

router.post('/chat/completions', async (req: AuthenticatedRequest, res) => {
  const controller = new AbortController();
  const abort = () => {
    if (!controller.signal.aborted) {
      controller.abort(new Error('The API client disconnected'));
    }
  };
  req.once('aborted', abort);
  res.once('close', () => {
    if (!res.writableEnded) abort();
  });
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const model = body.model;
    if (typeof model !== 'string' || !model.trim() || model.length > 200) {
      sendError(res, 400, 'model is required');
      return;
    }
    const messages = readMessages(body.messages);
    if (typeof messages === 'string') {
      sendError(res, 400, messages);
      return;
    }
    const options = readSamplingOptions(body);
    if (typeof options === 'string') {
      sendError(res, 400, options);
      return;
    }
    const stream = body.stream === true;
    const userId = userIdOf(req);

    let target;
    try {
      target = await chatGenerationService.prepareGenerationTarget(
        model.trim(),
        userId,
        options as Record<string, unknown>,
        undefined,
        controller.signal
      );
    } catch (error) {
      sendError(
        res,
        404,
        `The model "${model}" is not available: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
        'invalid_request_error'
      );
      return;
    }

    const ollamaMessages: OllamaChatMessage[] = messages.map(message => ({
      role: message.role,
      content: message.content,
    }));
    const timestamp = Date.now();
    const pluginMessages: ChatMessage[] = messages.map((message, index) => ({
      id: `v1-${index}`,
      role: message.role,
      content: message.content,
      timestamp,
    }));

    const completionId = `chatcmpl-${randomUUID()}`;
    const created = Math.floor(timestamp / 1000);

    if (!stream) {
      const result = await chatGenerationService.executeNonStreaming({
        target,
        ollamaMessages,
        pluginMessages,
        userId,
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      const statistics = result.response;
      const promptTokens = statistics.prompt_eval_count ?? 0;
      const completionTokens = statistics.eval_count ?? 0;
      res.json({
        id: completionId,
        object: 'chat.completion',
        created,
        model: target.actualModelName,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: result.assistantContent,
            },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: promptTokens + completionTokens,
        },
      });
      return;
    }

    // Streaming: OpenAI-style SSE chunk frames ending with [DONE].
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
    const writeChunk = (delta: Record<string, unknown>, finish?: string) => {
      if (res.writableEnded) return;
      res.write(
        `data: ${JSON.stringify({
          id: completionId,
          object: 'chat.completion.chunk',
          created,
          model: target.actualModelName,
          choices: [{ index: 0, delta, finish_reason: finish ?? null }],
        })}\n\n`
      );
    };
    writeChunk({ role: 'assistant' });
    try {
      if (target.activePlugin) {
        for await (const chunk of pluginService.executePluginStreamRequest(
          target.actualModelName,
          pluginMessages,
          target.mergedOptions as GenerationOptions,
          userId,
          target.activePlugin.id,
          controller.signal
        )) {
          if (chunk.type === 'content' && chunk.content) {
            writeChunk({ content: chunk.content });
          }
        }
      } else {
        await ollamaService.generateChatStreamResponse(
          {
            model: target.actualModelName,
            messages: ollamaMessages,
            stream: true,
            options: target.mergedOptions as Record<string, unknown>,
          },
          chunk => {
            if (chunk.message?.content) {
              writeChunk({ content: chunk.message.content });
            }
          },
          error => {
            throw error;
          },
          () => undefined,
          controller.signal,
          { userId }
        );
      }
      writeChunk({}, 'stop');
      res.write('data: [DONE]\n\n');
      res.end();
    } catch (error) {
      if (controller.signal.aborted) {
        res.end();
        return;
      }
      logger.error('Streaming completion failed:', error);
      if (!res.writableEnded) {
        res.write(
          `data: ${JSON.stringify({
            error: {
              message:
                error instanceof Error ? error.message : 'generation failed',
              type: 'server_error',
              code: null,
            },
          })}\n\n`
        );
        res.end();
      }
    }
  } catch (error) {
    if (controller.signal.aborted) return;
    logger.error('Chat completion failed:', error);
    if (!res.headersSent) {
      sendError(
        res,
        500,
        error instanceof Error ? error.message : 'generation failed',
        'server_error'
      );
    }
  }
});

export default router;
