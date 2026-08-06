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

test('keyboard shortcuts are listed in settings, not in a floating overlay', async ({
  page,
}) => {
  await mockLibreWebUiApi(page);
  await page.goto('/chat');
  await expect(page.getByRole('textbox', { name: 'Message...' })).toBeVisible();

  // The floating indicator that used to sit over the chat is gone.
  await expect(page.getByTitle(/keyboard shortcuts/i)).toHaveCount(0);

  // Its key now opens settings on the shortcuts tab.
  await page.keyboard.press('h');
  const tab = page.getByRole('tab', { name: 'Shortcuts', exact: true });
  await expect(tab).toHaveAttribute('aria-selected', 'true');

  // Shortcuts from every part of the app, including ones the old modal
  // never listed.
  for (const label of [
    'Open command palette',
    'New chat',
    'New Work session',
    'Save an edited message',
    'Save file',
    'Format code',
  ]) {
    await expect(page.getByText(label, { exact: true })).toBeVisible();
  }

  // Settings stay reachable by their own key, on their usual tab.
  await page.keyboard.press('Escape');
  await expect(tab).toHaveCount(0);
  await page.keyboard.press('Control+,');
  await expect(
    page.getByRole('tab', { name: 'Appearance', exact: true })
  ).toHaveAttribute('aria-selected', 'true');
});
