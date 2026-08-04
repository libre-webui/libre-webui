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

test('desktop compact sidebar is a readable recent-chat rail', async ({
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
  await expect(page.getByTestId('sidebar-navigation')).toHaveCount(0);
  await expect(page.getByTestId('sidebar-compact-session')).toHaveCount(8);
  await expect(page.getByTestId('sidebar-mobile-chats')).toBeHidden();

  const firstRecent = page.getByTestId('sidebar-compact-session').first();
  await expect(firstRecent).toHaveAccessibleName('Northern lights research');
  await expect(firstRecent).toHaveText('NR');
  await page.getByTestId('sidebar-compact-session').nth(1).click();
  await expect(page).toHaveURL(/\/c\/rail-session-1$/);
  await expect(
    page.getByTestId('sidebar-compact-session').nth(1)
  ).toHaveAttribute('aria-current', 'page');
  await expect(
    page.getByTestId('sidebar-compact-session').first()
  ).not.toHaveAttribute('aria-current', 'page');

  await page.getByTestId('sidebar-rail-expand').click();
  await expect(
    sidebar.getByText('Northern lights research', { exact: true })
  ).toBeVisible();
});
