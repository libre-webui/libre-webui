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
  formatClock,
  getCelestialPalette,
  getCelestialScene,
  getSolarState,
  MINUTES_PER_DAY,
} from './celestial';

const june = new Date(2026, 5, 21, 12, 0, 0);
const december = new Date(2026, 11, 21, 12, 0, 0);

test('days are longer in June than in December', () => {
  const summer = getSolarState(june);
  const winter = getSolarState(december);
  assert.ok(summer.sunset - summer.sunrise > winter.sunset - winter.sunrise);
  assert.ok(summer.sunrise < winter.sunrise);
});

test('noon is bright and light, midnight is dark and starry', () => {
  const noon = getCelestialPalette(june, 13 * 60);
  const midnight = getCelestialPalette(june, 0);
  assert.equal(noon.isDark, false);
  assert.equal(midnight.isDark, true);
  assert.equal(noon.night, 0);
  assert.equal(midnight.night, 1);
  assert.ok(getCelestialScene(noon).sun.visible);
  assert.ok(!getCelestialScene(noon).moon.visible);
  assert.ok(getCelestialScene(midnight).moon.visible);
});

test('every minute of the day yields a complete, finite palette', () => {
  for (let minute = 0; minute < MINUTES_PER_DAY; minute += 7) {
    const palette = getCelestialPalette(december, minute);
    for (const value of Object.values(palette.roles)) {
      assert.match(value, /^#[0-9a-f]{6}$/, `role at ${minute}`);
    }
    assert.match(palette.sky.top, /^#[0-9a-f]{6}$/);
    assert.ok(Number.isFinite(palette.solar.altitude));
  }
});

test('adjacent minutes never jump far in colour', () => {
  const channel = (hex: string, i: number) =>
    parseInt(hex.slice(1 + 2 * i, 3 + 2 * i), 16);
  let previous = getCelestialPalette(june, 0);
  for (let minute = 1; minute < MINUTES_PER_DAY; minute += 1) {
    const next = getCelestialPalette(june, minute);
    if (next.isDark === previous.isDark) {
      for (let i = 0; i < 3; i += 1) {
        assert.ok(
          Math.abs(channel(next.sky.mid, i) - channel(previous.sky.mid, i)) <
            30,
          `sky moved too fast at minute ${minute}`
        );
      }
    }
    previous = next;
  }
});

test('a real location moves solar noon with longitude and refines day length', () => {
  const montreal = { latitude: 45.5, longitude: -73.6 };
  const tenDegreesWest = { latitude: 45.5, longitude: -83.6 };
  const here = getSolarState(june, undefined, montreal);
  const west = getSolarState(june, undefined, tenDegreesWest);
  // Ten degrees of longitude is forty minutes of solar time.
  assert.ok(Math.abs(west.solarNoon - here.solarNoon - 40) < 2);
  assert.ok(here.sunset - here.sunrise > 15 * 60);
  const tropics = getSolarState(june, undefined, {
    latitude: 5,
    longitude: -73.6,
  });
  assert.ok(tropics.sunset - tropics.sunrise < here.sunset - here.sunrise);
});

test('weather greys the sky, dims the sun, and hides the stars', () => {
  const overcast = {
    kind: 'rain' as const,
    cloudCover: 0.95,
    precipitation: 2,
    windSpeed: 30,
    fetchedAt: 0,
  };
  const clear = getCelestialPalette(june, 13 * 60);
  const rainy = getCelestialPalette(june, 13 * 60, { weather: overcast });
  const clearScene = getCelestialScene(clear);
  const rainyScene = getCelestialScene(rainy);
  assert.ok(rainyScene.cloudOpacity > clearScene.cloudOpacity);
  assert.ok(rainyScene.sun.dim < 0.5);
  assert.ok(rainyScene.rain > 0.5);
  assert.equal(rainyScene.weatherKind, 'rain');
  assert.ok(rainyScene.wind > 1);
  const night = getCelestialScene(
    getCelestialPalette(june, 0, { weather: overcast })
  );
  assert.ok(night.stars < 0.2);
});

test('the clock label reads like a wall clock', () => {
  assert.equal(formatClock(0), '12:00am');
  assert.equal(formatClock(19 * 60 + 9), '7:09pm');
  assert.equal(formatClock(19 * 60 + 9, false), '19:09');
});
