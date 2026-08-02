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
// https://openrouter.ai/docs/app-attribution
const OPENROUTER_APP_URL = 'https://librewebui.org';
const OPENROUTER_APP_TITLE = 'Libre WebUI';
const OPENROUTER_APP_CATEGORIES = 'general-chat,personal-agent';
export const PLUGIN_MODEL_DISCOVERY_VARIABLES = [
  'endpoint',
  'api_url',
  'models_endpoint',
  'base_url',
  'api_path',
  'api_mode',
] as const;

type PluginVariableValues = Record<string, unknown>;

function optionalPluginVariableString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined;
}

export function isPluginConnectionEndpointVariable(name: string): boolean {
  return (PLUGIN_MODEL_DISCOVERY_VARIABLES as readonly string[]).includes(name);
}

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

export function isSafePluginEndpoint(endpoint: string): boolean {
  const url = new URL(endpoint);
  return url.protocol === 'https:' || url.protocol === 'http:';
}

export function validatePluginEndpointOverride(
  endpoint: string
): string | null {
  try {
    if (!isSafePluginEndpoint(endpoint)) {
      logger.warn(
        `Rejected unsupported endpoint override: ${endpoint} (only HTTP and HTTPS URLs are allowed)`
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
        `Unsupported endpoint protocol: ${url.protocol}. Only HTTP and HTTPS URLs are allowed.`
      );
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Unsupported')) {
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
      'Invalid plugin endpoint override. Use an absolute HTTP or HTTPS URL.'
    );
  }

  return validatedOverride;
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
  const userConfiguredMode = optionalPluginString(variables.api_mode);
  const configuredMode = userConfiguredMode || plugin.api_mode;
  if (
    configuredMode !== undefined &&
    !PLUGIN_API_MODES.has(configuredMode as PluginApiMode)
  ) {
    throw new Error(`Invalid plugin API mode: ${configuredMode}`);
  }

  let apiMode =
    (configuredMode as PluginApiMode | undefined) ||
    inferPluginApiMode(plugin.endpoint);
  const endpointOverride =
    optionalPluginString(variables.endpoint) ||
    optionalPluginString(variables.api_url);
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
    const endpoint = resolvePluginEndpoint(plugin.endpoint, endpointOverride);
    apiMode = inferKnownPluginApiMode(endpoint) || apiMode;
    return { apiMode, endpoint };
  }

  const baseUrl = configuredBaseUrl || optionalPluginString(plugin.base_url);
  if (baseUrl) {
    const modeOverridesManifest =
      userConfiguredMode !== undefined &&
      userConfiguredMode !== plugin.api_mode &&
      configuredApiPath === undefined;
    const configuredPath =
      configuredApiPath ||
      (modeOverridesManifest
        ? undefined
        : optionalPluginString(plugin.api_path));
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

/**
 * Resolve a plugin's full operation URL.
 *
 * `endpoint` is the canonical variable. Imported legacy plugins may use
 * `api_url`; it is consulted only when `endpoint` is blank or absent.
 */
export function resolvePluginOperationEndpoint(
  endpoint: string,
  variables: PluginVariableValues = {}
): string {
  const endpointOverride =
    optionalPluginVariableString(variables.endpoint) ||
    optionalPluginVariableString(variables.api_url);
  return resolvePluginEndpoint(endpoint, endpointOverride);
}

export function resolvePluginModelsEndpoint(
  endpoint: string,
  modelsEndpointOverride?: string
): string {
  const explicitModelsEndpoint = optionalPluginVariableString(
    modelsEndpointOverride
  );
  if (explicitModelsEndpoint) {
    return resolvePluginEndpoint('', explicitModelsEndpoint);
  }

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
  apiKey?: string | null,
  endpoint?: string
): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (apiKey && plugin.auth.header) {
    headers[plugin.auth.header] = plugin.auth.prefix
      ? `${plugin.auth.prefix}${apiKey}`
      : apiKey;
  }

  if (endpoint) {
    Object.assign(headers, buildPluginAttributionHeaders(plugin, endpoint));
  }

  return headers;
}

export function buildPluginAttributionHeaders(
  plugin: Pick<Plugin, 'id'>,
  endpoint: string
): Record<string, string> {
  if (plugin.id !== 'openrouter') return {};

  try {
    const url = new URL(endpoint);
    if (url.protocol !== 'https:' || url.hostname !== 'openrouter.ai') {
      return {};
    }
  } catch {
    return {};
  }

  return {
    'HTTP-Referer': OPENROUTER_APP_URL,
    'X-OpenRouter-Title': OPENROUTER_APP_TITLE,
    'X-OpenRouter-Categories': OPENROUTER_APP_CATEGORIES,
  };
}

export function pluginRequiresApiKey(plugin: Pick<Plugin, 'auth'>): boolean {
  return Boolean(plugin.auth.header || plugin.auth.key_env);
}

export function buildPluginModelDiscoveryHeaders(
  plugin: Plugin,
  apiKey?: string | null,
  endpoint?: string
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

  if (endpoint) {
    Object.assign(headers, buildPluginAttributionHeaders(plugin, endpoint));
  }

  return headers;
}
