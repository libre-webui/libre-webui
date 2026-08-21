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
 * Egress guard for tool-server requests. Every request resolves the target
 * host itself, refuses private/loopback/metadata address space, and pins the
 * connection to the resolved address so a DNS rebind between check and use
 * cannot redirect the call. Redirects are refused outright: a registered
 * tool destination is exact. Response reads are size-capped and every call
 * carries a hard timeout combined with the caller's abort signal.
 *
 * An administrator can allow exact internal hostnames through the
 * TOOLS_PRIVATE_NETWORK_ALLOWLIST environment variable (comma-separated,
 * matched case-insensitively against the URL hostname). Allowlisted hosts
 * are still connection-pinned and capped.
 */

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Agent, fetch } from 'undici';
import { createPinnedLookup, isPublicIpAddress } from './webpageFetcher.js';

const ABSOLUTE_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const ABSOLUTE_MAX_TIMEOUT_MS = 120_000;

// Explicit comparisons, not Math.min/Math.max: a NaN request value must land
// on the ceiling instead of propagating, and the bounds stay visible to
// static analysis of the setTimeout below.
const clampFinite = (value: number, min: number, max: number): number => {
  if (!Number.isFinite(value)) return max;
  if (value < min) return min;
  if (value > max) return max;
  return value;
};

export class ToolEgressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolEgressError';
  }
}

const privateHostAllowlist = (): Set<string> =>
  new Set(
    (process.env.TOOLS_PRIVATE_NETWORK_ALLOWLIST ?? '')
      .split(',')
      .map(entry => entry.trim().toLowerCase())
      .filter(Boolean)
  );

export const isAllowlistedPrivateHost = (hostname: string): boolean =>
  privateHostAllowlist().has(hostname.toLowerCase());

export interface ToolHttpRequest {
  url: string;
  method: string;
  headers?: Record<string, string>;
  /** Request body; binary bodies (Web Push) send as-is. */
  body?: string | Uint8Array;
  timeoutMs: number;
  maxResponseBytes: number;
  signal?: AbortSignal;
}

export interface ToolHttpResponse {
  status: number;
  headers: Record<string, string>;
  bodyText: string;
  truncated: boolean;
}

export const validateToolServerUrl = (rawUrl: string): URL => {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ToolEgressError('Invalid tool server URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ToolEgressError('Only http and https tool servers are supported');
  }
  if (url.username || url.password) {
    throw new ToolEgressError(
      'Tool server URLs cannot contain embedded credentials'
    );
  }
  return url;
};

interface ResolvedTarget {
  address: string;
  family: 4 | 6;
}

const resolveTarget = async (url: URL): Promise<ResolvedTarget> => {
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const literalKind = isIP(hostname);
  const resolved =
    literalKind !== 0
      ? [{ address: hostname, family: literalKind as 4 | 6 }]
      : await lookup(hostname, { all: true });
  if (resolved.length === 0) {
    throw new ToolEgressError('Tool server host could not be resolved');
  }
  const allowPrivate = isAllowlistedPrivateHost(url.hostname);
  for (const { address } of resolved) {
    if (!allowPrivate && !isPublicIpAddress(address)) {
      throw new ToolEgressError(
        'Tool server resolves to a private or local address'
      );
    }
  }
  const [first] = resolved;
  if (first.family !== 4 && first.family !== 6) {
    throw new ToolEgressError('Unsupported address family');
  }
  return { address: first.address, family: first.family as 4 | 6 };
};

export async function secureToolRequest(
  request: ToolHttpRequest
): Promise<ToolHttpResponse> {
  const url = validateToolServerUrl(request.url);
  const target = await resolveTarget(url);
  const maxBytes = clampFinite(
    request.maxResponseBytes,
    1,
    ABSOLUTE_MAX_RESPONSE_BYTES
  );
  const timeoutMs = clampFinite(
    request.timeoutMs,
    1000,
    ABSOLUTE_MAX_TIMEOUT_MS
  );

  // The size cap is enforced by the read loop below, which stops at maxBytes
  // and cancels the stream. A dispatcher-level maxResponseSize cannot do the
  // job here: it destroys the request as soon as the limit is crossed, so an
  // oversized body would surface as a transport failure instead of the
  // truncated result the caller is documented to receive.
  const dispatcher = new Agent({
    connect: { lookup: createPinnedLookup(target) },
  });
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new ToolEgressError('Tool request timed out')),
    timeoutMs
  );
  const forwardAbort = () => controller.abort(request.signal?.reason);
  request.signal?.addEventListener('abort', forwardAbort, { once: true });
  if (request.signal?.aborted) forwardAbort();

  try {
    const response = await fetch(url, {
      method: request.method,
      redirect: 'manual',
      signal: controller.signal,
      dispatcher,
      headers: {
        'User-Agent': 'Libre-WebUI/1.0 (+tool gateway)',
        ...request.headers,
      },
      ...(request.body !== undefined ? { body: request.body } : {}),
    });

    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new ToolEgressError(
        'Tool server responded with a redirect; registered destinations are exact'
      );
    }

    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    let truncated = false;
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > maxBytes) {
          truncated = true;
          const keep = value.byteLength - (received - maxBytes);
          if (keep > 0) chunks.push(value.subarray(0, keep));
          await reader.cancel();
          break;
        }
        chunks.push(value);
      }
    }

    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });
    return {
      status: response.status,
      headers,
      bodyText: Buffer.concat(chunks).toString('utf-8'),
      truncated,
    };
  } finally {
    clearTimeout(timer);
    request.signal?.removeEventListener('abort', forwardAbort);
    await dispatcher.close();
  }
}
