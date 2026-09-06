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

import { expect, test, type Page } from '@playwright/test';
import { mockLibreWebUiApi } from './lib/mockApi';

async function openNightSky(page: Page, thunder = false) {
  await page.clock.install({
    time: thunder
      ? new Date('2026-06-21T00:00:00Z')
      : new Date(2026, 5, 21, 1, 0),
  });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await mockLibreWebUiApi(page, {
    preferences: {
      theme: {
        mode: 'celestial',
        adaptToAccent: false,
        accent: 'blue',
        customAccent: '#2563eb',
      },
    },
  });
  if (thunder) {
    await page.addInitScript(() => {
      localStorage.setItem(
        'libre-webui-celestial',
        JSON.stringify({
          location: { latitude: 0, longitude: 0 },
          weatherEnabled: true,
        })
      );
    });
    await page.route('https://api.open-meteo.com/**', route =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          current: {
            weather_code: 95,
            cloud_cover: 90,
            precipitation: 2,
            wind_speed_10m: 20,
          },
        }),
      })
    );
  }
  await page.goto('/chat');
  const sky = page.getByTestId('celestial-sky');
  await expect(sky).toBeVisible();
  await expect(page.locator('html')).not.toHaveAttribute('data-sweep', 'true');
  await expect(sky).toHaveAttribute('data-night', 'true');
  await expect(sky).toHaveAttribute('data-motion', 'active');
  return sky;
}

async function motionValues(page: Page) {
  return page.getByTestId('celestial-sky').evaluate(element => {
    const sky = element as HTMLElement;
    const root = document.documentElement;
    return [
      sky.style.getPropertyValue('--sky-px'),
      sky.style.getPropertyValue('--sky-py'),
      sky.style.getPropertyValue('--sky-scroll'),
      root.style.getPropertyValue('--lamp-x'),
      root.style.getPropertyValue('--lamp-y'),
      root.style.getPropertyValue('--lamp-pulse'),
    ];
  });
}

test('changing reduced motion live resets the sky and restores interaction when disabled', async ({
  page,
}) => {
  const sky = await openNightSky(page);
  await page.mouse.move(100, 120);
  await expect.poll(async () => (await motionValues(page))[0]).not.toBe('');
  const composer = page.getByRole('textbox', { name: 'Message...' });
  await composer.fill('A quiet night');
  await composer.press('End');
  await expect(page.locator('html')).toHaveAttribute('data-composing', 'true');

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(sky).toHaveAttribute('data-motion', 'paused');
  await expect.poll(() => motionValues(page)).toEqual(['', '', '', '', '', '']);
  await expect(page.locator('html')).not.toHaveAttribute('data-composing');
  await page.mouse.move(800, 250);
  await composer.press('ArrowLeft');
  await page.clock.runFor(50);
  expect(await motionValues(page)).toEqual(['', '', '', '', '', '']);
  await expect(page.locator('html')).toHaveClass(/celestial/);
  await expect(composer).toHaveValue('A quiet night');

  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect(sky).toHaveAttribute('data-motion', 'active');
  await page.mouse.move(200, 150);
  await expect.poll(async () => (await motionValues(page))[0]).not.toBe('');
});

test('reduced motion stops pending meteors and storm flashes without changing weather', async ({
  page,
}) => {
  const sky = await openNightSky(page, true);
  await expect(sky).toHaveAttribute('data-weather', 'thunder');
  await page.clock.fastForward(13_000);
  await expect(sky.locator('.celestial-sky__meteor')).toHaveCount(1);
  await expect(sky).toHaveAttribute('data-flash', 'true');

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(sky).toHaveAttribute('data-motion', 'paused');
  await expect(sky.locator('.celestial-sky__meteor')).toHaveCount(0);
  await expect(sky).toHaveAttribute('data-flash', 'false');
  await page.clock.fastForward(60_000);
  await expect(sky.locator('.celestial-sky__meteor')).toHaveCount(0);
  await expect(sky).toHaveAttribute('data-flash', 'false');
  await expect(sky).toHaveAttribute('data-weather', 'thunder');
  await expect(page.getByTestId('celestial-rain')).toBeVisible();

  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect(sky).toHaveAttribute('data-motion', 'active');
  await page.clock.fastForward(13_000);
  await expect(sky.locator('.celestial-sky__meteor')).toHaveCount(1);
});

test('a hidden page pauses decoration and resumes when visible again', async ({
  page,
}) => {
  const sky = await openNightSky(page);
  await page.mouse.move(200, 100);
  await expect.poll(async () => (await motionValues(page))[0]).not.toBe('');
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(sky).toHaveAttribute('data-motion', 'paused');
  await expect.poll(() => motionValues(page)).toEqual(['', '', '', '', '', '']);
  await page.clock.fastForward(60_000);
  await expect(sky.locator('.celestial-sky__meteor')).toHaveCount(0);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(sky).toHaveAttribute('data-motion', 'active');
  await page.mouse.move(600, 100);
  await expect.poll(async () => (await motionValues(page))[0]).not.toBe('');
  await page.clock.fastForward(13_000);
  await expect(sky.locator('.celestial-sky__meteor')).toHaveCount(1);
});
