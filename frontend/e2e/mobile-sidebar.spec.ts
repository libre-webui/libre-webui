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

test.use({
  viewport: { width: 390, height: 844 },
  isMobile: true,
});

test('mobile navigation compacts the sidebar and pushes content aside', async ({
  page,
}) => {
  await mockLibreWebUiApi(page);

  await page.goto('/chat');

  const sidebar = page.getByTestId('sidebar');
  const appContent = page.getByTestId('app-shell-content');
  await expect(sidebar).toBeVisible();

  const expandedBox = await sidebar.boundingBox();
  expect(expandedBox).not.toBeNull();
  expect(expandedBox!.width).toBeGreaterThan(200);

  await page.getByRole('link', { name: 'Models' }).click();
  await expect(
    page.getByRole('heading', { name: 'Models', exact: true })
  ).toBeVisible();

  await expect
    .poll(async () => (await sidebar.boundingBox())?.width ?? 0)
    .toBeLessThan(100);
  await expect
    .poll(async () => (await appContent.boundingBox())?.x ?? 0)
    .toBeGreaterThan(50);
});

test('Arabic mobile navigation mirrors the sidebar and content offset', async ({
  page,
}) => {
  await mockLibreWebUiApi(page);
  await page.addInitScript(() => {
    localStorage.setItem('i18nextLng', 'ar');
  });

  await page.goto('/chat');

  const sidebar = page.getByTestId('sidebar');
  const appContent = page.getByTestId('app-shell-content');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(sidebar).toBeVisible();

  const expandedBox = await sidebar.boundingBox();
  expect(expandedBox).not.toBeNull();
  expect(expandedBox!.x + expandedBox!.width).toBeCloseTo(390, 0);

  await page.locator('a[href="/models"]').click();
  await page.waitForURL('**/models');

  await expect
    // Compact sidebar is w-18 (4.5rem) against the app's 15px root font.
    .poll(async () => (await sidebar.boundingBox())?.width ?? 0)
    .toBeCloseTo(67.5, 0);

  await expect
    .poll(async () => {
      const compactSidebarBox = await sidebar.boundingBox();
      const compactContentBox = await appContent.boundingBox();
      if (!compactSidebarBox || !compactContentBox)
        return Number.POSITIVE_INFINITY;

      return (
        compactContentBox.x + compactContentBox.width - compactSidebarBox.x
      );
    })
    .toBeLessThanOrEqual(3);
});
