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
 * Egress proxy for agent CLIs running inside Work sandboxes.
 *
 * A sandbox never holds a real credential. Its agent CLI is started with a
 * per-run placeholder (`lwui_ph_…`) in place of each secret and with
 * HTTPS_PROXY pointed at this proxy. For a credential's own API hosts the
 * proxy terminates TLS with a certificate from a private authority the
 * sandbox was told to trust, swaps the placeholder for the secret in the
 * request headers, and forwards the request to the real host. Every other
 * destination is an opaque tunnel, or refused outright when the task has no
 * network. A placeholder sent anywhere else stays a useless placeholder.
 *
 * Connections arrive as plain duplex streams (the sandbox relay carries them
 * over the exec channel), so the proxy listens on no port. Destinations are
 * resolved here and must be public addresses: the backend can usually reach
 * networks a sandbox cannot, and the proxy must not become a way in.
 */

import { randomBytes } from 'node:crypto';
import dns from 'node:dns';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import https from 'node:https';
import net, { isIP, type LookupFunction } from 'node:net';
import type { Duplex } from 'node:stream';
import tls from 'node:tls';
import { createLogger } from '../utils/logger.js';
import { isPublicIpAddress } from '../utils/webpageFetcher.js';
import {
  createCertificateAuthority,
  issueServerCertificate,
  type CertificateAuthority,
  type ServerCertificate,
} from '../utils/x509.js';

const logger = createLogger('services:work-egress');

const DAY_MS = 24 * 60 * 60_000;
/** Rotate the authority well before any sandbox could see it expire. */
const AUTHORITY_ROTATION_MARGIN_MS = 30 * DAY_MS;
const CERTIFICATE_RENEWAL_MARGIN_MS = DAY_MS;
const MAX_CACHED_CERTIFICATES = 256;
const HANDSHAKE_TIMEOUT_MS = 30_000;
const CONNECT_TIMEOUT_MS = 30_000;
/** Idle limit for an upstream socket; streamed replies keep it busy. */
const UPSTREAM_IDLE_TIMEOUT_MS = 15 * 60_000;
const MAX_CONNECTIONS_PER_SESSION = 64;
const INTERCEPT_PORT = 443;

/** Request headers that describe one hop and must not be forwarded. */
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/** A secret the proxy may inject, and only toward its own hosts. */
export interface EgressCredential {
  /** Environment name the sandbox sees, e.g. KIRO_API_KEY. Never secret. */
  readonly name: string;
  /** The value the sandbox holds instead of the secret. */
  readonly placeholder: string;
  readonly secret: string;
  /**
   * Host patterns where the placeholder is replaced. A `*` stands for one
   * DNS label, so `runtime.*.kiro.dev` matches `runtime.us-east-1.kiro.dev`
   * but not `evil.example.kiro.dev.attacker.test`.
   */
  readonly hosts: readonly string[];
}

export type EgressEvent =
  | { type: 'tunnel'; host: string; port: number }
  | { type: 'intercept'; host: string }
  | { type: 'substitute'; host: string; credential: string }
  | { type: 'deny'; host: string; port: number; reason: string }
  | { type: 'error'; host: string; message: string };

export interface EgressSessionOptions {
  readonly credentials: readonly EgressCredential[];
  /**
   * Whether destinations without a credential may be reached. False for a
   * task without network: its agent can then talk to its model API and to
   * the support hosts below, nothing else.
   */
  readonly allowOtherHosts: boolean;
  /** Host patterns tunnelled even when other hosts are not allowed. */
  readonly supportHosts?: readonly string[];
  readonly onEvent?: (event: EgressEvent) => void;
}

/**
 * How the proxy reaches upstreams. The defaults are the production rules:
 * public addresses only and the platform's trusted roots. Tests inject a
 * resolver for local fakes and the authority that signed them.
 */
export interface EgressDependencies {
  readonly lookup?: LookupFunction;
  readonly upstreamCa?: string[];
  /** Port actually dialed for a requested destination port. */
  readonly upstreamPort?: (host: string, port: number) => number;
}

const PLACEHOLDER_PREFIX = 'lwui_ph_';

/** A random placeholder that cannot collide with real key formats. */
export function createEgressPlaceholder(): string {
  return `${PLACEHOLDER_PREFIX}${randomBytes(24).toString('hex')}`;
}

/** Compile `*`-per-label host patterns into one anchored matcher. */
export function compileHostPatterns(
  patterns: readonly string[]
): (host: string) => boolean {
  const expressions = patterns
    .map(pattern => pattern.trim().toLowerCase())
    .filter(pattern => /^[a-z0-9*.-]+$/.test(pattern) && pattern.length > 0)
    .map(
      pattern =>
        new RegExp(
          `^${pattern
            .split('.')
            .map(label =>
              label === '*' ? '[a-z0-9](?:[a-z0-9-]*[a-z0-9])?' : escape(label)
            )
            .join('\\.')}$`
        )
    );
  return host => {
    const name = host.toLowerCase();
    return expressions.some(expression => expression.test(name));
  };
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** `host:port` from a CONNECT target, or undefined when malformed. */
export function parseConnectTarget(
  target: string | undefined
): { host: string; port: number } | undefined {
  if (!target) return undefined;
  const match = /^(\[[0-9a-fA-F:.]+\]|[^:[\]\s]+):(\d{1,5})$/.exec(target);
  if (!match) return undefined;
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return undefined;
  const host = match[1].replace(/^\[|\]$/g, '').toLowerCase();
  if (!isIP(host) && !/^[a-z0-9.-]{1,253}$/.test(host)) return undefined;
  return { host, port };
}

/**
 * DNS lookup that only ever yields public addresses. It runs on every
 * connection the proxy opens, so a rebinding answer is checked when it is
 * used rather than once up front.
 */
export const publicOnlyLookup: LookupFunction = (
  hostname,
  options,
  callback
) => {
  dns.lookup(
    hostname,
    { all: true, family: options.family ?? 0 },
    (error, addresses) => {
      if (error) {
        callback(error, '', 0);
        return;
      }
      const allowed = addresses.filter(entry =>
        isPublicIpAddress(entry.address)
      );
      if (allowed.length === 0) {
        const blocked = Object.assign(
          new Error(
            `Egress to ${hostname} is blocked: it does not resolve to a public address.`
          ),
          { code: 'EGRESS_PRIVATE_ADDRESS' }
        );
        callback(blocked, '', 0);
        return;
      }
      if (options.all) {
        callback(null, allowed);
        return;
      }
      callback(null, allowed[0].address, allowed[0].family);
    }
  );
};

/** Replace every placeholder a credential owns; report which ones fired. */
function substitute(
  value: string,
  credentials: readonly EgressCredential[],
  used: Set<string>
): string {
  if (!value.includes(PLACEHOLDER_PREFIX)) return value;
  let result = value;
  for (const credential of credentials) {
    if (result.includes(credential.placeholder)) {
      result = result.split(credential.placeholder).join(credential.secret);
      used.add(credential.name);
    }
  }
  return result;
}

/**
 * Forwardable copy of raw headers with placeholders replaced. `keepUpgrade`
 * preserves the Connection/Upgrade pair a WebSocket handshake needs.
 */
function forwardHeaders(
  rawHeaders: readonly string[],
  credentials: readonly EgressCredential[],
  used: Set<string>,
  keepUpgrade: boolean
): string[] {
  const connectionTokens = new Set<string>();
  for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
    if (rawHeaders[index].toLowerCase() === 'connection') {
      for (const token of rawHeaders[index + 1].split(',')) {
        connectionTokens.add(token.trim().toLowerCase());
      }
    }
  }
  const forwarded: string[] = [];
  for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
    const name = rawHeaders[index];
    const lower = name.toLowerCase();
    if (keepUpgrade && (lower === 'connection' || lower === 'upgrade')) {
      forwarded.push(name, rawHeaders[index + 1]);
      continue;
    }
    if (HOP_BY_HOP_HEADERS.has(lower) || connectionTokens.has(lower)) continue;
    forwarded.push(name, substitute(rawHeaders[index + 1], credentials, used));
  }
  return forwarded;
}

function responseHeaders(rawHeaders: readonly string[]): string[] {
  const forwarded: string[] = [];
  for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
    const lower = rawHeaders[index].toLowerCase();
    if (lower === 'transfer-encoding' || lower === 'connection') continue;
    if (lower === 'keep-alive' || lower === 'proxy-connection') continue;
    forwarded.push(rawHeaders[index], rawHeaders[index + 1]);
  }
  return forwarded;
}

function rawResponseHead(
  statusCode: number,
  statusMessage: string,
  rawHeaders: readonly string[]
): string {
  const lines = [`HTTP/1.1 ${statusCode} ${statusMessage}`];
  for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
    lines.push(`${rawHeaders[index]}: ${rawHeaders[index + 1]}`);
  }
  return `${lines.join('\r\n')}\r\n\r\n`;
}

function refuse(socket: Duplex, status: number, reason: string): void {
  if (socket.destroyed) return;
  socket.end(
    `HTTP/1.1 ${status} ${reason}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`
  );
}

interface InterceptContext {
  host: string;
  port: number;
  credentials: readonly EgressCredential[];
}

/**
 * One run's view of the proxy: its credentials, its network policy, and
 * every connection it opened, so closing the session ends all of them.
 */
export class EgressSession {
  private readonly front: http.Server;
  private readonly inner: http.Server;
  private readonly agent: https.Agent;
  private readonly connections = new Set<Duplex>();
  private readonly contexts = new WeakMap<object, InterceptContext>();
  private readonly credentialHosts: Array<{
    credential: EgressCredential;
    matches: (host: string) => boolean;
  }>;
  private readonly isSupportHost: (host: string) => boolean;
  private closed = false;
  readonly stats = { tunnels: 0, intercepts: 0, substitutions: 0, denied: 0 };

  private readonly lookup: LookupFunction;
  private readonly upstreamCa?: string[];
  private readonly upstreamPort: (host: string, port: number) => number;

  constructor(
    private readonly authority: CertificateAuthority,
    private readonly certificateFor: (
      authority: CertificateAuthority,
      host: string
    ) => ServerCertificate,
    private readonly options: EgressSessionOptions,
    dependencies: EgressDependencies = {}
  ) {
    this.lookup = dependencies.lookup ?? publicOnlyLookup;
    this.upstreamCa = dependencies.upstreamCa;
    this.upstreamPort = dependencies.upstreamPort ?? ((_host, port) => port);
    this.credentialHosts = options.credentials.map(credential => ({
      credential,
      matches: compileHostPatterns(credential.hosts),
    }));
    this.isSupportHost = compileHostPatterns(options.supportHosts ?? []);
    this.agent = new https.Agent({
      keepAlive: true,
      maxSockets: 16,
      lookup: this.lookup,
      timeout: UPSTREAM_IDLE_TIMEOUT_MS,
      ...(this.upstreamCa ? { ca: this.upstreamCa } : {}),
    });
    this.front = http.createServer();
    this.front.on('connect', (request, socket, head) =>
      this.handleConnect(request, socket, head)
    );
    this.front.on('request', (request, response) =>
      this.handlePlainRequest(request, response)
    );
    this.front.on('upgrade', (_request, socket) =>
      refuse(socket, 501, 'Not Implemented')
    );
    this.inner = http.createServer();
    this.inner.on('request', (request, response) =>
      this.handleInterceptedRequest(request, response)
    );
    this.inner.on('upgrade', (request, socket, head) =>
      this.handleInterceptedUpgrade(request, socket, head)
    );
    for (const server of [this.front, this.inner]) {
      server.on('clientError', (_error, socket) => socket.destroy());
    }
  }

  /** Hand one client connection to the proxy. */
  accept(stream: Duplex): void {
    if (this.closed || this.connections.size >= MAX_CONNECTIONS_PER_SESSION) {
      stream.destroy();
      return;
    }
    this.track(stream);
    this.front.emit('connection', stream);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const connection of this.connections) connection.destroy();
    this.connections.clear();
    this.agent.destroy();
  }

  private track(stream: Duplex): void {
    this.connections.add(stream);
    stream.once('close', () => this.connections.delete(stream));
    stream.on('error', () => undefined);
  }

  private emit(event: EgressEvent): void {
    if (event.type === 'deny') this.stats.denied += 1;
    try {
      this.options.onEvent?.(event);
    } catch (error) {
      logger.warn('Egress event observer failed', error);
    }
  }

  private credentialsFor(host: string, port: number): EgressCredential[] {
    if (port !== INTERCEPT_PORT || isIP(host)) return [];
    return this.credentialHosts
      .filter(entry => entry.matches(host))
      .map(entry => entry.credential);
  }

  private handleConnect(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer
  ): void {
    const target = parseConnectTarget(request.url);
    if (!target) {
      refuse(socket, 400, 'Bad Request');
      return;
    }
    const credentials = this.credentialsFor(target.host, target.port);
    if (credentials.length > 0) {
      this.intercept(socket, head, target, credentials);
      return;
    }
    if (!this.options.allowOtherHosts && !this.isSupportHost(target.host)) {
      this.emit({
        type: 'deny',
        host: target.host,
        port: target.port,
        reason: 'This Work task has no network access.',
      });
      refuse(socket, 403, 'Forbidden');
      return;
    }
    this.tunnel(socket, head, target);
  }

  private tunnel(
    socket: Duplex,
    head: Buffer,
    target: { host: string; port: number }
  ): void {
    if (isIP(target.host) && !isPublicIpAddress(target.host)) {
      this.emit({
        type: 'deny',
        host: target.host,
        port: target.port,
        reason: 'Private addresses are not reachable from Work sandboxes.',
      });
      refuse(socket, 403, 'Forbidden');
      return;
    }
    let connected = false;
    const upstream = net.connect({
      host: target.host,
      port: this.upstreamPort(target.host, target.port),
      lookup: this.lookup,
    });
    this.track(upstream);
    upstream.setTimeout(CONNECT_TIMEOUT_MS, () => {
      if (!connected) upstream.destroy(new Error('Connection timed out.'));
    });
    upstream.once('connect', () => {
      connected = true;
      upstream.setTimeout(UPSTREAM_IDLE_TIMEOUT_MS, () => upstream.destroy());
      this.stats.tunnels += 1;
      this.emit({ type: 'tunnel', host: target.host, port: target.port });
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on('error', error => {
      if (!connected) {
        this.emit({
          type: 'error',
          host: target.host,
          message: error.message,
        });
        refuse(socket, 502, 'Bad Gateway');
        return;
      }
      socket.destroy();
    });
    socket.once('close', () => upstream.destroy());
  }

  private intercept(
    socket: Duplex,
    head: Buffer,
    target: { host: string; port: number },
    credentials: readonly EgressCredential[]
  ): void {
    let certificate: ServerCertificate;
    try {
      certificate = this.certificateFor(this.authority, target.host);
    } catch (error) {
      this.emit({
        type: 'error',
        host: target.host,
        message: error instanceof Error ? error.message : String(error),
      });
      refuse(socket, 502, 'Bad Gateway');
      return;
    }
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length > 0) socket.unshift(head);
    const secure = new tls.TLSSocket(socket, {
      isServer: true,
      secureContext: tls.createSecureContext({
        key: certificate.privateKeyPem,
        cert: certificate.certificatePem,
      }),
      ALPNProtocols: ['http/1.1'],
    });
    this.track(secure);
    const handshakeTimer = setTimeout(
      () => secure.destroy(),
      HANDSHAKE_TIMEOUT_MS
    );
    handshakeTimer.unref?.();
    secure.once('secure', () => {
      clearTimeout(handshakeTimer);
      this.stats.intercepts += 1;
      this.emit({ type: 'intercept', host: target.host });
    });
    secure.once('close', () => clearTimeout(handshakeTimer));
    this.contexts.set(secure, { ...target, credentials });
    this.inner.emit('connection', secure);
  }

  private noteSubstitutions(host: string, used: Set<string>): void {
    for (const name of used) {
      this.stats.substitutions += 1;
      this.emit({ type: 'substitute', host, credential: name });
    }
  }

  private handleInterceptedRequest(
    request: IncomingMessage,
    response: ServerResponse
  ): void {
    const context = this.contexts.get(request.socket);
    if (!context) {
      response.writeHead(502).end();
      return;
    }
    const used = new Set<string>();
    const path = substitute(request.url ?? '/', context.credentials, used);
    const headers = forwardHeaders(
      request.rawHeaders,
      context.credentials,
      used,
      false
    );
    this.noteSubstitutions(context.host, used);
    const upstream = https.request({
      host: context.host,
      port: this.upstreamPort(context.host, context.port),
      servername: context.host,
      method: request.method,
      path,
      headers,
      agent: this.agent,
    });
    upstream.on('response', upstreamResponse => {
      response.writeHead(
        upstreamResponse.statusCode ?? 502,
        upstreamResponse.statusMessage,
        responseHeaders(upstreamResponse.rawHeaders)
      );
      upstreamResponse.pipe(response);
      upstreamResponse.on('error', () => response.destroy());
    });
    upstream.on('error', error => {
      this.emit({ type: 'error', host: context.host, message: error.message });
      if (!response.headersSent) {
        response.writeHead(502, { 'Content-Type': 'text/plain' });
        response.end(`Egress proxy could not reach ${context.host}.`);
      } else {
        response.destroy();
      }
    });
    response.once('close', () => {
      if (!response.writableFinished) upstream.destroy();
    });
    request.pipe(upstream);
  }

  private handleInterceptedUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer
  ): void {
    const context = this.contexts.get(request.socket);
    if (!context) {
      refuse(socket, 502, 'Bad Gateway');
      return;
    }
    const used = new Set<string>();
    const path = substitute(request.url ?? '/', context.credentials, used);
    const headers = forwardHeaders(
      request.rawHeaders,
      context.credentials,
      used,
      true
    );
    this.noteSubstitutions(context.host, used);
    const upstream = https.request({
      host: context.host,
      port: this.upstreamPort(context.host, context.port),
      servername: context.host,
      method: request.method,
      path,
      headers,
      lookup: this.lookup,
      agent: false,
      ...(this.upstreamCa ? { ca: this.upstreamCa } : {}),
    });
    upstream.on('upgrade', (upstreamResponse, upstreamSocket, upstreamHead) => {
      this.track(upstreamSocket);
      upstreamSocket.setTimeout(UPSTREAM_IDLE_TIMEOUT_MS, () =>
        upstreamSocket.destroy()
      );
      socket.write(
        rawResponseHead(
          upstreamResponse.statusCode ?? 101,
          upstreamResponse.statusMessage ?? 'Switching Protocols',
          upstreamResponse.rawHeaders
        )
      );
      if (upstreamHead.length > 0) socket.write(upstreamHead);
      if (head.length > 0) upstreamSocket.write(head);
      upstreamSocket.pipe(socket);
      socket.pipe(upstreamSocket);
      upstreamSocket.on('error', () => socket.destroy());
      socket.once('close', () => upstreamSocket.destroy());
    });
    upstream.on('response', upstreamResponse => {
      // The server declined the upgrade; pass its answer through as-is.
      socket.write(
        rawResponseHead(
          upstreamResponse.statusCode ?? 502,
          upstreamResponse.statusMessage ?? 'Bad Gateway',
          responseHeaders(upstreamResponse.rawHeaders).concat([
            'Connection',
            'close',
          ])
        )
      );
      upstreamResponse.pipe(socket);
    });
    upstream.on('error', error => {
      this.emit({ type: 'error', host: context.host, message: error.message });
      refuse(socket, 502, 'Bad Gateway');
    });
    upstream.end();
  }

  /** Absolute-form `http://` requests: no credentials, policy applies. */
  private handlePlainRequest(
    request: IncomingMessage,
    response: ServerResponse
  ): void {
    let target: URL;
    try {
      target = new URL(request.url ?? '');
    } catch {
      response.writeHead(400).end();
      return;
    }
    const host = target.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    const port = Number(target.port || 80);
    if (
      target.protocol !== 'http:' ||
      (!this.options.allowOtherHosts && !this.isSupportHost(host)) ||
      (isIP(host) !== 0 && !isPublicIpAddress(host))
    ) {
      this.emit({
        type: 'deny',
        host,
        port,
        reason: 'Plain HTTP egress is not allowed for this destination.',
      });
      response.writeHead(403).end();
      return;
    }
    const upstream = http.request({
      host,
      port: this.upstreamPort(host, port),
      method: request.method,
      path: `${target.pathname}${target.search}`,
      headers: forwardHeaders(request.rawHeaders, [], new Set(), false),
      lookup: this.lookup,
      agent: false,
    });
    upstream.on('response', upstreamResponse => {
      response.writeHead(
        upstreamResponse.statusCode ?? 502,
        upstreamResponse.statusMessage,
        responseHeaders(upstreamResponse.rawHeaders)
      );
      upstreamResponse.pipe(response);
    });
    upstream.on('error', () => {
      if (!response.headersSent) response.writeHead(502);
      response.end();
    });
    request.pipe(upstream);
  }
}

/** Process-wide certificate state shared by every session. */
export class WorkEgressProxy {
  private authority?: CertificateAuthority;
  private readonly certificates = new Map<string, ServerCertificate>();

  constructor(private readonly dependencies: EgressDependencies = {}) {}

  /** The authority new sessions use, rotated before it nears expiry. */
  currentAuthority(now = Date.now()): CertificateAuthority {
    if (
      !this.authority ||
      this.authority.notAfter.getTime() - now < AUTHORITY_ROTATION_MARGIN_MS
    ) {
      this.authority = createCertificateAuthority(undefined, now);
      this.certificates.clear();
    }
    return this.authority;
  }

  createSession(options: EgressSessionOptions): {
    session: EgressSession;
    certificateAuthorityPem: string;
  } {
    const authority = this.currentAuthority();
    return {
      session: new EgressSession(
        authority,
        (issuer, host) => this.certificateFor(issuer, host),
        options,
        this.dependencies
      ),
      certificateAuthorityPem: authority.certificatePem,
    };
  }

  private certificateFor(
    authority: CertificateAuthority,
    host: string
  ): ServerCertificate {
    const key = `${authority.keyId.toString('hex')}:${host}`;
    const cached = this.certificates.get(key);
    if (
      cached &&
      cached.notAfter.getTime() - Date.now() > CERTIFICATE_RENEWAL_MARGIN_MS
    ) {
      return cached;
    }
    const issued = issueServerCertificate(authority, host);
    if (this.certificates.size >= MAX_CACHED_CERTIFICATES) {
      const oldest = this.certificates.keys().next().value;
      if (oldest !== undefined) this.certificates.delete(oldest);
    }
    this.certificates.set(key, issued);
    return issued;
  }
}

export const workEgressProxy = new WorkEgressProxy();
export default workEgressProxy;
