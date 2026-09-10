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

import { expect, test, type Locator } from '@playwright/test';
import { mockLibreWebUiApi } from './lib/mockApi';
import { openSettingsModal, selectSettingsTab } from './lib/settingsTab';

const expectFade = async (
  region: Locator,
  top: number,
  bottom: number,
  left = 0,
  right = 0
) => {
  for (const [edge, value] of Object.entries({ top, bottom, left, right })) {
    await expect(region).toHaveCSS(`--scroll-fade-${edge}`, `${value}px`);
  }
};

test.use({ viewport: { width: 1280, height: 720 } });

for (const mode of ['light', 'dark', 'amoled', 'celestial'] as const) {
  test(`Settings navigation and content fade independently in ${mode}`, async ({
    page,
  }) => {
    await mockLibreWebUiApi(page, {
      preferences: {
        theme: {
          mode,
          accent: 'blue',
          adaptToAccent: false,
          customAccent: '#2563eb',
        },
      },
    });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/chat');
    const panel = await openSettingsModal(page);
    const navigation = panel.getByTestId('settings-navigation-scroll-region');
    const content = panel.getByTestId('settings-scroll-region');
    const search = panel.getByRole('searchbox', { name: 'Search' });
    await expectFade(navigation, 0, 24);
    await expectFade(content, 0, 24);

    await navigation.hover();
    await page.mouse.wheel(0, 100);
    await expectFade(navigation, 24, 24);
    await expect(navigation).toHaveCSS('mask-image', /linear-gradient/);
    await expect(search).toBeInViewport({ ratio: 1 });
    await expectFade(content, 0, 24);

    await content.hover();
    await page.mouse.wheel(0, 160);
    await expectFade(content, 24, 24);
    await expect(content).toHaveCSS('mask-image', /linear-gradient/);
    await content.evaluate(element => {
      element.scrollTop = element.scrollHeight;
    });
    await expectFade(content, 24, 0);

    await selectSettingsTab(panel, 'generation');
    await expect(content).toHaveCSS('--scroll-fade-top', '0px');
    await expect(content).toHaveCSS('mask-image', /linear-gradient/);
    await search.fill('about');
    await expectFade(navigation, 0, 0);
    await expect(navigation).not.toHaveAttribute('data-scroll-fade-active');
    await expect(navigation).toHaveCSS('mask-image', 'none');
    await search.clear();
    await expectFade(navigation, 0, 24);
  });
}

test('mobile Settings fades horizontally and responds to live RTL changes', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockLibreWebUiApi(page);
  await page.goto('/chat');
  const panel = await openSettingsModal(page);
  const navigation = panel.getByTestId('settings-navigation-scroll-region');
  await expectFade(navigation, 0, 0, 0, 24);
  await navigation.hover();
  await page.mouse.wheel(160, 0);
  await expectFade(navigation, 0, 0, 24, 24);

  await panel.getByTestId('language-switcher-select').selectOption('ar');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await navigation.evaluate(element => {
    element.scrollLeft = 0;
  });
  await expectFade(navigation, 0, 0, 24, 0);
  await navigation.evaluate(element => {
    element.scrollLeft = -element.scrollWidth;
  });
  await expectFade(navigation, 0, 0, 0, 24);

  await page.setViewportSize({ width: 1280, height: 720 });
  await expectFade(navigation, 0, 24);
});

test('nested dialogs fade their content while preserving chrome and keyboard focus', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 560 });
  await mockLibreWebUiApi(page);
  await page.goto('/chat');
  const settings = await openSettingsModal(page);
  await selectSettingsTab(settings, 'prompts');
  await settings.getByTestId('prompt-new').click();
  const dialog = page.getByTestId('prompt-modal');
  const content = dialog.getByTestId('modal-scroll-region');
  await expect(dialog).toHaveCSS('mask-image', 'none');
  await expectFade(content, 0, 24);
  await content.hover();
  await page.mouse.wheel(0, 100);
  await expect(content).toHaveCSS('--scroll-fade-top', '24px');
  await expect(content).toHaveCSS('mask-image', /linear-gradient/);
  await expect(dialog.getByTestId('prompt-content')).toHaveCSS(
    'mask-image',
    'none'
  );

  await page.keyboard.press('Tab');
  await expect(content).toHaveCSS('mask-image', 'none');
  await page.mouse.wheel(0, 100);
  await expect(content).toHaveCSS('mask-image', /linear-gradient/);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(settings.getByTestId('prompt-new')).toBeFocused();
  await expect(settings).toBeVisible();
});

test('page panels gain and clear fades as the window resizes', async ({
  page,
}) => {
  // The artifact demo route belongs to the authenticated application shell.
  await mockLibreWebUiApi(page, {
    systemInfo: {
      requiresAuth: true,
      hasUsers: true,
      userCount: 1,
      version: '0.34.1-e2e',
    },
  });
  await page.addInitScript(() =>
    localStorage.setItem('auth-token', 'e2e-token')
  );
  await page.goto('/artifacts');
  const pageContent = page.getByTestId('page-scroll-region');
  await expect(pageContent).toBeVisible({ timeout: 15000 });
  await expectFade(pageContent, 0, 24);
  await pageContent.hover();
  await page.mouse.wheel(0, 180);
  await expect(pageContent).toHaveCSS('--scroll-fade-top', '24px');
  await pageContent.evaluate(element => {
    element.scrollTop = element.scrollHeight;
  });
  await expectFade(pageContent, 24, 0);

  await page.goto('/');
  const home = page.getByTestId('home-page');
  await page.setViewportSize({ width: 1280, height: 1200 });
  await expectFade(home, 0, 0);
  await expect(home).toHaveCSS('mask-image', 'none');
  await page.setViewportSize({ width: 1280, height: 400 });
  await expect(home).toHaveAttribute('data-scroll-fade-active');
  await expect(home).toHaveCSS('--scroll-fade-bottom', '24px');
});
