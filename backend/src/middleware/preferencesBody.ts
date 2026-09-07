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

import express, { type RequestHandler } from 'express';

const withJsonSizeLimitResponse =
  (parser: RequestHandler): RequestHandler =>
  (req, res, next) => {
    parser(req, res, error => {
      if (error?.type === 'entity.too.large') {
        // Parser rejections are client errors, not an application failure.
        res
          .status(413)
          .json({ success: false, error: 'Request body is too large' });
        return;
      }
      next(error);
    });
  };

// A 10 MiB uploaded wallpaper expands to about 13.34 MiB as a data URL.
// Parse this one write route after its existing authentication middleware.
export const preferencesUpdateJson = withJsonSizeLimitResponse(
  express.json({ limit: '16mb' })
);

export const deferPreferencesUpdateJson = (
  defaultJson: RequestHandler
): RequestHandler => {
  const parseDefault = withJsonSizeLimitResponse(defaultJson);
  return (req, res, next) => {
    if (req.method === 'PUT' && /^\/api\/preferences\/?$/i.test(req.path)) {
      next();
      return;
    }
    parseDefault(req, res, next);
  };
};
