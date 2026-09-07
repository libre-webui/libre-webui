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

import assert from 'node:assert/strict';
import {
  createServer as createHttpServer,
  request as httpRequest,
  type ClientRequest,
  type IncomingHttpHeaders,
  type Server,
} from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import test, { type TestContext } from 'node:test';
import { createServer, type ViteDevServer } from 'vite';
import { backendReadyProxy } from './backendReady';

interface HttpResult {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

interface ReceivedRequest {
  method: string | undefined;
  url: string | undefined;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

async function listen(server: Server, port: number) {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  return (server.address() as AddressInfo).port;
}

async function close(server: Server) {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close(error => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
}

async function fixture(t: TestContext, waitMs = 3_000) {
  const directory = await mkdtemp(join(tmpdir(), 'libre-vite-ready-'));
  const received: ReceivedRequest[] = [];
  const clients = new Set<ClientRequest>();
  const arrivals = new Map<string, () => void>();
  const backend = createHttpServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      received.push({
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: Buffer.concat(chunks),
      });
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ success: true, ticket: 'fixture-ticket' }));
    });
  });
  let vite: ViteDevServer | undefined;
  t.after(async () => {
    for (const request of clients) request.destroy();
    await vite?.close();
    await close(backend);
    await rm(directory, { recursive: true, force: true });
  });

  // Reserve an ephemeral destination, then leave it unavailable until the
  // test explicitly starts it. No developer ports or configuration are used.
  const backendPort = await listen(backend, 0);
  await close(backend);
  await mkdir(join(directory, 'apix'));
  await writeFile(join(directory, 'ready.txt'), 'Vite assets are ready');
  await writeFile(join(directory, 'apix', 'ready.txt'), 'Not an API route');
  const target = `http://127.0.0.1:${backendPort}`;
  vite = await createServer({
    configFile: false,
    envFile: false,
    root: directory,
    cacheDir: join(directory, '.vite-cache'),
    publicDir: false,
    appType: 'custom',
    logLevel: 'silent',
    optimizeDeps: { noDiscovery: true, include: [] },
    plugins: [
      {
        name: 'test-request-arrival',
        configureServer(server) {
          server.middlewares.use((request, _response, next) => {
            arrivals.get(request.url || '')?.();
            arrivals.delete(request.url || '');
            next();
          });
        },
      },
      backendReadyProxy(target, {
        waitMs,
        pollMs: 10,
        probeTimeoutMs: 30,
      }),
    ],
    server: {
      host: '127.0.0.1',
      port: 0,
      strictPort: true,
      hmr: false,
      watch: null,
      proxy: { '^/api(?:/|[?]|$)': { target, changeOrigin: true } },
    },
  });
  await vite.listen();
  const port = (vite.httpServer!.address() as AddressInfo).port;

  return {
    received,
    startBackend: () => listen(backend, backendPort),
    waitForRequest: (path: string) =>
      new Promise<void>(resolve => arrivals.set(path, resolve)),
    send(path: string, body?: Buffer) {
      let client!: ClientRequest;
      const response = new Promise<HttpResult>((resolve, reject) => {
        client = httpRequest(
          `http://127.0.0.1:${port}${path}`,
          {
            method: body ? 'POST' : 'GET',
            agent: false,
            headers: body
              ? {
                  'Content-Type': 'application/json',
                  'Content-Length': body.length,
                  'X-Request-ID': 'original-ticket-request',
                }
              : {},
          },
          incoming => {
            const chunks: Buffer[] = [];
            incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
            incoming.on('error', reject);
            incoming.on('end', () =>
              resolve({
                status: incoming.statusCode || 0,
                headers: incoming.headers,
                body: Buffer.concat(chunks),
              })
            );
          }
        );
        clients.add(client);
        client.once('close', () => clients.delete(client));
        client.on('error', reject);
        client.setTimeout(5_000, () =>
          client.destroy(new Error('Fixture request timed out'))
        );
        if (body) {
          client.write(body.subarray(0, 11));
          client.write(body.subarray(11));
        }
        client.end();
      });
      return { client, response };
    },
  };
}

test(
  'Vite holds startup ticket POSTs intact while assets remain available',
  { timeout: 10_000 },
  async t => {
    const app = await fixture(t);
    const ticketPath = '/api/auth/websocket-ticket';
    const payload = Buffer.from('{\n  "audience": "chat"\n}\n');
    const paths = [ticketPath, '/api/preferences', '/api/models'];
    const arrivals = paths.map(path => app.waitForRequest(path));
    const requests = paths.map(path =>
      app.send(path, path === ticketPath ? payload : undefined)
    );
    let completed = 0;
    for (const request of requests) {
      void request.response.then(
        () => {
          completed++;
        },
        () => {
          completed++;
        }
      );
    }
    await Promise.all(arrivals);

    for (const [path, expected] of [
      ['/ready.txt', 'Vite assets are ready'],
      ['/apix/ready.txt', 'Not an API route'],
    ]) {
      const asset = await app.send(path).response;
      assert.equal(asset.status, 200);
      assert.equal(asset.body.toString(), expected);
    }
    assert.equal(
      completed,
      0,
      'API requests must still be waiting for the backend'
    );
    assert.equal(app.received.length, 0);

    await app.startBackend();
    const responses = await Promise.all(
      requests.map(request => request.response)
    );
    assert.deepEqual(
      responses.map(response => response.status),
      [200, 200, 200]
    );
    assert.deepEqual(
      app.received.map(request => request.url).sort(),
      [...paths].sort()
    );
    const tickets = app.received.filter(request => request.url === ticketPath);
    assert.equal(
      tickets.length,
      1,
      'A one-use ticket POST must be forwarded exactly once'
    );
    assert.equal(tickets[0].method, 'POST');
    assert.equal(tickets[0].headers['content-type'], 'application/json');
    assert.equal(tickets[0].headers['x-request-id'], 'original-ticket-request');
    assert.deepEqual(tickets[0].body, payload);
  }
);

test(
  'Vite returns a retryable startup timeout and recovers without replaying the expired POST',
  { timeout: 10_000 },
  async t => {
    const app = await fixture(t, 120);
    const expired = await app.send(
      '/api/auth/websocket-ticket',
      Buffer.from('{"audience":"chat"}')
    ).response;
    assert.equal(expired.status, 503);
    assert.equal(expired.headers['retry-after'], '1');
    assert.equal(expired.headers['cache-control'], 'no-store');
    assert.equal(JSON.parse(expired.body.toString()).success, false);
    assert.equal(app.received.length, 0);

    await app.startBackend();
    const recovered = await app.send('/api/preferences').response;
    assert.equal(recovered.status, 200);
    const next = await app.send('/api/models').response;
    assert.equal(next.status, 200);
    assert.deepEqual(
      app.received.map(request => request.url),
      ['/api/preferences', '/api/models']
    );
  }
);

test(
  'a client disconnected during startup is not forwarded when the backend starts',
  { timeout: 10_000 },
  async t => {
    const app = await fixture(t);
    const path = '/api/auth/websocket-ticket';
    const arrived = app.waitForRequest(path);
    const abandoned = app.send(path, Buffer.from('{"audience":"chat"}'));
    const cancelled = assert.rejects(abandoned.response, /client left/);
    await arrived;
    abandoned.client.destroy(new Error('client left'));
    await cancelled;

    await app.startBackend();
    const recovered = await app.send('/api/models').response;
    assert.equal(recovered.status, 200);
    assert.deepEqual(
      app.received.map(request => request.url),
      ['/api/models']
    );
  }
);
