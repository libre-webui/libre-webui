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

import { expect, test, type Page } from '@playwright/test';
import { mockLibreWebUiApi } from './lib/mockApi';

const sessions = Array.from({ length: 8 }, (_, index) => ({
  id: `rail-session-${index}`,
  title: [
    'Northern lights research',
    'Garden planning notes',
    'Release checklist',
    'Model comparison',
    'French translation',
    'API design review',
    'Weekend ideas',
    'Reading list',
  ][index],
  model: 'llama3.2:3b',
  messages: [],
  createdAt: Date.now() - index * 1000,
  updatedAt: Date.now() - index * 1000,
}));

test('desktop compact sidebar hides the unreadable session list', async ({
  page,
}) => {
  await mockLibreWebUiApi(page, { sessions });
  await page.goto('/chat');

  await page.getByTestId('sidebar-toggle-size').click();

  const sidebar = page.getByTestId('sidebar');
  await expect
    .poll(async () => (await sidebar.boundingBox())?.width ?? 0)
    .toBeLessThan(90);
  await expect(page.getByTestId('sidebar-rail-expand')).toBeVisible();
  await expect(page.getByTestId('sidebar-navigation')).toBeVisible();
  // Session titles cannot be read at rail width, so no session list at all.
  await expect(page.getByTestId('sidebar-compact-session')).toHaveCount(0);
  await expect(page.getByTestId('sidebar-mobile-chats')).toBeHidden();

  // Expanding brings the readable session list back.
  await page.getByTestId('sidebar-rail-expand').click();
  await expect(
    sidebar.getByText('Northern lights research', { exact: true })
  ).toBeVisible();
});

async function prepareCompactSidebar(
  page: Page,
  options: {
    role?: 'admin' | 'user';
    agentsEnabled?: boolean;
    language?: 'en' | 'ar';
  } = {}
) {
  const systemInfo = {
    requiresAuth: true,
    hasUsers: true,
    userCount: 2,
    version: '0.25.0-e2e',
    agentsEnabled: options.agentsEnabled ?? false,
    turnstile: { enabled: false },
  };
  await mockLibreWebUiApi(page, {
    sessions,
    systemInfo,
    authRole: options.role ?? 'admin',
  });
  await page.addInitScript(language => {
    localStorage.setItem('auth-token', 'e2e-token');
    localStorage.setItem('i18nextLng', language);
  }, options.language ?? 'en');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/chat');
  await page.getByTestId('sidebar-toggle-size').click();
  await expect
    .poll(
      async () => (await page.getByTestId('sidebar').boundingBox())?.width ?? 0
    )
    .toBeLessThan(90);
}

const destinations = [
  { name: 'Channels', path: '/channels' },
  { name: 'Notes', path: '/notes' },
  { name: 'Calendar', path: '/calendar' },
  { name: 'Automations', path: '/automations' },
  { name: 'Personas', path: '/personas' },
  { name: 'Imagine', path: '/gallery' },
] as const;

test('compact Explore links navigate with accessible labels and active states', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await prepareCompactSidebar(page);
  const sidebar = page.getByTestId('sidebar');
  const navigation = sidebar.getByTestId('sidebar-navigation');
  await expect(navigation.getByRole('link')).toHaveCount(destinations.length);
  await expect(sidebar.getByTestId('sidebar-chat-button')).toBeVisible();
  await expect(sidebar.getByTestId('sidebar-work-button')).toBeVisible();
  await expect(sidebar.getByTestId('sidebar-search-button')).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath('compact-explore-desktop.png'),
  });
  for (const { name, path } of destinations) {
    const link = navigation.getByRole('link', { name, exact: true });
    await expect(link).toHaveAttribute('title', name);
    await expect(link).toHaveAttribute('href', path);
    const bounds = await link.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.width).toBeGreaterThanOrEqual(44);
    expect(bounds!.height).toBeGreaterThanOrEqual(44);
    await link.click();
    await expect.poll(() => new URL(page.url()).pathname).toBe(path);
    await expect(link).toHaveAttribute('aria-current', 'page');
    await expect(navigation.locator('[aria-current="page"]')).toHaveCount(1);
    expect((await sidebar.boundingBox())!.width).toBeLessThan(90);
    await expect(sidebar.getByTestId('sidebar-compact-session')).toHaveCount(0);
  }

  await navigation.getByRole('link', { name: 'Channels', exact: true }).focus();
  await page.keyboard.press('Tab');
  const notes = navigation.getByRole('link', { name: 'Notes', exact: true });
  await expect(notes).toBeFocused();
  await expect(notes).not.toHaveCSS('box-shadow', 'none');
  await page.keyboard.press('Enter');
  await expect.poll(() => new URL(page.url()).pathname).toBe('/notes');
  await expect(notes).toHaveAttribute('aria-current', 'page');
});

test('Search follows compact browsing and still precedes Explore when expanded', async ({
  page,
}) => {
  await prepareCompactSidebar(page);
  const sidebar = page.getByTestId('sidebar');
  const browse = sidebar.getByTestId('sidebar-browse-scroll-region');
  const navigation = browse.getByTestId('sidebar-navigation');
  const search = browse.getByTestId('sidebar-search-button');
  await expect(
    browse.locator('button:visible, a[href]:visible').last()
  ).toHaveAttribute('data-testid', 'sidebar-search-button');
  await navigation.getByRole('link').last().focus();
  await page.keyboard.press('Tab');
  await expect(search).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('command-palette')).toBeVisible();
  await expect(page.getByTestId('command-palette-input')).toBeFocused();
  await page.keyboard.press('Escape');
  await sidebar.getByTestId('sidebar-rail-expand').click();
  const expandedSearch = sidebar.getByTestId('sidebar-search-button');
  const searchBounds = (await expandedSearch.boundingBox())!;
  const navigationBounds = (await navigation.boundingBox())!;
  expect(searchBounds.y + searchBounds.height).toBeLessThanOrEqual(
    navigationBounds.y
  );
});

test('legacy User Management pins stay absent while System and Settings remain available', async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      'libre-webui-app-state',
      JSON.stringify({
        state: { pinnedAdminShortcuts: ['users', 'system'] },
        version: 0,
      })
    );
  });
  await prepareCompactSidebar(page);
  const sidebar = page.getByTestId('sidebar');
  await expect(sidebar.getByTestId('sidebar-rail-pinned-users')).toHaveCount(0);
  const system = sidebar.getByTestId('sidebar-rail-pinned-system');
  await expect(system).toBeVisible();
  await sidebar.getByTestId('sidebar-rail-user-menu-button').click();
  const menu = sidebar.getByTestId('sidebar-user-menu');
  await expect(menu).toBeVisible();
  await expect(
    menu.getByRole('link', { name: 'User Management', exact: true })
  ).toHaveCount(0);
  await expect(menu.getByTestId('sidebar-shortcut-pin-users')).toHaveCount(0);
  await expect(
    menu.getByRole('link', { name: 'System', exact: true })
  ).toBeVisible();
  await sidebar.getByTestId('sidebar-rail-user-menu-button').click();
  await system.click();
  await expect.poll(() => new URL(page.url()).pathname).toBe('/system');
  await sidebar.getByTestId('sidebar-rail-expand').click();
  await expect(sidebar.getByTestId('sidebar-pinned-users')).toHaveCount(0);
  await expect(sidebar.getByTestId('sidebar-pinned-system')).toBeVisible();
  await sidebar.getByRole('button', { name: /e2e/ }).click();
  await expect(menu).toBeVisible();
  await expect(
    menu.getByRole('link', { name: 'User Management', exact: true })
  ).toHaveCount(0);
  await expect(menu.getByTestId('sidebar-shortcut-pin-users')).toHaveCount(0);
  await sidebar.getByRole('button', { name: /e2e/ }).click();
  await sidebar.getByTestId('sidebar-settings-button').click();
  const settings = page.getByTestId('settings-modal-panel');
  await settings
    .getByRole('tab', { name: 'User Management', exact: true })
    .click();
  await expect(settings.getByTestId('user-directory')).toBeVisible();
});

for (const { role, agentsEnabled, visible } of [
  { role: 'admin', agentsEnabled: true, visible: true },
  { role: 'admin', agentsEnabled: false, visible: false },
  { role: 'user', agentsEnabled: true, visible: false },
] as const) {
  test(`compact Agents access for ${role} with opt-in ${agentsEnabled}`, async ({
    page,
  }) => {
    await prepareCompactSidebar(page, { role, agentsEnabled });
    const navigation = page.getByTestId('sidebar-navigation');
    await expect(
      navigation.getByRole('link', { name: 'Agents', exact: true })
    ).toHaveCount(visible ? 1 : 0);
    await expect(navigation.getByRole('link')).toHaveCount(
      destinations.length + (visible ? 1 : 0)
    );
  });
}

test('short mobile RTL rails scroll Explore while keeping settings and account reachable', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 400 });
  await prepareCompactSidebar(page, { language: 'ar', agentsEnabled: true });
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  const sidebar = page.getByTestId('sidebar');
  const browse = sidebar.getByTestId('sidebar-browse-scroll-region');
  const navigation = browse.getByTestId('sidebar-navigation');
  await expect(browse.getByTestId('sidebar-mobile-chats')).toBeVisible();
  await expect(
    browse.locator('button:visible, a[href]:visible').last()
  ).toHaveAttribute('data-testid', 'sidebar-search-button');
  await expect
    .poll(() =>
      browse.evaluate(element => element.scrollHeight - element.clientHeight)
    )
    .toBeGreaterThan(0);
  const agents = navigation.locator('a[href="/agents"]');
  await agents.scrollIntoViewIfNeeded();
  await expect(agents).toBeInViewport();
  await expect
    .poll(() => browse.evaluate(element => element.scrollTop))
    .toBeGreaterThan(0);
  const settings = sidebar.getByTestId('sidebar-rail-settings-button');
  const account = sidebar.getByTestId('sidebar-rail-user-menu-button');
  await expect(settings).toBeInViewport();
  await expect(account).toBeInViewport();
  await expect(browse.getByTestId('sidebar-rail-settings-button')).toHaveCount(
    0
  );
  await page.screenshot({
    path: testInfo.outputPath('compact-explore-mobile-rtl.png'),
  });
  await navigation.locator('a[href="/gallery"]').click();
  await expect.poll(() => new URL(page.url()).pathname).toBe('/gallery');
  await expect(navigation.locator('a[href="/gallery"]')).toHaveAttribute(
    'aria-current',
    'page'
  );
  expect((await sidebar.boundingBox())!.width).toBeLessThan(90);
  await settings.click();
  await expect(page.getByTestId('settings-modal-panel')).toBeVisible();
  await page.keyboard.press('Escape');
  await account.click();
  await expect(account).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByTestId('sidebar-user-menu')).toBeVisible();
});

for (const layout of [
  { width: 1280, height: 900, fontSize: 15, language: 'en' },
  { width: 1280, height: 900, fontSize: 16, language: 'en' },
  { width: 900, height: 900, fontSize: 15, language: 'en' },
  { width: 900, height: 900, fontSize: 16, language: 'en' },
  { width: 900, height: 400, fontSize: 15, language: 'en' },
  { width: 390, height: 400, fontSize: 16, language: 'ar' },
] as const) {
  test(`compact rail stays symmetric at ${layout.width}x${layout.height}, ${layout.fontSize}px, ${layout.language}`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: layout.width, height: layout.height });
    await prepareCompactSidebar(page, {
      language: layout.language,
      agentsEnabled: true,
    });
    if (layout.fontSize === 16) {
      await page.evaluate(() => {
        document.documentElement.style.fontSize = '16px';
      });
    }
    await expect(page.locator('html')).toHaveCSS(
      'font-size',
      `${layout.fontSize}px`
    );
    const sidebar = page.getByTestId('sidebar');
    const browse = sidebar.getByTestId('sidebar-browse-scroll-region');
    await expect(sidebar).toHaveCSS('border-inline-end-width', '0px');
    await expect(sidebar).toHaveCSS('box-shadow', 'none');

    const geometryErrors = () =>
      sidebar.evaluate(element => {
        const browse = element.querySelector<HTMLElement>(
          '[data-testid="sidebar-browse-scroll-region"]'
        )!;
        const sidebarBounds = element.getBoundingClientRect();
        const center = sidebarBounds.x + sidebarBounds.width / 2;
        const visible = (node: Element) =>
          node.getClientRects().length > 0 &&
          getComputedStyle(node).visibility !== 'hidden';
        const controls = [
          ...browse.querySelectorAll<HTMLElement>('button, a[href]'),
        ].filter(visible);
        const errors: string[] = [];
        let previousY: number | undefined;
        for (const control of controls) {
          const bounds = control.getBoundingClientRect();
          const name = control.dataset.testid || control.getAttribute('href');
          const centerY = bounds.y + bounds.height / 2;
          if (
            Math.abs(bounds.width - 44) > 0.1 ||
            Math.abs(bounds.height - 44) > 0.1
          )
            errors.push(
              `${name}: ${bounds.width}x${bounds.height}, expected 44x44`
            );
          if (Math.abs(bounds.x + bounds.width / 2 - center) > 0.1)
            errors.push(
              `${name}: off-center by ${bounds.x + bounds.width / 2 - center}px`
            );
          if (
            previousY !== undefined &&
            Math.abs(centerY - previousY - 48) > 0.1
          )
            errors.push(
              `${name}: spacing ${centerY - previousY}px, expected 48px`
            );
          previousY = centerY;
          for (const icon of [...control.querySelectorAll('svg')].filter(
            visible
          )) {
            const iconBounds = icon.getBoundingClientRect();
            if (Math.abs(iconBounds.x + iconBounds.width / 2 - center) > 0.1)
              errors.push(`${name}: icon off-center`);
          }
        }
        if (controls.at(-1)?.dataset.testid !== 'sidebar-search-button')
          errors.push('Search must remain last');
        if (Math.abs(browse.clientWidth - element.clientWidth) > 1)
          errors.push(
            `Scrollbar reserves ${element.clientWidth - browse.clientWidth}px`
          );
        for (const footer of [
          ...element.querySelectorAll<HTMLElement>('button'),
        ].filter(node => !browse.contains(node) && visible(node))) {
          const bounds = footer.getBoundingClientRect();
          if (Math.abs(bounds.x + bounds.width / 2 - center) > 0.1)
            errors.push(
              `${footer.dataset.testid || footer.getAttribute('aria-label')}: footer off-center`
            );
        }
        return errors;
      });
    await expect.poll(geometryErrors).toEqual([]);

    if (layout.width >= 768) {
      const dividers = await browse.evaluate(
        element =>
          [...element.querySelectorAll('div')].filter(node => {
            if (!node.getClientRects().length) return false;
            const style = getComputedStyle(node);
            return (
              parseFloat(style.borderTopWidth) > 0 ||
              parseFloat(style.borderBottomWidth) > 0
            );
          }).length
      );
      expect(dividers).toBe(0);
    }
    if (layout.height === 400) {
      await expect
        .poll(() =>
          browse.evaluate(
            element => element.scrollHeight - element.clientHeight
          )
        )
        .toBeGreaterThan(0);
      const search = browse.getByTestId('sidebar-search-button');
      await search.scrollIntoViewIfNeeded();
      await expect(search).toBeInViewport();
      await expect(
        sidebar.getByTestId('sidebar-rail-settings-button')
      ).toBeInViewport();
      await expect(
        sidebar.getByTestId('sidebar-rail-user-menu-button')
      ).toBeInViewport();
      await expect.poll(geometryErrors).toEqual([]);
    }
    await page.screenshot({
      path: testInfo.outputPath(
        `rail-${layout.width}-${layout.height}-${layout.fontSize}-${layout.language}.png`
      ),
    });
    await sidebar.getByTestId('sidebar-rail-expand').click();
    await expect(sidebar).toHaveCSS('border-inline-end-width', '0px');
    await expect(sidebar).toHaveCSS('box-shadow', 'none');
  });
}
