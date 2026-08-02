import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import express from 'express';
import { WebSocket, WebSocketServer } from 'ws';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const proxyModule = await import(
  pathToFileURL(
    path.join(
      repoRoot,
      'backend',
      'dist',
      'services',
      'workPreviewProxyService.js'
    )
  ).href
);

const { WorkPreviewProxyService, WORK_PREVIEW_PROXY_PREFIX } = proxyModule;

const listen = server =>
  new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Test server did not publish a TCP port.'));
        return;
      }
      resolve(address.port);
    });
  });

const close = server =>
  new Promise((resolve, reject) => {
    server.close(error => (error ? reject(error) : resolve()));
  });

test('Work preview proxy serves remote-safe sandboxed HTTP and WebSocket traffic', async () => {
  const requests = [];
  const upstream = createServer((request, response) => {
    requests.push({
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
      cookie: request.headers.cookie,
      forwardedFor: request.headers['x-forwarded-for'],
    });

    if (request.url === '/') {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.setHeader(
        'Set-Cookie',
        'preview-secret=must-not-escape; HttpOnly; Secure'
      );
      response.setHeader('Clear-Site-Data', '"storage"');
      response.setHeader('Alt-Svc', 'h3=":443"');
      response.setHeader('X-Frame-Options', 'SAMEORIGIN');
      response.end(`<!doctype html>
<html>
  <head>
    <link rel="stylesheet" href="/style.css" />
    <script type="module" src="/src/main.js"></script>
    <style>.hero { background: url('/hero.png'); }</style>
  </head>
  <body><form action="/submit"></form><script>fetch('/api/data')</script></body>
</html>`);
      return;
    }
    if (request.url === '/style.css') {
      response.setHeader('Content-Type', 'text/css');
      response.end(`.hero { background: url('/hero.png'); }`);
      return;
    }
    if (request.url === '/src/main.js') {
      response.setHeader('Content-Type', 'text/javascript');
      response.end(`import '/@vite/client'; fetch('/api/data');`);
      return;
    }
    if (request.url === '/redirect') {
      response.statusCode = 302;
      response.setHeader('Location', '/next?ready=1');
      response.end();
      return;
    }
    response.setHeader('Content-Type', 'text/plain');
    response.end(`upstream:${request.url}`);
  });
  const upstreamWebSockets = new WebSocketServer({ noServer: true });
  upstream.on('upgrade', (request, socket, head) => {
    upstreamWebSockets.handleUpgrade(request, socket, head, webSocket => {
      upstreamWebSockets.emit('connection', webSocket, request);
    });
  });
  upstreamWebSockets.on('connection', (webSocket, request) => {
    webSocket.on('message', value => {
      webSocket.send(`echo:${request.url}:${value.toString()}`);
    });
  });

  const upstreamPort = await listen(upstream);
  const taskId = '7b99a57d-9bf7-40fc-9511-c10b084253ff';
  let previewRecord;
  const service = new WorkPreviewProxyService(
    'preview-proxy-test-secret',
    candidateTaskId => (candidateTaskId === taskId ? previewRecord : undefined),
    '127.0.0.1'
  );
  const previewPath = service.createPreviewUrl(taskId, upstreamPort);
  previewRecord = { preview_status: 'running', preview_url: previewPath };

  const app = express();
  app.use(WORK_PREVIEW_PROXY_PREFIX, service.handleHttp);
  const proxy = createServer(app);
  proxy.on('upgrade', (request, socket, head) => {
    if (!service.tryHandleUpgrade(request, socket, head)) socket.destroy();
  });
  const proxyPort = await listen(proxy);
  const proxyOrigin = `http://127.0.0.1:${proxyPort}`;

  try {
    const rootResponse = await fetch(`${proxyOrigin}${previewPath}`, {
      headers: {
        Authorization: 'Bearer main-app-secret',
        Cookie: 'session=main-app-secret',
        'X-Forwarded-For': '203.0.113.7',
      },
    });
    assert.equal(rootResponse.status, 200);
    assert.equal(rootResponse.headers.get('set-cookie'), null);
    assert.equal(rootResponse.headers.get('clear-site-data'), null);
    assert.equal(rootResponse.headers.get('alt-svc'), null);
    assert.equal(rootResponse.headers.get('x-frame-options'), null);
    assert.equal(rootResponse.headers.get('access-control-allow-origin'), '*');
    assert.equal(rootResponse.headers.get('referrer-policy'), 'no-referrer');
    const contentSecurityPolicy =
      rootResponse.headers.get('content-security-policy') || '';
    assert.match(contentSecurityPolicy, /sandbox allow-scripts/);
    assert.doesNotMatch(contentSecurityPolicy, /allow-same-origin/);
    assert.match(contentSecurityPolicy, /frame-ancestors 'self'/);

    const html = await rootResponse.text();
    assert.match(html, new RegExp(`<base href="${previewPath}"`));
    assert.match(html, new RegExp(`href="${previewPath}style\\.css"`));
    assert.match(html, new RegExp(`src="${previewPath}src/main\\.js"`));
    assert.match(html, new RegExp(`url\\('${previewPath}hero\\.png'\\)`));
    assert.match(html, new RegExp(`fetch\\('${previewPath}api/data'\\)`));
    assert.match(html, /function PreviewWebSocket/);

    assert.equal(requests[0].authorization, undefined);
    assert.equal(requests[0].cookie, undefined);
    assert.equal(requests[0].forwardedFor, undefined);

    const css = await (
      await fetch(`${proxyOrigin}${previewPath}style.css`)
    ).text();
    assert.equal(css, `.hero { background: url('${previewPath}hero.png'); }`);

    const script = await (
      await fetch(`${proxyOrigin}${previewPath}src/main.js`)
    ).text();
    assert.equal(
      script,
      `import '${previewPath}@vite/client'; fetch('${previewPath}api/data');`
    );

    const redirect = await fetch(`${proxyOrigin}${previewPath}redirect`, {
      redirect: 'manual',
    });
    assert.equal(redirect.status, 302);
    assert.equal(
      redirect.headers.get('location'),
      `${previewPath}next?ready=1`
    );

    const requestCountBeforePreflight = requests.length;
    const preflight = await fetch(`${proxyOrigin}${previewPath}api/data`, {
      method: 'OPTIONS',
      headers: {
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type,x-preview-test',
        Origin: 'null',
      },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), '*');
    assert.equal(preflight.headers.get('access-control-allow-methods'), 'POST');
    assert.equal(requests.length, requestCountBeforePreflight);

    const webSocket = new WebSocket(
      `ws://127.0.0.1:${proxyPort}${previewPath}socket?token=dev`
    );
    const echoed = await new Promise((resolve, reject) => {
      webSocket.once('open', () => webSocket.send('ready'));
      webSocket.once('message', value => resolve(value.toString()));
      webSocket.once('error', reject);
    });
    assert.equal(echoed, 'echo:/socket?token=dev:ready');
    webSocket.close();

    const invalidPath = previewPath.replace(
      /\.[A-Za-z0-9_-]{43}\/$/,
      `.${'B'.repeat(43)}/`
    );
    assert.equal((await fetch(`${proxyOrigin}${invalidPath}`)).status, 404);

    const restartedPreviewPath = service.createPreviewUrl(taskId, upstreamPort);
    assert.notEqual(restartedPreviewPath, previewPath);
    previewRecord = {
      preview_status: 'running',
      preview_url: restartedPreviewPath,
    };
    assert.equal(
      (await fetch(`${proxyOrigin}${previewPath}`)).status,
      404,
      'restarting on the same Docker port still revokes the old URL'
    );
    assert.equal(
      (await fetch(`${proxyOrigin}${restartedPreviewPath}`)).status,
      200
    );

    previewRecord = { preview_status: 'stopped', preview_url: null };
    assert.equal(
      (await fetch(`${proxyOrigin}${restartedPreviewPath}`)).status,
      404,
      'stopping the preview revokes its signed capability URL'
    );
  } finally {
    for (const client of upstreamWebSockets.clients) client.terminate();
    await close(proxy);
    await close(upstream);
  }
});

test('Work preview proxy is wired before middleware and into upgrades', () => {
  const backendIndex = readFileSync(
    path.join(repoRoot, 'backend', 'src', 'index.ts'),
    'utf8'
  );
  const webSocketServer = readFileSync(
    path.join(repoRoot, 'backend', 'src', 'websocketServer.ts'),
    'utf8'
  );
  const runtime = readFileSync(
    path.join(repoRoot, 'backend', 'src', 'services', 'workRuntimeService.ts'),
    'utf8'
  );

  const proxyMiddleware = backendIndex.indexOf(
    'app.use(WORK_PREVIEW_PROXY_PREFIX, workPreviewProxyService.handleHttp)'
  );
  assert.ok(proxyMiddleware > 0);
  assert.ok(proxyMiddleware < backendIndex.indexOf('helmet({'));
  assert.ok(proxyMiddleware < backendIndex.indexOf('express.json('));
  assert.match(
    webSocketServer,
    /workPreviewProxyService\.tryHandleUpgrade\(request, socket, head\)/
  );
  assert.match(
    runtime,
    /workPreviewProxyService\.createPreviewUrl\(task\.id, publishedPort\)/
  );
});
