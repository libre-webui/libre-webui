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
  userCount: 1,
  signupEnabled: true,
  version: '0.17.0-e2e',
  turnstile: { enabled: false },
};

/**
 * Live password feedback on the signup form: the meter reacts as the user
 * types, so the 12-character policy is learned before submission, not from
 * a rejection toast.
 */
test('the signup password field grades strength live against the real policy', async ({
  page,
}) => {
  await mockLibreWebUiApi(page, { systemInfo });
  await page.goto('/login');
  await page.getByRole('button', { name: 'Sign up here' }).click();

  const password = page.getByLabel('Password', { exact: true });
  // Untouched: the static requirements sentence, no meter yet.
  await expect(page.getByTestId('password-strength-meter')).toHaveCount(0);
  await expect(page.getByText(/at least 12 characters/i)).toBeVisible();

  await password.fill('short');
  const label = page.getByTestId('password-strength-label');
  await expect(label).toHaveText('Weak');

  // Length and case are met, the number is still missing.
  await password.fill('LongerPassword');
  await expect(label).toHaveText('Fair');

  // Every requirement met, minimum form.
  await password.fill('Passw0rdBasic');
  await expect(label).toHaveText('Good');
  await expect(page.getByText('At least one number')).toBeVisible();

  // Extra length pushes it to strong.
  await password.fill('Passw0rdWithRealLength');
  await expect(label).toHaveText('Strong');
});
