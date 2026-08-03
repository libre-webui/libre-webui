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
      const navigation = document.querySelector(
        '[data-testid="sidebar-navigation"]'
      );
      if (!navigation) return;

      document.documentElement.dataset.firstNavDir =
        document.documentElement.dir;
      document.documentElement.dataset.firstNavLang =
        document.documentElement.lang;
      // The destinations render as icons, so the translated strings live in
      // their accessible names rather than in text nodes.
      const navigationText = [
        navigation.textContent || '',
        ...Array.from(navigation.querySelectorAll('[aria-label]')).map(
          element => element.getAttribute('aria-label') || ''
        ),
      ].join(' ');
      document.documentElement.dataset.firstNavArabic = String(
        /[\u0600-\u06ff]/.test(navigationText)
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

  await expect(page.locator('textarea[rows="1"][dir="auto"]')).toBeVisible();
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

test('Arabic mirrors the new Home and tab menus', async ({ page }) => {
  await mockLibreWebUiApi(page, {
    systemInfo: {
      requiresAuth: true,
      hasUsers: true,
      userCount: 1,
      version: '0.17.0-e2e',
      turnstile: { enabled: false },
    },
    authUsers: [
      {
        id: 'rtl-admin',
        username: 'admin',
        email: 'admin@example.test',
        role: 'admin',
        status: 'active',
        token: 'rtl-admin-token',
      },
    ],
  });
  await page.addInitScript(() => {
    localStorage.setItem('i18nextLng', 'ar');
    localStorage.setItem('auth-token', 'rtl-admin-token');
  });

  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');

  const incognitoAction = page.getByTestId('home-incognito-chat');
  await expect(incognitoAction).toHaveText('دردشة مخفية');
  await expect(incognitoAction).toHaveCSS('direction', 'rtl');
  const homeIconBox = await incognitoAction.locator('svg').boundingBox();
  const homeLabelBox = await incognitoAction.locator('span').boundingBox();
  expect(homeIconBox).not.toBeNull();
  expect(homeLabelBox).not.toBeNull();
  expect(homeIconBox!.x + homeIconBox!.width / 2).toBeGreaterThan(
    homeLabelBox!.x + homeLabelBox!.width / 2
  );

  const newTabButton = page.getByTestId('app-tab-new');
  await newTabButton.click();
  const newTabMenu = page.getByTestId('app-tab-new-menu');
  await expect(newTabMenu).toHaveCSS('direction', 'rtl');
  await expect(
    newTabMenu.getByRole('menuitem', { name: 'الوكلاء' })
  ).toBeVisible();
  await expect(
    newTabMenu.getByRole('menuitem', { name: 'إدارة المستخدمين' })
  ).toBeVisible();

  const incognitoMenuItem = newTabMenu.getByRole('menuitem', {
    name: 'دردشة مخفية',
  });
  const menuIconBox = await incognitoMenuItem.locator('svg').boundingBox();
  const menuLabelBox = await incognitoMenuItem
    .locator('span')
    .first()
    .boundingBox();
  expect(menuIconBox).not.toBeNull();
  expect(menuLabelBox).not.toBeNull();
  expect(menuIconBox!.x + menuIconBox!.width / 2).toBeGreaterThan(
    menuLabelBox!.x + menuLabelBox!.width / 2
  );

  const newTabButtonBox = await newTabButton.boundingBox();
  const newTabMenuBox = await newTabMenu.boundingBox();
  expect(newTabButtonBox).not.toBeNull();
  expect(newTabMenuBox).not.toBeNull();
  expect(
    Math.abs(
      newTabMenuBox!.x +
        newTabMenuBox!.width -
        (newTabButtonBox!.x + newTabButtonBox!.width)
    )
  ).toBeLessThanOrEqual(2);

  await newTabButton.click();
  await page.getByRole('button', { name: /admin/i }).last().click();
  const userMenu = page.getByTestId('sidebar-user-menu');
  await expect(userMenu).toHaveCSS('direction', 'rtl');
  const settingsButton = userMenu.getByRole('button', {
    name: 'الإعدادات',
    exact: true,
  });
  const settingsButtonBox = await settingsButton.boundingBox();
  const settingsIconBox = await settingsButton
    .locator('.lucide-settings')
    .boundingBox();
  expect(settingsButtonBox).not.toBeNull();
  expect(settingsIconBox).not.toBeNull();
  expect(settingsIconBox!.x + settingsIconBox!.width / 2).toBeGreaterThan(
    settingsButtonBox!.x + settingsButtonBox!.width / 2
  );
});
