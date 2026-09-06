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

test('sign-in language can be changed before authentication on a small screen', async ({
  page,
}) => {
  await mockLibreWebUiApi(page, {
    systemInfo: {
      requiresAuth: true,
      hasUsers: true,
      userCount: 1,
      signupEnabled: false,
      version: '0.34.0-e2e',
      turnstile: { enabled: false },
    },
  });
  await page.setViewportSize({ width: 320, height: 740 });
  await page.goto('/login');
  const language = page.getByRole('combobox', { name: 'Language' });
  await expect(language).toBeInViewport();
  await language.selectOption('ar');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  const translatedLanguage = page.getByTestId('language-switcher-select');
  await expect(translatedLanguage).toBeInViewport();
  await translatedLanguage.selectOption('en');
  await expect(
    page.getByRole('heading', { name: 'Welcome Back' })
  ).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  await page.reload();
  await expect(page.getByRole('combobox', { name: 'Language' })).toHaveValue(
    'en'
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth
    )
  ).toBe(true);
});

for (const existing of [false, true]) {
  test(`composing text does not send ${existing ? 'an existing' : 'a new'} chat`, async ({
    page,
  }) => {
    await mockLibreWebUiApi(page, {
      sessions: existing
        ? [
            {
              id: 'ime-chat',
              title: 'IME chat',
              model: 'llama3.2:3b',
              createdAt: 1,
              updatedAt: 1,
              messages: [
                { id: 'hello', role: 'user', content: 'Hello', timestamp: 1 },
              ],
            },
          ]
        : [],
    });
    await page.goto(existing ? '/c/ime-chat' : '/chat');
    if (existing) {
      await page.getByTitle('Edit', { exact: true }).click();
      const editor = page.locator('textarea[dir="auto"]').first();
      await editor.fill('編集');
      await editor.dispatchEvent('keydown', {
        key: 'Enter',
        isComposing: true,
        bubbles: true,
      });
      await expect(editor).toHaveValue('編集');
      await editor.dispatchEvent('keydown', {
        key: 'Escape',
        isComposing: true,
        bubbles: true,
      });
      await expect(editor).toHaveValue('編集');
      await editor.press('Escape');
      await expect(page.getByTitle('Edit', { exact: true })).toBeVisible();
    }
    const composer = page.locator('textarea[rows="1"][dir="auto"]').first();
    await expect(composer).toBeVisible();
    await composer.fill('日本語');
    await composer.dispatchEvent('keydown', {
      key: 'Enter',
      code: 'Enter',
      isComposing: true,
      bubbles: true,
    });
    await expect(composer).toHaveValue('日本語');
    await composer.dispatchEvent('keydown', {
      key: 'Enter',
      code: 'Enter',
      keyCode: 229,
      bubbles: true,
    });
    await expect(composer).toHaveValue('日本語');
    await composer.press('Shift+Enter');
    await expect(composer).toHaveValue('日本語\n');
    await composer.press('Enter');
    await expect(composer).toHaveValue('');
  });
}
