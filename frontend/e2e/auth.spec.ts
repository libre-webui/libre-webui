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

test('demo mode login is click-only with disabled demo credentials', async ({
  page,
}) => {
  const port = process.env.PLAYWRIGHT_PORT || '4173';

  await mockLibreWebUiApi(page, {
    systemInfo: {
      requiresAuth: true,
      hasUsers: true,
      userCount: 1,
      allowUserModelPull: true,
      version: '0.10.0-e2e',
      turnstile: { enabled: false },
    },
  });

  await page.goto(`http://demo.localhost:${port}/login`);

  await expect(page.getByLabel('Username')).toHaveValue('demo');
  await expect(page.getByLabel('Username')).toBeDisabled();
  await expect(page.getByLabel('Password')).toHaveValue('demo');
  await expect(page.getByLabel('Password')).toBeDisabled();
  await expect(page.getByRole('button', { name: /sign in/i })).toBeEnabled();

  await page.getByRole('button', { name: /sign in/i }).click();

  await expect(page.getByText('Demo Mode')).toBeVisible();
  // Signing in lands on the Home launcher tab, not straight into a chat.
  await expect(page.getByTestId('home-page')).toBeVisible();
  await expect(page.getByTestId('home-new-chat')).toBeVisible();
  await expect(page).not.toHaveURL(/\/login$/);
});

test('one-user mode bypasses login and renders the app shell', async ({
  page,
}) => {
  await mockLibreWebUiApi(page, {
    systemInfo: {
      requiresAuth: false,
      hasUsers: true,
      userCount: 1,
      allowUserModelPull: true,
      version: '0.10.0-e2e',
      turnstile: { enabled: false },
    },
  });

  await page.goto('/login');

  await expect(page.getByTestId('app-shell-content')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Sign In' })).toHaveCount(0);
  await expect(page.getByTestId('home-page')).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
});
