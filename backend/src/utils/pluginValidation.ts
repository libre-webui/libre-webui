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
const PRIVATE_NETWORK_PATTERN =
  /^(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.)/;

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
  const isPrivateNetwork = PRIVATE_NETWORK_PATTERN.test(url.hostname);

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
