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
import test from 'node:test';
import {
  HttpError,
  buildUrl,
  createHttpClient,
  isHttpError,
  prepareBody,
} from './httpClient';

type Call = { url: string; init: RequestInit };

const fakeFetch = (
  respond: (call: Call) => Response | Promise<Response>
): { fetch: typeof fetch; calls: Call[] } => {
  const calls: Call[] = [];
  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit
  ) => {
    const call = { url: String(input), init: init || {} };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

test('buildUrl joins the base, keeps absolute URLs, and serializes params', () => {
  assert.equal(buildUrl('/users', 'http://api/'), 'http://api/users');
  assert.equal(buildUrl('users', 'http://api'), 'http://api/users');
  assert.equal(buildUrl('https://x.test/a', 'http://api'), 'https://x.test/a');
  assert.equal(
    buildUrl('/search', '/api', {
      q: 'a b',
      skip: undefined,
      empty: null,
      tags: ['x', 'y'],
      page: 2,
    }),
    '/api/search?q=a+b&tags%5B%5D=x&tags%5B%5D=y&page=2'
  );
  assert.equal(
    buildUrl('/list?sort=asc', '/api', { page: 1 }),
    '/api/list?sort=asc&page=1'
  );
});

test('prepareBody encodes objects as JSON and leaves multipart to the browser', () => {
  const headers: Record<string, string> = {};
  assert.equal(prepareBody({ a: 1 }, headers), '{"a":1}');
  assert.equal(headers['Content-Type'], 'application/json');

  const form = new FormData();
  form.append('file', new Blob(['x']), 'x.txt');
  const multipart: Record<string, string> = {
    'Content-Type': 'multipart/form-data',
  };
  assert.equal(prepareBody(form, multipart), form);
  assert.deepEqual(multipart, {});

  const octet: Record<string, string> = {
    'Content-Type': 'application/octet-stream',
  };
  const blob = new Blob(['bytes']);
  assert.equal(prepareBody(blob, octet), blob);
  assert.equal(octet['Content-Type'], 'application/octet-stream');

  assert.equal(prepareBody(undefined, {}), undefined);
});

test('get sends the request hook headers and parses JSON', async () => {
  const { fetch, calls } = fakeFetch(() => json({ success: true, data: [1] }));
  const client = createHttpClient({
    baseURL: '/api',
    fetch,
    onRequest: config => ({
      ...config,
      headers: { ...(config.headers || {}), Authorization: 'Bearer t' },
    }),
  });

  const response = await client.get<{ success: boolean; data: number[] }>(
    '/items',
    { params: { limit: 5 } }
  );

  assert.equal(response.status, 200);
  assert.deepEqual(response.data, { success: true, data: [1] });
  assert.equal(calls[0].url, '/api/items?limit=5');
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(
    (calls[0].init.headers as Record<string, string>).Authorization,
    'Bearer t'
  );
});

test('post encodes JSON bodies and passes binary bodies through', async () => {
  const { fetch, calls } = fakeFetch(() => json({ ok: true }));
  const client = createHttpClient({ baseURL: '/api', fetch });

  await client.post('/things', { name: 'x' });
  assert.equal(calls[0].init.body, '{"name":"x"}');
  assert.equal(
    (calls[0].init.headers as Record<string, string>)['Content-Type'],
    'application/json'
  );

  const blob = new Blob(['raw']);
  await client.post('/blobs/1', blob, {
    headers: { 'Content-Type': 'application/octet-stream' },
  });
  assert.equal(calls[1].init.body, blob);
});

test('non-2xx responses become HttpError with the parsed body attached', async () => {
  const { fetch } = fakeFetch(() =>
    json({ success: false, message: 'nope', code: 'ACCOUNT_PENDING' }, 403)
  );
  const client = createHttpClient({ baseURL: '/api', fetch });

  await assert.rejects(client.get('/private'), (error: unknown) => {
    assert.ok(isHttpError<{ message: string; code: string }>(error));
    assert.equal(error.message, 'Request failed with status code 403');
    assert.equal(error.code, 'ERR_BAD_REQUEST');
    assert.equal(error.response?.status, 403);
    assert.equal(error.response?.data.code, 'ACCOUNT_PENDING');
    assert.equal(error.config.url, '/private');
    return true;
  });
});

test('the error hook can replace the error or recover with a response', async () => {
  const { fetch } = fakeFetch(() => json({ error: 'expired' }, 401));
  const seen: HttpError[] = [];
  const replacing = createHttpClient({
    baseURL: '/api',
    fetch,
    onError: error => {
      seen.push(error);
      throw new Error('Session expired');
    },
  });
  await assert.rejects(replacing.get('/me'), { message: 'Session expired' });
  assert.equal(seen[0]?.response?.status, 401);

  const recovering = createHttpClient({
    baseURL: '/api',
    fetch,
    onError: async error => ({ ...error.response!, data: { recovered: true } }),
  });
  const response = await recovering.get<{ recovered: boolean }>('/me');
  assert.deepEqual(response.data, { recovered: true });
});

test('responseType blob and text skip JSON parsing', async () => {
  const { fetch } = fakeFetch(
    () =>
      new Response('{"not":"parsed"}', {
        headers: { 'content-type': 'application/json' },
      })
  );
  const client = createHttpClient({ fetch });
  const asText = await client.get<string>('/x', { responseType: 'text' });
  assert.equal(asText.data, '{"not":"parsed"}');
  const asBlob = await client.get<Blob>('/x', { responseType: 'blob' });
  assert.ok(asBlob.data instanceof Blob);
  assert.equal(await asBlob.data.text(), '{"not":"parsed"}');
});

test('empty and non-JSON bodies come back as null or text', async () => {
  const client = createHttpClient({
    fetch: fakeFetch(({ url }) =>
      url.endsWith('/empty')
        ? new Response(null, { status: 204 })
        : new Response('plain words', {
            headers: { 'content-type': 'text/plain' },
          })
    ).fetch,
  });
  assert.equal((await client.delete('/empty')).data, null);
  assert.equal((await client.get('/words')).data, 'plain words');
});

test('timeouts and caller cancellation are distinguishable', async () => {
  const hanging = fakeFetch(
    ({ init }) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        );
      })
  ).fetch;

  const slow = createHttpClient({ fetch: hanging, timeout: 10 });
  await assert.rejects(slow.get('/slow'), (error: unknown) => {
    assert.ok(isHttpError(error));
    assert.equal(error.code, 'ECONNABORTED');
    assert.equal(error.message, 'timeout of 10ms exceeded');
    return true;
  });

  const controller = new AbortController();
  const cancelable = createHttpClient({ fetch: hanging, timeout: 10_000 });
  const pending = cancelable.get('/cancel', { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, (error: unknown) => {
    assert.ok(isHttpError(error));
    assert.equal(error.code, 'ERR_CANCELED');
    return true;
  });
});

test('network failures surface as ERR_NETWORK', async () => {
  const client = createHttpClient({
    fetch: (async () => {
      throw new TypeError('Failed to fetch');
    }) as typeof fetch,
  });
  await assert.rejects(client.get('/down'), (error: unknown) => {
    assert.ok(error instanceof HttpError);
    assert.equal(error.code, 'ERR_NETWORK');
    assert.equal(error.message, 'Network Error');
    return true;
  });
});
