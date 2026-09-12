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

const sessions = Array.from({ length: 30 }, (_, index) => ({
  id: `fade-session-${index}`,
  title: `History item ${index + 1}`,
  model: 'llama3.2:3b',
  messages: [],
  createdAt: Date.now() - index * 1000,
  updatedAt: Date.now() - index * 1000,
}));

const expectFade = async (region: Locator, top: number, bottom: number) => {
  await expect(region).toHaveCSS('--sidebar-fade-top', `${top}px`);
  await expect(region).toHaveCSS('--sidebar-fade-bottom', `${bottom}px`);
};

test.use({ viewport: { width: 1280, height: 800 } });

for (const mode of ['light', 'dark', 'amoled', 'celestial'] as const) {
  test(`sidebar fades follow scrolling in ${mode} mode`, async ({ page }) => {
    await mockLibreWebUiApi(page, {
      sessions,
      systemInfo: { defaultTheme: { mode } },
    });
    await page.goto('/chat');
    const region = page.getByTestId('sidebar-session-scroll-region');

    await expectFade(region, 0, 24);
    await expect(region).toHaveCSS('mask-image', /linear-gradient/);
    await region.hover();
    await page.mouse.wheel(0, 160);
    await expectFade(region, 24, 24);

    await region.evaluate(element => {
      element.scrollTop = element.scrollHeight;
    });
    await expectFade(region, 24, 0);
    await expect(
      region.getByRole('button', { name: 'History item 30', exact: true })
    ).toBeInViewport({ ratio: 1 });

    await region.evaluate(element => {
      element.scrollTop = 4;
    });
    await expectFade(region, 4, 24);
    await region.evaluate(element => {
      element.scrollTop = 0;
    });
    await expectFade(region, 0, 24);

    await page.getByTestId('sidebar-toggle-size').click();
    await expect(region).toBeHidden();
    await expect(region).toHaveCSS('mask-image', 'none');
    await page.getByTestId('sidebar-rail-expand').click();
    await expectFade(region, 0, 24);

    await page.keyboard.press('Tab');
    await region
      .getByRole('button', { name: 'History item 1', exact: true })
      .focus();
    await expect(region).toHaveCSS('mask-image', 'none');
  });
}

test('fades update for folder and viewport resizing with reduced motion', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await mockLibreWebUiApi(page, {
    sessions: sessions.slice(0, 12).map(session => ({
      ...session,
      folderId: 'fade-folder',
    })),
    folders: [
      {
        id: 'fade-folder',
        name: 'Scroll history',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ],
  });
  await page.setViewportSize({ width: 1280, height: 600 });
  await page.goto('/chat');
  const region = page.getByTestId('sidebar-session-scroll-region');
  await expectFade(region, 0, 24);

  const folder = region.getByRole('button', { name: /Scroll history/ });
  await folder.click();
  await expectFade(region, 0, 0);
  await folder.click();
  await expectFade(region, 0, 24);

  await page.setViewportSize({ width: 1280, height: 1200 });
  await expectFade(region, 0, 0);
  await page.setViewportSize({ width: 1280, height: 600 });
  await expectFade(region, 0, 24);
});

test('Work history uses the same scroll fades', async ({ page }) => {
  await mockLibreWebUiApi(page, {
    workTasks: sessions.map(session => ({
      ...session,
      providerType: 'ollama',
      status: 'completed',
      networkEnabled: false,
      previewStatus: 'stopped',
      workspacePath: '/workspace',
    })),
  });
  await page.goto('/work');
  const region = page.getByTestId('sidebar-work-task-scroll-region');
  await expectFade(region, 0, 24);
  await region.hover();
  await page.mouse.wheel(0, 160);
  await expectFade(region, 24, 24);
  await region.evaluate(element => {
    element.scrollTop = element.scrollHeight;
  });
  await expectFade(region, 24, 0);
});
