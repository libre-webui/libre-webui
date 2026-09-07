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

import { createConnection } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import type { Plugin } from 'vite';

interface BackendReadyOptions {
  waitMs?: number;
  pollMs?: number;
  probeTimeoutMs?: number;
}

function acceptsConnections(
  target: URL,
  timeoutMs: number,
  signal: AbortSignal
): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise(resolve => {
    const socket = createConnection({
      host: target.hostname.replace(/^\[|\]$/g, ''),
      port: Number(target.port || (target.protocol === 'https:' ? 443 : 80)),
    });
    let settled = false;
    const finish = (ready: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      socket.destroy();
      resolve(ready);
    };
    const abort = () => finish(false);
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.once('connect', () => finish(true));
    socket.on('error', () => finish(false));
    signal.addEventListener('abort', abort, { once: true });
  });
}

/** Hold local API requests before proxying, never replay an attempted write. */
export function backendReadyProxy(
  target: string,
  {
    waitMs = 10_000,
    pollMs = 100,
    probeTimeoutMs = 500,
  }: BackendReadyOptions = {}
): Plugin {
  const destination = new URL(target);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(
    destination.hostname.toLowerCase()
  );
  let abortProbes = () => {};
  return {
    name: 'libre-backend-ready-proxy',
    apply: 'serve',
    configureServer(server) {
      if (!local) return;
      abortProbes();
      const controller = new AbortController();
      abortProbes = () => controller.abort();
      let pending: Promise<boolean> | null = null;
      const waitForBackend = async () => {
        const deadline = Date.now() + waitMs;
        const { signal } = controller;
        while (!signal.aborted && Date.now() < deadline) {
          if (
            await acceptsConnections(
              destination,
              Math.min(probeTimeoutMs, Math.max(1, deadline - Date.now())),
              signal
            )
          )
            return true;
          try {
            await delay(
              Math.min(pollMs, Math.max(1, deadline - Date.now())),
              undefined,
              { signal }
            );
          } catch {
            return false;
          }
        }
        return false;
      };
      server.httpServer?.once('close', () => controller.abort());
      server.middlewares.use((req, res, next) => {
        if (!/^\/api(?:\/|\?|$)/.test(req.url || '')) {
          next();
          return;
        }
        if (!pending) {
          // Share the probe across startup requests, then probe afresh on the
          // next burst so backend watch-mode restarts also recover naturally.
          const attempt = waitForBackend().finally(() => {
            if (pending === attempt) pending = null;
          });
          pending = attempt;
        }
        void pending.then(ready => {
          if (res.destroyed || req.aborted) return;
          if (ready && !controller.signal.aborted) {
            next();
            return;
          }
          res.statusCode = 503;
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Cache-Control', 'no-store');
          res.setHeader('Retry-After', '1');
          res.end(
            JSON.stringify({
              success: false,
              error:
                'The development backend is unavailable. Try again shortly.',
            })
          );
        });
      });
    },
    closeBundle() {
      abortProbes();
    },
  };
}
