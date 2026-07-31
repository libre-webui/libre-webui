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

export type PluginEndpointValidationError =
  'invalid-url' | 'insecure-url' | 'query-or-fragment';

const MAX_API_PATH_DECODE_PASSES = 8;
const PLUGIN_MODEL_DISCOVERY_VARIABLES = new Set([
  'endpoint',
  'api_url',
  'models_endpoint',
  'base_url',
  'api_path',
  'api_mode',
]);

export function isPluginConnectionEndpointVariable(name: string): boolean {
  return PLUGIN_MODEL_DISCOVERY_VARIABLES.has(name);
}

export function hasPluginModelDiscoveryVariable(
  values: Record<string, unknown>
): boolean {
  return Object.keys(values).some(isPluginConnectionEndpointVariable);
}

/**
 * Match the backend's endpoint override policy before variables are saved.
 * Endpoint overrides must be absolute HTTP or HTTPS URLs.
 */
export function getPluginEndpointValidationError(
  endpoint: string,
  variableName?: string
): PluginEndpointValidationError | null {
  const normalizedEndpoint = endpoint.trim();
  if (!normalizedEndpoint) {
    return null;
  }

  let url: URL;

  try {
    url = new URL(normalizedEndpoint);
  } catch {
    return 'invalid-url';
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return 'insecure-url';
  }

  if (
    variableName?.toLowerCase().endsWith('base_url') &&
    (url.search || url.hash)
  ) {
    return 'query-or-fragment';
  }

  return null;
}

export function isPluginHttpEndpoint(endpoint: string): boolean {
  try {
    return new URL(endpoint.trim()).protocol === 'http:';
  } catch {
    return false;
  }
}

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
