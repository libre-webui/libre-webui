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

import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { createLogger } from '../utils/logger.js';
import {
  currentLogContext,
  runWithLogContext,
} from '../observability/requestContext.js';

const logger = createLogger('middleware:index');
const accessLog = createLogger('http');

/**
 * Assign one correlation id per request. A sane inbound X-Request-Id is
 * honored so proxies can stitch traces together; anything else is replaced.
 * The id is echoed back on the response and stored in async-local context so
 * the logger and audit trail attach it without explicit plumbing.
 */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{8,64}$/;

export const requestContext = (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const inbound = req.header('x-request-id');
  const requestId =
    inbound && REQUEST_ID_PATTERN.test(inbound) ? inbound : randomUUID();
  res.setHeader('X-Request-Id', requestId);
  runWithLogContext({ requestId }, () => next());
};

/**
 * Access log with the query string stripped: query parameters can carry
 * user content or short-lived credentials, so only the path is recorded.
 * The captured context is re-entered inside the finish callback because
 * event emitters fire outside the registration's async scope.
 */
export const accessLogger = (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const start = Date.now();
  const context = currentLogContext();
  res.on('finish', () => {
    runWithLogContext(context ?? {}, () => {
      const path = req.originalUrl.split('?')[0];
      accessLog.info(
        `${req.method} ${path} ${res.statusCode} ${Date.now() - start}ms`
      );
    });
  });
  next();
};

export const errorHandler = (
  error: unknown,
  req: Request,
  res: Response,
  _next: NextFunction
) => {
  logger.error('Error:', error);

  // Default error response
  let statusCode = 500;
  let message = 'Internal server error';

  // Handle specific error types
  if (error && typeof error === 'object') {
    const err = error as { name?: string; message?: string; stack?: string };
    if (err.name === 'ValidationError') {
      statusCode = 400;
      message = 'Validation error';
    } else if (err.name === 'UnauthorizedError') {
      statusCode = 401;
      message = 'Unauthorized';
    } else if (err.message) {
      message = err.message;
    }
  }

  res.status(statusCode).json({
    success: false,
    error: message,
    ...(process.env.NODE_ENV === 'development' && {
      stack:
        error && typeof error === 'object' && 'stack' in error
          ? (error as { stack?: string }).stack
          : undefined,
    }),
  });
};

export const notFoundHandler = (
  req: Request,
  res: Response,
  _next: NextFunction
) => {
  res.status(404).json({
    success: false,
    error: 'Route not found',
    path: req.originalUrl,
  });
};

export const requestLogger = (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const start = Date.now();
  const context = currentLogContext();

  res.on('finish', () => {
    runWithLogContext(context ?? {}, () => {
      const duration = Date.now() - start;
      const path = req.originalUrl.split('?')[0];
      logger.debug(`${req.method} ${path} - ${res.statusCode} - ${duration}ms`);
    });
  });

  next();
};
