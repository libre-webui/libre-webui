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
 * Live weather for the celestial theme, from Open-Meteo (no key, CORS).
 * Opt-in: nothing is fetched until the user turns it on, and the request
 * goes straight from the browser to api.open-meteo.com with the rounded
 * coordinates the user chose; the Libre WebUI server never sees them.
 */

export type WeatherKind =
  | 'clear'
  | 'partly'
  | 'overcast'
  | 'fog'
  | 'drizzle'
  | 'rain'
  | 'snow'
  | 'thunder';

export interface CelestialWeather {
  kind: WeatherKind;
  /** 0..1 */
  cloudCover: number;
  /** mm in the last hour */
  precipitation: number;
  /** km/h */
  windSpeed: number;
  fetchedAt: number;
}

export interface CelestialLocation {
  latitude: number;
  longitude: number;
}

export const WEATHER_REFRESH_MS = 15 * 60_000;
export const WEATHER_TIMEOUT_MS = 10_000;
export const WEATHER_ENDPOINT = 'https://api.open-meteo.com/v1/forecast';

/** WMO weather interpretation codes, as Open-Meteo reports them. */
export const weatherKindFromCode = (code: number): WeatherKind => {
  if (code === 0) return 'clear';
  if (code <= 2) return 'partly';
  if (code === 3) return 'overcast';
  if (code === 45 || code === 48) return 'fog';
  if (code >= 51 && code <= 57) return 'drizzle';
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return 'rain';
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow';
  if (code >= 95) return 'thunder';
  return 'partly';
};

/** Round to about a kilometre so a stored location is not a street address. */
export const roundCoordinate = (value: number): number =>
  Math.round(value * 100) / 100;

export const isValidLocation = (
  value: Partial<CelestialLocation> | null | undefined
): value is CelestialLocation =>
  !!value &&
  typeof value.latitude === 'number' &&
  typeof value.longitude === 'number' &&
  Number.isFinite(value.latitude) &&
  Number.isFinite(value.longitude) &&
  Math.abs(value.latitude) <= 90 &&
  Math.abs(value.longitude) <= 180;

export async function fetchWeather(
  location: CelestialLocation,
  signal?: AbortSignal
): Promise<CelestialWeather> {
  const url = new URL(WEATHER_ENDPOINT);
  url.searchParams.set('latitude', String(location.latitude));
  url.searchParams.set('longitude', String(location.longitude));
  url.searchParams.set(
    'current',
    'weather_code,cloud_cover,precipitation,wind_speed_10m'
  );
  url.searchParams.set('timezone', 'auto');
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  // A stalled connection (including its response body) must not prevent
  // the next weather refresh from running.
  const timeout = setTimeout(
    () =>
      controller.abort(
        new DOMException('Weather request timed out', 'TimeoutError')
      ),
    WEATHER_TIMEOUT_MS
  );
  try {
    const response = await fetch(url.toString(), { signal: controller.signal });
    if (!response.ok) throw new Error(`weather ${response.status}`);
    const body = (await response.json()) as {
      current?: {
        weather_code: number;
        cloud_cover: number;
        precipitation: number;
        wind_speed_10m: number;
      };
    } | null;
    const current = body?.current;
    if (
      !current ||
      ![
        current.weather_code,
        current.cloud_cover,
        current.precipitation,
        current.wind_speed_10m,
      ].every(Number.isFinite)
    ) {
      throw new Error('weather missing current conditions');
    }
    return {
      kind: weatherKindFromCode(current.weather_code),
      cloudCover: Math.min(1, Math.max(0, current.cloud_cover / 100)),
      precipitation: Math.max(0, current.precipitation),
      windSpeed: Math.max(0, current.wind_speed_10m),
      fetchedAt: Date.now(),
    };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}
