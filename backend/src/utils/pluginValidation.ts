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

import type { Plugin } from '../types/index.js';
import { createLogger } from './logger.js';

const logger = createLogger('utils:plugin-validation');

const MODEL_PATTERN = /^[a-zA-Z0-9\-_:./~]+$/;

function isPrivateIpv4Address(hostname: string): boolean {
  const octets = hostname.split('.');
  if (octets.length !== 4 || octets.some(octet => !/^\d{1,3}$/.test(octet))) {
    return false;
  }

  const [first, second, third, fourth] = octets.map(Number);
  if (
    [first, second, third, fourth].some(
      octet => !Number.isInteger(octet) || octet < 0 || octet > 255
    )
  ) {
    return false;
  }

  return (
    first === 10 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

export function validatePluginModel(model: string): void {
  if (!model || typeof model !== 'string') {
    throw new Error('Invalid model parameter: must be a non-empty string');
  }

  if (!MODEL_PATTERN.test(model)) {
    throw new Error(
      `Invalid model parameter: ${model} contains invalid characters`
    );
  }

  if (model.includes('..') || model.includes('\\')) {
    throw new Error(
      `Invalid model parameter: ${model} contains invalid patterns`
    );
  }
}

export function isSafePluginEndpoint(endpoint: string): boolean {
  const url = new URL(endpoint);
  const isLocalhost = ['localhost', '127.0.0.1', '[::1]'].includes(
    url.hostname
  );
  const isPrivateNetwork = isPrivateIpv4Address(url.hostname);

  return (
    url.protocol === 'https:' ||
    (url.protocol === 'http:' && (isLocalhost || isPrivateNetwork))
  );
}

export function validatePluginEndpointOverride(
  endpoint: string
): string | null {
  try {
    if (!isSafePluginEndpoint(endpoint)) {
      logger.warn(
        `Rejected insecure endpoint override: ${endpoint} (only HTTPS or localhost/private IPs allowed)`
      );
      return null;
    }

    return endpoint;
  } catch {
    logger.warn(`Rejected invalid endpoint override URL: ${endpoint}`);
    return null;
  }
}

export function assertSafePluginEndpoint(
  endpoint: string,
  label: string = 'endpoint URL'
): void {
  try {
    if (!isSafePluginEndpoint(endpoint)) {
      const url = new URL(endpoint);
      throw new Error(
        `Insecure endpoint protocol: ${url.protocol}. Only HTTPS is allowed for remote endpoints. ` +
          `(HTTP is permitted for localhost and private network IPs)`
      );
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Insecure')) {
      throw error;
    }

    throw new Error(`Invalid ${label}: ${endpoint}`);
  }
}

export function resolvePluginEndpoint(
  endpoint: string,
  endpointOverride?: string
): string {
  const normalizedOverride = endpointOverride?.trim();
  if (!normalizedOverride) {
    return endpoint;
  }

  const validatedOverride = validatePluginEndpointOverride(normalizedOverride);
  if (!validatedOverride) {
    throw new Error(
      'Invalid or unsafe plugin endpoint override. Use HTTPS for remote endpoints, ' +
        'or HTTP for localhost and private IPv4 addresses.'
    );
  }

  return validatedOverride;
}

export function resolvePluginModelsEndpoint(endpoint: string): string {
  const url = new URL(endpoint);
  url.search = '';
  url.hash = '';
  url.pathname = url.pathname === '/' ? '/' : url.pathname.replace(/\/+$/, '');

  if (url.pathname.endsWith('/models')) {
    return url.toString();
  }

  for (const suffix of [
    '/chat/completions',
    '/completions',
    '/embeddings',
    '/messages',
  ]) {
    if (url.pathname.endsWith(suffix)) {
      url.pathname = `${url.pathname.slice(0, -suffix.length)}/models`;
      return url.toString();
    }
  }

  const basePath = url.pathname === '/' ? '' : url.pathname;
  url.pathname = `${basePath}/models`;
  return url.toString();
}

export function applyModelEndpointTemplate(
  endpoint: string,
  model: string
): string {
  const encodedModelPath = model
    .split('/')
    .map(segment => encodeURIComponent(segment))
    .join('/');
  return endpoint.replace('{model}', encodedModelPath);
}

export function buildPluginAuthHeaders(
  plugin: Plugin,
  apiKey?: string | null
): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (apiKey && plugin.auth.header) {
    headers[plugin.auth.header] = plugin.auth.prefix
      ? `${plugin.auth.prefix}${apiKey}`
      : apiKey;
  }

  return headers;
}

export function pluginRequiresApiKey(plugin: Pick<Plugin, 'auth'>): boolean {
  return Boolean(plugin.auth.header || plugin.auth.key_env);
}

export function buildPluginModelDiscoveryHeaders(
  plugin: Plugin,
  apiKey?: string | null
): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
  };

  if (apiKey && plugin.auth.header) {
    headers[plugin.auth.header] = plugin.auth.prefix
      ? `${plugin.auth.prefix}${apiKey}`
      : apiKey;
  }

  if (plugin.id === 'anthropic') {
    headers['anthropic-version'] = '2023-06-01';
  }

  return headers;
}
