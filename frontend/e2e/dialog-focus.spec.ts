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
import { openSettingsModal, openSettingsTab } from './lib/settingsTab';

test.beforeEach(async ({ page }) => {
  await mockLibreWebUiApi(page);
  await page.route('**/api/prompts', route =>
    route.fulfill({ json: { success: true, data: [] } })
  );
  await page.goto('/chat');
  await expect(page.getByRole('textbox', { name: 'Message...' })).toBeVisible();
});

test('desktop Settings opens ready to search and restores the opener on Escape', async ({
  page,
}) => {
  const composer = page.getByRole('textbox', { name: 'Message...' });
  await composer.focus();
  const settings = await openSettingsModal(page);
  const search = settings.getByRole('searchbox', { name: 'Search' });
  await expect(search).toBeFocused();
  await page.keyboard.type('temperature');
  await expect(search).toHaveValue('temperature');
  await expect(settings.getByTestId('settings-tab-generation')).toHaveAttribute(
    'aria-selected',
    'true'
  );

  await page.keyboard.press('Escape');
  await expect(settings).toHaveCount(0);
  await expect(composer).toBeFocused();
});

test('mobile Settings focuses a visible control when search is hidden', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const composer = page.getByRole('textbox', { name: 'Message...' });
  await composer.focus();
  const settings = await openSettingsModal(page);
  const close = settings.getByRole('button', { name: 'Close', exact: true });
  await expect(close).toBeVisible();
  await expect(close).toBeFocused();
  await expect(settings.getByRole('searchbox')).toHaveCount(0);

  await page.keyboard.press('Escape');
  await expect(settings).toHaveCount(0);
  await expect(composer).toBeFocused();
});

test('a nested form preserves its requested autofocus', async ({ page }) => {
  await openSettingsTab(page, 'prompts');
  await page.getByTestId('prompt-new').click();
  await expect(page.getByTestId('prompt-modal')).toBeVisible();
  await expect(page.getByTestId('prompt-slug')).toBeFocused();
});

test('nested dialogs wrap keyboard focus and skip disabled controls', async ({
  page,
}) => {
  await openSettingsTab(page, 'prompts');
  await page.getByTestId('prompt-new').click();
  const dialog = page.getByTestId('prompt-modal');
  const close = dialog.getByRole('button', { name: 'Close', exact: true });
  const cancel = dialog.getByRole('button', { name: 'Cancel', exact: true });
  const save = dialog.getByTestId('prompt-save');
  await expect(save).toBeDisabled();

  await close.focus();
  await page.keyboard.press('Shift+Tab');
  await expect(cancel).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(close).toBeFocused();

  await dialog.getByTestId('prompt-slug').fill('focus-test');
  await dialog.getByTestId('prompt-title').fill('Focus test');
  await dialog
    .getByTestId('prompt-content')
    .fill('Describe keyboard navigation.');
  await expect(save).toBeEnabled();
  await close.focus();
  await page.keyboard.press('Shift+Tab');
  await expect(save).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(close).toBeFocused();
});

test('Escape dismisses only the foremost dialog and restores each opener', async ({
  page,
}) => {
  const composer = page.getByRole('textbox', { name: 'Message...' });
  await composer.focus();
  const settings = await openSettingsTab(page, 'prompts');
  const opener = page.getByTestId('prompt-new');
  await opener.click();
  const dialog = page.getByTestId('prompt-modal');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Close', exact: true }).focus();

  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(settings).toBeVisible();
  await expect(opener).toBeFocused();

  await opener.click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(opener).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(settings).toHaveCount(0);
  await expect(composer).toBeFocused();
});

test('the command palette keeps focus above Settings and restores its opener', async ({
  page,
}) => {
  const settings = await openSettingsTab(page, 'prompts');
  const opener = settings.getByTestId('prompt-new');
  await opener.focus();
  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog', { name: 'Search', exact: true });
  const input = palette.getByTestId('command-palette-input');
  await expect(palette).toHaveAttribute('aria-modal', 'true');
  await expect(input).toBeFocused();

  const firstAction = palette.getByRole('button').first();
  const lastAction = palette.getByRole('button').last();
  await page.keyboard.press('Tab');
  await expect(firstAction).toBeFocused();
  await input.focus();
  await page.keyboard.press('Shift+Tab');
  await expect(lastAction).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(input).toBeFocused();

  await firstAction.focus();
  await page.keyboard.press('Escape');
  await expect(palette).toHaveCount(0);
  await expect(settings).toBeVisible();
  await expect(opener).toBeFocused();

  await page.keyboard.press('Control+k');
  await expect(input).toBeFocused();
  await page.keyboard.press('Control+k');
  await expect(palette).toHaveCount(0);
  await expect(opener).toBeFocused();
});

test('the command palette opens above a nested form and closes one layer at a time', async ({
  page,
}) => {
  const settings = await openSettingsTab(page, 'prompts');
  await settings.getByTestId('prompt-new').click();
  const prompt = page.getByTestId('prompt-modal');
  const slug = prompt.getByTestId('prompt-slug');
  await expect(slug).toBeFocused();
  await page.keyboard.press('Control+k');

  const palette = page.getByRole('dialog', { name: 'Search', exact: true });
  const input = palette.getByTestId('command-palette-input');
  // Clicking also proves the palette is painted above the existing form.
  await input.click();
  await expect(input).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(palette).toHaveCount(0);
  await expect(prompt).toBeVisible();
  await expect(slug).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(prompt).toHaveCount(0);
  await expect(settings).toBeVisible();
  await expect(settings.getByTestId('prompt-new')).toBeFocused();
});
