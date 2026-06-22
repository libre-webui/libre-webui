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

test('settings modal lazy-loads and switches languages from async locale chunks', async ({
  page,
}) => {
  await mockLibreWebUiApi(page);
  await page.goto('/chat');

  await page.keyboard.press('Control+,');

  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();

  await page.getByTestId('language-switcher-select').selectOption('fr');

  await expect(page.getByRole('heading', { name: 'Paramètres' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Langue' })).toBeVisible();
});
