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

import { isIPv4 } from 'node:net';

export interface CorsOriginPolicyOptions {
  allowedOrigins: readonly string[];
  allowNetworkOrigins: boolean;
}

/** Match the existing Docker/development network policy against literal hosts. */
function isNetworkHostname(hostname: string): boolean {
  if (hostname === 'localhost') return true;
  if (!isIPv4(hostname)) return false;
  const [first, second] = hostname.split('.').map(Number);
  return (
    first === 127 ||
    first === 10 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 100 && second >= 64 && second <= 127)
  );
}

/**
 * Build the application's CORS policy without importing its stateful server.
 * Origin headers are serialized origins, not arbitrary URLs or origin lists.
 */
export function createCorsOriginPolicy({
  allowedOrigins,
  allowNetworkOrigins,
}: CorsOriginPolicyOptions): (origin: unknown) => boolean {
  const configured = new Set(allowedOrigins);
  return (origin: unknown): boolean => {
    // Native clients may omit Origin; an empty or malformed header is different.
    if (origin === undefined) return true;
    if (typeof origin !== 'string') return false;
    // Opaque origins remain an explicit operator choice, never a LAN exception.
    if (origin === 'null') return configured.has('*') || configured.has(origin);

    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      return false;
    }
    // Node treats extension schemes as opaque; their explicitly configured
    // browser origins still have a scheme and authority. They never gain the
    // automatic HTTP(S) network exception below.
    const serializedOrigin =
      parsed.origin === 'null'
        ? `${parsed.protocol}//${parsed.host}`
        : parsed.origin;
    // Reject credentials, paths, query/fragment components, multiple origins,
    // and alternate IP spellings instead of normalizing them into trusted hosts.
    if (!parsed.host || serializedOrigin !== origin) return false;
    if (configured.has('*') || configured.has(origin)) return true;
    return (
      allowNetworkOrigins &&
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      isNetworkHostname(parsed.hostname)
    );
  };
}
