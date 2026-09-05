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
import test, { type TestContext } from 'node:test';
import { useCelestialStore } from './celestialStore';

const store = useCelestialStore;
const location = { latitude: 50.3, longitude: 5.1 };
const reading = (weatherCode = 63) =>
  Response.json({
    current: {
      weather_code: weatherCode,
      cloud_cover: 96,
      precipitation: 2.4,
      wind_speed_10m: 28,
    },
  });

const setup = (t: TestContext) => {
  store.getState().setWeatherEnabled(false);
  store.getState().setLocation(location);
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000_000 });
  t.after(() => {
    store.getState().setWeatherEnabled(false);
    store.getState().setLocation(null);
    store.getState().clear();
  });
};

test('weather stays opt-in and recovers after 503 without a request per paint', async t => {
  setup(t);
  let requests = 0;
  const fetch = t.mock.method(globalThis, 'fetch', async () =>
    ++requests === 1 ? new Response(null, { status: 503 }) : reading()
  );
  await store.getState().maybeRefreshWeather();
  assert.equal(fetch.mock.callCount(), 0);

  store.getState().setWeatherEnabled(true);
  await store.getState().maybeRefreshWeather();
  assert.equal(store.getState().weatherStatus, 'error');
  for (let frame = 0; frame < 60; frame++) {
    await store.getState().maybeRefreshWeather();
  }
  t.mock.timers.tick(14_999);
  await store.getState().maybeRefreshWeather();
  assert.equal(fetch.mock.callCount(), 1);

  t.mock.timers.tick(1);
  await store.getState().maybeRefreshWeather();
  assert.equal(fetch.mock.callCount(), 2);
  assert.equal(store.getState().weatherStatus, 'ready');
  assert.equal(store.getState().weather?.kind, 'rain');
});

test('outages back off to five minutes and preserve the last successful weather', async t => {
  setup(t);
  let unavailable = false;
  const fetch = t.mock.method(globalThis, 'fetch', async () =>
    unavailable ? new Response(null, { status: 503 }) : reading()
  );
  store.getState().setWeatherEnabled(true);
  await store.getState().maybeRefreshWeather();
  const previous = store.getState().weather;
  unavailable = true;
  t.mock.timers.tick(15 * 60_000);
  await store.getState().maybeRefreshWeather();

  for (const delay of [
    15_000, 30_000, 60_000, 120_000, 240_000, 300_000, 300_000,
  ]) {
    const calls = fetch.mock.callCount();
    t.mock.timers.tick(delay - 1);
    await store.getState().maybeRefreshWeather();
    assert.equal(fetch.mock.callCount(), calls);
    assert.equal(store.getState().weather, previous);
    t.mock.timers.tick(1);
    await store.getState().maybeRefreshWeather();
    assert.equal(fetch.mock.callCount(), calls + 1);
  }

  unavailable = false;
  t.mock.timers.tick(300_000);
  await store.getState().maybeRefreshWeather();
  assert.equal(store.getState().weatherStatus, 'ready');
  assert.notEqual(store.getState().weather, previous);

  // A successful refresh resets the delay for the next temporary outage.
  unavailable = true;
  t.mock.timers.tick(15 * 60_000);
  await store.getState().maybeRefreshWeather();
  const calls = fetch.mock.callCount();
  t.mock.timers.tick(15_000);
  await store.getState().maybeRefreshWeather();
  assert.equal(fetch.mock.callCount(), calls + 1);
});

test('a stalled request times out, releases concurrent callers, and can recover', async t => {
  setup(t);
  let requests = 0;
  const fetch = t.mock.method(
    globalThis,
    'fetch',
    async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (++requests > 1) return reading();
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(init.signal?.reason)
        );
      });
    }
  );
  store.getState().setWeatherEnabled(true);
  const waiting = Promise.all([
    store.getState().maybeRefreshWeather(),
    store.getState().maybeRefreshWeather(),
  ]);
  assert.equal(fetch.mock.callCount(), 1);
  t.mock.timers.tick(10_000);
  await waiting;
  assert.equal(store.getState().weatherStatus, 'error');

  t.mock.timers.tick(15_000);
  await store.getState().maybeRefreshWeather();
  assert.equal(fetch.mock.callCount(), 2);
  assert.equal(store.getState().weatherStatus, 'ready');
});

test('changing location cancels old weather and rejects a late result', async t => {
  setup(t);
  let requests = 0;
  let finishOld!: (response: Response) => void;
  let oldSignal: AbortSignal | null | undefined;
  const fetch = t.mock.method(
    globalThis,
    'fetch',
    async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (++requests > 1) return reading(0);
      oldSignal = init?.signal;
      return new Promise<Response>(resolve => {
        finishOld = resolve;
      });
    }
  );
  store.getState().setWeatherEnabled(true);
  const oldRequest = store.getState().maybeRefreshWeather();
  store.getState().setLocation({ latitude: 45.5, longitude: -73.57 });
  assert.equal(oldSignal?.aborted, true);
  await store.getState().maybeRefreshWeather();
  assert.equal(fetch.mock.callCount(), 2);
  assert.equal(store.getState().weather?.kind, 'clear');

  finishOld(reading());
  await oldRequest;
  assert.equal(store.getState().weather?.kind, 'clear');
  assert.equal(store.getState().weatherStatus, 'ready');
});

for (const action of ['disable', 'clear', 'remove location'] as const) {
  test(`${action} cancels pending weather without accepting a late result`, async t => {
    setup(t);
    let finish!: (response: Response) => void;
    let signal: AbortSignal | null | undefined;
    t.mock.method(
      globalThis,
      'fetch',
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        signal = init?.signal;
        return new Promise<Response>(resolve => {
          finish = resolve;
        });
      }
    );
    store.getState().setWeatherEnabled(true);
    const request = store.getState().maybeRefreshWeather();
    if (action === 'disable') store.getState().setWeatherEnabled(false);
    else if (action === 'clear') store.getState().clear();
    else store.getState().setLocation(null);
    assert.equal(signal?.aborted, true);
    finish(reading());
    await request;
    assert.equal(store.getState().weatherStatus, 'idle');
    assert.equal(store.getState().weather, null);
  });
}
