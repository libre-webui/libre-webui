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

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { LookupFunction } from 'node:net';
import ipaddr from 'ipaddr.js';
import { Agent, fetch } from 'undici';

const MAX_REDIRECTS = 3;
const MAX_BODY_BYTES = 2 * 1024 * 1024; // 2 MB of HTML is plenty of context
const FETCH_TIMEOUT_MS = 15_000;

export function isPublicIpAddress(address: string): boolean {
  try {
    // process() converts every IPv4-mapped IPv6 representation to IPv4 before
    // range classification, including canonical hexadecimal forms.
    return ipaddr.process(address).range() === 'unicast';
  } catch {
    return false;
  }
}

interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

async function resolvePublicAddresses(url: URL): Promise<ResolvedAddress[]> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Only http and https URLs are supported');
  }
  if (url.username || url.password) {
    throw new Error('URLs with embedded credentials are not supported');
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const literalKind = isIP(hostname);
  const resolved =
    literalKind !== 0
      ? [{ address: hostname, family: literalKind as 4 | 6 }]
      : await lookup(hostname, { all: true });
  const addresses: ResolvedAddress[] = resolved.map(({ address, family }) => {
    if (family !== 4 && family !== 6) {
      throw new Error('Host resolved to an unsupported address family');
    }
    return { address, family: family as 4 | 6 };
  });

  if (addresses.length === 0) {
    throw new Error('Host could not be resolved');
  }
  for (const { address } of addresses) {
    if (!isPublicIpAddress(address)) {
      throw new Error('URL resolves to a private or local address');
    }
  }

  return addresses;
}

export function createPinnedLookup(target: ResolvedAddress): LookupFunction {
  const pinnedLookup: LookupFunction = (_hostname, options, callback) => {
    if (options.all) {
      callback(null, [target]);
      return;
    }
    callback(null, target.address, target.family);
  };

  return pinnedLookup;
}

function createPinnedDispatcher(target: ResolvedAddress): Agent {
  return new Agent({
    connect: { lookup: createPinnedLookup(target) },
    maxResponseSize: MAX_BODY_BYTES + 1,
  });
}

function htmlToText(html: string): { title: string | null; text: string } {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);

  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const title = titleMatch
    ? titleMatch[1].replace(/\s+/g, ' ').trim() || null
    : null;
  return { title, text };
}

export interface FetchedWebpage {
  url: string;
  title: string | null;
  text: string;
}

/**
 * Fetch a public webpage and reduce it to plain text for document ingestion.
 * Every hop of a redirect chain is re-validated against private address
 * space, and the body read is capped, so the endpoint cannot be used to
 * probe the server's network.
 */
export async function fetchWebpageAsText(
  rawUrl: string
): Promise<FetchedWebpage> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('Invalid URL');
  }

  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    const [target] = await resolvePublicAddresses(url);
    const dispatcher = createPinnedDispatcher(target);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        redirect: 'manual',
        signal: controller.signal,
        dispatcher,
        headers: {
          'User-Agent': 'Libre-WebUI/1.0 (+webpage attachment)',
          Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
        },
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) throw new Error('Redirect without a location');
        await response.body?.cancel();
        url = new URL(location, url);
        continue;
      }

      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`The page responded with status ${response.status}`);
      }

      const contentType = response.headers.get('content-type') || '';
      if (
        !contentType.includes('text/html') &&
        !contentType.includes('text/plain') &&
        !contentType.includes('application/xhtml')
      ) {
        await response.body?.cancel();
        throw new Error('The URL does not point to a webpage');
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error('The page returned no content');
      const chunks: Uint8Array[] = [];
      let received = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > MAX_BODY_BYTES) {
          await reader.cancel();
          throw new Error('The webpage exceeds the 2 MB size limit');
        }
        chunks.push(value);
      }
      const body = Buffer.concat(chunks).toString('utf-8');

      if (contentType.includes('text/plain')) {
        return { url: url.toString(), title: null, text: body.trim() };
      }

      const { title, text } = htmlToText(body);
      if (!text) throw new Error('The page contained no readable text');
      return { url: url.toString(), title, text };
    } finally {
      clearTimeout(timer);
      await dispatcher.close();
    }
  }

  throw new Error('Too many redirects');
}
