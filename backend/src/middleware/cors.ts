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

import type { NextFunction, Request, Response } from 'express';

/**
 * Cross-origin resource sharing without the `cors` package.
 *
 * The behavior mirrors what the app relied on from that package with a
 * callback-style origin policy:
 * - the policy answers `true` to allow, `false` to pass the request through
 *   with no CORS headers at all, or an error to fail the request;
 * - an allowed request echoes its Origin (a request without one gets no
 *   allow-origin header) and always adds `Vary: Origin`;
 * - `credentials` adds `Access-Control-Allow-Credentials: true`;
 * - every OPTIONS request is treated as a preflight and answered with 204,
 *   the configured methods and headers, and an empty body.
 */

export type CorsOriginCallback = (error: Error | null, allow?: boolean) => void;

export interface CorsOptions {
  origin: (origin: string | undefined, callback: CorsOriginCallback) => void;
  methods?: string[];
  allowedHeaders?: string[];
  credentials?: boolean;
}

const appendVary = (res: Response, field: string) => {
  const current = res.getHeader('Vary');
  if (!current) {
    res.setHeader('Vary', field);
    return;
  }
  const existing = String(current)
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
  if (existing.includes('*')) return;
  if (!existing.some(value => value.toLowerCase() === field.toLowerCase())) {
    res.setHeader('Vary', [...existing, field].join(', '));
  }
};

export const createCorsMiddleware = (options: CorsOptions) => {
  const methods = (
    options.methods || ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE']
  ).join(',');
  const allowedHeaders = options.allowedHeaders?.join(',');

  return (req: Request, res: Response, next: NextFunction) => {
    const requestOrigin = req.headers.origin;
    options.origin(requestOrigin, (error, allow) => {
      if (error) return next(error);
      if (!allow) return next();

      if (requestOrigin) {
        res.setHeader('Access-Control-Allow-Origin', requestOrigin);
      }
      appendVary(res, 'Origin');
      if (options.credentials) {
        res.setHeader('Access-Control-Allow-Credentials', 'true');
      }

      if (req.method !== 'OPTIONS') return next();

      res.setHeader('Access-Control-Allow-Methods', methods);
      if (allowedHeaders) {
        res.setHeader('Access-Control-Allow-Headers', allowedHeaders);
      } else {
        const requested = req.headers['access-control-request-headers'];
        if (requested) {
          res.setHeader('Access-Control-Allow-Headers', requested);
          appendVary(res, 'Access-Control-Request-Headers');
        }
      }
      res.statusCode = 204;
      res.setHeader('Content-Length', '0');
      res.end();
    });
  };
};
