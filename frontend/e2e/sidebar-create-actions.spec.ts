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

const session = {
  id: 'sidebar-create-actions-session',
  title: 'Sidebar create actions session',
  model: 'llama3.2:3b',
  messages: [],
  createdAt: 1,
  updatedAt: 1,
};

test('sidebar Work and Chat actions navigate to their fresh start screens', async ({
  page,
}) => {
  await mockLibreWebUiApi(page, { sessions: [session] });

  await page.goto(`/c/${session.id}`);
  await expect(page.getByPlaceholder('Send a message')).toBeVisible();

  await page.getByTestId('sidebar-work-button').click();
  await expect(page).toHaveURL(/\/agents$/);

  await page.getByTestId('sidebar-chat-button').click();
  await expect(page).toHaveURL(/\/chat$/);
  await expect(page.getByPlaceholder('Message...')).toBeVisible();
  await expect(page.getByPlaceholder('Send a message')).toHaveCount(0);
});

test('Work stays available when no chat model is installed', async ({
  page,
}) => {
  await mockLibreWebUiApi(page, { models: [] });

  await page.goto('/chat');

  await expect(page.getByTestId('sidebar-work-button')).toBeEnabled();
  await expect(page.getByTestId('sidebar-chat-button')).toBeDisabled();
});
