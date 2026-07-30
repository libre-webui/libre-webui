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

import type { Plugin, PluginApiMode } from '../types/index.js';
import { createLogger } from './logger.js';

const logger = createLogger('utils:plugin-validation');

const MODEL_PATTERN = /^[a-zA-Z0-9\-_:./~]+$/;
const PLUGIN_API_MODES = new Set<PluginApiMode>([
  'chat_completions',
  'responses',
]);
const MAX_API_PATH_DECODE_PASSES = 8;

export interface ResolvedPluginApiConfig {
  apiMode: PluginApiMode;
  endpoint: string;
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

export function isSafePluginEndpoint(endpoint: string): boolean {
  const url = new URL(endpoint);
  const isLocalhost = ['localhost', '127.0.0.1', '[::1]'].includes(
    url.hostname
  );
  const isPrivateNetwork = isPrivateIpv4Hostname(url.hostname);

  return url.protocol === 'https:' || isLocalhost || isPrivateNetwork;
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
  return (
    (endpointOverride && validatePluginEndpointOverride(endpointOverride)) ||
    endpoint
  );
}

function optionalPluginString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function inferKnownPluginApiMode(endpoint: string): PluginApiMode | undefined {
  try {
    const pathname = new URL(endpoint).pathname.replace(/\/+$/, '');
    if (pathname.endsWith('/responses')) return 'responses';
    if (
      pathname.endsWith('/chat/completions') ||
      pathname.endsWith('/completions')
    ) {
      return 'chat_completions';
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export function inferPluginApiMode(endpoint: string): PluginApiMode {
  return inferKnownPluginApiMode(endpoint) || 'chat_completions';
}

export function validatePluginApiPath(apiPath: string): string | null {
  const trimmed = apiPath.trim();
  if (
    !trimmed.startsWith('/') ||
    trimmed.startsWith('//') ||
    trimmed.includes('://') ||
    trimmed.includes('\\') ||
    trimmed.includes('?') ||
    trimmed.includes('#')
  ) {
    return null;
  }

  let decoded = trimmed;
  let decodingStable = false;
  for (
    let decodePass = 0;
    decodePass <= MAX_API_PATH_DECODE_PASSES;
    decodePass += 1
  ) {
    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      return null;
    }
    if (next === decoded) {
      decodingStable = true;
      break;
    }
    if (decodePass === MAX_API_PATH_DECODE_PASSES) {
      return null;
    }
    decoded = next;
  }

  if (
    !decodingStable ||
    decoded.includes('\\') ||
    decoded.includes('?') ||
    decoded.includes('#') ||
    decoded.split('/').some(segment => segment === '.' || segment === '..')
  ) {
    return null;
  }

  return `/${trimmed.replace(/^\/+|\/+$/g, '')}`;
}

function combinePluginBaseUrlAndPath(baseUrl: string, apiPath: string): string {
  assertSafePluginEndpoint(baseUrl, 'plugin base URL');
  const base = new URL(baseUrl);
  if (base.search || base.hash) {
    throw new Error(
      'Invalid plugin base URL: query strings and fragments are not supported'
    );
  }

  const validatedPath = validatePluginApiPath(apiPath);
  if (!validatedPath) {
    throw new Error(`Invalid plugin API path: ${apiPath}`);
  }

  const basePath = base.pathname.replace(/\/+$/, '');
  base.pathname = `${basePath}${validatedPath}`;
  const requiredPrefix = basePath ? `${basePath}/` : '/';
  if (base.pathname !== basePath && !base.pathname.startsWith(requiredPrefix)) {
    throw new Error(`Invalid plugin API path: ${apiPath}`);
  }
  return base.toString();
}

export function resolvePluginApiConfig(
  plugin: Pick<Plugin, 'endpoint' | 'api_mode' | 'base_url' | 'api_path'>,
  variables: Record<string, string | number | boolean> = {}
): ResolvedPluginApiConfig {
  const configuredMode =
    optionalPluginString(variables.api_mode) || plugin.api_mode;
  if (
    configuredMode !== undefined &&
    !PLUGIN_API_MODES.has(configuredMode as PluginApiMode)
  ) {
    throw new Error(`Invalid plugin API mode: ${configuredMode}`);
  }

  let apiMode =
    (configuredMode as PluginApiMode | undefined) ||
    inferPluginApiMode(plugin.endpoint);
  const endpointOverride = optionalPluginString(variables.endpoint);
  const configuredBaseUrl = optionalPluginString(variables.base_url);
  const configuredApiPath = optionalPluginString(variables.api_path);
  const hasStructuredApiOverride =
    (configuredBaseUrl !== undefined &&
      configuredBaseUrl !== optionalPluginString(plugin.base_url)) ||
    (configuredApiPath !== undefined &&
      configuredApiPath !== optionalPluginString(plugin.api_path)) ||
    (configuredMode !== undefined && configuredMode !== plugin.api_mode);
  // Older bundled manifests stored their own default endpoint as a user
  // variable. Treat that exact value as a default rather than an override so
  // upgraded users can change Base URL without first clearing stale data.
  if (
    endpointOverride &&
    (endpointOverride !== plugin.endpoint || !hasStructuredApiOverride)
  ) {
    assertSafePluginEndpoint(endpointOverride, 'plugin endpoint override');
    apiMode = inferKnownPluginApiMode(endpointOverride) || apiMode;
    return { apiMode, endpoint: endpointOverride };
  }

  const baseUrl = configuredBaseUrl || optionalPluginString(plugin.base_url);
  if (baseUrl) {
    const configuredPath =
      configuredApiPath || optionalPluginString(plugin.api_path);
    const defaultPath =
      apiMode === 'responses' ? '/responses' : '/chat/completions';
    const endpoint = combinePluginBaseUrlAndPath(
      baseUrl,
      configuredPath || defaultPath
    );
    return {
      apiMode: inferKnownPluginApiMode(endpoint) || apiMode,
      endpoint,
    };
  }

  if (optionalPluginString(variables.api_path)) {
    throw new Error('A plugin base URL is required when API path is set');
  }

  apiMode = inferKnownPluginApiMode(plugin.endpoint) || apiMode;
  return { apiMode, endpoint: plugin.endpoint };
}

export function resolvePluginModelsEndpoint(endpoint: string): string {
  const url = new URL(endpoint);
  url.search = '';
  url.hash = '';
  url.pathname = url.pathname.replace(/\/+$/, '') || '/';

  if (url.pathname.endsWith('/models')) {
    return url.toString();
  }

  for (const suffix of [
    '/chat/completions',
    '/completions',
    '/responses',
    '/embeddings',
    '/messages',
  ]) {
    if (url.pathname.endsWith(suffix)) {
      url.pathname = `${url.pathname.slice(0, -suffix.length)}/models`;
      return url.toString();
    }
  }

  const basePath =
    url.pathname === '/'
      ? ''
      : url.pathname.endsWith('/')
        ? url.pathname.slice(0, -1)
        : url.pathname;
  url.pathname = `${basePath}/models`;
  return url.toString();
}

export function applyModelEndpointTemplate(
  endpoint: string,
  model: string
): string {
  return endpoint.replace('{model}', encodeURIComponent(model));
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
