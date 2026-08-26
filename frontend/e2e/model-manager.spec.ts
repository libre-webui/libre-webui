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
import { openSettingsTab } from './lib/settingsTab';

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
