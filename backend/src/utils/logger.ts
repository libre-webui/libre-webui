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

import { currentLogContext } from '../observability/requestContext.js';
import { recordOtelLog } from '../observability/otel.js';
import { redactLogFields } from './logRedaction.js';

export { redactLogFields } from './logRedaction.js';

export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug';

export type LogFormat = 'text' | 'json';

export const getLogFormat = (): LogFormat =>
  process.env.LOG_FORMAT?.trim().toLowerCase() === 'json' ? 'json' : 'text';

const writeStructuredLine = (
  level: Exclude<LogLevel, 'silent'>,
  scope: string,
  args: unknown[]
): void => {
  const messageParts: string[] = [];
  let details: Record<string, unknown> | undefined;
  for (const arg of args) {
    if (
      arg !== null &&
      typeof arg === 'object' &&
      !(arg instanceof Error) &&
      !Array.isArray(arg)
    ) {
      details = {
        ...details,
        ...(redactLogFields(arg) as Record<string, unknown>),
      };
    } else if (arg instanceof Error) {
      messageParts.push(arg.message);
      details = { ...details, errorName: arg.name };
    } else {
      messageParts.push(String(redactLogFields(arg)));
    }
  }
  const context = currentLogContext();
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    scope,
    message: messageParts.join(' '),
    ...(context?.requestId ? { requestId: context.requestId } : {}),
    ...(context?.jobId ? { jobId: context.jobId } : {}),
    ...(details && Object.keys(details).length > 0 ? { details } : {}),
  });
  const stream =
    level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  stream.write(`${line}\n`);
};

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

  const emit = (
    level: Exclude<LogLevel, 'silent'>,
    write: (...args: unknown[]) => void,
    args: unknown[]
  ) => {
    if (!isLogLevelEnabled(level)) return;
    if (level === 'warn' || level === 'error') {
      // Best-effort log export; a no-op unless OTLP is configured.
      recordOtelLog(
        level,
        scope,
        args
          .map(arg => {
            const redacted = redactLogFields(arg);
            return typeof redacted === 'string'
              ? redacted
              : JSON.stringify(redacted);
          })
          .join(' ')
      );
    }
    if (getLogFormat() === 'json') {
      writeStructuredLine(level, scope, args);
      return;
    }
    write(prefix, ...args);
  };

  return {
    debug: (...args: unknown[]) => emit('debug', console.debug, args),
    info: (...args: unknown[]) => emit('info', console.info, args),
    warn: (...args: unknown[]) => emit('warn', console.warn, args),
    error: (...args: unknown[]) => emit('error', console.error, args),
  };
}

export const logger = createLogger('app');
