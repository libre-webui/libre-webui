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
 * The behavior mirrors what the app relied on from that package:
 * - `isOriginAllowed` decides for every request; a request without an
 *   Origin header is passed to it as `undefined` (same-origin, curl, native
 *   apps) and is normally allowed;
 * - an allowed request echoes its Origin (a request without one gets no
 *   allow-origin header) and always adds `Vary: Origin`; the echo happens
 *   only inside the allow check, so credentials are never offered to an
 *   origin the policy did not accept;
 * - a refused origin fails the request through `rejection`, which the error
 *   handler turns into a response;
 * - `credentials` adds `Access-Control-Allow-Credentials: true`;
 * - every OPTIONS request is treated as a preflight and answered with 204,
 *   the configured methods and headers, and an empty body.
 */

export interface CorsOptions {
  isOriginAllowed: (origin: string | undefined) => boolean;
  /** Error raised for a refused origin. Default: "Not allowed by CORS". */
  rejection?: (origin: string | undefined) => Error;
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
  const rejection =
    options.rejection || (() => new Error('Not allowed by CORS'));

  return (req: Request, res: Response, next: NextFunction) => {
    const requestOrigin = req.headers.origin;
    if (options.isOriginAllowed(requestOrigin)) {
      // Echo the origin only once the policy accepted this exact value.
      if (requestOrigin !== undefined) {
        res.setHeader('Access-Control-Allow-Origin', requestOrigin);
      }
    } else {
      return next(rejection(requestOrigin));
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
  };
};
