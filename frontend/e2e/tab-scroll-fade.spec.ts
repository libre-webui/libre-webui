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

const sessions = Array.from({ length: 8 }, (_, index) => ({
  id: `tab-fade-${index}`,
  title: `Forest planning notes ${index + 1}`,
  model: 'llama3.2:3b',
  createdAt: Date.now(),
  updatedAt: Date.now(),
  messages: [],
}));

const expectFade = async (strip: Locator, left: number, right: number) => {
  await expect(strip).toHaveCSS('--tab-fade-left', `${left}px`);
  await expect(strip).toHaveCSS('--tab-fade-right', `${right}px`);
};

test.use({ viewport: { width: 1280, height: 800 } });

for (const { language, mode } of [
  { language: 'en', mode: 'light' },
  { language: 'ar', mode: 'dark' },
  { language: 'en', mode: 'amoled' },
  { language: 'en', mode: 'celestial' },
] as const) {
  test(`tab fades track scrolling and resizing in ${language}/${mode}`, async ({
    page,
  }) => {
    await mockLibreWebUiApi(page, {
      sessions,
      preferences: {
        theme: {
          mode,
          accent: 'blue',
          adaptToAccent: false,
          customAccent: '#2563eb',
        },
      },
    });
    await page.addInitScript(
      ({ language, sessions }) => {
        localStorage.setItem('i18nextLng', language);
        localStorage.setItem(
          'libre-webui-tabs',
          JSON.stringify({
            state: {
              tabs: [
                { id: 'home', kind: 'home', path: '/' },
                ...sessions.map(session => ({
                  id: `chat:${session.id}`,
                  kind: 'chat',
                  path: `/c/${session.id}`,
                })),
              ],
              activeTabId: 'home',
            },
            version: 0,
          })
        );
      },
      { language, sessions }
    );
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');

    const rtl = language === 'ar';
    const strip = page.getByRole('tablist');
    await expect(page.locator('html')).toHaveAttribute(
      'dir',
      rtl ? 'rtl' : 'ltr'
    );
    await expectFade(strip, rtl ? 24 : 0, rtl ? 0 : 24);
    await expect(strip).toHaveCSS('mask-image', /linear-gradient/);
    await strip.hover();
    await page.mouse.wheel(rtl ? -160 : 160, 0);
    await expectFade(strip, 24, 24);

    await strip.evaluate((element, rtl) => {
      element.scrollLeft = rtl ? -element.scrollWidth : element.scrollWidth;
    }, rtl);
    await expectFade(strip, rtl ? 0 : 24, rtl ? 24 : 0);
    await expect(page.getByTestId('app-tab').last()).toBeInViewport({
      ratio: 1,
    });
    await expect(page.getByTestId('app-tab-new')).toBeInViewport({ ratio: 1 });
    await expect(page.getByTestId('app-tab-new')).toHaveCSS(
      'mask-image',
      'none'
    );

    // Selecting a clipped tab must reveal the whole tab, outside the fade.
    await page
      .getByTestId('sidebar')
      .getByRole('button', { name: sessions[0].title, exact: true })
      .click();
    await expect(strip.getByRole('tab', { selected: true })).toBeInViewport({
      ratio: 1,
    });

    await page.setViewportSize({ width: 2200, height: 800 });
    await expectFade(strip, 0, 0);
    await page.setViewportSize({ width: 1280, height: 800 });
    await strip.evaluate(element => {
      element.scrollLeft = 0;
    });
    await expectFade(strip, rtl ? 24 : 0, rtl ? 0 : 24);

    await page.keyboard.press('Tab');
    await strip.getByRole('tab').first().focus();
    await expect(strip).toHaveCSS('mask-image', 'none');

    await strip.getByRole('tab').first().click({ button: 'right' });
    await page.getByTestId('app-tab-context-close-all').click();
    await expect(strip.getByRole('tab')).toHaveCount(1);
    await expectFade(strip, 0, 0);
  });
}
