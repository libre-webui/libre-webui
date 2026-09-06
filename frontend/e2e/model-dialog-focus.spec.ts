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
import { openSettingsTab } from './lib/settingsTab';

const forms = [
  {
    title: 'Copy Model',
    opener: /^Copy Model/,
    firstField: 'Source Model',
    lastAction: 'Copy Model',
  },
  {
    title: 'Create Custom Model',
    opener: /^Create Model/,
    firstField: 'Model Name',
    lastAction: 'Create Model',
  },
  {
    title: 'Test Embeddings',
    opener: /^Test Embeddings/,
    firstField: 'Embedding Model',
    lastAction: 'Generate Embeddings',
  },
];

test.beforeEach(async ({ page }) => {
  await mockLibreWebUiApi(page);
  await page.addInitScript(() => localStorage.setItem('i18nextLng', 'en'));
  await page.goto('/chat');
});

for (const form of forms) {
  test(`${form.title} keeps keyboard focus above Settings and restores its opener`, async ({
    page,
  }) => {
    const settings = await openSettingsTab(page, 'model-manager');
    await settings.getByRole('button', { name: 'Advanced Actions' }).click();
    const opener = settings.getByRole('button', { name: form.opener });
    await opener.click();

    const dialog = page.getByRole('dialog', { name: form.title, exact: true });
    const close = dialog.getByRole('button', { name: 'Close', exact: true });
    await expect(close).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(
      dialog.getByLabel(form.firstField, { exact: true })
    ).toBeFocused();

    if (form.title === 'Copy Model') {
      await dialog
        .getByLabel('Source Model', { exact: true })
        .selectOption('llama3.2:3b');
      await dialog
        .getByLabel('New Model Name', { exact: true })
        .fill('keyboard-copy');
    } else if (form.title === 'Create Custom Model') {
      await dialog
        .getByLabel('Model Name', { exact: true })
        .fill('keyboard-create');
      await dialog
        .getByLabel('Modelfile', { exact: true })
        .fill('FROM llama3.2:3b');
    } else {
      await dialog
        .getByLabel('Embedding Model', { exact: true })
        .selectOption('llama3.2:3b');
      await dialog
        .getByLabel('Input Text', { exact: true })
        .fill('Keyboard focus');
    }

    const lastAction = dialog.getByRole('button', {
      name: form.lastAction,
      exact: true,
    });
    await expect(lastAction).toBeEnabled();
    await lastAction.focus();
    await page.keyboard.press('Tab');
    await expect(close).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(lastAction).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(settings).toBeVisible();
    await expect(opener).toBeFocused();
  });
}

test('model details keeps its only button focused and closes before Settings', async ({
  page,
}) => {
  const settings = await openSettingsTab(page, 'model-manager');
  const opener = settings
    .getByRole('button', { name: 'Info', exact: true })
    .first();
  await opener.click();

  const dialog = page.getByRole('dialog', { name: /^Model Details:/ });
  const close = dialog.getByRole('button', { name: 'Close', exact: true });
  await expect(close).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(close).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(close).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(settings).toBeVisible();
  await expect(opener).toBeFocused();
});
