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

import { expect, test } from '@playwright/test';
import { mockLibreWebUiApi } from './lib/mockApi';
import { openSettingsTab, selectSettingsTab } from './lib/settingsTab';

const preferences = {
  theme: {
    mode: 'celestial',
    accent: 'blue',
    adaptToAccent: false,
    customAccent: '#2563eb',
  },
};

test.describe('celestial preview polish', () => {
  test.use({ timezoneId: 'UTC' });

  test.beforeEach(async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-09-05T12:00:00Z'));
    await page.emulateMedia({ reducedMotion: 'reduce' });
  });

  test('distinguishes live time from preview without saving settings or requesting weather', async ({
    page,
  }) => {
    const api = await mockLibreWebUiApi(page, { preferences });
    const weatherRequests: string[] = [];
    page.on('request', request => {
      if (new URL(request.url()).hostname === 'api.open-meteo.com') {
        weatherRequests.push(request.url());
      }
    });
    await page.goto('/');
    const trigger = page.getByTestId('celestial-clock-trigger');
    await expect(trigger).toHaveAccessibleDescription('Live');
    await trigger.click();
    const panel = page.getByTestId('celestial-day-popover');
    const status = panel.getByTestId('celestial-preview-status');
    const reset = panel.getByTestId('celestial-follow-clock');
    const originalWrites = api.preferenceUpdateRequests.length;
    await expect(status).toHaveText('Live');
    await expect(reset).toBeDisabled();
    await expect(
      panel.getByTestId('celestial-time-anchors').locator('span')
    ).toHaveText(['12:00am', '12:00pm', '11:59pm']);

    await panel.getByTestId('celestial-scrubber').fill('60');
    await expect(status).toHaveText('Preview');
    await expect(trigger).toHaveAccessibleDescription('Preview');
    await expect(reset).toBeEnabled();
    const ink = await page.evaluate(
      () =>
        `rgb(${getComputedStyle(document.documentElement).getPropertyValue('--color-ink').trim().split(/\s+/).join(', ')})`
    );
    await expect(reset).toHaveCSS('background-color', ink);

    await reset.click();
    await expect(status).toHaveText('Live');
    await expect(panel.getByTestId('celestial-preview-clock')).toHaveText(
      '12:00pm'
    );
    await expect(trigger).toHaveAccessibleDescription('Live');
    await expect(reset).toBeDisabled();
    expect(api.preferenceUpdateRequests).toHaveLength(originalWrites);
    expect(weatherRequests).toEqual([]);
  });

  test('keeps the clock and timeline readable in a narrow Arabic viewport', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await mockLibreWebUiApi(page, { preferences });
    await page.addInitScript(() => localStorage.setItem('i18nextLng', 'ar'));
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    const trigger = page.getByTestId('celestial-clock-trigger');
    const triggerBounds = await trigger.boundingBox();
    expect(triggerBounds!.width).toBeGreaterThanOrEqual(44);
    expect(triggerBounds!.height).toBeGreaterThanOrEqual(44);
    const tabBarBounds = await page.getByTestId('app-tab-bar').boundingBox();
    expect(triggerBounds!.y).toBeGreaterThanOrEqual(tabBarBounds!.y);
    expect(triggerBounds!.y + triggerBounds!.height).toBeLessThanOrEqual(
      tabBarBounds!.y + tabBarBounds!.height
    );
    await expect(trigger.getByTestId('celestial-clock-time')).toHaveCSS(
      'direction',
      'ltr'
    );
    await trigger.click();

    const panel = page.getByTestId('celestial-day-popover');
    await expect(panel.getByTestId('celestial-preview-status')).toHaveText(
      'مباشر'
    );
    await panel.getByTestId('celestial-scrubber').fill('780');
    await expect(panel.getByTestId('celestial-preview-status')).toHaveText(
      'معاينة'
    );
    const clock = panel.getByTestId('celestial-preview-clock');
    await expect(clock).toHaveCSS('direction', 'ltr');
    await expect(clock).toHaveText('1:00pm');
    await expect(panel.getByTestId('celestial-time-anchors')).toHaveCSS(
      'direction',
      'ltr'
    );
    for (const event of ['sunrise', 'sunset']) {
      await expect(
        panel
          .getByTestId(`celestial-preview-${event}`)
          .locator('span.tabular-nums')
      ).toHaveCSS('direction', 'ltr');
    }

    const clockBounds = await clock.boundingBox();
    const closeBounds = await panel.locator('button[aria-label]').boundingBox();
    expect(clockBounds!.x).toBeGreaterThanOrEqual(
      closeBounds!.x + closeBounds!.width
    );
    const panelBounds = await panel.boundingBox();
    expect(panelBounds!.x).toBeGreaterThanOrEqual(0);
    expect(panelBounds!.x + panelBounds!.width).toBeLessThanOrEqual(320);
    expect(panelBounds!.y + panelBounds!.height).toBeLessThanOrEqual(568);
    expect(
      await panel.evaluate(
        element => element.scrollWidth <= element.clientWidth
      )
    ).toBe(true);
  });

  test('Appearance shares the preview status and restores live time when leaving the section', async ({
    page,
  }) => {
    await mockLibreWebUiApi(page, { preferences });
    await page.goto('/');
    const settings = await openSettingsTab(page, 'appearance');
    const preview = settings.getByTestId('celestial-preview');
    await expect(preview.getByTestId('celestial-preview-status')).toHaveText(
      'Live'
    );
    await preview.getByTestId('celestial-scrubber').fill('60');
    await expect(preview.getByTestId('celestial-preview-status')).toHaveText(
      'Preview'
    );
    await selectSettingsTab(settings, 'shortcuts');
    await expect(page.getByTestId('celestial-sky')).toHaveAttribute(
      'data-preview',
      'false'
    );
    await expect(
      page.getByTestId('celestial-clock-trigger')
    ).toHaveAccessibleDescription('Live');
  });
});
