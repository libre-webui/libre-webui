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
 * A small fetch-based HTTP client with the request surface the app grew up
 * on: `get/post/...` returning `{ data, status }`, `params`, `responseType`,
 * per-request timeouts, and errors that carry `response.status` and
 * `response.data`. It has no DOM or Vite dependencies so it can be unit
 * tested in Node.
 */

export type HttpMethod =
  'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

export type HttpResponseType = 'json' | 'text' | 'blob' | 'arraybuffer';

export type HttpParams = Record<string, unknown>;

export interface HttpRequestConfig {
  url?: string;
  method?: HttpMethod | Lowercase<HttpMethod>;
  baseURL?: string;
  params?: HttpParams;
  headers?: Record<string, string>;
  data?: unknown;
  signal?: AbortSignal;
  /** Milliseconds; 0 disables the timeout. */
  timeout?: number;
  responseType?: HttpResponseType;
}

export interface HttpResponse<T = unknown> {
  data: T;
  status: number;
  statusText: string;
  headers: Headers;
  config: HttpRequestConfig;
}

export type HttpErrorCode =
  | 'ERR_BAD_REQUEST'
  | 'ERR_BAD_RESPONSE'
  | 'ERR_NETWORK'
  | 'ERR_CANCELED'
  | 'ECONNABORTED';

export class HttpError<T = unknown> extends Error {
  readonly name = 'HttpError';
  readonly code: HttpErrorCode;
  readonly config: HttpRequestConfig;
  readonly response?: HttpResponse<T>;

  constructor(
    message: string,
    code: HttpErrorCode,
    config: HttpRequestConfig,
    response?: HttpResponse<T>
  ) {
    super(message);
    this.code = code;
    this.config = config;
    this.response = response;
  }
}

export const isHttpError = <T = unknown>(
  error: unknown
): error is HttpError<T> => error instanceof HttpError;

export interface HttpClientOptions {
  baseURL?: string;
  timeout?: number;
  /** Runs before every request; return the config to send. */
  onRequest?: (config: HttpRequestConfig) => HttpRequestConfig;
  /**
   * Runs for every failure. Return a response to recover, or throw to
   * propagate (optionally a different error).
   */
  onError?: (error: HttpError) => Promise<HttpResponse> | never;
  fetch?: typeof fetch;
}

/* eslint-disable @typescript-eslint/no-explicit-any -- axios-compatible defaults */
export interface HttpClient {
  request<T = any>(config: HttpRequestConfig): Promise<HttpResponse<T>>;
  get<T = any>(
    url: string,
    config?: HttpRequestConfig
  ): Promise<HttpResponse<T>>;
  delete<T = any>(
    url: string,
    config?: HttpRequestConfig
  ): Promise<HttpResponse<T>>;
  head<T = any>(
    url: string,
    config?: HttpRequestConfig
  ): Promise<HttpResponse<T>>;
  post<T = any>(
    url: string,
    data?: unknown,
    config?: HttpRequestConfig
  ): Promise<HttpResponse<T>>;
  put<T = any>(
    url: string,
    data?: unknown,
    config?: HttpRequestConfig
  ): Promise<HttpResponse<T>>;
  patch<T = any>(
    url: string,
    data?: unknown,
    config?: HttpRequestConfig
  ): Promise<HttpResponse<T>>;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const ABSOLUTE_URL = /^[a-z][a-z0-9+.-]*:\/\//i;

const appendParam = (search: URLSearchParams, key: string, value: unknown) => {
  if (value === undefined || value === null) return;
  if (Array.isArray(value)) {
    for (const item of value) appendParam(search, `${key}[]`, item);
    return;
  }
  if (value instanceof Date) {
    search.append(key, value.toISOString());
    return;
  }
  if (typeof value === 'object') {
    search.append(key, JSON.stringify(value));
    return;
  }
  search.append(key, String(value));
};

export const buildUrl = (
  url: string,
  baseURL?: string,
  params?: HttpParams
): string => {
  let full = url;
  if (baseURL && !ABSOLUTE_URL.test(url)) {
    const base = baseURL.replace(/\/+$/, '');
    full = url ? `${base}/${url.replace(/^\/+/, '')}` : base;
  }
  if (!params) return full;
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    appendParam(search, key, value);
  }
  const query = search.toString();
  if (!query) return full;
  const [beforeHash, hash] = full.split('#', 2);
  const joiner = beforeHash.includes('?') ? '&' : '?';
  return `${beforeHash}${joiner}${query}${hash ? `#${hash}` : ''}`;
};

const isBodyPassthrough = (data: unknown): boolean =>
  typeof data === 'string' ||
  (typeof FormData !== 'undefined' && data instanceof FormData) ||
  (typeof Blob !== 'undefined' && data instanceof Blob) ||
  (typeof URLSearchParams !== 'undefined' && data instanceof URLSearchParams) ||
  data instanceof ArrayBuffer ||
  ArrayBuffer.isView(data) ||
  (typeof ReadableStream !== 'undefined' && data instanceof ReadableStream);

const findHeader = (
  headers: Record<string, string>,
  name: string
): string | undefined => {
  const wanted = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === wanted) return key;
  }
  return undefined;
};

/**
 * Serialize the body and settle the Content-Type: objects become JSON, and a
 * hand-written multipart type is dropped so the browser can add its boundary.
 */
export const prepareBody = (
  data: unknown,
  headers: Record<string, string>
): BodyInit | undefined => {
  if (data === undefined || data === null) return undefined;
  const contentTypeKey = findHeader(headers, 'content-type');
  if (typeof FormData !== 'undefined' && data instanceof FormData) {
    if (
      contentTypeKey &&
      headers[contentTypeKey].toLowerCase().startsWith('multipart/form-data')
    ) {
      delete headers[contentTypeKey];
    }
    return data;
  }
  if (isBodyPassthrough(data)) return data as BodyInit;
  if (!contentTypeKey) headers['Content-Type'] = 'application/json';
  return JSON.stringify(data);
};

const parseBody = async (
  response: Response,
  responseType: HttpResponseType
): Promise<unknown> => {
  if (response.status === 204 || response.status === 205) return null;
  switch (responseType) {
    case 'blob':
      return response.blob();
    case 'arraybuffer':
      return response.arrayBuffer();
    case 'text':
      return response.text();
    default: {
      const text = await response.text();
      if (!text) return null;
      const contentType = response.headers.get('content-type') || '';
      const looksJson =
        contentType.includes('json') || /^\s*[[{]/.test(text.slice(0, 64));
      if (!looksJson) return text;
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    }
  }
};

const isAbortError = (error: unknown): boolean =>
  error instanceof Error &&
  (error.name === 'AbortError' || error.name === 'TimeoutError');

/** Combine the caller's signal with the timeout signal. */
const combineSignals = (
  signals: AbortSignal[]
): { signal: AbortSignal | undefined; cleanup: () => void } => {
  if (signals.length === 0) return { signal: undefined, cleanup: () => {} };
  if (signals.length === 1) return { signal: signals[0], cleanup: () => {} };
  const controller = new AbortController();
  const listeners: Array<() => void> = [];
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    const onAbort = () => controller.abort(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    listeners.push(() => signal.removeEventListener('abort', onAbort));
  }
  return {
    signal: controller.signal,
    cleanup: () => listeners.forEach(remove => remove()),
  };
};

export const createHttpClient = (
  options: HttpClientOptions = {}
): HttpClient => {
  const fetchImpl = options.fetch;

  const send = async <T>(
    input: HttpRequestConfig
  ): Promise<HttpResponse<T>> => {
    const prepared = options.onRequest
      ? options.onRequest({ ...input })
      : { ...input };
    const config: HttpRequestConfig = {
      ...prepared,
      baseURL: prepared.baseURL ?? options.baseURL,
      timeout: prepared.timeout ?? options.timeout ?? 0,
      method: (prepared.method || 'GET').toUpperCase() as HttpMethod,
    };
    const headers: Record<string, string> = { ...(config.headers || {}) };
    const body = prepareBody(config.data, headers);
    const url = buildUrl(config.url || '', config.baseURL, config.params);

    const signals: AbortSignal[] = [];
    if (config.signal) signals.push(config.signal);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    if (config.timeout && config.timeout > 0) {
      const timeoutController = new AbortController();
      timer = setTimeout(() => {
        timedOut = true;
        timeoutController.abort();
      }, config.timeout);
      signals.push(timeoutController.signal);
    }
    const combined = combineSignals(signals);

    const fail = (error: HttpError): Promise<HttpResponse<T>> => {
      if (!options.onError) return Promise.reject(error);
      return options.onError(error) as Promise<HttpResponse<T>>;
    };

    try {
      let response: Response;
      try {
        response = await (fetchImpl || fetch)(url, {
          method: config.method,
          headers,
          body,
          signal: combined.signal,
        });
      } catch (error) {
        if (timedOut) {
          return fail(
            new HttpError(
              `timeout of ${config.timeout}ms exceeded`,
              'ECONNABORTED',
              config
            )
          );
        }
        if (isAbortError(error)) {
          return fail(new HttpError('canceled', 'ERR_CANCELED', config));
        }
        return fail(new HttpError('Network Error', 'ERR_NETWORK', config));
      }

      const data = (await parseBody(
        response,
        config.responseType || 'json'
      )) as T;
      const result: HttpResponse<T> = {
        data,
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
        config,
      };
      if (response.status >= 200 && response.status < 300) return result;
      return fail(
        new HttpError(
          `Request failed with status code ${response.status}`,
          response.status >= 500 ? 'ERR_BAD_RESPONSE' : 'ERR_BAD_REQUEST',
          config,
          result
        )
      );
    } finally {
      if (timer) clearTimeout(timer);
      combined.cleanup();
    }
  };

  const withBody =
    (method: HttpMethod) =>
    <T>(url: string, data?: unknown, config: HttpRequestConfig = {}) =>
      send<T>({ ...config, url, method, data });
  const withoutBody =
    (method: HttpMethod) =>
    <T>(url: string, config: HttpRequestConfig = {}) =>
      send<T>({ ...config, url, method });

  return {
    request: send,
    get: withoutBody('GET'),
    delete: withoutBody('DELETE'),
    head: withoutBody('HEAD'),
    post: withBody('POST'),
    put: withBody('PUT'),
    patch: withBody('PATCH'),
  };
};
