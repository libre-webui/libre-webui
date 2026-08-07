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

const openGenerationTab = async (page: import('@playwright/test').Page) => {
  await page.goto('/chat');
  await expect(page.getByRole('textbox', { name: 'Message...' })).toBeVisible();
  await page.keyboard.press('Control+,');
  await page.getByRole('tab', { name: 'Generation', exact: true }).click();
  await page
    .getByRole('button', { name: /Advanced generation settings/ })
    .click();
};

test('generation settings save globally unless a model is chosen explicitly', async ({
  page,
}) => {
  const mockApi = await mockLibreWebUiApi(page);
  await openGenerationTab(page);

  // A chat model is always selected, which is exactly the case that used to
  // pin silently. The default has to be the values every model falls back to.
  const scope = page.getByLabel('Applies to');
  await expect(scope).toHaveValue('global');

  await page.getByRole('button', { name: /Save/ }).first().click();
  await expect
    .poll(() => mockApi.preferenceScopedWrites.length)
    .toBeGreaterThan(0);

  const globalWrite = mockApi.preferenceScopedWrites.at(-1);
  expect(globalWrite?.path).toBe('/preferences/generation-options');
  expect(globalWrite?.body).not.toHaveProperty('model');
});

test('choosing a model pins the settings to that model alone', async ({
  page,
}) => {
  const mockApi = await mockLibreWebUiApi(page);
  await openGenerationTab(page);

  const scope = page.getByLabel('Applies to');
  await scope.selectOption('model');

  await page.getByRole('button', { name: /Save/ }).first().click();
  await expect
    .poll(() => mockApi.preferenceScopedWrites.length)
    .toBeGreaterThan(0);

  const pinned = mockApi.preferenceScopedWrites.at(-1);
  expect(pinned?.path).toBe('/preferences/model-generation-options');
  expect(pinned?.body.model).toBe('llama3.2:3b');
});
