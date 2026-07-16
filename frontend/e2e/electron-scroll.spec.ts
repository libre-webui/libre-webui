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

import { expect, Locator, Page, test } from '@playwright/test';
import { mockLibreWebUiApi } from './lib/mockApi';

test.use({
  viewport: { width: 800, height: 600 },
});

const systemInfo = {
  requiresAuth: true,
  hasUsers: true,
  userCount: 1,
  allowUserModelPull: true,
  version: '0.13.4-e2e',
  turnstile: { enabled: false },
};

const sessions = Array.from({ length: 32 }, (_, index) => ({
  id: `electron-scroll-${index + 1}`,
  title: `Desktop conversation ${index + 1}`,
  model: 'llama3.2:3b',
  messages: [],
  createdAt: Date.UTC(2026, 6, 16, 12, index),
  updatedAt: Date.UTC(2026, 6, 16, 13, index),
}));

async function expectWheelScroll(page: Page, region: Locator) {
  await expect(region).toBeVisible();
  await expect
    .poll(async () =>
      region.evaluate(element => element.scrollHeight - element.clientHeight)
    )
    .toBeGreaterThan(0);

  await region.evaluate(element => {
    element.scrollTop = 0;
  });
  await region.hover();
  await page.mouse.wheel(0, 560);

  await expect
    .poll(async () => region.evaluate(element => element.scrollTop))
    .toBeGreaterThan(0);
}

test('Electron-sized pages, sidebar history, and settings accept wheel scrolling', async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem('auth-token', 'e2e-token');
    document.documentElement.dataset.runtime = 'electron';
    document.documentElement.dataset.platform = 'darwin';
  });
  await mockLibreWebUiApi(page, { systemInfo, sessions });

  await page.goto('/artifacts');
  await expect(
    page.getByRole('heading', { name: 'Artifacts Demo' })
  ).toBeVisible();

  await expectWheelScroll(
    page,
    page.getByTestId('sidebar-session-scroll-region')
  );
  await expectWheelScroll(page, page.getByTestId('page-scroll-region'));

  await page.keyboard.press('Control+,');
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await expectWheelScroll(page, page.getByTestId('settings-scroll-region'));
});
