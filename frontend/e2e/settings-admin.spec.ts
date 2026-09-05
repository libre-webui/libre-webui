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
  userCount: 2,
  signupEnabled: true,
  version: '0.17.0-e2e',
  turnstile: { enabled: false },
};

const admin = {
  id: 'admin-user',
  username: 'admin',
  email: 'admin@example.test',
  role: 'admin' as const,
  status: 'active' as const,
  token: 'admin-token',
};
const member = {
  id: 'member-user',
  username: 'member',
  email: 'member@example.test',
  role: 'user' as const,
  status: 'active' as const,
  token: 'member-token',
};

test('administrators reach User Management from Settings and from /users', async ({
  page,
}) => {
  await mockLibreWebUiApi(page, { systemInfo, authUsers: [admin, member] });
  await page.addInitScript(() => {
    localStorage.setItem('i18nextLng', 'en');
    localStorage.setItem('auth-token', 'admin-token');
  });

  await page.goto('/chat');
  await expect(page.getByRole('textbox', { name: 'Message...' })).toBeVisible();
  await page.keyboard.press('Control+,');
  const modal = page.getByTestId('settings-scroll-region');
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await page.getByRole('tab', { name: 'User Management' }).click();
  await expect(
    modal.getByRole('heading', { name: 'User Management', exact: true })
  ).toBeVisible();
  await expect(
    modal.getByRole('radiogroup', { name: 'Default theme' })
  ).toBeVisible();
  await expect(
    modal.getByRole('heading', { name: 'member', exact: true })
  ).toBeVisible();
  await page.keyboard.press('Escape');

  // The old page URL now opens the same tab over the home tab.
  await page.goto('/users');
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await expect(
    page
      .getByTestId('settings-scroll-region')
      .getByRole('heading', { name: 'User Management', exact: true })
  ).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
});

test('regular users do not get the Administration group', async ({ page }) => {
  await mockLibreWebUiApi(page, { systemInfo, authUsers: [admin, member] });
  await page.addInitScript(() => {
    localStorage.setItem('i18nextLng', 'en');
    localStorage.setItem('auth-token', 'member-token');
  });
  await page.goto('/chat');
  await expect(page.getByRole('textbox', { name: 'Message...' })).toBeVisible();
  await page.keyboard.press('Control+,');
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'User Management' })).toHaveCount(
    0
  );
  await expect(page.getByText('Administration')).toHaveCount(0);
});

for (const { language, theme, title } of [
  { language: 'en', theme: 'light', title: 'Tool access' },
  { language: 'ar', theme: 'dark', title: 'الوصول إلى الأدوات' },
] as const) {
  test(`Tool access keeps Settings inside the viewport in ${language} ${theme} mode`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1920, height: 950 });
    await page.emulateMedia({
      reducedMotion: language === 'ar' ? 'reduce' : 'no-preference',
    });
    await mockLibreWebUiApi(page, {
      systemInfo,
      authUsers: [
        {
          ...admin,
          preferences: {
            theme: {
              mode: theme,
              adaptToAccent: false,
              accent: 'blue',
              customAccent: '#2563eb',
            },
          },
        },
        member,
      ],
    });
    const accessUpdates: string[] = [];
    await page.route('**/api/tools/access', async route => {
      if (route.request().method() === 'PUT') {
        accessUpdates.push(route.request().postDataJSON().mode);
      }
      await route.fulfill({
        json: {
          success: true,
          data: { mode: accessUpdates.at(-1) ?? 'admins', lockedByEnv: false },
        },
      });
    });
    await page.addInitScript(language => {
      localStorage.setItem('i18nextLng', language);
      localStorage.setItem('auth-token', 'admin-token');
    }, language);

    await page.goto('/users');
    await expect(page.locator('html')).toHaveAttribute(
      'dir',
      language === 'ar' ? 'rtl' : 'ltr'
    );
    if (theme === 'dark') {
      await expect(page.locator('html')).toHaveClass(/dark/);
    } else {
      await expect(page.locator('html')).not.toHaveClass(/dark/);
    }
    const content = page.getByTestId('settings-scroll-region');
    const toggle = content
      .getByRole('heading', { name: title, exact: true })
      .locator('..')
      .locator('..')
      .locator('label');
    const checkbox = toggle.getByRole('checkbox');
    await expect(checkbox).toBeEnabled();
    await expect(checkbox).not.toBeChecked();
    // Reproduce clicking a lower setting after scrolling the modal content.
    await toggle.evaluate(element => {
      const region = element.closest('[data-testid="settings-scroll-region"]')!;
      region.scrollTop +=
        element.getBoundingClientRect().top -
        region.getBoundingClientRect().top -
        160;
    });
    await expect
      .poll(() => content.evaluate(el => el.scrollTop))
      .toBeGreaterThan(0);
    const layout = () =>
      page.evaluate(() => {
        const panel = document
          .querySelector('[data-testid="settings-modal-panel"]')!
          .getBoundingClientRect();
        const app = document
          .querySelector('[data-testid="app-shell-content"]')!
          .getBoundingClientRect();
        return {
          documentScroll: document.scrollingElement!.scrollTop,
          contentScroll: document.querySelector(
            '[data-testid="settings-scroll-region"]'
          )!.scrollTop,
          panelTop: panel.top,
          panelBottom: panel.bottom,
          appBottom: app.bottom,
        };
      });
    const before = await layout();
    expect(before.documentScroll).toBe(0);
    expect(before.panelTop).toBeGreaterThanOrEqual(0);
    expect(before.panelBottom).toBeLessThanOrEqual(950);

    // Click the visible control, allowing the browser's native label focus.
    await toggle.click();
    await expect.poll(() => accessUpdates).toEqual(['all-users']);
    await expect(checkbox).toBeChecked();
    await expect.poll(layout).toEqual(before);

    const controlBounds = await toggle.boundingBox();
    const focusBounds = await checkbox.boundingBox();
    expect(controlBounds).not.toBeNull();
    expect(focusBounds).not.toBeNull();
    expect(focusBounds!.y).toBeGreaterThanOrEqual(controlBounds!.y);
    expect(focusBounds!.y + focusBounds!.height).toBeLessThanOrEqual(
      controlBounds!.y + controlBounds!.height
    );

    await checkbox.focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    await expect(checkbox).toBeFocused();
    await expect(toggle.locator(':scope > div')).not.toHaveCSS(
      'box-shadow',
      'none'
    );
    await page.keyboard.press('Space');
    await expect.poll(() => accessUpdates).toEqual(['all-users', 'admins']);
    await expect(checkbox).not.toBeChecked();
    await expect.poll(layout).toEqual(before);
  });
}
