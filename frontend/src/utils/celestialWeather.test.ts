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
  fetchWeather,
  WEATHER_ENDPOINT,
  WEATHER_TIMEOUT_MS,
} from './celestialWeather';

const location = { latitude: 50.3, longitude: 5.1 };
const current = {
  weather_code: 63,
  cloud_cover: 96,
  precipitation: 2.4,
  wind_speed_10m: 28,
};

const pendingUntilAbort = (signal: AbortSignal): Promise<never> =>
  new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    else {
      signal.addEventListener('abort', () => reject(signal.reason), {
        once: true,
      });
    }
  });

test('fetches the chosen location and returns real current conditions', async t => {
  const now = 1_800_000_000_000;
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now });
  let requestSignal: AbortSignal | null = null;
  const fetch = t.mock.method(
    globalThis,
    'fetch',
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      assert.equal(`${url.origin}${url.pathname}`, WEATHER_ENDPOINT);
      assert.equal(url.searchParams.get('latitude'), '50.3');
      assert.equal(url.searchParams.get('longitude'), '5.1');
      assert.equal(
        url.searchParams.get('current'),
        'weather_code,cloud_cover,precipitation,wind_speed_10m'
      );
      assert.equal(url.searchParams.get('timezone'), 'auto');
      requestSignal = init?.signal ?? null;
      return Response.json({ current });
    }
  );

  assert.deepEqual(await fetchWeather(location), {
    kind: 'rain',
    cloudCover: 0.96,
    precipitation: 2.4,
    windSpeed: 28,
    fetchedAt: now,
  });
  assert.equal(fetch.mock.callCount(), 1);
  assert.ok(requestSignal);
  t.mock.timers.tick(WEATHER_TIMEOUT_MS);
  assert.equal((requestSignal as AbortSignal).aborted, false);
});

test('reports service errors instead of inventing current weather', async t => {
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ error: true }, { status: 503 })
  );
  await assert.rejects(fetchWeather(location), /weather 503/);
});

test('times out a weather connection that never responds', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(
    globalThis,
    'fetch',
    (_input: RequestInfo | URL, init?: RequestInit) => {
      assert.ok(init?.signal);
      return pendingUntilAbort(init.signal);
    }
  );

  const request = fetchWeather(location);
  const rejected = assert.rejects(request, { name: 'TimeoutError' });
  t.mock.timers.tick(WEATHER_TIMEOUT_MS);
  await rejected;
});

test('times out when response headers arrive but the body stalls', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let bodyStarted!: () => void;
  const started = new Promise<void>(resolve => {
    bodyStarted = resolve;
  });
  t.mock.method(
    globalThis,
    'fetch',
    async (_input: RequestInfo | URL, init?: RequestInit) => {
      assert.ok(init?.signal);
      const signal = init.signal;
      const response = Response.json({ current });
      t.mock.method(response, 'json', () => {
        bodyStarted();
        return pendingUntilAbort(signal);
      });
      return response;
    }
  );

  const request = fetchWeather(location);
  const rejected = assert.rejects(request, { name: 'TimeoutError' });
  await started;
  t.mock.timers.tick(WEATHER_TIMEOUT_MS);
  await rejected;
});

test('cancels in-flight weather requests when the caller aborts', async t => {
  t.mock.method(
    globalThis,
    'fetch',
    (_input: RequestInfo | URL, init?: RequestInit) => {
      assert.ok(init?.signal);
      return pendingUntilAbort(init.signal);
    }
  );
  const controller = new AbortController();
  const request = fetchWeather(location, controller.signal);
  const rejected = assert.rejects(request, { name: 'AbortError' });
  controller.abort();
  await rejected;
});

test('honors an already-cancelled caller signal', async t => {
  t.mock.method(
    globalThis,
    'fetch',
    (_input: RequestInfo | URL, init?: RequestInit) => {
      assert.ok(init?.signal?.aborted);
      return pendingUntilAbort(init.signal);
    }
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(fetchWeather(location, controller.signal), {
    name: 'AbortError',
  });
});

test('rejects missing, null, and nonnumeric current conditions', async t => {
  const bodies = [
    null,
    {},
    { current: null },
    { current: {} },
    ...Object.keys(current).flatMap(key => [
      { current: { ...current, [key]: null } },
      { current: { ...current, [key]: '0' } },
    ]),
  ];
  let bodyIndex = 0;
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json(bodies[bodyIndex++])
  );

  for (const body of bodies) {
    await assert.rejects(
      fetchWeather(location),
      /weather missing current conditions/,
      JSON.stringify(body)
    );
  }
});
