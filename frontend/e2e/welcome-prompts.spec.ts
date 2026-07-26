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

test('new chats rotate through distinct creator prompts', async ({ page }) => {
  await mockLibreWebUiApi(page);
  await page.addInitScript(() => {
    window.sessionStorage.setItem('welcomePromptIndex', '0');
  });

  await page.goto('/chat');

  const newChatButton = page.getByTestId('sidebar-chat-button');
  await expect(newChatButton).toBeEnabled();

  await newChatButton.click();
  await expect(
    page.getByRole('heading', { name: 'What should we make?', exact: true })
  ).toBeVisible();

  await newChatButton.click();
  await expect(
    page.getByRole('heading', { name: 'Where should we begin?', exact: true })
  ).toBeVisible();
});
