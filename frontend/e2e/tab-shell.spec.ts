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

const session = {
  id: 'tab-session',
  title: 'Garden planning notes',
  model: 'llama3.2:3b',
  createdAt: 1_710_000_000_000,
  updatedAt: 1_710_000_100_000,
  messages: [],
};

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    // Tabs persist across reloads; start each test from a clean strip.
    localStorage.removeItem('libre-webui-tabs');
  });
});

test('home is the default tab and opening a chat adds a closable tab', async ({
  page,
}) => {
  await mockLibreWebUiApi(page, { sessions: [session] });
  await page.goto('/');

  const tabs = page.getByTestId('app-tab');
  await expect(tabs).toHaveCount(1);
  await expect(tabs.first()).toHaveText(/Home/);
  await expect(page.getByTestId('home-page')).toBeVisible();

  await page.goto('/c/tab-session');
  await expect(tabs).toHaveCount(2);
  await expect(tabs.nth(1)).toHaveText(/Garden planning notes/);
  await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');

  // Home has no close affordance; the chat tab does.
  await expect(tabs.first().getByTestId('app-tab-close')).toHaveCount(0);
  await tabs.nth(1).getByTestId('app-tab-close').click();

  await expect(tabs).toHaveCount(1);
  await expect(page).toHaveURL(/\/$/);
});

test('the new-tab menu opens pages as tabs and shows their shortcuts', async ({
  page,
}) => {
  await mockLibreWebUiApi(page);
  await page.goto('/');

  await page.getByTestId('app-tab-new').click();
  const menu = page.getByTestId('app-tab-new-menu');
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem').first()).toContainText('New Chat');
  await expect(menu.getByRole('menuitem').first()).toContainText('O');

  await menu.getByRole('menuitem', { name: /Models/ }).click();
  await expect(page).toHaveURL(/\/models$/);
  await expect(page.getByTestId('app-tab')).toHaveCount(2);
});

test('the command palette opens with the keyboard and jumps to a chat', async ({
  page,
}) => {
  await mockLibreWebUiApi(page, { sessions: [session] });
  await page.goto('/');

  await expect(page.getByTestId('command-palette')).toHaveCount(0);
  await page.keyboard.press('ControlOrMeta+k');

  const palette = page.getByTestId('command-palette');
  await expect(palette).toBeVisible();

  await page.getByTestId('command-palette-input').fill('garden');
  await page.keyboard.press('Enter');

  await expect(palette).toHaveCount(0);
  await expect(page).toHaveURL(/\/c\/tab-session$/);
});

test('the sidebar search entry opens the palette and escape closes it', async ({
  page,
}) => {
  await mockLibreWebUiApi(page);
  await page.goto('/');

  await page.getByTestId('sidebar-search-button').click();
  await expect(page.getByTestId('command-palette')).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page.getByTestId('command-palette')).toHaveCount(0);
});
