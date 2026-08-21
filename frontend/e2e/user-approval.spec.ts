/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
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
  userCount: 1,
  signupEnabled: true,
  version: '0.17.0-e2e',
  turnstile: { enabled: false },
};
const validPassword = 'SecurePassword123';

test('new registrations wait for approval and cannot enter the UI', async ({
  page,
}) => {
  await mockLibreWebUiApi(page, { systemInfo });
  await page.goto('/login');

  await page.getByRole('button', { name: 'Sign up here' }).click();
  await page.getByLabel('Username').fill('pending-user');
  await page.getByLabel(/Email/).fill('pending@example.test');
  await page.getByLabel('Password', { exact: true }).fill(validPassword);
  await page.getByLabel('Confirm Password').fill(validPassword);
  await page.getByRole('button', { name: 'Create Account' }).click();

  await expect(page.getByTestId('signup-approval-pending')).toBeVisible();
  await expect(page.getByText('Awaiting approval')).toBeVisible();
  await expect(page.getByTestId('app-shell-content')).toHaveCount(0);

  await page.getByRole('button', { name: 'Back to sign in' }).click();
  await page.getByLabel('Username').fill('pending-user');
  await page.getByLabel('Password').fill(validPassword);
  await page.getByRole('button', { name: 'Sign In', exact: true }).click();

  await expect(page.getByTestId('login-approval-pending')).toBeVisible();
  await expect(page.getByTestId('app-shell-content')).toHaveCount(0);
  await expect(page).toHaveURL(/\/login$/);
});

test('administrators are notified and can activate pending accounts', async ({
  page,
}) => {
  await mockLibreWebUiApi(page, {
    systemInfo,
    authUsers: [
      {
        id: 'admin-user',
        username: 'admin',
        email: 'admin@example.test',
        role: 'admin',
        status: 'active',
        token: 'admin-token',
      },
      {
        id: 'pending-user',
        username: 'waiting',
        email: 'waiting@example.test',
        role: 'user',
        status: 'pending',
        token: 'pending-token',
      },
    ],
  });
  await page.addInitScript(() => {
    localStorage.setItem('auth-token', 'admin-token');
  });

  await page.goto('/users');

  await expect(page.getByTestId('pending-user-notification-badge')).toHaveText(
    '1'
  );
  const pendingReview = page.getByTestId('pending-user-approvals');
  await expect(pendingReview).toContainText('waiting');
  await pendingReview.getByTestId('approve-user-button').click();

  await expect(pendingReview).toHaveCount(0);
  await expect(page.getByTestId('pending-user-notification-badge')).toHaveCount(
    0
  );
  await expect(
    page.getByRole('heading', { name: 'waiting', exact: true })
  ).toBeVisible();
});
