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
import { openSettingsTab, selectSettingsTab } from './lib/settingsTab';

const authenticatedSystemInfo = {
  requiresAuth: true,
  hasUsers: true,
  userCount: 2,
  version: '0.28.0-e2e',
  turnstile: { enabled: false },
};

test('bulk model updates are scoped to the Ollama model manager', async ({
  page,
}) => {
  await mockLibreWebUiApi(page, {
    authRole: 'admin',
    systemInfo: authenticatedSystemInfo,
  });
  await page.addInitScript(() => {
    localStorage.setItem('auth-token', 'e2e-token');
  });
  await page.route('**/api/ollama/models/pull-all/stream', async route => {
    await route.fulfill({
      status: 200,
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
      },
      body: [
        'data: {"type":"progress","current":1,"total":1,"modelName":"llama3.2:3b","status":"success"}',
        '',
        'data: {"type":"complete"}',
        '',
        '',
      ].join('\n'),
    });
  });

  await page.goto('/');
  const panel = await openSettingsTab(page, 'models');

  await expect(panel.getByText('Bulk Operations', { exact: true })).toHaveCount(
    0
  );
  await expect(
    panel.getByRole('button', { name: 'Update All', exact: true })
  ).toHaveCount(0);

  await selectSettingsTab(panel, 'model-manager');
  const bulkOperations = panel.getByTestId('model-manager-bulk-operations');
  await expect(bulkOperations).toBeVisible();
  await expect(
    bulkOperations.getByRole('heading', {
      name: 'Bulk Operations',
      exact: true,
    })
  ).toBeVisible();

  const updateRequest = page.waitForRequest(request => {
    const url = new URL(request.url());
    return (
      request.method() === 'GET' &&
      url.pathname === '/api/ollama/models/pull-all/stream'
    );
  });
  await bulkOperations
    .getByRole('button', { name: 'Update All', exact: true })
    .click();
  await updateRequest;
  await expect(
    page.getByText('All models updated successfully!')
  ).toBeVisible();
});

test('bulk model updates expose their progress accessibly', async ({
  page,
}) => {
  await mockLibreWebUiApi(page, {
    authRole: 'admin',
    systemInfo: authenticatedSystemInfo,
  });
  await page.addInitScript(() => {
    localStorage.setItem('auth-token', 'e2e-token');
  });
  await page.route('**/api/ollama/models/pull-all/stream', async route => {
    await route.fulfill({
      status: 200,
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
      },
      body: [
        'data: {"type":"progress","current":1,"total":2,"modelName":"llama3.2:3b","status":"success"}',
        '',
        '',
      ].join('\n'),
    });
  });

  await page.goto('/chat');
  const panel = await openSettingsTab(page, 'model-manager');
  const bulkOperations = panel.getByTestId('model-manager-bulk-operations');
  await bulkOperations
    .getByRole('button', { name: 'Update All', exact: true })
    .click();

  await expect(bulkOperations).toHaveAttribute('aria-busy', 'true');
  await expect(
    bulkOperations.getByRole('button', { name: 'Updating models...' })
  ).toBeDisabled();
  await expect(
    bulkOperations.getByRole('progressbar', { name: 'Update All Models' })
  ).toHaveAttribute('aria-valuenow', '50');
  await expect(bulkOperations).toContainText('Updating llama3.2:3b (1/2)');
});

test('bulk model updates stay hidden when the account cannot use the admin endpoint', async ({
  page,
}) => {
  await mockLibreWebUiApi(page, {
    authRole: 'user',
    systemInfo: authenticatedSystemInfo,
  });
  await page.addInitScript(() => {
    localStorage.setItem('auth-token', 'e2e-token');
  });

  await page.goto('/chat');
  const panel = await openSettingsTab(page, 'model-manager');

  await expect(
    panel.getByText(
      'Model installation is restricted to administrators on this instance.'
    )
  ).toBeVisible();
  await expect(panel.getByTestId('model-manager-bulk-operations')).toHaveCount(
    0
  );
});

test('cloud library pulls append the Ollama cloud suffix automatically', async ({
  page,
}) => {
  const api = await mockLibreWebUiApi(page, {
    cloudLibraryModels: [
      {
        name: 'gpt-oss',
        description: 'Cloud listing returned without :cloud',
        category: 'cloud',
        sizes: ['cloud'],
        pulls: 'Cloud',
        tags: ['cloud'],
      },
    ],
  });

  await page.goto('/');
  await openSettingsTab(page, 'model-manager');

  await page.getByRole('button', { name: /browse library/i }).click();
  await page.getByRole('button', { name: /^cloud$/i }).click();
  await expect(page.getByTestId('library-model-card-gpt-oss')).toBeVisible();

  const pullRequest = page.waitForRequest(request => {
    const url = request.url();
    return url.includes('/api/ollama/pull/stream') && url.includes('model=');
  });

  await page.getByTestId('library-model-install-gpt-oss').click();
  const request = await pullRequest;
  const model = new URL(request.url()).searchParams.get('model');

  expect(model).toBe('gpt-oss:cloud');
  await expect.poll(() => api.pullStreamUrls.length).toBe(1);
  expect(api.pullStreamUrls).toContain(request.url());
});
