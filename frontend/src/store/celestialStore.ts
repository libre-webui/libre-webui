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

import { create } from 'zustand';
import {
  getCelestialPalette,
  getCelestialScene,
  type CelestialPalette,
  type CelestialScene,
} from '@/utils/celestial';
import {
  fetchWeather,
  isValidLocation,
  roundCoordinate,
  WEATHER_REFRESH_MS,
  type CelestialLocation,
  type CelestialWeather,
} from '@/utils/celestialWeather';

/**
 * Location and the weather switch live only in this browser. They are never
 * part of the synced theme preference, so the server never learns where a
 * user is; the only network call is the opt-in weather fetch to Open-Meteo.
 */
const LOCAL_KEY = 'libre-webui-celestial';

type Persisted = {
  location?: CelestialLocation | null;
  weatherEnabled?: boolean;
};

const readLocal = (): Persisted => {
  if (typeof localStorage === 'undefined') return {};
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    const parsed = raw ? (JSON.parse(raw) as Persisted) : {};
    return {
      location: isValidLocation(parsed.location) ? parsed.location : null,
      weatherEnabled: parsed.weatherEnabled === true,
    };
  } catch {
    return {};
  }
};

const writeLocal = (value: Persisted) => {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(value));
  } catch {
    // Storage full or blocked: the setting simply does not survive a reload.
  }
};

interface CelestialState {
  /** True only while the celestial theme is the applied theme. */
  active: boolean;
  /** Latest palette while the celestial theme is active, else null. */
  palette: CelestialPalette | null;
  scene: CelestialScene | null;
  /** A minute of the day being previewed from Settings, else null. */
  previewMinutes: number | null;
  location: CelestialLocation | null;
  weatherEnabled: boolean;
  weather: CelestialWeather | null;
  weatherStatus: 'idle' | 'loading' | 'ready' | 'error';
  /** Mark the theme active; refresh() is a no-op while inactive. */
  activate: () => void;
  refresh: () => void;
  setPreviewMinutes: (minutes: number | null) => void;
  setLocation: (location: CelestialLocation | null) => void;
  /** Ask the browser once; resolves false when denied or unavailable. */
  requestBrowserLocation: () => Promise<boolean>;
  setWeatherEnabled: (enabled: boolean) => void;
  /** Fetch when enabled and the last reading is stale; safe to call often. */
  maybeRefreshWeather: (force?: boolean) => Promise<void>;
  clear: () => void;
}

export const useCelestialStore = create<CelestialState>((set, get) => {
  const persisted = readLocal();
  let weatherRequest: {
    controller: AbortController;
    promise: Promise<void>;
  } | null = null;
  let retryAt = 0;
  let retryDelay = 15_000;
  const cancelWeatherRequest = () => {
    weatherRequest?.controller.abort();
    weatherRequest = null;
    retryAt = 0;
    retryDelay = 15_000;
  };
  return {
    active: false,
    palette: null,
    scene: null,
    previewMinutes: null,
    location: persisted.location ?? null,
    weatherEnabled: persisted.weatherEnabled ?? false,
    weather: null,
    weatherStatus: 'idle',
    activate: () => set({ active: true }),
    refresh: () => {
      // Never build a sky for a theme that is not celestial: a preview reset
      // from Settings used to conjure one behind the dark UI.
      if (!get().active) return;
      const { previewMinutes, location, weatherEnabled, weather } = get();
      const palette = getCelestialPalette(
        new Date(),
        previewMinutes ?? undefined,
        {
          location,
          weather: weatherEnabled && location ? weather : null,
        }
      );
      set({ palette, scene: getCelestialScene(palette) });
    },
    setPreviewMinutes: minutes => {
      set({ previewMinutes: minutes });
      get().refresh();
    },
    setLocation: location => {
      cancelWeatherRequest();
      const next = isValidLocation(location)
        ? {
            latitude: roundCoordinate(location.latitude),
            longitude: roundCoordinate(location.longitude),
          }
        : null;
      set({ location: next, weather: null, weatherStatus: 'idle' });
      writeLocal({ location: next, weatherEnabled: get().weatherEnabled });
      get().refresh();
      if (next && get().weatherEnabled) void get().maybeRefreshWeather(true);
    },
    requestBrowserLocation: () =>
      new Promise<boolean>(resolve => {
        if (typeof navigator === 'undefined' || !navigator.geolocation) {
          resolve(false);
          return;
        }
        navigator.geolocation.getCurrentPosition(
          position => {
            get().setLocation({
              latitude: position.coords.latitude,
              longitude: position.coords.longitude,
            });
            resolve(true);
          },
          () => resolve(false),
          { enableHighAccuracy: false, maximumAge: 3_600_000, timeout: 12_000 }
        );
      }),
    setWeatherEnabled: enabled => {
      if (!enabled) cancelWeatherRequest();
      set({
        weatherEnabled: enabled,
        weatherStatus: enabled ? get().weatherStatus : 'idle',
      });
      writeLocal({ location: get().location, weatherEnabled: enabled });
      get().refresh();
      if (enabled) void get().maybeRefreshWeather(true);
    },
    maybeRefreshWeather: async (force = false) => {
      const { weatherEnabled, location, weather } = get();
      if (!weatherEnabled || !location) return;
      const fresh =
        weather && Date.now() - weather.fetchedAt < WEATHER_REFRESH_MS;
      if (!force && (fresh || Date.now() < retryAt)) return;
      if (weatherRequest) return weatherRequest.promise;
      const controller = new AbortController();
      const request = {
        controller,
        promise: fetchWeather(location, controller.signal)
          .then(next => {
            if (weatherRequest !== request) return;
            retryAt = 0;
            retryDelay = 15_000;
            set({ weather: next, weatherStatus: 'ready' });
            get().refresh();
          })
          .catch(() => {
            if (weatherRequest !== request) return;
            // Paints also run on every preview/arrival animation frame.
            // Back off after failures instead of issuing a request per frame.
            retryAt = Date.now() + retryDelay;
            retryDelay = Math.min(retryDelay * 2, 5 * 60_000);
            set({ weatherStatus: 'error' });
          })
          .finally(() => {
            if (weatherRequest === request) weatherRequest = null;
          }),
      };
      weatherRequest = request;
      set({ weatherStatus: 'loading' });
      return request.promise;
    },
    clear: () => {
      cancelWeatherRequest();
      set({
        active: false,
        palette: null,
        scene: null,
        previewMinutes: null,
        weatherStatus: get().weather ? 'ready' : 'idle',
      });
    },
  };
});
