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

const session = {
  id: 'tab-session',
  title: 'Garden planning notes',
  model: 'llama3.2:3b',
  createdAt: 1_710_000_000_000,
  updatedAt: 1_710_000_100_000,
  messages: [],
};

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    // Tabs persist across reloads; start each test from a clean strip.
    localStorage.removeItem('libre-webui-tabs');
  });
});

test.describe('home greeting', () => {
  test.use({ timezoneId: 'UTC' });

  for (const { hour, language, greeting } of [
    { hour: 2, language: 'en', greeting: 'Good night' },
    { hour: 9, language: 'en', greeting: 'Good morning' },
    { hour: 14, language: 'en', greeting: 'Good afternoon' },
    { hour: 19, language: 'en', greeting: 'Good evening' },
    { hour: 9, language: 'fr', greeting: 'Bonjour' },
  ]) {
    test(`uses the ${language} translation at ${hour}:00`, async ({ page }) => {
      const missingGreetings: string[] = [];
      page.on('console', message => {
        const text = message.text();
        if (text.includes('missingKey') && text.includes('greeting')) {
          missingGreetings.push(text);
        }
      });

      await mockLibreWebUiApi(page);
      await page.addInitScript(locale => {
        localStorage.setItem('i18nextLng', locale);
        localStorage.setItem('auth-token', 'e2e-token');
      }, language);
      await page.clock.setFixedTime(new Date(Date.UTC(2026, 8, 5, hour)));
      await page.goto('/');

      await expect(
        page.getByTestId('home-page').getByRole('heading', { level: 1 })
      ).toHaveText(`${greeting}, e2e.`);
      expect(missingGreetings).toEqual([]);
    });
  }
});

test.describe('celestial day explorer', () => {
  test.use({ timezoneId: 'UTC' });

  test.beforeEach(async ({ page }) => {
    await mockLibreWebUiApi(page, {
      preferences: {
        theme: {
          mode: 'celestial',
          accent: 'blue',
          adaptToAccent: false,
          customAccent: '#2563eb',
        },
      },
    });
    await page.clock.setFixedTime(new Date('2026-09-05T12:00:00Z'));
    await page.emulateMedia({ reducedMotion: 'reduce' });
  });

  test('explores the sky with the keyboard and restores live time on dismissal', async ({
    page,
  }) => {
    const weatherRequests: string[] = [];
    page.on('request', request => {
      if (request.url().includes('api.open-meteo.com')) {
        weatherRequests.push(request.url());
      }
    });
    await page.goto('/');
    const trigger = page.getByTestId('celestial-clock-trigger');
    const panel = page.getByTestId('celestial-day-popover');
    const sky = page.getByTestId('celestial-sky');
    await expect(trigger).toHaveAccessibleName('Time of day: 12:00pm');
    await trigger.focus();
    await page.keyboard.press('Enter');
    await expect(panel).toHaveAccessibleName('Time of day');
    const slider = panel.getByTestId('celestial-scrubber');
    await expect(slider).toBeFocused();
    await slider.press('Home');
    await expect(slider).toHaveAttribute('aria-valuetext', '12:00am');
    await expect(sky).toHaveAttribute('data-night', 'true');
    await slider.press('ArrowRight');
    await expect(slider).toHaveValue('1');
    await slider.fill('780');
    await expect(sky).toHaveAttribute('data-night', 'false');
    for (const event of ['sunrise', 'sunset']) {
      const shortcut = panel.getByTestId(`celestial-preview-${event}`);
      const eventTime = await shortcut
        .locator('span.tabular-nums')
        .textContent();
      await shortcut.click();
      await expect(panel.getByTestId('celestial-preview-clock')).toHaveText(
        eventTime ?? ''
      );
    }
    await panel.getByTestId('celestial-follow-clock').click();
    await expect(sky).toHaveAttribute('data-preview', 'false');
    await expect(slider).toHaveValue('720');
    await slider.fill('60');
    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expect(sky).toHaveAttribute('data-preview', 'false');

    await trigger.click();
    await panel.getByTestId('celestial-scrubber').fill('60');
    await page
      .getByTestId('home-page')
      .getByRole('heading', { level: 1 })
      .click();
    await expect(panel).toHaveCount(0);
    await expect(sky).toHaveAttribute('data-preview', 'false');
    expect(weatherRequests).toEqual([]);
  });

  test('hands preview control to Appearance and stays hidden in flat themes', async ({
    page,
  }) => {
    await page.goto('/');
    await page.getByTestId('celestial-clock-trigger').click();
    await page
      .getByTestId('celestial-day-popover')
      .getByTestId('celestial-scrubber')
      .fill('60');
    // Global shortcuts ignore inputs, including the focused time slider.
    await page.keyboard.press('Control+,');
    await expect(page.getByTestId('celestial-day-popover')).toBeVisible();
    await expect(page.getByTestId('celestial-preview-clock')).toHaveText(
      '1:00am'
    );
    await page.keyboard.press('Tab');
    await expect(page.getByTestId('celestial-preview-sunrise')).toBeFocused();
    await page.keyboard.press('Control+,');
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
    await expect(page.getByTestId('celestial-day-popover')).toHaveCount(0);
    await expect(page.getByTestId('celestial-sky')).toHaveAttribute(
      'data-preview',
      'false'
    );
    await page.getByTestId('celestial-scrubber').fill('60');
    await expect(page.getByTestId('celestial-preview-clock')).toHaveText(
      '1:00am'
    );
    await page.getByRole('button', { name: 'Light', exact: true }).click();
    await expect(page.getByTestId('celestial-clock-trigger')).toHaveCount(0);
    await expect(page.getByTestId('celestial-sky')).toHaveCount(0);
  });

  test('fits a narrow Arabic viewport and clears preview on resize', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 568 });
    await page.addInitScript(() => localStorage.setItem('i18nextLng', 'ar'));
    await page.goto('/');
    await page.getByTestId('celestial-clock-trigger').click();
    const panel = page.getByTestId('celestial-day-popover');
    await expect(panel).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    const bounds = await panel.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(568);
    const slider = panel.getByTestId('celestial-scrubber');
    await expect(slider).toHaveAttribute('dir', 'ltr');
    await slider.fill('60');
    await page.setViewportSize({ width: 568, height: 390 });
    await expect(panel).toHaveCount(0);
    await expect(page.getByTestId('celestial-sky')).toHaveAttribute(
      'data-preview',
      'false'
    );
  });
});

test('home is the default tab and opening a chat adds a closable tab', async ({
  page,
}) => {
  await mockLibreWebUiApi(page, { sessions: [session] });
  await page.goto('/');

  const tabs = page.getByTestId('app-tab');
  await expect(tabs).toHaveCount(1);
  await expect(tabs.first()).toHaveText(/Home/);
  await expect(page.getByTestId('home-page')).toBeVisible();

  await page.goto('/c/tab-session');
  await expect(tabs).toHaveCount(2);
  await expect(tabs.nth(1)).toHaveText(/Garden planning notes/);
  await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');

  // Home has no close affordance; the chat tab does.
  await expect(tabs.first().getByTestId('app-tab-close')).toHaveCount(0);
  await tabs.nth(1).getByTestId('app-tab-close').click();

  await expect(tabs).toHaveCount(1);
  await expect(page).toHaveURL(/\/$/);
});

test('the new-tab menu opens pages as tabs and shows their shortcuts', async ({
  page,
}) => {
  await mockLibreWebUiApi(page);
  await page.goto('/');

  await page.getByTestId('app-tab-new').click();
  const menu = page.getByTestId('app-tab-new-menu');
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem').first()).toContainText('New Chat');
  await expect(menu.getByRole('menuitem').first()).toContainText('O');
  await expect(menu.getByRole('menuitem').nth(1)).toHaveText('Incognito Chat');
  await expect(menu.getByRole('menuitem', { name: 'Notes' })).toBeVisible();

  await menu.getByRole('menuitem', { name: /Calendar/ }).click();
  await expect(page).toHaveURL(/\/calendar$/);
  await expect(page.getByTestId('app-tab')).toHaveCount(2);
});

test('the new-tab menu stays fully visible in a narrow window', async ({
  page,
}) => {
  await page.setViewportSize({ width: 466, height: 1014 });
  await mockLibreWebUiApi(page);
  await page.goto('/');

  await page.getByTestId('sidebar-toggle-size').click();
  await page.getByTestId('app-tab-new').click();
  const menu = page.getByTestId('app-tab-new-menu');
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem').first()).toContainText('New Chat');

  const menuBox = await menu.boundingBox();
  const contentBox = await page.getByTestId('app-shell-content').boundingBox();
  expect(menuBox).not.toBeNull();
  expect(contentBox).not.toBeNull();
  expect(menuBox!.x).toBeGreaterThanOrEqual(contentBox!.x + 7);
  expect(menuBox!.x + menuBox!.width).toBeLessThanOrEqual(
    contentBox!.x + contentBox!.width - 7
  );
});

test('incognito chat starts from Home without creating a saved session', async ({
  page,
}) => {
  let createSessionRequests = 0;
  page.on('request', request => {
    if (
      request.method() === 'POST' &&
      new URL(request.url()).pathname.endsWith('/chat/sessions')
    ) {
      createSessionRequests += 1;
    }
  });

  await mockLibreWebUiApi(page, { sessions: [session] });
  await page.goto('/');

  const startActions = page.locator(
    '[data-testid="home-new-chat"], [data-testid="home-incognito-chat"], [data-testid="home-new-work"]'
  );
  await expect(startActions).toHaveCount(3);
  await expect(startActions.nth(0)).toContainText('New Chat');
  await expect(startActions.nth(1)).toContainText('Incognito Chat');
  await expect(startActions.nth(2)).toContainText('New Work');
  await expect(
    page.getByRole('button', { name: 'Notes', exact: true })
  ).toBeVisible();

  await page.getByTestId('home-incognito-chat').click();
  await expect(page).toHaveURL(/\/chat\?incognito=1$/);
  await expect(page.getByText('Private Mode')).toBeVisible();
  await expect(page.getByTestId('app-tab').last()).toContainText(
    'Incognito Chat'
  );
  expect(createSessionRequests).toBe(0);

  await page.reload();
  await expect(page.getByText('Private Mode')).toBeVisible();
  expect(createSessionRequests).toBe(0);

  await page.keyboard.press('ControlOrMeta+k');
  await page.getByTestId('command-palette-input').fill('garden');
  await page
    .getByTestId('command-palette')
    .getByRole('button', { name: /Garden planning notes/ })
    .click();
  await expect(page).toHaveURL(/\/c\/tab-session$/);
  await expect(page.getByText('Private Mode')).toHaveCount(0);
});

test('the tab context menu closes other, right-side, or all non-Home tabs', async ({
  page,
}) => {
  await mockLibreWebUiApi(page);
  await page.goto('/');

  const tabs = page.getByTestId('app-tab');
  const openTab = async (name: string, expectedCount: number) => {
    await page.getByTestId('app-tab-new').click();
    await page
      .getByTestId('app-tab-new-menu')
      .getByRole('menuitem', { name })
      .click();
    await expect(tabs).toHaveCount(expectedCount);
  };

  await openTab('Calendar', 2);
  await openTab('Personas', 3);
  await openTab('Imagine', 4);

  await tabs.filter({ hasText: 'Calendar' }).click({ button: 'right' });
  const contextMenu = page.getByTestId('app-tab-context-menu');
  await expect(contextMenu).toBeVisible();
  await page.getByTestId('app-tab-context-close-right').click();
  await expect(tabs).toHaveCount(2);
  await expect(page).toHaveURL(/\/calendar$/);

  await openTab('Personas', 3);
  await openTab('Imagine', 4);
  await tabs.filter({ hasText: 'Personas' }).click({ button: 'right' });
  await page.getByTestId('app-tab-context-close-others').click();
  await expect(tabs).toHaveCount(2);
  await expect(tabs.nth(1)).toHaveText(/Personas/);
  await expect(page).toHaveURL(/\/personas$/);

  await openTab('Imagine', 3);
  await tabs.filter({ hasText: 'Imagine' }).click({ button: 'right' });
  await page.getByTestId('app-tab-context-close-all').click();
  await expect(tabs).toHaveCount(1);
  await expect(tabs.first()).toHaveText(/Home/);
  await expect(page).toHaveURL(/\/$/);

  await tabs.first().click({ button: 'right' });
  await expect(page.getByTestId('app-tab-context-close')).toBeDisabled();
  await expect(page.getByTestId('app-tab-context-close-all')).toBeDisabled();
});

test('the command palette opens with the keyboard and jumps to a chat', async ({
  page,
}) => {
  await mockLibreWebUiApi(page, { sessions: [session] });
  await page.goto('/');

  await expect(page.getByTestId('command-palette')).toHaveCount(0);
  await page.keyboard.press('ControlOrMeta+k');

  const palette = page.getByTestId('command-palette');
  await expect(palette).toBeVisible();

  await page.getByTestId('command-palette-input').fill('garden');
  await expect(
    palette.getByRole('button', { name: /Garden planning notes/ })
  ).toBeVisible();
  await page.keyboard.press('Enter');

  await expect(palette).toHaveCount(0);
  await expect(page).toHaveURL(/\/c\/tab-session$/);
});

test('the sidebar search entry opens the palette and escape closes it', async ({
  page,
}) => {
  await mockLibreWebUiApi(page);
  await page.goto('/');

  await page.getByTestId('sidebar-search-button').click();
  await expect(page.getByTestId('command-palette')).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page.getByTestId('command-palette')).toHaveCount(0);
});

test('reopening the palette starts from an empty, focused query', async ({
  page,
}) => {
  await mockLibreWebUiApi(page);
  await page.goto('/');
  await expect(page.getByTestId('home-page')).toBeVisible();

  const input = page.getByTestId('command-palette-input');

  // Type, close with Escape, reopen with the keyboard.
  await page.keyboard.press('ControlOrMeta+k');
  await input.fill('personas');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('command-palette')).toHaveCount(0);

  await page.keyboard.press('ControlOrMeta+k');
  await expect(input).toHaveValue('');

  // Same again, closing via the shortcut and reopening from the sidebar.
  await input.fill('calendar');
  await page.keyboard.press('ControlOrMeta+k');
  await expect(page.getByTestId('command-palette')).toHaveCount(0);
  await page.getByTestId('sidebar-search-button').click();
  await expect(input).toHaveValue('');

  // The input takes focus on open, so typing goes straight into it.
  await expect(input).toBeFocused();
  await page.keyboard.type('imag');
  await expect(input).toHaveValue('imag');
});
