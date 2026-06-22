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

export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug';

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

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

const defaultLogLevel = (): LogLevel => {
  if (
    process.env.DEMO_MODE === 'true' ||
    process.env.VITE_DEMO_MODE === 'true'
  ) {
    return 'warn';
  }

  if (process.env.DEBUG === 'true') {
    return 'debug';
  }

  if (process.env.NODE_ENV === 'production') {
    return 'info';
  }

  if (process.env.NODE_ENV === 'test') {
    return 'warn';
  }

  return 'info';
};

export const getLogLevel = (): LogLevel =>
  normalizeLogLevel(process.env.LOG_LEVEL) || defaultLogLevel();

export const isLogLevelEnabled = (level: Exclude<LogLevel, 'silent'>) => {
  const currentLevel = getLogLevel();
  return LEVEL_PRIORITY[currentLevel] >= LEVEL_PRIORITY[level];
};

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
