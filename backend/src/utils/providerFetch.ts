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

import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';

/**
 * Outbound HTTP for provider and upstream calls, on Node's built-in fetch.
 *
 * It keeps the contract the services were written against:
 * - a non-2xx status throws a ProviderHttpError carrying `response.status`,
 *   `response.statusText`, `response.headers`, and a decoded `response.data`;
 * - a timeout throws a ProviderTimeoutError with code `ECONNABORTED`;
 * - a caller abort throws an AbortError with code `ERR_CANCELED`;
 * - an unreachable host throws a ProviderNetworkError that has a `request`
 *   property, which the "unable to reach" branches key on;
 * - `maxResponseBytes` refuses an oversized body, by Content-Length first and
 *   by a counted read otherwise, before it is buffered;
 * - redirects are refused by default so credentials never follow a 3xx.
 *
 * `fetch` is looked up on `globalThis` per call so tests can stub it.
 */

export type ProviderResponseType = 'json' | 'text' | 'bytes' | 'stream';

type FetchBody = NonNullable<Parameters<typeof globalThis.fetch>[1]>['body'];

export interface ProviderRequestOptions {
  url: string;
  method?: string;
  headers?: Record<string, string | undefined>;
  /** Sent as-is: string, Buffer, Uint8Array, FormData, URLSearchParams, Blob. */
  body?: FetchBody | Buffer;
  /** Serialized with JSON.stringify and sent as application/json. */
  json?: unknown;
  /** Milliseconds; omit or 0 for no timeout. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Refuse bodies larger than this many bytes (json, text, bytes only). */
  maxResponseBytes?: number;
  responseType?: ProviderResponseType;
  /** Default 'error': a 3xx is a failure. 'follow' lets fetch follow it. */
  redirect?: 'error' | 'follow' | 'manual';
}

export interface ProviderResponse<T = unknown> {
  status: number;
  statusText: string;
  /** Lower-case header names, joined values. */
  headers: Record<string, string>;
  data: T;
}

export type ProviderErrorCode =
  | 'ERR_BAD_REQUEST'
  | 'ERR_BAD_RESPONSE'
  | 'ERR_NETWORK'
  | 'ERR_CANCELED'
  | 'ECONNABORTED';

export class ProviderHttpError<T = unknown> extends Error {
  readonly name: string = 'ProviderHttpError';
  readonly code: ProviderErrorCode;
  readonly response: ProviderResponse<T>;
  readonly url: string;

  constructor(url: string, response: ProviderResponse<T>, message?: string) {
    super(message || `Request failed with status code ${response.status}`);
    this.url = url;
    this.response = response;
    this.code = response.status >= 500 ? 'ERR_BAD_RESPONSE' : 'ERR_BAD_REQUEST';
  }
}

export class ProviderTimeoutError extends Error {
  readonly name: string = 'ProviderTimeoutError';
  readonly code = 'ECONNABORTED' as const;
  readonly url: string;
  /** A timeout never produced a response, so it counts as a request failure. */
  readonly request: { url: string };

  constructor(url: string, timeoutMs: number) {
    super(`timeout of ${timeoutMs}ms exceeded`);
    this.url = url;
    this.request = { url };
  }
}

export class ProviderNetworkError extends Error {
  readonly name: string = 'ProviderNetworkError';
  /** The OS code when there is one (ECONNREFUSED, ENOTFOUND), else ERR_NETWORK. */
  readonly code: string;
  readonly url: string;
  /** Present so `'request' in error` connection checks keep working. */
  readonly request: { url: string };

  constructor(url: string, cause: unknown) {
    super(describeCause(cause) || 'Network Error');
    this.url = url;
    this.code = systemCode(cause) || 'ERR_NETWORK';
    this.request = { url };
    (this as { cause?: unknown }).cause = cause;
  }
}

/** Walk a fetch failure's cause chain for an OS-level error code. */
const systemCode = (cause: unknown, depth = 0): string => {
  if (!cause || typeof cause !== 'object' || depth > 4) return '';
  const error = cause as { code?: unknown; cause?: unknown; errors?: unknown };
  if (typeof error.code === 'string' && /^E[A-Z]+$/.test(error.code)) {
    return error.code;
  }
  if (Array.isArray(error.errors)) {
    for (const inner of error.errors) {
      const code = systemCode(inner, depth + 1);
      if (code) return code;
    }
  }
  return systemCode(error.cause, depth + 1);
};

export class ProviderResponseTooLargeError extends Error {
  readonly name: string = 'ProviderResponseTooLargeError';
  readonly code = 'ERR_BAD_RESPONSE' as const;
  readonly url: string;
  readonly limit: number;

  constructor(url: string, limit: number) {
    super(`maxContentLength size of ${limit} exceeded`);
    this.url = url;
    this.limit = limit;
  }
}

const describeCause = (cause: unknown): string => {
  if (!cause || typeof cause !== 'object') return '';
  const error = cause as { message?: unknown; cause?: unknown; code?: unknown };
  const inner = error.cause as
    { message?: unknown; code?: unknown } | undefined;
  const code = inner?.code ?? error.code;
  const message = inner?.message ?? error.message;
  if (typeof message === 'string' && message && message !== 'fetch failed') {
    return message;
  }
  return typeof code === 'string' ? code : '';
};

const createCancelError = (reason?: unknown): Error => {
  const error = new Error(
    reason instanceof Error && reason.message ? reason.message : 'canceled'
  ) as Error & { code: string };
  error.name = 'AbortError';
  error.code = 'ERR_CANCELED';
  return error;
};

/** True for a caller abort, whichever layer produced the error. */
export const isProviderRequestCancelled = (error: unknown): boolean => {
  if (error instanceof DOMException && error.name === 'AbortError') return true;
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { name?: unknown; code?: unknown };
  return (
    candidate.name === 'AbortError' ||
    candidate.name === 'CanceledError' ||
    candidate.code === 'ABORT_ERR' ||
    candidate.code === 'ERR_CANCELED'
  );
};

export const isProviderHttpError = <T = unknown>(
  error: unknown
): error is ProviderHttpError<T> => error instanceof ProviderHttpError;

export const isProviderTimeout = (error: unknown): boolean =>
  error instanceof ProviderTimeoutError ||
  (typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'ECONNABORTED');

const headersToRecord = (headers: Headers): Record<string, string> => {
  const record: Record<string, string> = {};
  headers.forEach((value, key) => {
    record[key.toLowerCase()] = value;
  });
  return record;
};

const compactHeaders = (
  headers: Record<string, string | undefined> | undefined
): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers || {})) {
    if (value !== undefined && value !== null) out[key] = String(value);
  }
  return out;
};

const hasHeader = (headers: Record<string, string>, name: string): boolean =>
  Object.keys(headers).some(key => key.toLowerCase() === name.toLowerCase());

const looksLikeJson = (contentType: string, text: string): boolean =>
  contentType.includes('json') || /^\s*[[{]/.test(text.slice(0, 64));

const decodeText = (bytes: Buffer, contentType: string): unknown => {
  const text = bytes.toString('utf8');
  if (!text) return null;
  if (!looksLikeJson(contentType, text)) return text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

/** Read a body fully, refusing to buffer more than `limit` bytes. */
export async function readBodyBounded(
  response: Response,
  url: string,
  limit: number | undefined,
  onChunk?: () => void
): Promise<Buffer> {
  if (limit !== undefined) {
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > limit) {
      await response.body?.cancel().catch(() => {});
      throw new ProviderResponseTooLargeError(url, limit);
    }
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    onChunk?.();
    received += value.byteLength;
    if (limit !== undefined && received > limit) {
      await reader.cancel().catch(() => {});
      throw new ProviderResponseTooLargeError(url, limit);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

const ERROR_BODY_MAX_BYTES = 1024 * 1024;

const decodeErrorBody = async (
  response: Response,
  url: string,
  responseType: ProviderResponseType
): Promise<unknown> => {
  try {
    const bytes = await readBodyBounded(response, url, ERROR_BODY_MAX_BYTES);
    if (responseType === 'bytes') return bytes;
    return decodeText(bytes, response.headers.get('content-type') || '');
  } catch {
    return null;
  }
};

/**
 * Perform one outbound request. See the module comment for the contract.
 */
export async function providerRequest<T = unknown>(
  options: ProviderRequestOptions
): Promise<ProviderResponse<T>> {
  const {
    url,
    signal,
    timeoutMs = 0,
    responseType = 'json',
    maxResponseBytes,
    redirect = 'error',
  } = options;
  const method = (
    options.method ||
    (options.body !== undefined || options.json !== undefined ? 'POST' : 'GET')
  ).toUpperCase();
  const headers = compactHeaders(options.headers);

  let body: FetchBody = options.body as FetchBody;
  if (options.json !== undefined) {
    body = JSON.stringify(options.json);
    if (!hasHeader(headers, 'content-type')) {
      headers['Content-Type'] = 'application/json';
    }
  } else if (Buffer.isBuffer(body)) {
    body = new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  }

  if (signal?.aborted) throw createCancelError(signal.reason);

  // The timeout is an idle timeout, as the axios socket timeout was: it is
  // re-armed on every chunk, so a slow but live download or a long stream is
  // not cut off, while a stalled peer still fails after `timeoutMs`.
  const signals: AbortSignal[] = [];
  if (signal) signals.push(signal);
  const timeoutController = timeoutMs > 0 ? new AbortController() : undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const armTimer = () => {
    if (!timeoutController) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      timeoutController.abort();
    }, timeoutMs);
  };
  const disarmTimer = () => clearTimeout(timer);
  if (timeoutController) signals.push(timeoutController.signal);
  const combined = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
  armTimer();

  const translate = (error: unknown): Error => {
    if (timedOut && !signal?.aborted) {
      return new ProviderTimeoutError(url, timeoutMs);
    }
    if (signal?.aborted || isProviderRequestCancelled(error)) {
      return createCancelError(signal?.reason);
    }
    if (error instanceof ProviderResponseTooLargeError) return error;
    return new ProviderNetworkError(url, error);
  };

  let response: Response;
  try {
    response = await globalThis.fetch(url, {
      method,
      headers,
      body,
      signal: combined,
      redirect,
    });
  } catch (error) {
    disarmTimer();
    throw translate(error);
  }
  armTimer();

  const meta = {
    status: response.status,
    statusText: response.statusText,
    headers: headersToRecord(response.headers),
  };

  if (!response.ok) {
    try {
      const data = await decodeErrorBody(response, url, responseType);
      throw new ProviderHttpError(url, { ...meta, data });
    } finally {
      disarmTimer();
    }
  }

  try {
    if (responseType === 'stream') {
      disarmTimer();
      return {
        ...meta,
        data: watchedStream(response.body, url, timeoutMs) as unknown as T,
      };
    }
    const bytes = await readBodyBounded(
      response,
      url,
      maxResponseBytes,
      armTimer
    );
    if (responseType === 'bytes') return { ...meta, data: bytes as T };
    if (responseType === 'text') {
      return { ...meta, data: bytes.toString('utf8') as T };
    }
    return {
      ...meta,
      data: decodeText(bytes, meta.headers['content-type'] || '') as T,
    };
  } catch (error) {
    throw translate(error);
  } finally {
    disarmTimer();
  }
}

/**
 * Turn a response body into a Node Readable that fails with a
 * ProviderTimeoutError when the peer goes quiet for `timeoutMs`. The idle
 * check rides on a TransformStream so the Readable's own mode (events or
 * async iteration) is left to the consumer.
 */
const watchedStream = (
  body: Response['body'],
  url: string,
  timeoutMs: number
): Readable => {
  if (!body) return Readable.from([]);
  if (!(timeoutMs > 0)) {
    return Readable.fromWeb(body as WebReadableStream<Uint8Array>);
  }
  const idle = new AbortController();
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const armIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(
      () => idle.abort(new ProviderTimeoutError(url, timeoutMs)),
      timeoutMs
    );
  };
  const watched = body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      start: armIdle,
      transform(chunk, controller) {
        armIdle();
        controller.enqueue(chunk);
      },
      flush: () => clearTimeout(idleTimer),
    }),
    { signal: idle.signal }
  );
  const stream = Readable.fromWeb(watched as WebReadableStream<Uint8Array>);
  stream.once('close', () => clearTimeout(idleTimer));
  return stream;
};
