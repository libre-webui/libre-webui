/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
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

const standupPrompt = {
  id: 'prompt-standup',
  slug: 'standup',
  title: 'Daily standup',
  description: 'Turns yesterday into a standup update',
  content: 'Write a standup update covering yesterday, today and blockers.',
  variables: [],
  tags: ['work'],
  version: 1,
  createdAt: 1_770_000_000_000,
  updatedAt: 1_770_000_000_000,
  ownerUserId: 'e2e-user',
};

test('the composer offers prompts on slash and inserts rendered content', async ({
  page,
}) => {
  await mockLibreWebUiApi(page, {
    sessions: [
      {
        id: 'composer-session',
        title: 'Composer',
        model: 'llama3.2:3b',
        createdAt: 1_770_000_000_000,
        updatedAt: 1_770_000_000_000,
        messages: [],
      },
    ],
  });
  await page.addInitScript(() => {
    localStorage.setItem('i18nextLng', 'en');
    localStorage.setItem('auth-token', 'e2e-token');
  });

  let promptListRequests = 0;
  await page.route(/\/api\/prompts(?:\/.*)?$/, async route => {
    promptListRequests += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: [standupPrompt] }),
    });
  });

  // ChatInput, and with it the command menus, only mounts inside a session.
  await page.goto('/c/composer-session');
  const composer = page.locator('textarea[rows="1"][dir="auto"]');
  await expect(composer).toBeVisible();

  // The menu only exists once the draft opens with a slash.
  await expect(page.getByTestId('composer-suggestions')).toHaveCount(0);

  await composer.fill('/');
  const menu = page.getByTestId('composer-suggestions');
  await expect(menu).toBeVisible();
  await expect(menu).toContainText('/standup');
  await expect(menu).toContainText(standupPrompt.title);
  expect(promptListRequests).toBeGreaterThan(0);

  await menu.getByRole('option', { name: /Daily standup/ }).click();

  // A prompt with no variables goes straight into the draft.
  await expect(page.getByTestId('composer-suggestions')).toHaveCount(0);
  await expect(composer).toHaveValue(standupPrompt.content);
});

test('the welcome composer offers prompts on slash too', async ({ page }) => {
  await mockLibreWebUiApi(page, { sessions: [] });
  await page.addInitScript(() => {
    localStorage.setItem('i18nextLng', 'en');
    localStorage.setItem('auth-token', 'e2e-token');
  });
  await page.route(/\/api\/prompts(?:\/.*)?$/, async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: [standupPrompt] }),
    });
  });

  // A brand-new chat starts on the welcome screen, which has its own
  // composer — the command menus must work there as well.
  await page.goto('/chat');
  const composer = page.locator('textarea[rows="1"]').first();
  await expect(composer).toBeVisible();

  await composer.fill('/stand');
  const menu = page.getByTestId('composer-suggestions');
  await expect(menu).toBeVisible();
  await expect(menu).toContainText('/standup');

  await menu.getByRole('option', { name: /Daily standup/ }).click();
  await expect(composer).toHaveValue(standupPrompt.content);
});

test('a bare slash with an empty library points at the settings panel', async ({
  page,
}) => {
  await mockLibreWebUiApi(page, { sessions: [] });
  await page.addInitScript(() => {
    localStorage.setItem('i18nextLng', 'en');
    localStorage.setItem('auth-token', 'e2e-token');
  });
  await page.route(/\/api\/prompts(?:\/.*)?$/, async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: [] }),
    });
  });

  await page.goto('/chat');
  const composer = page.locator('textarea[rows="1"]').first();
  await expect(composer).toBeVisible();

  await composer.fill('/');
  const empty = page.getByTestId('composer-suggestions-empty');
  await expect(empty).toBeVisible();
  await expect(empty).toContainText('Settings');
});
