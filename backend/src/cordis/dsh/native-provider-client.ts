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

import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import path from 'node:path';
import { BlockAssembler, type StreamChunk } from '@deepseek-ai/dsh-llm';
import {
  createAssistantMessage,
  createSystemMessage,
  createToolResultMessage,
  createUserMessage,
} from '@deepseek-ai/dsh-llm/message';
import type {
  OllamaChatRequest,
  OllamaChatResponse,
} from '../../types/index.js';
import type { WorkModelStreamObserver } from '../../services/workModelProviderService.js';
import type { NativeDshUsageEventInput } from '../../services/pluginUsageService.js';
import { createLogger } from '../../utils/logger.js';
import type { BridgeCall, BridgeEvent } from './librewebui-llm-adapter.js';
import {
  parseNativeProviderCatalog,
  parseNativeProviderChunk,
  parseNativeProviderRequest,
  type NativeProviderCatalog,
  type NativeProviderModel,
  type NativeProviderRequest,
} from './native-provider-protocol.js';

export type NativeDshModel = NativeProviderModel;
export interface NativeDshCatalog {
  status: 'disabled' | 'unavailable' | 'ready';
  models: NativeDshModel[];
}

const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const MAX_STREAM_BYTES = 128 * 1024 * 1024;
const CATALOG_TIMEOUT_MS = 10_000;
const GENERATION_TIMEOUT_MS = 10 * 60_000;
const logger = createLogger('native-dsh-provider');

interface NativeProviderDependencies {
  socketPath(): string | undefined | Promise<string | undefined>;
  authorize(userId: string): Promise<boolean>;
  recordUsage?(usage: NativeDshUsageEventInput): Promise<void> | void;
  assertUsageAllowed?(
    input: Pick<NativeDshUsageEventInput, 'userId' | 'providerId' | 'model'>
  ): Promise<void> | void;
}

const defaultDependencies: NativeProviderDependencies = {
  async socketPath() {
    const { cordisRuntimeConfig } = await import('../runtime.js');
    return cordisRuntimeConfig().nativeProvider?.socketPath;
  },
  async authorize(userId) {
    const [{ userModel }, { isCordisBridgeEnabled }] = await Promise.all([
      import('../../models/userModel.js'),
      import('../runtime.js'),
    ]);
    const user = await userModel.getUserById(userId);
    return (
      user?.role === 'admin' &&
      user.status === 'active' &&
      (await isCordisBridgeEnabled())
    );
  },
};

/** The socket is a local capability owned by the same OS account as LWUI. */
export async function verifyNativeProviderSocket(
  socketPath: string
): Promise<void> {
  if (!process.getuid || !path.isAbsolute(socketPath))
    throw new Error('Native DSH providers require a local Unix socket.');
  const directory = path.dirname(socketPath);
  const [parent, socket, canonicalDirectory] = await Promise.all([
    lstat(directory),
    lstat(socketPath),
    realpath(directory),
  ]);
  const uid = process.getuid();
  if (
    canonicalDirectory !== directory ||
    !parent.isDirectory() ||
    parent.uid !== uid ||
    (parent.mode & 0o777) !== 0o700 ||
    !socket.isSocket() ||
    socket.uid !== uid ||
    (socket.mode & 0o777) !== 0o600
  )
    throw new Error(
      'The native DSH provider socket must be private to this OS account.'
    );
}

async function openRequest(
  socketPath: string,
  endpoint: '/catalog' | '/generate',
  payload: unknown,
  signal: AbortSignal,
  onDispatch?: () => void
): Promise<IncomingMessage> {
  signal.throwIfAborted();
  await verifyNativeProviderSocket(socketPath);
  signal.throwIfAborted();
  const body = JSON.stringify(payload);
  if (Buffer.byteLength(body) > MAX_REQUEST_BYTES)
    throw new Error('The native DSH request exceeds its size limit.');
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        socketPath,
        path: endpoint,
        method: 'POST',
        agent: false,
        signal,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      response => {
        if (response.statusCode !== 200) {
          // Never reflect a remote provider's raw diagnostic or credentials.
          response.destroy();
          reject(
            new Error(
              `Native DSH provider request failed (${response.statusCode}).`
            )
          );
        } else resolve(response);
      }
    );
    request.once('error', reject);
    onDispatch?.();
    request.end(body);
  });
}

function plainObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function toNativeRequest(
  call: BridgeCall,
  providerId: string,
  instanceId: string
): NativeProviderRequest {
  return parseNativeProviderRequest({
    provider: providerId,
    model: call.model,
    messages: call.messages.map(message => {
      if (message.role === 'system')
        return createSystemMessage(message.content, 'libre-webui');
      if (message.role === 'tool') {
        if (!message.toolCallId)
          throw new Error('Native DSH tool results require a call ID.');
        return createToolResultMessage({
          callId: message.toolCallId as never,
          content: [{ type: 'text', text: message.content }],
          isError: false,
        });
      }
      if (message.role === 'assistant') {
        const saved = plainObject(message.providerMetadata?.nativeDsh);
        return createAssistantMessage({
          content: [
            ...(message.thinking
              ? [{ type: 'reasoning' as const, text: message.thinking }]
              : []),
            ...(message.content
              ? [{ type: 'text' as const, text: message.content }]
              : []),
            ...(message.toolCalls ?? []).map(tool => ({
              type: 'tool-call' as const,
              id: tool.id as never,
              name: tool.name,
              arguments: tool.arguments,
            })),
          ],
          source: {
            provider:
              typeof saved?.provider === 'string' ? saved.provider : providerId,
            model: typeof saved?.model === 'string' ? saved.model : call.model,
            ...(saved?.replayState &&
            saved.instanceId === instanceId &&
            saved.provider === providerId &&
            saved.model === call.model
              ? { replayState: saved.replayState }
              : {}),
          },
        });
      }
      return createUserMessage({
        content: [{ type: 'text', text: message.content }],
        source: { kind: 'user' },
      });
    }),
    ...(call.tools?.length ? { tools: call.tools } : {}),
    ...(call.temperature === undefined
      ? {}
      : { temperature: call.temperature }),
    ...(call.maxTokens === undefined ? {} : { maxTokens: call.maxTokens }),
    ...(call.stop?.length ? { stop: call.stop } : {}),
    ...(call.reasoningEffort ? { reasoningEffort: call.reasoningEffort } : {}),
    ...(call.purpose ? { purpose: call.purpose } : {}),
  });
}

/** Only provider inference crosses this boundary; tool execution stays in Work. */
export class NativeDshProviderService {
  constructor(
    private readonly dependencies: NativeProviderDependencies = defaultDependencies
  ) {}

  private async recordUsage(input: NativeDshUsageEventInput): Promise<void> {
    try {
      if (this.dependencies.recordUsage) {
        await this.dependencies.recordUsage(input);
      } else {
        const { recordNativeDshUsage } =
          await import('../../services/pluginUsageService.js');
        await recordNativeDshUsage(input);
      }
    } catch {
      // Usage is best effort and cannot turn a successful model response into
      // a failure or replace the original cancellation/provider error.
      logger.warn('Failed to record native DSH provider usage.');
    }
  }

  private async assertUsageAllowed(
    input: Pick<NativeDshUsageEventInput, 'userId' | 'providerId' | 'model'>
  ): Promise<void> {
    if (this.dependencies.assertUsageAllowed) {
      await this.dependencies.assertUsageAllowed(input);
    } else {
      const { assertNativeDshUsageAllowed } =
        await import('../../services/pluginUsageService.js');
      await assertNativeDshUsageAllowed(input);
    }
  }

  private async connection(userId: string): Promise<string> {
    if (!(await this.dependencies.authorize(userId)))
      throw new Error(
        'Native DSH providers require an active administrator and enabled Cordis engine.'
      );
    const socketPath = await this.dependencies.socketPath();
    if (!socketPath) throw new Error('Native DSH providers are not connected.');
    return socketPath;
  }

  private async readCatalog(
    socketPath: string,
    signal?: AbortSignal
  ): Promise<NativeProviderCatalog> {
    const response = await openRequest(
      socketPath,
      '/catalog',
      {},
      AbortSignal.any([
        AbortSignal.timeout(CATALOG_TIMEOUT_MS),
        ...(signal ? [signal] : []),
      ])
    );
    let bytes = 0;
    const chunks: Buffer[] = [];
    try {
      for await (const chunk of response) {
        const buffer = Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > MAX_FRAME_BYTES)
          throw new Error('Native DSH catalog exceeds its size limit.');
        chunks.push(buffer);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        throw new Error('Invalid native DSH provider catalog.');
      }
      return parseNativeProviderCatalog(parsed);
    } finally {
      response.destroy();
    }
  }

  async catalog(userId: string): Promise<NativeDshCatalog> {
    try {
      if (
        !(await this.dependencies.authorize(userId)) ||
        !(await this.dependencies.socketPath())
      )
        return { status: 'disabled', models: [] };
      const catalog = await this.readCatalog(await this.connection(userId));
      return { status: 'ready', models: catalog.models };
    } catch {
      return { status: 'unavailable', models: [] };
    }
  }

  async assertModel(
    providerId: string,
    model: string,
    userId: string
  ): Promise<NativeDshModel> {
    const catalog = await this.readCatalog(await this.connection(userId));
    const selected = catalog.models.find(
      entry => entry.providerId === providerId && entry.model === model
    );
    if (!selected)
      throw new Error('The selected native DSH model is unavailable.');
    return selected;
  }

  async routingFingerprint(
    providerId: string,
    model: string,
    userId: string
  ): Promise<string> {
    const socketPath = await this.connection(userId);
    const catalog = await this.readCatalog(socketPath);
    if (
      !catalog.models.some(
        entry => entry.providerId === providerId && entry.model === model
      )
    )
      throw new Error('The selected native DSH model is unavailable.');
    return createHash('sha256')
      .update(
        JSON.stringify({
          providerType: 'dsh',
          socketPath,
          instanceId: catalog.instanceId,
          providerId,
          model,
        })
      )
      .digest('hex');
  }

  private async *chunks(
    call: BridgeCall,
    providerId: string,
    userId: string,
    onInstance: (id: string) => void
  ): AsyncIterable<StreamChunk> {
    const boundedSignal = AbortSignal.any([
      AbortSignal.timeout(GENERATION_TIMEOUT_MS),
      ...(call.signal ? [call.signal] : []),
    ]);
    const socketPath = await this.connection(userId);
    const catalog = await this.readCatalog(socketPath, boundedSignal);
    const request = toNativeRequest(call, providerId, catalog.instanceId);
    const selected = catalog.models.find(
      entry =>
        entry.providerId === request.provider && entry.model === request.model
    );
    if (!selected)
      throw new Error('The selected native DSH model is unavailable.');
    await this.assertUsageAllowed({ userId, providerId, model: request.model });
    let response: IncomingMessage | undefined;
    let startedAt: number | undefined;
    let status: NativeDshUsageEventInput['status'] = 'cancelled';
    let usage: NativeDshUsageEventInput['usage'];
    let pending = '';
    let bytes = 0;
    let finished = false;
    let finishKind: string | undefined;
    try {
      response = await openRequest(
        socketPath,
        '/generate',
        { ...request, instanceId: catalog.instanceId },
        boundedSignal,
        () => {
          startedAt = Date.now();
        }
      );
      onInstance(catalog.instanceId);
      response.setEncoding('utf8');
      for await (const part of response) {
        boundedSignal.throwIfAborted();
        bytes += Buffer.byteLength(part);
        if (bytes > MAX_STREAM_BYTES)
          throw new Error('Native DSH output exceeds its size limit.');
        pending += part;
        let newline: number;
        while ((newline = pending.indexOf('\n')) !== -1) {
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          if (!line || Buffer.byteLength(line) > MAX_FRAME_BYTES || finished)
            throw new Error('Invalid native DSH stream frame.');
          let parsed: unknown;
          try {
            parsed = JSON.parse(line);
          } catch {
            throw new Error('Invalid native DSH stream frame.');
          }
          const chunk = parseNativeProviderChunk(parsed);
          if (chunk.type === 'usage') usage = { ...chunk.usage };
          if (chunk.type === 'finish') {
            finished = true;
            finishKind = chunk.reason.kind;
          }
          yield chunk;
        }
        if (Buffer.byteLength(pending) > MAX_FRAME_BYTES)
          throw new Error('Native DSH stream frame exceeds its size limit.');
      }
      if (pending || !finished)
        throw new Error('Native DSH closed before completing its response.');
      status =
        finishKind === 'error'
          ? 'error'
          : finishKind === 'aborted'
            ? 'cancelled'
            : 'success';
    } catch (error) {
      status = boundedSignal.aborted ? 'cancelled' : 'error';
      throw error;
    } finally {
      response?.destroy();
      // This transport owns one ledger event per dispatched /generate call.
      // Catalog/authorization failures never get here with a start timestamp;
      // generator return before a complete stream retains cancelled status.
      if (startedAt !== undefined) {
        await this.recordUsage({
          userId,
          providerId,
          providerName: selected.providerName,
          model: request.model,
          status,
          durationMs: Math.max(0, Date.now() - startedAt),
          createdAt: startedAt,
          ...(usage ? { usage } : {}),
        });
      }
    }
  }

  async *stream(
    call: BridgeCall,
    providerId: string
  ): AsyncIterable<BridgeEvent> {
    if (!call.userId)
      throw new Error(
        'Native DSH calls require an authenticated administrator.'
      );
    const assembler = new BlockAssembler();
    let instanceId: string | undefined;
    for await (const chunk of this.chunks(call, providerId, call.userId, id => {
      instanceId = id;
    })) {
      assembler.push(chunk);
      if (chunk.type === 'text-delta') yield { type: 'text', text: chunk.text };
      if (chunk.type === 'reasoning-delta')
        yield { type: 'reasoning', text: chunk.text };
    }
    const finish = assembler.finish;
    if (assembler.usage)
      yield {
        type: 'usage',
        inputTokens:
          assembler.usage.inputTokens +
          (assembler.usage.cacheReadTokens ?? 0) +
          (assembler.usage.cacheWriteTokens ?? 0),
        outputTokens: assembler.usage.outputTokens,
      };
    if (finish.kind === 'error' || finish.kind === 'aborted')
      throw new Error(
        `Native DSH generation ${finish.kind}: ${finish.failure.code}.`
      );
    if (!['stop', 'tool-calls', 'max-tokens'].includes(finish.kind))
      throw new Error('Native DSH returned an unsupported completion reason.');
    for (const block of assembler.blocks()) {
      if (block.type === 'tool-call')
        yield {
          type: 'tool-call',
          toolCall: {
            id: block.id,
            name: block.name,
            arguments: block.arguments,
          },
        };
    }
    yield {
      type: 'done',
      reason: finish.kind as 'stop' | 'tool-calls' | 'max-tokens',
      providerMetadata: {
        nativeDsh: {
          provider: providerId,
          model: call.model,
          instanceId,
          ...(assembler.replayState
            ? { replayState: assembler.replayState }
            : {}),
        },
      },
    };
  }

  async generate(
    request: OllamaChatRequest,
    providerId: string,
    userId: string,
    observer: WorkModelStreamObserver = {},
    signal?: AbortSignal
  ): Promise<OllamaChatResponse> {
    if (request.messages.some(message => message.images?.length))
      throw new Error(
        'Native DSH images are unsupported; the provider connection accepts text and tool messages only.'
      );
    const call: BridgeCall = {
      model: request.model,
      userId,
      signal,
      messages: request.messages.map(message => ({
        role: message.role,
        content: message.content,
        thinking: message.thinking,
        providerMetadata: message.providerMetadata,
        toolCallId: message.tool_call_id,
        toolCalls: message.tool_calls?.map(tool => {
          const fn = plainObject(tool.function);
          if (typeof tool.id !== 'string' || typeof fn?.name !== 'string')
            throw new Error('Invalid native DSH tool call.');
          return {
            id: tool.id,
            name: fn.name,
            arguments:
              typeof fn.arguments === 'string'
                ? fn.arguments
                : JSON.stringify(fn.arguments ?? {}),
          };
        }),
      })),
      tools: request.tools?.map(tool => {
        const fn = plainObject(tool.function) ?? tool;
        if (typeof fn.name !== 'string' || !plainObject(fn.parameters))
          throw new Error('Invalid native DSH tool schema.');
        return {
          name: fn.name,
          description: typeof fn.description === 'string' ? fn.description : '',
          parameters: fn.parameters as Record<string, unknown>,
        };
      }),
      ...(typeof request.options?.temperature === 'number'
        ? { temperature: request.options.temperature }
        : {}),
      ...(typeof request.options?.num_predict === 'number' &&
      request.options.num_predict > 0
        ? { maxTokens: request.options.num_predict }
        : {}),
      ...(Array.isArray(request.options?.stop)
        ? { stop: request.options.stop as string[] }
        : {}),
    };
    const response: OllamaChatResponse = {
      model: request.model,
      created_at: new Date().toISOString(),
      message: { role: 'assistant', content: '' },
      done: false,
    };
    for await (const event of this.stream(call, providerId)) {
      if (event.type === 'text') {
        response.message.content += event.text;
        observer.onContent?.(event.text);
      } else if (event.type === 'reasoning') {
        response.message.thinking =
          (response.message.thinking ?? '') + event.text;
        observer.onReasoning?.(event.text);
      } else if (event.type === 'tool-call') {
        (response.message.tool_calls ??= []).push({
          id: event.toolCall.id,
          type: 'function',
          function: {
            name: event.toolCall.name,
            arguments: event.toolCall.arguments,
          },
        });
      } else if (event.type === 'usage') {
        response.prompt_eval_count = event.inputTokens;
        response.eval_count = event.outputTokens;
        observer.onUsage?.({
          promptTokens: event.inputTokens,
          completionTokens: event.outputTokens,
          totalTokens: event.inputTokens + event.outputTokens,
        });
      } else if (event.type === 'done') {
        response.done = true;
        response.done_reason =
          event.reason === 'max-tokens'
            ? 'incomplete:max_output_tokens'
            : event.reason;
        response.message.providerMetadata = event.providerMetadata;
      }
    }
    return response;
  }

  async text(input: {
    providerId: string;
    model: string;
    userId: string;
    prompt: string;
    purpose?: 'session-title';
    signal?: AbortSignal;
  }): Promise<string> {
    const model = await this.assertModel(
      input.providerId,
      input.model,
      input.userId
    );
    const off = model.reasoning?.efforts.find(effort =>
      ['off', 'none'].includes(effort.id)
    );
    const call: BridgeCall = {
      model: input.model,
      userId: input.userId,
      messages: [{ role: 'user', content: input.prompt }],
      temperature: 0.3,
      maxTokens: 512,
      ...(off ? { reasoningEffort: off.id } : {}),
      ...(input.purpose ? { purpose: input.purpose } : {}),
      signal: AbortSignal.any([
        AbortSignal.timeout(60_000),
        ...(input.signal ? [input.signal] : []),
      ]),
    };
    let text = '';
    for await (const event of this.stream(call, input.providerId))
      if (event.type === 'text') text += event.text;
    return text;
  }
}

export const nativeDshProviderService = new NativeDshProviderService();
