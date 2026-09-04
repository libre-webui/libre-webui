import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const { createCorsMiddleware } = await import(
  pathToFileURL(path.resolve('backend/dist/middleware/cors.js')).href
);
const { default: express } = await import('express');

const ALLOWED = 'http://allowed.example.test';

const startApp = async () => {
  const app = express();
  app.use(
    createCorsMiddleware({
      origin: (origin, callback) => {
        if (!origin) return callback(null, true);
        if (origin === ALLOWED) return callback(null, true);
        if (origin === 'http://silent.example.test')
          return callback(null, false);
        callback(new Error('Not allowed by CORS'));
      },
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

test('a policy answer of false passes the request through with no CORS headers', async () => {
  const { base, close } = await startApp();
  try {
    const response = await fetch(`${base}/ping`, {
      headers: { Origin: 'http://silent.example.test' },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
    assert.equal(
      response.headers.get('access-control-allow-credentials'),
      null
    );
    assert.equal(response.headers.get('vary'), 'Accept-Encoding');
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
