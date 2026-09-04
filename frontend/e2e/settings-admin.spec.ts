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

const systemInfo = {
  requiresAuth: true,
  hasUsers: true,
  userCount: 2,
  signupEnabled: true,
  version: '0.17.0-e2e',
  turnstile: { enabled: false },
};

const admin = {
  id: 'admin-user',
  username: 'admin',
  email: 'admin@example.test',
  role: 'admin' as const,
  status: 'active' as const,
  token: 'admin-token',
};
const member = {
  id: 'member-user',
  username: 'member',
  email: 'member@example.test',
  role: 'user' as const,
  status: 'active' as const,
  token: 'member-token',
};

test('administrators reach User Management from Settings and from /users', async ({
  page,
}) => {
  await mockLibreWebUiApi(page, { systemInfo, authUsers: [admin, member] });
  await page.addInitScript(() => {
    localStorage.setItem('i18nextLng', 'en');
    localStorage.setItem('auth-token', 'admin-token');
  });

  await page.goto('/chat');
  await expect(page.getByRole('textbox', { name: 'Message...' })).toBeVisible();
  await page.keyboard.press('Control+,');
  const modal = page.getByTestId('settings-scroll-region');
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await page.getByRole('tab', { name: 'User Management' }).click();
  await expect(
    modal.getByRole('heading', { name: 'User Management', exact: true })
  ).toBeVisible();
  await expect(
    modal.getByRole('radiogroup', { name: 'Default theme' })
  ).toBeVisible();
  await expect(
    modal.getByRole('heading', { name: 'member', exact: true })
  ).toBeVisible();
  await page.keyboard.press('Escape');

  // The old page URL now opens the same tab over the home tab.
  await page.goto('/users');
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await expect(
    page
      .getByTestId('settings-scroll-region')
      .getByRole('heading', { name: 'User Management', exact: true })
  ).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
});

test('regular users do not get the Administration group', async ({ page }) => {
  await mockLibreWebUiApi(page, { systemInfo, authUsers: [admin, member] });
  await page.addInitScript(() => {
    localStorage.setItem('i18nextLng', 'en');
    localStorage.setItem('auth-token', 'member-token');
  });
  await page.goto('/chat');
  await expect(page.getByRole('textbox', { name: 'Message...' })).toBeVisible();
  await page.keyboard.press('Control+,');
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'User Management' })).toHaveCount(
    0
  );
  await expect(page.getByText('Administration')).toHaveCount(0);
});
