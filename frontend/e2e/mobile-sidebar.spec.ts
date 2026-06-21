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
