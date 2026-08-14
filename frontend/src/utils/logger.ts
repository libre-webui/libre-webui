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

import { isDemoMode } from '@/utils/demoMode';

export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug';

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

const STORAGE_KEY = 'libre-webui:log-level';

const normalizeLogLevel = (level?: string): LogLevel | undefined => {
  const normalized = level?.trim().toLowerCase();

  if (
    normalized === 'silent' ||
    normalized === 'error' ||
    normalized === 'warn' ||
    normalized === 'info' ||
    normalized === 'debug'
  ) {
    return normalized;
  }

  return undefined;
};

const getStoredLogLevel = (): LogLevel | undefined => {
  try {
    return normalizeLogLevel(window.localStorage.getItem(STORAGE_KEY) || '');
  } catch (_error) {
    return undefined;
  }
};

const defaultLogLevel = (): LogLevel => {
  if (isDemoMode() || import.meta.env?.PROD) {
    return 'warn';
  }

  return import.meta.env?.VITE_DEBUG_VERBOSE === 'true' ? 'debug' : 'warn';
};

export const getLogLevel = (): LogLevel =>
  getStoredLogLevel() ||
  normalizeLogLevel(import.meta.env?.VITE_LOG_LEVEL) ||
  defaultLogLevel();

export const isLogLevelEnabled = (level: Exclude<LogLevel, 'silent'>) => {
  const currentLevel = getLogLevel();
  return LEVEL_PRIORITY[currentLevel] >= LEVEL_PRIORITY[level];
};

export const isDebugLoggingEnabled = () => isLogLevelEnabled('debug');

export interface Logger {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

export function createLogger(scope: string): Logger {
  const prefix = `[${scope}]`;

  return {
    debug: (...args: unknown[]) => {
      if (isLogLevelEnabled('debug')) {
        console.debug(prefix, ...args);
      }
    },
    info: (...args: unknown[]) => {
      if (isLogLevelEnabled('info')) {
        console.info(prefix, ...args);
      }
    },
    warn: (...args: unknown[]) => {
      if (isLogLevelEnabled('warn')) {
        console.warn(prefix, ...args);
      }
    },
    error: (...args: unknown[]) => {
      if (isLogLevelEnabled('error')) {
        console.error(prefix, ...args);
      }
    },
  };
}

export const logger = createLogger('app');
