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
 * Get the API base URL using consistent logic across the application
 */

import { createLogger, isDebugLoggingEnabled } from '@/utils/logger';

const logger = createLogger('config');

export interface ApiUrlEnvironment {
  protocol: string;
  origin: string;
  apiBaseUrl?: string;
}

export function resolveApiBaseUrl(environment: ApiUrlEnvironment): string {
  // An explicit URL is useful for standalone frontend deployments and keeps
  // existing VITE_API_BASE_URL configurations authoritative.
  if (environment.apiBaseUrl?.trim()) return environment.apiBaseUrl.trim();

  // Electron cannot use the Vite dev-server proxy from a file:// page.
  if (environment.protocol === 'file:') {
    return 'http://localhost:3001/api';
  }

  // Browser development uses Vite's same-origin API proxy. This also makes
  // npm run dev:host work from another device without exposing port 3001.
  return `${environment.origin}/api`;
}

export const getApiBaseUrl = (): string => {
  return resolveApiBaseUrl({
    protocol: window.location.protocol,
    origin: window.location.origin,
    apiBaseUrl: import.meta.env?.VITE_API_BASE_URL,
  });
};

/**
 * API base URL constant - use this instead of duplicating the logic
 */
export const API_BASE_URL = getApiBaseUrl();
export const isVerboseDebugEnabled = isDebugLoggingEnabled();

/**
 * Log configuration information for debugging
 */
export const logConfigInfo = (): void => {
  if (!isVerboseDebugEnabled) return;

  logger.debug('API_BASE_URL configured as:', API_BASE_URL);
  logger.debug('Window location:', window.location);
  logger.debug('Environment variables:', import.meta.env);
};
