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

export type PluginEndpointValidationError = 'invalid-url' | 'insecure-url';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const PLUGIN_MODEL_DISCOVERY_VARIABLES = new Set([
  'endpoint',
  'api_url',
  'models_endpoint',
]);

export function isPluginConnectionEndpointVariable(name: string): boolean {
  return PLUGIN_MODEL_DISCOVERY_VARIABLES.has(name);
}

export function hasPluginModelDiscoveryVariable(
  values: Record<string, unknown>
): boolean {
  return Object.keys(values).some(isPluginConnectionEndpointVariable);
}

function isPrivateIpv4Literal(hostname: string): boolean {
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

/**
 * Match the backend's endpoint override policy before variables are saved.
 * Remote endpoints require HTTPS. Plain HTTP is limited to exact loopback
 * hosts and private IPv4 literals.
 */
export function getPluginEndpointValidationError(
  endpoint: string
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

  if (url.protocol === 'https:') {
    return null;
  }

  if (
    url.protocol === 'http:' &&
    (LOOPBACK_HOSTS.has(url.hostname) || isPrivateIpv4Literal(url.hostname))
  ) {
    return null;
  }

  return 'insecure-url';
}
