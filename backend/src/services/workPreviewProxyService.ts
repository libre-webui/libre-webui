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

import crypto from 'node:crypto';
import http, {
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
} from 'node:http';
import type { Duplex } from 'node:stream';
import type { Request, Response } from 'express';
import { getWorkPersistence } from '../platform/workPersistence/index.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('services:work-preview-proxy');

export const WORK_PREVIEW_PROXY_PREFIX = '/api/work/previews';

const MAX_REWRITABLE_RESPONSE_BYTES = 8 * 1024 * 1024;
const TASK_ID_PATTERN = /^[A-Za-z0-9-]{1,100}$/;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
// Derive a domain-separated capability secret from JWT_SECRET when it exists.
// An unset JWT secret already makes sessions process-local; the random fallback
// gives preview capabilities the same restart semantics without importing the
// auth service (whose model singleton opens the database during module load).
const WORK_PREVIEW_SECRET = crypto
  .createHash('sha256')
  .update(
    `libre-work-preview:${process.env.JWT_SECRET || crypto.randomBytes(64).toString('hex')}`
  )
  .digest('hex');
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);
const PRIVATE_REQUEST_HEADERS = new Set([
  'authorization',
  'cookie',
  'host',
  'origin',
  'referer',
]);
const PRIVATE_RESPONSE_HEADERS = new Set([
  'alt-svc',
  'authentication-info',
  'clear-site-data',
  'content-security-policy',
  'content-security-policy-report-only',
  'cross-origin-embedder-policy',
  'cross-origin-opener-policy',
  'cross-origin-resource-policy',
  'document-policy',
  'feature-policy',
  'nel',
  'origin-agent-cluster',
  'permissions-policy',
  'reporting-endpoints',
  'report-to',
  'set-cookie',
  'strict-transport-security',
  'www-authenticate',
  'x-frame-options',
  'x-permitted-cross-domain-policies',
]);
const SAFE_WEBSOCKET_RESPONSE_HEADERS = new Set([
  'connection',
  'sec-websocket-accept',
  'sec-websocket-extensions',
  'sec-websocket-protocol',
  'upgrade',
]);

const previewFrameAncestors = (): string => {
  const ancestors = new Set(["'self'"]);
  if (process.env.NODE_ENV !== 'production') {
    ancestors.add('http://localhost:*');
    ancestors.add('http://127.0.0.1:*');
    ancestors.add('http://[::1]:*');
  }
  for (const candidate of (process.env.CORS_ORIGIN || '').split(',')) {
    try {
      const origin = new URL(candidate.trim());
      if (origin.protocol === 'http:' || origin.protocol === 'https:') {
        ancestors.add(origin.origin);
      }
    } catch {
      // Ignore wildcard and malformed CORS entries in a CSP source list.
    }
  }
  return [...ancestors].join(' ');
};

interface PreviewRecord {
  preview_status: string;
  preview_url: string | null;
  preview_upstream_host: string | null;
  preview_upstream_port: number | null;
}

export type PreviewRecordLookup = (
  taskId: string
) => PreviewRecord | undefined | Promise<PreviewRecord | undefined>;

interface PreviewProxyTarget {
  upstreamHost: string;
  taskId: string;
  port: number;
  proxyBasePath: string;
  upstreamPath: string;
}

const defaultPreviewLookup: PreviewRecordLookup = taskId =>
  getWorkPersistence().findPreview(taskId);

export const normalizePreviewUpstreamHost = (value: string): string => {
  const normalized = value.trim().replace(/^\[|\]$/g, '');
  if (
    !normalized ||
    normalized.length > 253 ||
    !/^[A-Za-z0-9._:%-]+$/.test(normalized) ||
    normalized === '0.0.0.0' ||
    normalized === '::'
  ) {
    throw new Error('Work preview upstream host is invalid.');
  }
  return normalized;
};

const secureEqual = (left: string, right: string): boolean => {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    crypto.timingSafeEqual(leftBuffer, rightBuffer)
  );
};

const escapeHtmlAttribute = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

const formatHostForUrl = (host: string): string =>
  host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;

const proxyBootstrap = (proxyBasePath: string): string => {
  const serializedBase = JSON.stringify(proxyBasePath);
  return `<base href="${escapeHtmlAttribute(proxyBasePath)}" />
<script>(() => {
  const proxyBase = ${serializedBase};
  const rewrite = value => {
    if (value == null) return value;
    try {
      const url = new URL(String(value), document.baseURI);
      const proxyProtocol = url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'ws:' || url.protocol === 'wss:';
      if (proxyProtocol && url.host === location.host && !url.pathname.startsWith(proxyBase)) {
        url.pathname = proxyBase + url.pathname.replace(/^\\/+/, '');
        return url.toString();
      }
    } catch {}
    return value;
  };

  const nativeFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    if (typeof input === 'string' || input instanceof URL) return nativeFetch(rewrite(input), init);
    if (input instanceof Request) return nativeFetch(new Request(rewrite(input.url), input), init);
    return nativeFetch(input, init);
  };

  const nativeOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    return nativeOpen.call(this, method, rewrite(url), ...rest);
  };

  const NativeWebSocket = window.WebSocket;
  function PreviewWebSocket(url, protocols) {
    return protocols === undefined
      ? new NativeWebSocket(rewrite(url))
      : new NativeWebSocket(rewrite(url), protocols);
  }
  PreviewWebSocket.prototype = NativeWebSocket.prototype;
  PreviewWebSocket.CONNECTING = NativeWebSocket.CONNECTING;
  PreviewWebSocket.OPEN = NativeWebSocket.OPEN;
  PreviewWebSocket.CLOSING = NativeWebSocket.CLOSING;
  PreviewWebSocket.CLOSED = NativeWebSocket.CLOSED;
  window.WebSocket = PreviewWebSocket;

  if (window.EventSource) {
    const NativeEventSource = window.EventSource;
    function PreviewEventSource(url, options) {
      return new NativeEventSource(rewrite(url), options);
    }
    PreviewEventSource.prototype = NativeEventSource.prototype;
    window.EventSource = PreviewEventSource;
  }

  const nativeSetAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function(name, value) {
    if (/^srcset$/i.test(name)) {
      const sourceSet = String(value).split(',').map(candidate => {
        const [url, ...descriptor] = candidate.trim().split(/\\s+/);
        return [rewrite(url), ...descriptor].join(' ');
      }).join(', ');
      return nativeSetAttribute.call(this, name, sourceSet);
    }
    const urlAttribute = /^(?:src|href|action|formaction|poster|data)$/i.test(name);
    return nativeSetAttribute.call(this, name, urlAttribute ? rewrite(value) : value);
  };

  for (const method of ['pushState', 'replaceState']) {
    const nativeHistoryMethod = history[method].bind(history);
    history[method] = (state, unused, url) => nativeHistoryMethod(state, unused, rewrite(url));
  }
})();</script>`;
};

const rewriteQuotedRootPaths = (
  content: string,
  proxyBasePath: string
): string =>
  content.replace(/(["'`])\/(?!\/)(?=[@A-Za-z0-9._~-])/g, `$1${proxyBasePath}`);

export const rewritePreviewText = (
  content: string,
  contentType: string,
  proxyBasePath: string
): string => {
  const normalizedType = contentType.toLowerCase();

  if (
    normalizedType.includes('text/html') ||
    normalizedType.includes('application/xhtml+xml')
  ) {
    let rewritten = content.replace(
      /(\b(?:src|href|action|formaction|poster|data)\s*=\s*["'])\/(?!\/)/gi,
      `$1${proxyBasePath}`
    );
    rewritten = rewritten.replace(
      /(\bsrcset\s*=\s*["'])([^"']*)(["'])/gi,
      (_match, open: string, sourceSet: string, close: string) =>
        `${open}${sourceSet.replace(
          /(^|,\s*)\/(?!\/)/g,
          `$1${proxyBasePath}`
        )}${close}`
    );
    rewritten = rewritten.replace(
      /(<script\b[^>]*>)([\s\S]*?)(<\/script\b[^>]*>)/gi,
      (_match, open: string, script: string, close: string) =>
        `${open}${rewriteQuotedRootPaths(script, proxyBasePath)}${close}`
    );
    rewritten = rewritten.replace(
      /(<style\b[^>]*>)([\s\S]*?)(<\/style\b[^>]*>)/gi,
      (_match, open: string, style: string, close: string) =>
        `${open}${rewritePreviewText(style, 'text/css', proxyBasePath)}${close}`
    );

    const injection = proxyBootstrap(proxyBasePath);
    return /<head\b[^>]*>/i.test(rewritten)
      ? rewritten.replace(/<head\b[^>]*>/i, match => `${match}\n${injection}`)
      : `${injection}\n${rewritten}`;
  }

  if (normalizedType.includes('text/css')) {
    return content
      .replace(/(url\(\s*["']?)\/(?!\/)/gi, `$1${proxyBasePath}`)
      .replace(/(@import\s+["'])\/(?!\/)/gi, `$1${proxyBasePath}`);
  }

  if (
    normalizedType.includes('javascript') ||
    normalizedType.includes('ecmascript') ||
    normalizedType.includes('typescript')
  ) {
    return rewriteQuotedRootPaths(content, proxyBasePath);
  }

  if (normalizedType.includes('image/svg+xml')) {
    return content.replace(
      /(\b(?:src|href)\s*=\s*["'])\/(?!\/)/gi,
      `$1${proxyBasePath}`
    );
  }

  return content;
};

const canRewriteContentType = (contentType: string): boolean => {
  const normalized = contentType.toLowerCase();
  return (
    normalized.includes('text/html') ||
    normalized.includes('application/xhtml+xml') ||
    normalized.includes('text/css') ||
    normalized.includes('javascript') ||
    normalized.includes('ecmascript') ||
    normalized.includes('typescript') ||
    normalized.includes('image/svg+xml')
  );
};

export class WorkPreviewProxyService {
  constructor(
    private readonly secret = WORK_PREVIEW_SECRET,
    private readonly lookupPreview: PreviewRecordLookup = defaultPreviewLookup
  ) {}

  private signature(taskId: string, port: number, nonce: string): string {
    return crypto
      .createHmac('sha256', this.secret)
      .update(`${taskId}:${port}:${nonce}`)
      .digest('base64url');
  }

  createPreviewUrl(taskId: string, port: number): string {
    if (!TASK_ID_PATTERN.test(taskId)) {
      throw new Error('Work preview task ID is invalid.');
    }
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error('Work preview port is invalid.');
    }
    const nonce = crypto.randomBytes(16).toString('base64url');
    const signature = this.signature(taskId, port, nonce);
    return `${WORK_PREVIEW_PROXY_PREFIX}/${encodeURIComponent(taskId)}/${port}.${nonce}.${signature}/`;
  }

  private activityListener?: (taskId: string) => void;

  /** Observe authorized preview traffic, e.g. to feed an idle sweep. */
  onPreviewActivity(listener: (taskId: string) => void): void {
    this.activityListener = listener;
  }

  private async parseTarget(
    rawUrl: string
  ): Promise<PreviewProxyTarget | undefined> {
    let url: URL;
    try {
      url = new URL(rawUrl, 'http://libre-preview.local');
    } catch {
      return undefined;
    }
    if (!url.pathname.startsWith(`${WORK_PREVIEW_PROXY_PREFIX}/`)) {
      return undefined;
    }

    const remainder = url.pathname.slice(WORK_PREVIEW_PROXY_PREFIX.length + 1);
    const segments = remainder.split('/');
    const encodedTaskId = segments.shift();
    const credential = segments.shift();
    if (!encodedTaskId || !credential) return undefined;

    let taskId: string;
    try {
      taskId = decodeURIComponent(encodedTaskId);
    } catch {
      return undefined;
    }
    if (!TASK_ID_PATTERN.test(taskId)) return undefined;

    const [rawPort = '', nonce = '', signature = '', ...extraCredentials] =
      credential.split('.');
    if (extraCredentials.length > 0) return undefined;
    const port = Number(rawPort);
    if (
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65_535 ||
      !NONCE_PATTERN.test(nonce) ||
      !SIGNATURE_PATTERN.test(signature)
    ) {
      return undefined;
    }
    const expectedSignature = this.signature(taskId, port, nonce);
    if (!secureEqual(signature, expectedSignature)) return undefined;

    const proxyBasePath = `${WORK_PREVIEW_PROXY_PREFIX}/${encodeURIComponent(taskId)}/${credential}/`;
    if (!url.pathname.startsWith(proxyBasePath)) return undefined;
    const record = await this.lookupPreview(taskId);
    if (
      record?.preview_status !== 'running' ||
      record.preview_url !== proxyBasePath ||
      record.preview_upstream_port !== port ||
      !record.preview_upstream_host
    ) {
      return undefined;
    }
    let upstreamHost: string;
    try {
      upstreamHost = normalizePreviewUpstreamHost(record.preview_upstream_host);
    } catch {
      return undefined;
    }

    const upstreamPath = `/${url.pathname.slice(proxyBasePath.length)}${url.search}`;
    // Every authorized preview request (HTTP and WebSocket both resolve
    // through here) counts as task activity for the idle sweep.
    this.activityListener?.(taskId);
    return {
      taskId,
      port,
      proxyBasePath,
      upstreamPath,
      upstreamHost,
    };
  }

  private upstreamRequestHeaders(
    headers: IncomingHttpHeaders,
    target: PreviewProxyTarget
  ): OutgoingHttpHeaders {
    const outgoing: OutgoingHttpHeaders = {};
    for (const [name, value] of Object.entries(headers)) {
      if (
        value === undefined ||
        HOP_BY_HOP_HEADERS.has(name) ||
        PRIVATE_REQUEST_HEADERS.has(name) ||
        name.startsWith('cf-') ||
        name.startsWith('x-forwarded-')
      ) {
        continue;
      }
      outgoing[name] = value;
    }
    outgoing.host = `${formatHostForUrl(target.upstreamHost)}:${target.port}`;
    outgoing['accept-encoding'] = 'identity';
    if (headers.origin) {
      outgoing.origin = `http://${formatHostForUrl(target.upstreamHost)}:${target.port}`;
    }
    return outgoing;
  }

  private rewriteLocation(value: string, target: PreviewProxyTarget): string {
    try {
      const location = new URL(
        value,
        `http://${formatHostForUrl(target.upstreamHost)}:${target.port}`
      );
      if (
        location.hostname.replace(/^\[|\]$/g, '') === target.upstreamHost &&
        Number(location.port || 80) === target.port
      ) {
        return `${target.proxyBasePath}${location.pathname.replace(/^\/+/, '')}${location.search}${location.hash}`;
      }
    } catch {
      // Preserve malformed upstream locations rather than creating a new URL.
    }
    return value;
  }

  private applyResponseHeaders(
    response: Response,
    upstream: IncomingMessage,
    target: PreviewProxyTarget,
    rewritten: boolean
  ): void {
    response.status(upstream.statusCode || 502);
    for (const [name, value] of Object.entries(upstream.headers)) {
      if (
        value === undefined ||
        HOP_BY_HOP_HEADERS.has(name) ||
        PRIVATE_RESPONSE_HEADERS.has(name) ||
        name.startsWith('access-control-') ||
        (rewritten &&
          (name === 'content-length' ||
            name === 'content-encoding' ||
            name === 'etag'))
      ) {
        continue;
      }
      response.setHeader(
        name,
        name === 'location' && typeof value === 'string'
          ? this.rewriteLocation(value, target)
          : value
      );
    }
    response.setHeader('Cache-Control', 'no-store');
    // A sandboxed preview has an opaque browser origin. Wildcard CORS lets its
    // modules and requests reach only this uncredentialed capability URL.
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader(
      'Permissions-Policy',
      'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=()'
    );
    const contentType = String(upstream.headers['content-type'] || '');
    if (
      contentType.toLowerCase().includes('text/html') ||
      contentType.toLowerCase().includes('application/xhtml+xml')
    ) {
      response.setHeader(
        'Content-Security-Policy',
        `sandbox allow-scripts allow-forms allow-modals allow-downloads; frame-ancestors ${previewFrameAncestors()}`
      );
    }
  }

  handleHttp = async (request: Request, response: Response): Promise<void> => {
    const target = await this.parseTarget(request.originalUrl || request.url);
    if (!target) {
      response.status(404).type('text/plain').send('Preview not found.');
      return;
    }

    if (
      request.method === 'OPTIONS' &&
      request.headers['access-control-request-method']
    ) {
      response.status(204);
      response.setHeader('Access-Control-Allow-Origin', '*');
      response.setHeader(
        'Access-Control-Allow-Methods',
        String(request.headers['access-control-request-method'])
      );
      const requestedHeaders =
        request.headers['access-control-request-headers'];
      if (requestedHeaders) {
        response.setHeader('Access-Control-Allow-Headers', requestedHeaders);
      }
      response.setHeader('Access-Control-Max-Age', '600');
      response.setHeader('Cache-Control', 'no-store');
      response.end();
      return;
    }

    const upstreamRequest = http.request(
      {
        hostname: target.upstreamHost,
        port: target.port,
        path: target.upstreamPath,
        method: request.method,
        headers: this.upstreamRequestHeaders(request.headers, target),
      },
      upstream => {
        const contentType = String(upstream.headers['content-type'] || '');
        const contentEncoding = String(
          upstream.headers['content-encoding'] || 'identity'
        ).toLowerCase();
        const rewritten =
          request.method !== 'HEAD' &&
          contentEncoding === 'identity' &&
          canRewriteContentType(contentType);

        if (!rewritten) {
          this.applyResponseHeaders(response, upstream, target, false);
          upstream.pipe(response);
          return;
        }

        const chunks: Buffer[] = [];
        let totalBytes = 0;
        upstream.on('data', (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          totalBytes += buffer.length;
          if (totalBytes > MAX_REWRITABLE_RESPONSE_BYTES) {
            upstream.destroy(
              new Error('Work preview text response exceeded the proxy limit.')
            );
            return;
          }
          chunks.push(buffer);
        });
        upstream.on('end', () => {
          if (response.destroyed) return;
          this.applyResponseHeaders(response, upstream, target, true);
          const body = rewritePreviewText(
            Buffer.concat(chunks).toString('utf8'),
            contentType,
            target.proxyBasePath
          );
          response.send(body);
        });
        upstream.on('error', error => {
          logger.warn('Work preview upstream response failed:', error.message);
          if (!response.headersSent) {
            response
              .status(502)
              .type('text/plain')
              .send('Preview unavailable.');
          } else {
            response.destroy(error);
          }
        });
      }
    );

    upstreamRequest.on('error', error => {
      logger.warn('Work preview proxy request failed:', error.message);
      if (!response.headersSent) {
        response.status(502).type('text/plain').send('Preview unavailable.');
      } else {
        response.destroy(error);
      }
    });
    request.on('aborted', () => upstreamRequest.destroy());
    request.pipe(upstreamRequest);
  };

  tryHandleUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer
  ): boolean {
    if (!(request.url || '').startsWith(`${WORK_PREVIEW_PROXY_PREFIX}/`)) {
      return false;
    }
    socket.pause();
    void this.handleUpgradeAuthorized(request, socket, head);
    return true;
  }

  private async handleUpgradeAuthorized(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer
  ): Promise<void> {
    let target: PreviewProxyTarget | undefined;
    try {
      target = await this.parseTarget(request.url || '');
    } catch (error) {
      logger.warn('Work preview authorization lookup failed:', error);
    }
    if (!target) {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      return;
    }
    socket.resume();

    const headers = this.upstreamRequestHeaders(request.headers, target);
    headers.connection = 'Upgrade';
    headers.upgrade = request.headers.upgrade || 'websocket';
    const upstreamRequest = http.request({
      hostname: target.upstreamHost,
      port: target.port,
      path: target.upstreamPath,
      method: request.method,
      headers,
    });
    socket.once('error', error => {
      logger.debug(
        'Work preview client WebSocket closed with an error:',
        error
      );
    });

    upstreamRequest.on('upgrade', (upstream, upstreamSocket, upstreamHead) => {
      const statusLine = `HTTP/${upstream.httpVersion} ${upstream.statusCode || 101} ${upstream.statusMessage || 'Switching Protocols'}\r\n`;
      const headerLines: string[] = [];
      for (let index = 0; index < upstream.rawHeaders.length; index += 2) {
        const name = upstream.rawHeaders[index];
        const value = upstream.rawHeaders[index + 1];
        if (!name || !SAFE_WEBSOCKET_RESPONSE_HEADERS.has(name.toLowerCase())) {
          continue;
        }
        headerLines.push(`${name}: ${value}`);
      }
      socket.write(`${statusLine}${headerLines.join('\r\n')}\r\n\r\n`);
      if (upstreamHead.length > 0) socket.write(upstreamHead);
      if (head.length > 0) upstreamSocket.write(head);
      upstreamSocket.once('error', error => {
        logger.debug(
          'Work preview upstream WebSocket closed with an error:',
          error
        );
        socket.destroy();
      });
      socket.once('close', () => upstreamSocket.destroy());
      upstreamSocket.pipe(socket);
      socket.pipe(upstreamSocket);
    });
    upstreamRequest.on('response', upstream => {
      upstream.resume();
      socket.end(
        `HTTP/1.1 ${upstream.statusCode || 502} ${upstream.statusMessage || 'Upgrade Failed'}\r\nConnection: close\r\n\r\n`
      );
    });
    upstreamRequest.on('error', error => {
      logger.warn('Work preview WebSocket proxy failed:', error.message);
      if (!socket.destroyed) {
        socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
      }
    });
    upstreamRequest.end();
  }
}

export const workPreviewProxyService = new WorkPreviewProxyService();
export default workPreviewProxyService;
