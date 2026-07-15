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

test('Arabic mirrors the desktop shell and preserves content direction', async ({
  page,
}) => {
  await mockLibreWebUiApi(page, {
    sessions: [
      {
        id: 'rtl-session',
        title: 'محادثة تجريبية',
        model: 'llama3.2:3b',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messages: [
          {
            id: 'rtl-user-message',
            role: 'user',
            content: 'مرحبا بالعالم',
            timestamp: Date.now(),
          },
          {
            id: 'rtl-assistant-message',
            role: 'assistant',
            content: 'مثال برمجي:\n```js\nconst answer = 42;\n```',
            timestamp: Date.now(),
            model: 'llama3.2:3b',
          },
        ],
      },
    ],
  });
  await page.addInitScript(() => {
    localStorage.setItem('i18nextLng', 'ar');

    const observer = new MutationObserver(() => {
      const navigation = document.querySelector('nav');
      if (!navigation) return;

      document.documentElement.dataset.firstNavDir =
        document.documentElement.dir;
      document.documentElement.dataset.firstNavLang =
        document.documentElement.lang;
      document.documentElement.dataset.firstNavArabic = String(
        /[\u0600-\u06ff]/.test(navigation.textContent || '')
      );
      observer.disconnect();
    });
    observer.observe(document, { childList: true, subtree: true });
  });

  await page.goto('/c/rtl-session');

  const html = page.locator('html');
  const sidebar = page.getByTestId('sidebar');
  const appContent = page.getByTestId('app-shell-content');
  await expect(html).toHaveAttribute('lang', 'ar');
  await expect(html).toHaveAttribute('dir', 'rtl');
  await expect(html).toHaveAttribute('data-first-nav-lang', 'ar');
  await expect(html).toHaveAttribute('data-first-nav-dir', 'rtl');
  await expect(html).toHaveAttribute('data-first-nav-arabic', 'true');
  await expect(sidebar).toBeVisible();

  const viewport = page.viewportSize();
  const sidebarBox = await sidebar.boundingBox();
  const contentBox = await appContent.boundingBox();
  expect(viewport).not.toBeNull();
  expect(sidebarBox).not.toBeNull();
  expect(contentBox).not.toBeNull();
  expect(sidebarBox!.x + sidebarBox!.width).toBeCloseTo(viewport!.width, 0);
  expect(contentBox!.x).toBeCloseTo(0, 0);
  expect(contentBox!.x + contentBox!.width).toBeLessThanOrEqual(
    sidebarBox!.x + 1
  );

  await expect(page.locator('textarea[dir="auto"]')).toBeVisible();
  await expect(
    page.getByText('مرحبا بالعالم', { exact: true })
  ).toHaveAttribute('dir', 'auto');
  await expect(page.getByText('الآن', { exact: true }).first()).toBeVisible();

  const codeBlock = page
    .locator('pre')
    .filter({ hasText: 'const answer = 42;' })
    .last();
  await expect(codeBlock).toBeVisible();
  await expect(codeBlock).toHaveCSS('direction', 'ltr');

  const modelSelector = page
    .locator('button[aria-haspopup="dialog"]')
    .filter({ visible: true });
  await expect(modelSelector).toHaveCount(1);
  await modelSelector.click();

  const dialog = page.getByRole('dialog');
  const searchInput = dialog.locator('input[type="text"]');
  const searchIcon = dialog.locator('.lucide-search');
  await expect(searchInput).toBeVisible();
  await expect(searchIcon).toBeVisible();

  const searchInputBox = await searchInput.boundingBox();
  const searchIconBox = await searchIcon.boundingBox();
  expect(searchInputBox).not.toBeNull();
  expect(searchIconBox).not.toBeNull();
  expect(searchIconBox!.x).toBeGreaterThan(
    searchInputBox!.x + searchInputBox!.width / 2
  );
});

test('Arabic time greeting isolates a Latin username', async ({ page }) => {
  await mockLibreWebUiApi(page);
  await page.addInitScript(() => {
    localStorage.setItem('i18nextLng', 'ar');
    localStorage.setItem('auth-token', 'e2e-token');
    sessionStorage.setItem('welcomePromptIndex', '0');
  });

  await page.goto('/chat');

  const greeting = page.getByRole('heading', { level: 1 });
  await expect(greeting).toContainText('e2e');
  const greetingText = await greeting.textContent();
  expect(greetingText).toContain('،');
  expect(greetingText).toContain('\u2068e2e\u2069');
});
