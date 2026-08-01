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

const session = {
  id: 'title-session',
  title: 'New Chat',
  model: 'llama3.2:3b',
  messages: [],
  createdAt: 1,
  updatedAt: 1,
};

test('generated title immediately replaces the sidebar preview without a duplicate update', async ({
  page,
}) => {
  const mockApi = await mockLibreWebUiApi(page, {
    sessions: [session],
    preferences: {
      titleSettings: {
        autoTitle: true,
        taskModel: 'llama3.2:3b',
      },
    },
    generatedTitle: {
      title: 'Persistent Sidebar Summary',
      source: 'ollama',
    },
  });

  await page.goto('/c/title-session');
  const messageInput = page.getByRole('textbox', { name: 'Send a message' });
  await expect(messageInput).toBeVisible();
  await expect(page.getByRole('heading', { name: 'New Chat' })).toBeVisible();

  await messageInput.fill('Explain why the generated title should update');
  await messageInput.press('Enter');

  await expect(
    page
      .getByTestId('sidebar-session-scroll-region')
      .getByText('Persistent Sidebar Summary', { exact: true })
  ).toBeVisible();
  await expect(
    page.getByText('Chat title generated', { exact: true })
  ).toBeVisible();
  await expect.poll(() => mockApi.titleGenerationRequests.length).toBe(1);

  expect(mockApi.titleGenerationRequests[0]).toEqual({
    sessionId: 'title-session',
    model: 'llama3.2:3b',
    message: 'Explain why the generated title should update',
  });
  expect(mockApi.sessionUpdateRequests).toHaveLength(0);
});

test('fallback title is applied without falsely reporting generation success', async ({
  page,
}) => {
  const mockApi = await mockLibreWebUiApi(page, {
    sessions: [session],
    preferences: {
      titleSettings: {
        autoTitle: true,
        taskModel: 'llama3.2:3b',
      },
    },
    generatedTitle: {
      title: 'Explain why fallback text is',
      source: 'fallback',
    },
  });

  await page.goto('/c/title-session');
  const messageInput = page.getByRole('textbox', { name: 'Send a message' });
  await expect(messageInput).toBeVisible();

  await messageInput.fill('Explain why fallback text is used');
  await messageInput.press('Enter');

  await expect(
    page
      .getByTestId('sidebar-session-scroll-region')
      .getByText('Explain why fallback text is', { exact: true })
  ).toBeVisible();
  await expect(
    page.getByText('Could not generate a title; using the message preview', {
      exact: true,
    })
  ).toBeVisible();
  await expect(
    page.getByText('Chat title generated', { exact: true })
  ).toHaveCount(0);
  expect(mockApi.sessionUpdateRequests).toHaveLength(0);
});
