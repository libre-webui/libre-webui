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
import { openSettingsTab } from './lib/settingsTab';

const celestialTheme = {
  mode: 'celestial',
  accent: 'blue',
  adaptToAccent: false,
  customAccent: '#2563eb',
};

test.use({ timezoneId: 'UTC' });

for (const width of [390, 1440]) {
  for (const [hour, body] of [
    [0, 'moon'],
    [12, 'sun'],
  ] as const) {
    test(`${body} follows the sky viewport at ${width}px`, async ({ page }) => {
      const height = 844;
      await page.setViewportSize({ width, height });
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.clock.setFixedTime(
        new Date(`2026-09-05T${String(hour).padStart(2, '0')}:00:00Z`)
      );
      await mockLibreWebUiApi(page, { preferences: { theme: celestialTheme } });
      await page.goto('/chat');
      const orb = page.getByTestId(`celestial-${body}`);
      await expect(orb).toHaveCSS('opacity', '1');
      await expect
        .poll(async () => {
          const box = (await orb.boundingBox())!;
          return Math.abs(box.x + box.width / 2 - width / 2);
        })
        .toBeLessThan(1);
      const box = (await orb.boundingBox())!;
      // Solar and lunar midnight/noon arcs peak at 12% of sky height.
      expect(box.y + box.height / 2).toBeCloseTo(height * 0.12, 0);
      expect(box.x).toBeGreaterThan(0);
      expect(box.x + box.width).toBeLessThan(width);
      expect(box.y).toBeGreaterThan(0);
    });
  }
}

for (const hour of [0, 12]) {
  test(`Chat and Work share readable Celestial glass at ${hour}:00`, async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.clock.setFixedTime(
      new Date(`2026-09-05T${String(hour).padStart(2, '0')}:00:00Z`)
    );
    await mockLibreWebUiApi(page, { preferences: { theme: celestialTheme } });
    const fills: string[] = [];
    for (const [route, selector] of [
      ['/chat', '[data-composer-box]'],
      ['/work', '[data-testid="work-composer-surface"]'],
    ]) {
      await page.goto(route);
      const surface = page.locator(selector);
      await expect(surface).toBeVisible();
      const before = await surface.evaluate(e => ({
        fill: getComputedStyle(e).backgroundColor,
        border: getComputedStyle(e).borderColor,
        blur: getComputedStyle(e).backdropFilter,
      }));
      fills.push(before.fill);
      const alpha = Number(before.fill.match(/,\s*([\d.]+)\)$/)?.[1]);
      expect(alpha).toBeGreaterThanOrEqual(0.7);
      expect(alpha).toBeLessThan(1);
      expect(before.blur).toContain('blur(');
      await surface.locator('textarea').fill('Test the writing surface');
      await expect
        .poll(() => surface.evaluate(e => getComputedStyle(e).borderColor))
        .not.toBe(before.border);
      const stacking = await page.evaluate(() => ({
        lamp: Number(
          getComputedStyle(document.querySelector('.celestial-sky__lamp')!)
            .zIndex
        ),
        content: Number(
          getComputedStyle(
            document.querySelector('[data-testid="app-shell-content"]')!
          ).zIndex
        ),
      }));
      expect(stacking.lamp).toBeLessThan(stacking.content);
    }
    expect(fills[0]).toBe(fills[1]);
  });
}

test('enabling reduced motion stops the Celestial arrival sweep', async ({
  page,
}) => {
  await page.clock.install({ time: new Date('2026-09-05T12:00:00Z') });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await mockLibreWebUiApi(page);
  await page.goto('/chat');
  await openSettingsTab(page, 'appearance');
  await page.clock.pauseAt(new Date('2026-09-05T12:00:10Z'));
  await page.getByRole('button', { name: 'Celestial', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-sweep', 'true');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.clock.runFor(64);
  await expect(page.locator('html')).not.toHaveAttribute('data-sweep');
  await expect(page.getByTestId('celestial-sky')).toHaveAttribute(
    'data-motion',
    'paused'
  );
  await expect(page.getByTestId('celestial-sky')).toHaveAttribute(
    'data-preview',
    'false'
  );
});
