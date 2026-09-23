import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const { createCorsMiddleware } = await import(
  pathToFileURL(path.resolve('backend/dist/middleware/cors.js')).href
);
const { createCorsOriginPolicy } = await import(
  pathToFileURL(path.resolve('backend/dist/utils/corsOriginPolicy.js')).href
);
const { default: express } = await import('express');

const ALLOWED = 'http://allowed.example.test';

const startApp = async ({
  allowedOrigins = [ALLOWED],
  allowNetworkOrigins = false,
} = {}) => {
  const app = express();
  app.use(
    createCorsMiddleware({
      isOriginAllowed: createCorsOriginPolicy({
        allowedOrigins,
        allowNetworkOrigins,
      }),
      rejection: () => new Error('Not allowed by CORS'),
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
      allowedHeaders: ['Content-Type', 'Authorization'],
      credentials: true,
    })
  );
  app.get('/ping', (_req, res) => {
    res.vary('Accept-Encoding');
    res.json({ ok: true });
  });
  app.use((error, _req, res, _next) => {
    res.status(500).json({ error: error.message });
  });
  const server = await new Promise(resolve => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => new Promise(resolve => server.close(resolve)) };
};

test('an allowed origin is echoed with credentials and Vary', async () => {
  const { base, close } = await startApp();
  try {
    const response = await fetch(`${base}/ping`, {
      headers: { Origin: ALLOWED },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), ALLOWED);
    assert.equal(
      response.headers.get('access-control-allow-credentials'),
      'true'
    );
    assert.equal(response.headers.get('vary'), 'Origin, Accept-Encoding');
    assert.deepEqual(await response.json(), { ok: true });
  } finally {
    await close();
  }
});

test('a preflight is answered with 204 and the configured methods and headers', async () => {
  const { base, close } = await startApp();
  try {
    const response = await fetch(`${base}/ping`, {
      method: 'OPTIONS',
      headers: {
        Origin: ALLOWED,
        'Access-Control-Request-Method': 'PUT',
        'Access-Control-Request-Headers': 'authorization,x-custom',
      },
    });
    assert.equal(response.status, 204);
    assert.equal(response.headers.get('access-control-allow-origin'), ALLOWED);
    assert.equal(
      response.headers.get('access-control-allow-methods'),
      'GET,POST,PUT,PATCH,DELETE'
    );
    assert.equal(
      response.headers.get('access-control-allow-headers'),
      'Content-Type,Authorization'
    );
    assert.equal(response.headers.get('content-length'), '0');
    assert.equal(await response.text(), '');
  } finally {
    await close();
  }
});

test('a request without an Origin gets no allow-origin header but still Vary', async () => {
  const { base, close } = await startApp();
  try {
    const response = await fetch(`${base}/ping`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
    assert.equal(response.headers.get('vary'), 'Origin, Accept-Encoding');
  } finally {
    await close();
  }
});

test('a rejected origin reaches the error handler', async () => {
  const { base, close } = await startApp();
  try {
    const response = await fetch(`${base}/ping`, {
      headers: { Origin: 'http://evil.example.test' },
    });
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: 'Not allowed by CORS' });
    assert.equal(response.headers.get('access-control-allow-origin'), null);
  } finally {
    await close();
  }
});

test('Docker and development origins require exact localhost or an allowed literal IPv4 address', () => {
  const policy = createCorsOriginPolicy({
    allowedOrigins: [ALLOWED],
    allowNetworkOrigins: true,
  });
  for (const origin of [
    'http://localhost:8080',
    'https://localhost',
    'http://127.0.0.1',
    'http://127.255.255.255:3001',
    'http://10.0.0.1',
    'https://10.255.255.255',
    'http://172.16.0.1',
    'http://172.31.255.255',
    'http://192.168.0.1',
    'http://192.168.255.255',
    'http://100.64.0.1',
    'http://100.127.255.255',
  ]) {
    assert.equal(policy(origin), true, origin);
  }
  for (const origin of [
    'https://localhost.attacker.example',
    'https://localhostevil.example',
    'https://127.attacker.example',
    'https://127.0.0.1.attacker.example',
    'https://10.attacker.example',
    'https://172.16.attacker.example',
    'https://192.168.attacker.example',
    'https://100.64.attacker.example',
    'http://localhost.',
    'http://sub.localhost',
    'http://126.255.255.255',
    'http://128.0.0.1',
    'http://172.15.255.255',
    'http://172.32.0.1',
    'http://192.169.0.1',
    'http://100.63.255.255',
    'http://100.128.0.1',
    'http://169.254.1.1',
    'http://[::1]',
    'http://[fd00::1]',
    'http://[::ffff:7f00:1]',
    'ftp://127.0.0.1',
    'chrome-extension://localhost',
  ]) {
    assert.equal(policy(origin), false, origin);
  }
});

test('native production keeps explicit origins and wildcard opt-in, including explicit IPv6 and opaque origins', () => {
  const policy = createCorsOriginPolicy({
    allowedOrigins: [
      ALLOWED,
      'http://[::1]:3001',
      'chrome-extension://abcdefghijklmnop',
      'null',
    ],
    allowNetworkOrigins: false,
  });
  assert.equal(policy(undefined), true);
  assert.equal(policy(ALLOWED), true);
  assert.equal(policy('http://[::1]:3001'), true);
  assert.equal(policy('chrome-extension://abcdefghijklmnop'), true);
  assert.equal(policy('null'), true);
  assert.equal(policy('http://127.0.0.1:3001'), false);
  assert.equal(policy('http://localhost:3001'), false);
  assert.equal(policy('http://192.168.1.2:8080'), false);
  assert.equal(policy('http://[::1]:3002'), false);
  assert.equal(policy('https://unlisted.example'), false);
  const wildcard = createCorsOriginPolicy({
    allowedOrigins: ['*'],
    allowNetworkOrigins: false,
  });
  assert.equal(wildcard('https://unlisted.example'), true);
  assert.equal(wildcard('http://[::1]:3001'), true);
  assert.equal(wildcard('chrome-extension://abcdefghijklmnop'), true);
  assert.equal(wildcard('null'), true);
  assert.equal(
    createCorsOriginPolicy({
      allowedOrigins: [ALLOWED],
      allowNetworkOrigins: true,
    })('null'),
    false
  );
});

test('malformed and ambiguous Origin values cannot become trusted through parsing or a wildcard', () => {
  const invalidOrigins = [
    '',
    null,
    42,
    {},
    [ALLOWED],
    [ALLOWED, 'https://evil.example'],
    `${ALLOWED}, https://evil.example`,
    `${ALLOWED} https://evil.example`,
    'http://localhost/path',
    'http://localhost/',
    'http://localhost?query=value',
    'http://localhost#fragment',
    'http://localhost@evil.example',
    'http://user:password@localhost',
    'http://localhost:65536',
    'http://127.1',
    'http://2130706433',
    'http://0x7f000001',
    'http://0177.0.0.1',
    'http://192.168.999.1',
    'https://LOCALHOST',
    'http://localhost:80',
    ' http://localhost',
    'http://localhost\t',
    'http://local\nhost',
    'http://localhost\\evil',
    'file:///',
    'data:text/plain,fixture',
    'chrome-extension://abcdefghijklmnop/page.html',
  ];
  for (const allowedOrigins of [
    [ALLOWED],
    ['*'],
    invalidOrigins.filter(value => typeof value === 'string'),
  ]) {
    const policy = createCorsOriginPolicy({
      allowedOrigins,
      allowNetworkOrigins: true,
    });
    for (const origin of invalidOrigins) {
      assert.equal(policy(origin), false, JSON.stringify(origin));
    }
  }
});

test('actual Docker policy rejects hostname lookalikes without reflecting credentialed CORS headers', async () => {
  const { base, close } = await startApp({ allowNetworkOrigins: true });
  try {
    for (const origin of [
      'https://localhost.attacker.example',
      'https://127.attacker.example',
      'https://10.attacker.example',
      `${ALLOWED}, https://evil.example`,
    ]) {
      for (const method of ['GET', 'OPTIONS']) {
        const response = await fetch(`${base}/ping`, {
          method,
          headers: {
            Origin: origin,
            'Access-Control-Request-Method': 'POST',
          },
        });
        assert.equal(response.status, 500, `${method} ${origin}`);
        assert.equal(response.headers.get('access-control-allow-origin'), null);
        assert.equal(
          response.headers.get('access-control-allow-credentials'),
          null
        );
        await response.arrayBuffer();
      }
    }
    const response = await fetch(`${base}/ping`, {
      headers: { Origin: 'http://192.168.1.2:8080' },
    });
    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get('access-control-allow-origin'),
      'http://192.168.1.2:8080'
    );
    assert.equal(
      response.headers.get('access-control-allow-credentials'),
      'true'
    );
    await response.arrayBuffer();
  } finally {
    await close();
  }
});

test('duplicate Origin headers are rejected rather than selecting an allowed entry', async () => {
  const { base, close } = await startApp({ allowNetworkOrigins: true });
  try {
    const response = await new Promise((resolve, reject) => {
      const request = http.get(
        `${base}/ping`,
        { headers: { Origin: [ALLOWED, 'https://evil.example'] } },
        result => {
          result.resume();
          result.on('end', () => resolve(result));
        }
      );
      request.on('error', reject);
    });
    assert.equal(response.statusCode, 500);
    assert.equal(response.headers['access-control-allow-origin'], undefined);
    assert.equal(
      response.headers['access-control-allow-credentials'],
      undefined
    );
  } finally {
    await close();
  }
});

test('middleware rejects unexpected Origin types before invoking a permissive callback', () => {
  for (const origin of [
    [ALLOWED],
    [ALLOWED, 'https://evil.example'],
    42,
    null,
  ]) {
    let policyCalls = 0;
    let rejection;
    const middleware = createCorsMiddleware({
      isOriginAllowed: () => {
        policyCalls += 1;
        return true;
      },
      credentials: true,
    });
    middleware(
      { method: 'GET', headers: { origin } },
      {
        setHeader: () => assert.fail('malformed origins must not be reflected'),
      },
      error => {
        rejection = error;
      }
    );
    assert.equal(policyCalls, 0);
    assert.match(rejection.message, /Not allowed by CORS/);
  }
});
