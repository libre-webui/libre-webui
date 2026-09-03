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
 * Delivery of the built frontend.
 *
 * Vite writes every script and stylesheet under /js and /assets with a
 * content hash in the name, so those files are immutable by construction:
 * they get a one-year cache lifetime and are compressed once per process
 * (brotli or gzip, whichever the client accepts) with the result held in
 * memory. Everything else in the dist root (index.html, the service worker,
 * the manifest, icons) is revalidated on every request so a deployment is
 * picked up immediately. Compression stays static-only on purpose: API
 * responses include streams that a buffering compressor would stall.
 */

import type { NextFunction, Request, Response } from 'express';
import express from 'express';
import { promises as fs } from 'fs';
import path from 'path';
import { brotliCompress, constants as zlibConstants, gzip } from 'zlib';
import { promisify } from 'util';

const brotliAsync = promisify(brotliCompress);
const gzipAsync = promisify(gzip);

/** A hashed Vite output: /js/name-XXXXXXXX.js or /assets/name-XXXXXXXX.css */
const HASHED_ASSET = /^\/(?:js|assets)\/[^/]+-[A-Za-z0-9_-]{8}\.(js|css|svg)$/;

export const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';
export const REVALIDATE_CACHE_CONTROL = 'no-cache';

const CONTENT_TYPES: Record<string, string> = {
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  svg: 'image/svg+xml',
};

type Encoding = 'br' | 'gzip';

/** Which encoding the client prefers among the ones we produce. */
export function pickEncoding(
  acceptEncoding: string | undefined
): Encoding | null {
  if (!acceptEncoding) return null;
  const accepted = new Map<string, number>();
  for (const part of acceptEncoding.split(',')) {
    const [name, ...params] = part.trim().split(';');
    const q = params
      .map(param => param.trim())
      .find(param => param.startsWith('q='));
    const weight = q ? Number(q.slice(2)) : 1;
    if (name)
      accepted.set(name.toLowerCase(), Number.isNaN(weight) ? 0 : weight);
  }
  const weightOf = (name: Encoding) =>
    accepted.get(name) ?? accepted.get('*') ?? 0;
  const brotli = weightOf('br');
  const gz = weightOf('gzip');
  if (brotli > 0 && brotli >= gz) return 'br';
  if (gz > 0) return 'gzip';
  return null;
}

export function isHashedAsset(pathname: string): boolean {
  return HASHED_ASSET.test(pathname);
}

/**
 * Serves hashed assets compressed and cached in memory, then falls through
 * to express.static with the right cache lifetimes for everything else.
 */
export function createStaticAssetHandlers(frontendPath: string) {
  const root = path.resolve(frontendPath);
  const compressed = new Map<string, Promise<Buffer | null>>();

  const load = (
    relative: string,
    encoding: Encoding
  ): Promise<Buffer | null> => {
    const key = `${encoding}:${relative}`;
    let pending = compressed.get(key);
    if (!pending) {
      pending = fs
        .readFile(path.join(root, relative))
        .then(raw =>
          encoding === 'br'
            ? brotliAsync(raw, {
                params: {
                  [zlibConstants.BROTLI_PARAM_QUALITY]: 9,
                  [zlibConstants.BROTLI_PARAM_SIZE_HINT]: raw.length,
                },
              })
            : gzipAsync(raw, { level: 9 })
        )
        .catch((): null => null);
      compressed.set(key, pending);
      // Do not remember a miss: the file may appear after a redeploy.
      void pending.then(result => {
        if (result === null) compressed.delete(key);
      });
    }
    return pending;
  };

  const compressedAssets = async (
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const match = HASHED_ASSET.exec(req.path);
    if (!match) return next();
    const encoding = pickEncoding(req.headers['accept-encoding'] as string);
    if (!encoding) return next();

    const body = await load(req.path.slice(1), encoding);
    if (!body) return next();

    res.setHeader('Content-Type', CONTENT_TYPES[match[1]]);
    res.setHeader('Content-Encoding', encoding);
    res.setHeader('Content-Length', body.length);
    res.setHeader('Cache-Control', IMMUTABLE_CACHE_CONTROL);
    res.setHeader('Vary', 'Accept-Encoding');
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    res.end(body);
  };

  const files = express.static(root, {
    maxAge: '1y',
    immutable: true,
    setHeaders(res, filePath) {
      const relative = `/${path.relative(root, filePath).split(path.sep).join('/')}`;
      if (!isHashedAsset(relative)) {
        res.setHeader('Cache-Control', REVALIDATE_CACHE_CONTROL);
      }
    },
  });

  return { compressedAssets, files };
}
