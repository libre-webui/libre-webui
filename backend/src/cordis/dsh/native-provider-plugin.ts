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

/** Native DSH plugin exposing only its LLM service through a private local socket. */
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { chmod, lstat, mkdir, realpath, unlink } from 'node:fs/promises';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import path from 'node:path';
import type { Socket } from 'node:net';
import type { Context } from '@deepseek-ai/cordis';
import type { StreamChunk } from '@deepseek-ai/dsh-llm';
import type {} from '@deepseek-ai/dsh-credentials';
import type {} from '@deepseek-ai/dsh-settings';
import {
  MAX_REQUEST_BYTES,
  MAX_RESPONSE_BYTES,
  NATIVE_PROVIDER_INSTANCE_HEADER,
  NativeProviderProtocolError,
  parseNativeProviderCatalog,
  parseNativeProviderChunk,
  parseNativeProviderRequest,
  type NativeProviderCatalog,
  type NativeProviderModel,
} from './native-provider-protocol.js';

export const name = 'libre-webui-native-provider';
export const inject = ['llm'];

export interface NativeProviderPluginConfig {
  socketPath: string;
  requestTimeoutMs?: number;
  maxConcurrentRequests?: number;
}

function configuration(
  value: NativeProviderPluginConfig
): Required<NativeProviderPluginConfig> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some(
      key =>
        !['socketPath', 'requestTimeoutMs', 'maxConcurrentRequests'].includes(
          key
        )
    ) ||
    typeof value.socketPath !== 'string' ||
    !path.isAbsolute(value.socketPath) ||
    path.resolve(value.socketPath) !== value.socketPath ||
    Buffer.byteLength(value.socketPath) > 100
  ) {
    throw new Error(
      'Native provider socketPath must be an absolute canonical Unix socket path of at most 100 bytes.'
    );
  }
  const requestTimeoutMs = value.requestTimeoutMs ?? 600_000;
  const maxConcurrentRequests = value.maxConcurrentRequests ?? 8;
  if (
    !Number.isSafeInteger(requestTimeoutMs) ||
    requestTimeoutMs < 10 ||
    requestTimeoutMs > 3_600_000 ||
    !Number.isSafeInteger(maxConcurrentRequests) ||
    maxConcurrentRequests < 1 ||
    maxConcurrentRequests > 64
  ) {
    throw new Error('Invalid native provider request limits.');
  }
  return {
    socketPath: value.socketPath,
    requestTimeoutMs,
    maxConcurrentRequests,
  };
}

async function prepareDirectory(socketPath: string): Promise<number> {
  if (typeof process.getuid !== 'function')
    throw new Error('Native provider sockets require a POSIX host.');
  const uid = process.getuid();
  const parent = path.dirname(socketPath);
  let ancestor = path.parse(parent).root;
  for (const segment of parent
    .slice(ancestor.length)
    .split(path.sep)
    .filter(Boolean)) {
    ancestor = path.join(ancestor, segment);
    const existing = await lstat(ancestor).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    });
    if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) {
      throw new Error(
        'Native provider socket directory cannot contain symbolic links.'
      );
    }
  }
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const info = await lstat(parent);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== uid ||
    (info.mode & 0o777) !== 0o700 ||
    (await realpath(parent)) !== parent
  ) {
    throw new Error(
      'Native provider socket directory must be physical, owned by the current user, and mode 0700.'
    );
  }
  const existing = await lstat(socketPath).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  });
  if (existing)
    throw new Error(
      'Native provider socket path already exists; refusing to replace it.'
    );
  return uid;
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted();
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', aborted));
  });
}

async function requestJson(request: IncomingMessage): Promise<unknown> {
  const length = request.headers['content-length'];
  if (length && (!/^\d+$/.test(length) || Number(length) > MAX_REQUEST_BYTES)) {
    throw new NativeProviderProtocolError(
      'Native provider request exceeds its byte limit.',
      413
    );
  }
  if (
    request.headers['content-type']?.split(';')[0].trim() !==
      'application/json' ||
    request.headers['content-encoding']
  ) {
    throw new NativeProviderProtocolError(
      'Native provider requests require unencoded application/json.',
      415
    );
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_REQUEST_BYTES)
      throw new NativeProviderProtocolError(
        'Native provider request exceeds its byte limit.',
        413
      );
    chunks.push(bytes);
  }
  try {
    return JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(
        Buffer.concat(chunks, size)
      )
    );
  } catch {
    throw new NativeProviderProtocolError(
      'Native provider request must be valid UTF-8 JSON.'
    );
  }
}

/** Start one local-only provider transport, owned and closed by this plugin fiber. */
export async function apply(
  ctx: Context,
  options: NativeProviderPluginConfig
): Promise<void> {
  const config = configuration(options);
  await ctx.effect(async () => {
    const uid = await prepareDirectory(config.socketPath);
    let instanceId = randomUUID();
    let stopping = false;
    const active = new Set<AbortController>();
    const operations = new Set<Promise<void>>();
    const connections = new Set<Socket>();
    const rotate = () => {
      instanceId = randomUUID();
      for (const controller of active)
        controller.abort(
          new NativeProviderProtocolError(
            'Native provider configuration changed; refresh its catalog.',
            409
          )
        );
    };
    const listeners = [
      ctx.on('llm/adapters-updated', rotate),
      ctx.on('credentials/reference-updated', rotate),
      ctx.on('credentials/record-updated', rotate),
      ctx.on('settings/updated', ns => {
        if (
          ctx.llm
            .listConfigurableProviders()
            .some(provider => provider.settingsNs === ns)
        )
          rotate();
      }),
    ];

    const catalog = async (
      signal: AbortSignal,
      selection?: Pick<NativeProviderModel, 'providerId' | 'model'>
    ): Promise<NativeProviderCatalog> => {
      const generation = instanceId;
      const models: NativeProviderModel[] = [];
      for (const provider of ctx.llm.listProviders()) {
        if (selection && provider.id !== selection.providerId) continue;
        try {
          const entries = await abortable(
            ctx.llm.listModels(provider.id),
            signal
          );
          for (const entry of entries) {
            if (selection && entry.id !== selection.model) continue;
            const resolved = await abortable(
              ctx.llm.resolveModelInfo(provider.id, entry.id, signal),
              signal
            );
            models.push({
              providerId: provider.id,
              model: entry.id,
              name: entry.name,
              providerName: provider.name,
              ...(resolved.context?.contextWindow
                ? { contextWindow: resolved.context.contextWindow }
                : {}),
              ...(resolved.defaultMaxTokens
                ? { defaultMaxTokens: resolved.defaultMaxTokens }
                : {}),
              ...(resolved.reasoning
                ? {
                    reasoning: {
                      efforts: resolved.reasoning.efforts.map(effort => ({
                        id: effort.id,
                        name: effort.name,
                        ...(effort.description === undefined
                          ? {}
                          : { description: effort.description }),
                      })),
                      ...(resolved.reasoning.defaultEffort
                        ? { defaultEffort: resolved.reasoning.defaultEffort }
                        : {}),
                    },
                  }
                : {}),
            });
          }
        } catch (error) {
          signal.throwIfAborted();
          ctx.logger.warn(
            'Native provider catalog group is unavailable',
            provider.id,
            error instanceof Error ? error.message : String(error)
          );
        }
      }
      signal.throwIfAborted();
      if (generation !== instanceId)
        throw new NativeProviderProtocolError(
          'Native provider configuration changed; refresh its catalog.',
          409
        );
      return parseNativeProviderCatalog({ instanceId: generation, models });
    };

    const handle = async (
      request: IncomingMessage,
      response: ServerResponse
    ): Promise<void> => {
      if (stopping || active.size >= config.maxConcurrentRequests) {
        response.writeHead(503, {
          'content-type': 'application/json',
          connection: 'close',
        });
        response.end(
          JSON.stringify({
            error: 'Native provider request capacity is unavailable.',
          })
        );
        request.resume();
        return;
      }
      const controller = new AbortController();
      const { signal } = controller;
      active.add(controller);
      const disconnected = () => {
        if (!response.writableEnded)
          controller.abort(new Error('Native provider client disconnected.'));
      };
      response.once('close', disconnected);
      request.once('aborted', disconnected);
      const timeout = setTimeout(
        () =>
          controller.abort(
            new NativeProviderProtocolError(
              'Native provider request timed out.',
              504
            )
          ),
        config.requestTimeoutMs
      );
      timeout.unref();
      const generation = instanceId;
      let bytesSent = 0;
      let finished = false;
      let iterator: AsyncIterator<StreamChunk> | undefined;
      const writeChunk = async (value: StreamChunk) => {
        const chunk = parseNativeProviderChunk(value);
        const line = `${JSON.stringify(chunk)}\n`;
        bytesSent += Buffer.byteLength(line);
        if (bytesSent > MAX_RESPONSE_BYTES)
          throw new NativeProviderProtocolError(
            'Native provider response exceeds its byte limit.',
            413
          );
        if (!response.write(line)) await once(response, 'drain', { signal });
      };
      try {
        if (
          request.method !== 'POST' ||
          !['/catalog', '/generate'].includes(request.url ?? '')
        ) {
          throw new NativeProviderProtocolError(
            'Unknown native provider operation.',
            404
          );
        }
        const body = await abortable(requestJson(request), signal);
        if (request.url === '/catalog') {
          if (
            !body ||
            typeof body !== 'object' ||
            Array.isArray(body) ||
            Object.keys(body).length !== 0
          ) {
            throw new NativeProviderProtocolError(
              'Native provider catalog request must be an empty object.'
            );
          }
          const result = await catalog(signal);
          response.writeHead(200, {
            'content-type': 'application/json',
            [NATIVE_PROVIDER_INSTANCE_HEADER]: result.instanceId,
          });
          response.end(JSON.stringify(result));
          return;
        }
        const parsed = parseNativeProviderRequest(body);
        if (
          parsed.instanceId !== undefined &&
          parsed.instanceId !== generation
        ) {
          throw new NativeProviderProtocolError(
            'Native provider configuration changed; refresh its catalog.',
            409
          );
        }
        // Generation needs only its exact route; unrelated catalogs or model
        // metadata must not delay a healthy selected provider.
        const available = await catalog(signal, {
          providerId: parsed.provider,
          model: parsed.model,
        });
        if (
          !available.models.some(
            model =>
              model.providerId === parsed.provider &&
              model.model === parsed.model
          )
        ) {
          throw new NativeProviderProtocolError(
            'The selected native provider model is unavailable.',
            422
          );
        }
        if (generation !== instanceId)
          throw new NativeProviderProtocolError(
            'Native provider configuration changed; refresh its catalog.',
            409
          );
        const { instanceId: _instanceId, ...call } = parsed;
        response.writeHead(200, {
          'content-type': 'application/x-ndjson',
          [NATIVE_PROVIDER_INSTANCE_HEADER]: generation,
          'cache-control': 'no-store',
        });
        iterator = ctx.llm.stream({ ...call, signal })[Symbol.asyncIterator]();
        for (;;) {
          const next = await abortable(
            Promise.resolve(iterator.next()),
            signal
          );
          if (next.done) break;
          await writeChunk(next.value);
          if (next.value.type === 'finish') {
            finished = true;
            break;
          }
        }
        if (!finished)
          throw new NativeProviderProtocolError(
            'Native provider ended without a terminal finish.',
            502
          );
        response.end();
      } catch (error) {
        controller.abort(error);
        if (response.destroyed) return;
        if (!response.headersSent) {
          const status =
            error instanceof NativeProviderProtocolError ? error.status : 502;
          response.writeHead(status, {
            'content-type': 'application/json',
            connection: 'close',
          });
          response.end(
            JSON.stringify({
              error:
                error instanceof NativeProviderProtocolError
                  ? error.message
                  : 'Native provider request failed.',
            })
          );
          request.resume();
        } else if (!finished) {
          const chunk: StreamChunk = {
            type: 'finish',
            reason: {
              kind: 'error',
              failure: {
                code:
                  error instanceof NativeProviderProtocolError &&
                  error.status === 409
                    ? 'NATIVE_PROVIDER_CHANGED'
                    : 'NATIVE_PROVIDER_STREAM_FAILED',
                message:
                  error instanceof NativeProviderProtocolError
                    ? error.message
                    : 'Native provider generation failed.',
              },
            },
          };
          response.end(`${JSON.stringify(chunk)}\n`);
        } else response.end();
      } finally {
        clearTimeout(timeout);
        response.removeListener('close', disconnected);
        request.removeListener('aborted', disconnected);
        controller.abort(new Error('Native provider request finished.'));
        active.delete(controller);
        // A disconnected reader must not keep teardown waiting on an adapter
        // that ignores cancellation. Its live signal already orders it to stop.
        if (iterator?.return) {
          try {
            void Promise.resolve(iterator.return()).catch(() => undefined);
          } catch {
            // Cancellation has already been delivered through the live signal.
          }
        }
      }
    };

    const server = createServer((request, response) => {
      const operation = handle(request, response);
      operations.add(operation);
      void operation
        .catch(() => response.destroy())
        .finally(() => operations.delete(operation));
    });
    server.requestTimeout = config.requestTimeoutMs;
    server.headersTimeout = Math.min(config.requestTimeoutMs, 60_000);
    server.on('connection', socket => {
      connections.add(socket);
      socket.once('close', () => connections.delete(socket));
    });
    server.on('clientError', (_error, socket) => socket.destroy());
    let socketIdentity: { ino: number; dev: number } | undefined;
    const close = async () => {
      stopping = true;
      listeners.forEach(dispose => dispose());
      for (const controller of active)
        controller.abort(new Error('Native provider plugin stopped.'));
      const closed = new Promise<void>(resolve =>
        server.close(() => resolve())
      );
      for (const socket of connections) socket.destroy();
      await closed;
      await Promise.allSettled([...operations]);
      const current = await lstat(config.socketPath).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT')
          return undefined;
        throw error;
      });
      if (
        current?.isSocket() &&
        socketIdentity &&
        current.ino === socketIdentity.ino &&
        current.dev === socketIdentity.dev
      )
        await unlink(config.socketPath);
    };
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.socketPath, () => {
          server.removeListener('error', reject);
          resolve();
        });
      });
      await chmod(config.socketPath, 0o600);
      const socket = await lstat(config.socketPath);
      if (
        !socket.isSocket() ||
        socket.uid !== uid ||
        (socket.mode & 0o777) !== 0o600
      )
        throw new Error('Native provider socket permissions are invalid.');
      socketIdentity = { ino: socket.ino, dev: socket.dev };
      return close;
    } catch (error) {
      await close();
      throw error;
    }
  }, 'native-provider: private Unix socket');
}
