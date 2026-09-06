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
import { openSettingsTab } from './lib/settingsTab';

const savedLocation = { latitude: 52.37, longitude: 4.9 };

async function prepareLocationForm(page: Page, language = 'en') {
  await mockLibreWebUiApi(page, {
    preferences: {
      theme: {
        mode: 'celestial',
        accent: 'blue',
        adaptToAccent: false,
        customAccent: '#2563eb',
      },
    },
  });
  const weatherRequests: string[] = [];
  await page.route('https://api.open-meteo.com/**', route => {
    weatherRequests.push(route.request().url());
    return route.abort();
  });
  await page.addInitScript(
    ({ location, locale }) => {
      localStorage.setItem('i18nextLng', locale);
      localStorage.setItem(
        'libre-webui-celestial',
        JSON.stringify({ location, weatherEnabled: false })
      );
      Object.defineProperty(navigator, 'geolocation', {
        configurable: true,
        value: {
          getCurrentPosition: () => {
            throw new Error('Location form must not request geolocation');
          },
        },
      });
    },
    { location: savedLocation, locale: language }
  );
  await page.goto('/chat');
  await openSettingsTab(page, 'appearance');
  await expect(page.getByTestId('celestial-location')).toBeVisible();
  return weatherRequests;
}

const storedPreferences = (page: Page) =>
  page.evaluate(() =>
    JSON.parse(localStorage.getItem('libre-webui-celestial') || '{}')
  );

test('invalid coordinate drafts preserve the saved location and weather preference', async ({
  page,
}) => {
  const weatherRequests = await prepareLocationForm(page);
  const latitude = page.getByLabel('Latitude', { exact: true });
  const longitude = page.getByLabel('Longitude', { exact: true });
  const apply = page.getByTestId('celestial-apply-location');
  const summary = page.getByTestId('celestial-location-value');

  for (const [lat, lon, invalidField] of [
    ['', '12', 'latitude'],
    ['12', '', 'longitude'],
    ['90.01', '12', 'latitude'],
    ['-90.01', '12', 'latitude'],
    ['12', '180.01', 'longitude'],
    ['12', '-180.01', 'longitude'],
  ]) {
    await latitude.fill(lat);
    await longitude.fill(lon);
    await apply.click();
    await expect(
      invalidField === 'latitude' ? latitude : longitude
    ).toBeFocused();
    await expect(summary).toHaveText('52.37°, 4.90°');
    expect(await storedPreferences(page)).toEqual({
      location: savedLocation,
      weatherEnabled: false,
    });
  }

  await latitude.fill('');
  await latitude.pressSequentially('1e309');
  await longitude.fill('12');
  await apply.click();
  await expect(latitude).toBeFocused();
  expect(
    await latitude.evaluate(input => (input as HTMLInputElement).validity.valid)
  ).toBe(false);
  expect(await storedPreferences(page)).toEqual({
    location: savedLocation,
    weatherEnabled: false,
  });
  expect(weatherRequests).toEqual([]);
});

test('valid coordinates apply with Enter, retain supported precision, and only Clear removes them', async ({
  page,
}) => {
  const weatherRequests = await prepareLocationForm(page);
  const latitude = page.getByLabel('Latitude', { exact: true });
  const longitude = page.getByLabel('Longitude', { exact: true });
  const summary = page.getByTestId('celestial-location-value');

  for (const [lat, lon, expected] of [
    ['12.34567', '-98.76543', { latitude: 12.35, longitude: -98.77 }],
    ['90', '180', { latitude: 90, longitude: 180 }],
    ['-90', '-180', { latitude: -90, longitude: -180 }],
    ['0', '0', { latitude: 0, longitude: 0 }],
  ] as const) {
    await latitude.fill(lat);
    await longitude.fill(lon);
    await longitude.press('Enter');
    await expect(latitude).toHaveValue('');
    await expect(longitude).toHaveValue('');
    expect(await storedPreferences(page)).toEqual({
      location: expected,
      weatherEnabled: false,
    });
    await expect(summary).toHaveText(
      `${expected.latitude.toFixed(2)}°, ${expected.longitude.toFixed(2)}°`
    );
  }

  await page.getByTestId('celestial-clear-location').click();
  await expect(summary).toHaveText('Approximate day length');
  expect(await storedPreferences(page)).toEqual({
    location: null,
    weatherEnabled: false,
  });
  expect(weatherRequests).toEqual([]);
});

for (const language of ['en', 'ar']) {
  test(`location labels and controls fit a narrow ${language} screen`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 844 });
    const weatherRequests = await prepareLocationForm(page, language);
    const location = page.getByTestId('celestial-location');
    const latitude = page.getByTestId('celestial-latitude');
    const longitude = page.getByTestId('celestial-longitude');
    await expect(latitude).toHaveAttribute('dir', 'ltr');
    await expect(longitude).toHaveAttribute('dir', 'ltr');
    await expect(latitude).toHaveCSS('font-size', '16px');
    await expect(longitude).toHaveCSS('font-size', '16px');
    for (const control of [
      latitude,
      longitude,
      page.getByTestId('celestial-location-value'),
      page.getByTestId('celestial-apply-location'),
      page.getByTestId('celestial-use-location'),
      page.getByTestId('celestial-clear-location'),
    ]) {
      await control.scrollIntoViewIfNeeded();
      await expect(control).toBeInViewport({ ratio: 1 });
      const box = (await control.boundingBox())!;
      const container = (await location.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(container.x);
      expect(box.x + box.width).toBeLessThanOrEqual(
        container.x + container.width
      );
    }
    expect(weatherRequests).toEqual([]);
  });
}
