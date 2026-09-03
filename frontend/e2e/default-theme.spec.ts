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

test('administrators set the instance default theme from the Users page', async ({
  page,
}) => {
  await mockLibreWebUiApi(page, {
    systemInfo: {
      requiresAuth: true,
      hasUsers: true,
      userCount: 1,
      signupEnabled: true,
      version: '0.17.0-e2e',
      turnstile: { enabled: false },
    },
    authUsers: [
      {
        id: 'admin-user',
        username: 'admin',
        email: 'admin@example.test',
        role: 'admin',
        status: 'active',
        token: 'admin-token',
      },
    ],
  });
  await page.addInitScript(() => {
    localStorage.setItem('auth-token', 'admin-token');
  });

  await page.goto('/users');

  const card = page.getByRole('radiogroup', { name: 'Default theme' });
  await expect(card.getByRole('radio', { name: 'Dark' })).toHaveAttribute(
    'aria-checked',
    'true'
  );

  const saved = page.waitForResponse(
    response =>
      response.url().endsWith('/api/preferences/default-theme') &&
      response.request().method() === 'PUT' &&
      response.request().postData()?.includes('"mode":"amoled"') === true
  );
  await card.getByRole('radio', { name: 'Pure Black' }).click();
  await saved;
  await expect(card.getByRole('radio', { name: 'Pure Black' })).toHaveAttribute(
    'aria-checked',
    'true'
  );

  // The signed-in administrator keeps their own theme; only the cached
  // instance default (used by the sign-in page) changes.
  await expect(page.locator('html')).not.toHaveClass(/amoled/);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const value = localStorage.getItem('libre-webui-instance-theme');
        return value ? JSON.parse(value).mode : undefined;
      })
    )
    .toBe('amoled');
});
