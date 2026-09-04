import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const {
  providerRequest,
  ProviderHttpError,
  ProviderNetworkError,
  ProviderResponseTooLargeError,
  ProviderTimeoutError,
  isProviderRequestCancelled,
} = await import(
  pathToFileURL(path.resolve('backend/dist/utils/providerFetch.js')).href
);

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', chunk => (body += chunk));
  req.on('end', () => {
    switch (req.url) {
      case '/json':
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            method: req.method,
            body,
            ct: req.headers['content-type'] || null,
          })
        );
        return;
      case '/fail':
        res.writeHead(422, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'bad input' } }));
        return;
      case '/fail-text':
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end('boom');
        return;
      case '/slow':
        setTimeout(() => {
          res.writeHead(200);
          res.end('late');
        }, 500);
        return;
      case '/big-declared':
        res.writeHead(200, {
          'content-length': '1000',
          'content-type': 'application/octet-stream',
        });
        res.end(Buffer.alloc(1000));
        return;
      case '/big-chunked':
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        res.write(Buffer.alloc(600));
        setTimeout(() => res.end(Buffer.alloc(600)), 10);
        return;
      case '/redirect':
        res.writeHead(302, { location: '/json' });
        res.end();
        return;
      case '/drip': {
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        let sent = 0;
        const tick = setInterval(() => {
          res.write('x');
          sent += 1;
          if (sent === 6) {
            clearInterval(tick);
            res.end();
          }
        }, 40);
        return;
      }
      case '/stall':
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        res.write('{"n":1}\n');
        return;
      case '/stream':
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        res.write('{"n":1}\n');
        setTimeout(() => res.end('{"n":2}\n'), 10);
        return;
      default:
        res.writeHead(404);
        res.end();
    }
  });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

test('json requests round-trip with the JSON content type', async () => {
  const response = await providerRequest({
    url: `${base}/json`,
    json: { a: 1 },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(response.data, {
    method: 'POST',
    body: '{"a":1}',
    ct: 'application/json',
  });
  assert.equal(response.headers['content-type'], 'application/json');
  const get = await providerRequest({ url: `${base}/json` });
  assert.equal(get.data.method, 'GET');
});

test('buffers and byte responses pass through untouched', async () => {
  const response = await providerRequest({
    url: `${base}/json`,
    method: 'POST',
    body: Buffer.from('raw'),
    headers: { 'Content-Type': 'application/octet-stream' },
    responseType: 'bytes',
  });
  assert.ok(Buffer.isBuffer(response.data));
  assert.equal(JSON.parse(response.data.toString()).body, 'raw');
});

test('non-2xx responses throw with the decoded body on error.response', async () => {
  await assert.rejects(providerRequest({ url: `${base}/fail` }), error => {
    assert.ok(error instanceof ProviderHttpError);
    assert.equal(error.message, 'Request failed with status code 422');
    assert.equal(error.code, 'ERR_BAD_REQUEST');
    assert.equal(error.response.status, 422);
    assert.deepEqual(error.response.data, { error: { message: 'bad input' } });
    return true;
  });
  await assert.rejects(
    providerRequest({ url: `${base}/fail-text`, responseType: 'bytes' }),
    error => {
      assert.equal(error.code, 'ERR_BAD_RESPONSE');
      assert.ok(Buffer.isBuffer(error.response.data));
      assert.equal(error.response.data.toString(), 'boom');
      return true;
    }
  );
  await assert.rejects(
    providerRequest({ url: `${base}/fail-text`, responseType: 'stream' }),
    error => error.response.data === 'boom'
  );
});

test('timeouts and caller aborts are told apart', async () => {
  await assert.rejects(
    providerRequest({ url: `${base}/slow`, timeoutMs: 50 }),
    error => {
      assert.ok(error instanceof ProviderTimeoutError);
      assert.equal(error.code, 'ECONNABORTED');
      assert.equal(error.message, 'timeout of 50ms exceeded');
      assert.equal(isProviderRequestCancelled(error), false);
      return true;
    }
  );
  const controller = new AbortController();
  const pending = providerRequest({
    url: `${base}/slow`,
    signal: controller.signal,
    timeoutMs: 5000,
  });
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(pending, error => {
    assert.equal(error.name, 'AbortError');
    assert.equal(error.code, 'ERR_CANCELED');
    assert.ok(isProviderRequestCancelled(error));
    return true;
  });
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(
    providerRequest({ url: `${base}/json`, signal: aborted.signal }),
    error => isProviderRequestCancelled(error)
  );
});

test('oversized bodies are refused by Content-Length and by counted read', async () => {
  for (const route of ['/big-declared', '/big-chunked']) {
    await assert.rejects(
      providerRequest({
        url: `${base}${route}`,
        responseType: 'bytes',
        maxResponseBytes: 999,
      }),
      error => {
        assert.ok(error instanceof ProviderResponseTooLargeError, route);
        assert.equal(error.message, 'maxContentLength size of 999 exceeded');
        return true;
      }
    );
  }
  const fits = await providerRequest({
    url: `${base}/big-declared`,
    responseType: 'bytes',
    maxResponseBytes: 1000,
  });
  assert.equal(fits.data.length, 1000);
});

test('redirects are refused unless asked to follow', async () => {
  await assert.rejects(
    providerRequest({ url: `${base}/redirect` }),
    error => error instanceof ProviderNetworkError
  );
  const followed = await providerRequest({
    url: `${base}/redirect`,
    redirect: 'follow',
  });
  assert.equal(followed.data.method, 'GET');
});

test('stream responses are Node readables that can be destroyed', async () => {
  const response = await providerRequest({
    url: `${base}/stream`,
    responseType: 'stream',
  });
  const chunks = [];
  for await (const chunk of response.data)
    chunks.push(Buffer.from(chunk).toString());
  assert.equal(chunks.join(''), '{"n":1}\n{"n":2}\n');
  const second = await providerRequest({
    url: `${base}/stream`,
    responseType: 'stream',
  });
  assert.equal(typeof second.data.destroy, 'function');
  second.data.destroy();
});

test('unreachable hosts surface as network errors with a request marker', async () => {
  const closed = http.createServer();
  await new Promise(resolve => closed.listen(0, '127.0.0.1', resolve));
  const closedPort = closed.address().port;
  await new Promise(resolve => closed.close(resolve));
  await assert.rejects(
    providerRequest({
      url: `http://127.0.0.1:${closedPort}/nope`,
      timeoutMs: 2000,
    }),
    error => {
      assert.ok(error instanceof ProviderNetworkError);
      assert.ok('request' in error);
      assert.equal(error.code, 'ECONNREFUSED');
      return true;
    }
  );
});

test('the timeout is an idle timeout: slow but live bodies finish', async () => {
  const buffered = await providerRequest({
    url: `${base}/drip`,
    responseType: 'bytes',
    timeoutMs: 100,
  });
  assert.equal(buffered.data.toString(), 'xxxxxx');

  const streamed = await providerRequest({
    url: `${base}/drip`,
    responseType: 'stream',
    timeoutMs: 100,
  });
  const parts = [];
  for await (const chunk of streamed.data) parts.push(chunk.toString());
  assert.equal(parts.join(''), 'xxxxxx');
});

test('a stalled stream fails with a timeout error on the readable', async () => {
  const response = await providerRequest({
    url: `${base}/stall`,
    responseType: 'stream',
    timeoutMs: 100,
  });
  const seen = [];
  const failure = await new Promise(resolve => {
    response.data.on('data', chunk => seen.push(chunk.toString()));
    response.data.once('error', resolve);
    response.data.once('end', () => resolve(null));
  });
  assert.deepEqual(seen, ['{"n":1}\n']);
  assert.ok(failure instanceof ProviderTimeoutError, String(failure));
  assert.equal(failure.code, 'ECONNABORTED');
});
