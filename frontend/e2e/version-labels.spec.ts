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

const baseSystemInfo = {
  requiresAuth: false,
  hasUsers: true,
  userCount: 1,
  signupEnabled: false,
  version: '0.19.1',
  turnstile: { enabled: false },
};

test('development image suffix appears on Home', async ({ page }) => {
  await mockLibreWebUiApi(page, { systemInfo: baseSystemInfo });
  await page.goto('/');

  await expect(page.getByTestId('app-version')).toContainText('v0.19.1-dev');
});

test('development image suffix appears on Login', async ({ page }) => {
  await mockLibreWebUiApi(page, {
    systemInfo: { ...baseSystemInfo, requiresAuth: true },
  });
  await page.goto('/login');

  await expect(page.getByTestId('app-version')).toContainText('v0.19.1-dev');
});
