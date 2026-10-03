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

// A landscape tablet: wide enough for desktop layouts, so only the
// coarse-pointer rule can size controls for fingers.
test.use({ viewport: { width: 1180, height: 820 } });

const undersizedControls = (page: Page) =>
  page.evaluate(() => {
    const selector =
      'button, select, [role="button"], [role="tab"], [role="option"]';
    return Array.from(document.querySelectorAll<HTMLElement>(selector))
      .filter(element => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          style.visibility !== 'hidden' &&
          !element.closest('[aria-hidden="true"], [inert]')
        );
      })
      .map(element => {
        const rect = element.getBoundingClientRect();
        return {
          name:
            element.getAttribute('aria-label') ||
            element.textContent?.trim().slice(0, 40) ||
            element.tagName,
          width: Math.round(rect.width * 10) / 10,
          height: Math.round(rect.height * 10) / 10,
        };
      })
      .filter(control => control.width < 44 || control.height < 44);
  });

test.describe('touch tablet', () => {
  test.use({ isMobile: true, hasTouch: true });

  test('sizes every visible control for a finger', async ({ page }) => {
    await mockLibreWebUiApi(page);
    for (const path of ['/chat', '/work', '/notes']) {
      await page.goto(path);
      await expect(page.getByTestId('sidebar')).toBeVisible();
      expect(
        await page.evaluate(() => matchMedia('(pointer: coarse)').matches)
      ).toBe(true);
      expect({ path, controls: await undersizedControls(page) }).toEqual({
        path,
        controls: [],
      });
    }
  });
});

test('fine pointers keep the compact desktop density', async ({ page }) => {
  await mockLibreWebUiApi(page);
  await page.goto('/chat');
  await expect(page.getByTestId('sidebar')).toBeVisible();
  expect(
    await page.evaluate(() => matchMedia('(pointer: coarse)').matches)
  ).toBe(false);
  expect((await undersizedControls(page)).length).toBeGreaterThan(0);
});
