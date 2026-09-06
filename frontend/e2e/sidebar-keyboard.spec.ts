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

import { expect, test, type Locator, type Page } from '@playwright/test';
import { mockLibreWebUiApi } from './lib/mockApi';

const createdAt = Date.now();
const session = {
  id: 'keyboard-garden',
  title:
    'Garden planning with keyboard navigation and a complete readable title',
  model: 'llama3.2:3b',
  messages: [],
  createdAt,
  updatedAt: createdAt,
};

const tabTo = async (page: Page, target: Locator) => {
  for (let step = 0; step < 30; step += 1) {
    if (await target.evaluate(element => element === document.activeElement)) {
      break;
    }
    await page.keyboard.press('Tab');
  }
  await expect(target).toBeFocused();
};

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('i18nextLng', 'en'));
});

test('chat history and its action menu work without a pointer', async ({
  page,
}) => {
  await mockLibreWebUiApi(page, { sessions: [session] });
  await page.goto('/chat');

  const sidebar = page.getByTestId('sidebar');
  const chat = sidebar.getByRole('button', {
    name: session.title,
    exact: true,
  });
  await page.getByTestId('sidebar-search-button').focus();
  await tabTo(page, chat);
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/c\/keyboard-garden$/);
  await expect(chat).toHaveAttribute('aria-current', 'page');

  // Loading a conversation may focus its composer. Return to the row and
  // verify its next tab stop reveals Actions without a mouse hover.
  await chat.focus();
  await page.keyboard.press('Tab');
  const actions = sidebar.getByTestId('sidebar-session-actions');
  await expect(actions).toBeFocused();
  await page.keyboard.press('Enter');

  const menu = page.getByTestId('sidebar-session-menu');
  const firstAction = menu.getByRole('menuitem').first();
  const lastAction = menu.getByRole('menuitem').last();
  await expect(firstAction).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(lastAction).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(firstAction).toBeFocused();
  await page.keyboard.press('End');
  await expect(lastAction).toBeFocused();
  await page.keyboard.press('Home');
  await expect(firstAction).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(actions).toBeFocused();

  await page.keyboard.press('Enter');
  await page.keyboard.press('ArrowDown');
  await expect(
    menu.getByRole('menuitem', { name: 'Rename chat' })
  ).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(
    sidebar.getByRole('textbox', { name: 'Rename chat' })
  ).toBeFocused();
  await expect(
    sidebar.getByRole('button', { name: 'Save', exact: true })
  ).toBeVisible();
  await expect(
    sidebar.getByRole('button', { name: 'Cancel', exact: true })
  ).toBeVisible();
});

test('Work history supports keyboard selection and dismissing its menu with Tab', async ({
  page,
}) => {
  const workTask = {
    id: 'keyboard-work',
    title: 'Keyboard workspace',
    model: 'llama3.2:3b',
    providerType: 'ollama' as const,
    status: 'completed' as const,
    networkEnabled: false,
    createdAt,
    updatedAt: createdAt,
    messages: [],
    activeRun: null,
    previewUrl: null,
    previewStatus: 'stopped' as const,
    workspacePath: '/workspace' as const,
  };
  await mockLibreWebUiApi(page, { workTasks: [workTask] });
  await page.goto('/work');

  const row = page.getByTestId('sidebar-work-task-item');
  const taskButton = row.getByRole('button', { name: /Keyboard workspace/ });
  await page.getByTestId('sidebar-search-button').focus();
  await tabTo(page, taskButton);
  await page.keyboard.press('Space');
  await expect(page).toHaveURL(/\/work\/keyboard-work$/);
  await expect(taskButton).toHaveAttribute('aria-current', 'page');
  await taskButton.focus();
  await page.keyboard.press('Tab');
  const actions = row.getByTestId('sidebar-work-task-actions');
  await expect(actions).toBeFocused();
  await page.keyboard.press('Enter');

  const menu = page.getByTestId('sidebar-work-task-menu');
  await expect(menu.getByRole('menuitem').first()).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(
    menu.getByRole('menuitem', { name: 'Delete task' })
  ).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(actions).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(menu.getByRole('menuitem').first()).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(menu).toBeHidden();
  await expect(taskButton).toBeFocused();
});

test('folder actions remain visible when navigating with the keyboard', async ({
  page,
}) => {
  await mockLibreWebUiApi(page, {
    sessions: [session],
    folders: [
      {
        id: 'garden-folder',
        name: 'Garden projects',
        createdAt,
        updatedAt: createdAt,
      },
    ],
  });
  await page.goto('/chat');

  const sidebar = page.getByTestId('sidebar');
  const folder = sidebar.getByRole('button', { name: 'Garden projects 0' });
  await page.getByTestId('sidebar-search-button').focus();
  await tabTo(page, folder);
  await page.keyboard.press('Tab');
  const rename = sidebar.getByRole('button', { name: 'Rename chat' });
  await expect(rename).toBeFocused();
  await expect(rename.locator('..')).toHaveCSS('opacity', '1');
  await page.keyboard.press('Tab');
  const remove = sidebar.getByRole('button', { name: 'Delete folder' });
  await expect(remove).toBeFocused();
  await expect(remove.locator('..')).toHaveCSS('opacity', '1');
});
