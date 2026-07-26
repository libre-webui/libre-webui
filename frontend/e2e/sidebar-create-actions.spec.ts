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

const privateWorkTask = {
  id: 'private-work-task',
  title: 'Private admin workspace',
  model: 'llama3.2:3b',
  providerType: 'ollama' as const,
  status: 'completed' as const,
  networkEnabled: false,
  createdAt: 1,
  updatedAt: 1,
  messages: [],
  activeRun: null,
  previewUrl: null,
  previewStatus: 'stopped' as const,
  workspacePath: '/workspace' as const,
};

test('sidebar Work and Chat actions navigate to their fresh start screens', async ({
  page,
}) => {
  await mockLibreWebUiApi(page, { sessions: [session] });

  await page.goto(`/c/${session.id}`);
  await expect(page.getByPlaceholder('Send a message')).toBeVisible();
  const navigation = page.getByTestId('sidebar-navigation');
  const chatNavigation = navigation.getByRole('button', { name: 'Chat' });
  const workNavigation = navigation.getByRole('link', { name: 'Work' });
  await expect(page.getByTestId('sidebar-chat-button')).toHaveAttribute(
    'aria-pressed',
    'true'
  );
  await expect(page.getByTestId('sidebar-work-button')).toHaveAttribute(
    'aria-pressed',
    'false'
  );
  await expect(chatNavigation).toHaveAttribute('aria-current', 'page');
  await expect(workNavigation).not.toHaveAttribute('aria-current', 'page');

  await page.getByTestId('sidebar-work-button').click();
  await expect(page).toHaveURL(/\/work$/);
  await expect(page.getByTestId('sidebar-work-button')).toHaveAttribute(
    'aria-pressed',
    'true'
  );
  await expect(page.getByTestId('sidebar-chat-button')).toHaveAttribute(
    'aria-pressed',
    'false'
  );
  await expect(workNavigation).toHaveAttribute('aria-current', 'page');
  await expect(chatNavigation).not.toHaveAttribute('aria-current', 'page');

  await page.getByTestId('sidebar-chat-button').click();
  await expect(page).toHaveURL(/\/chat$/);
  await expect(page.getByTestId('sidebar-chat-button')).toHaveAttribute(
    'aria-pressed',
    'true'
  );
  await expect(page.getByTestId('sidebar-work-button')).toHaveAttribute(
    'aria-pressed',
    'false'
  );
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

test('Work is hidden and route-protected for non-admin users', async ({
  page,
}) => {
  const mock = await mockLibreWebUiApi(page, {
    authRole: 'user',
    workTasks: [privateWorkTask],
    systemInfo: {
      requiresAuth: true,
      hasUsers: true,
      userCount: 2,
      allowUserModelPull: true,
      version: '0.10.0-e2e',
      turnstile: { enabled: false },
    },
  });

  await page.goto('/login');
  await page.getByLabel('Username').fill('member');
  await page.getByLabel('Password').fill('password');
  await page.getByRole('button', { name: /sign in/i }).click();

  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId('sidebar-work-button')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Work' })).toHaveCount(0);

  await page.goto('/work');
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId('work-page')).toHaveCount(0);
  await expect(page.getByText(privateWorkTask.title)).toHaveCount(0);
  expect(mock.workTaskListRequests).toHaveLength(0);
});
