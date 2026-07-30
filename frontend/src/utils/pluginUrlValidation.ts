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

function isPrivateIpv4Hostname(hostname: string): boolean {
  const octets = hostname.split('.');
  if (octets.length !== 4 || octets.some(octet => !/^\d{1,3}$/.test(octet))) {
    return false;
  }

  const values = octets.map(Number);
  if (values.some(value => value < 0 || value > 255)) {
    return false;
  }

  const [first, second] = values;
  return (
    first === 10 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

const MAX_API_PATH_DECODE_PASSES = 8;

export function isPluginUrlVariable(name: string): boolean {
  const normalized = name.toLowerCase();
  return (
    normalized === 'endpoint' ||
    normalized === 'base_url' ||
    normalized === 'api_url' ||
    normalized === 'models_endpoint' ||
    normalized.endsWith('_endpoint') ||
    normalized.endsWith('_base_url')
  );
}

/**
 * Client-side feedback only. The backend repeats URL validation immediately
 * before provider credentials are attached or a network request is made.
 */
export function isSafePluginUrl(value: string, name: string): boolean {
  try {
    const url = new URL(value);
    const isLocalhost = ['localhost', '127.0.0.1', '[::1]'].includes(
      url.hostname
    );
    const isPrivateNetwork = isPrivateIpv4Hostname(url.hostname);
    if (url.protocol !== 'https:' && !isLocalhost && !isPrivateNetwork) {
      return false;
    }
    return !(
      name.toLowerCase().endsWith('base_url') &&
      (url.search || url.hash)
    );
  } catch {
    return false;
  }
}

export function isValidPluginApiPath(value: string): boolean {
  const trimmed = value.trim();
  if (
    !trimmed.startsWith('/') ||
    trimmed.startsWith('//') ||
    trimmed.includes('://') ||
    trimmed.includes('\\') ||
    trimmed.includes('?') ||
    trimmed.includes('#')
  ) {
    return false;
  }

  let decoded = trimmed;
  for (
    let decodePass = 0;
    decodePass <= MAX_API_PATH_DECODE_PASSES;
    decodePass += 1
  ) {
    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      return false;
    }
    if (next === decoded) {
      return (
        !decoded.includes('\\') &&
        !decoded.includes('?') &&
        !decoded.includes('#') &&
        !decoded.split('/').some(segment => segment === '.' || segment === '..')
      );
    }
    if (decodePass === MAX_API_PATH_DECODE_PASSES) {
      return false;
    }
    decoded = next;
  }

  return false;
}
