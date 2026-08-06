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

test('a model pulled while the app is open becomes selectable without a reload', async ({
  page,
}) => {
  const mockApi = await mockLibreWebUiApi(page);

  await page.goto('/chat');
  // The picker is a visually hidden native select behind a styled trigger.
  const options = page.locator('select option');
  await expect(options.filter({ hasText: 'llama' }).first()).toBeAttached();
  await expect(options.filter({ hasText: 'fresh-model' })).toHaveCount(0);

  // The model appears on the backend, as it would once a pull finishes.
  mockApi.setModels([
    ...mockApi.getModels(),
    {
      name: 'fresh-model:latest',
      model: 'fresh-model:latest',
      size: 1024,
      digest: 'fresh',
      modified_at: new Date(0).toISOString(),
      details: {
        family: 'llama',
        parameter_size: '1B',
        quantization_level: 'Q4_0',
      },
    },
  ]);

  // Completing a pull announces the change; nothing else should be needed.
  await page.evaluate(() =>
    window.dispatchEvent(new Event('libre:models-changed'))
  );

  await expect(
    options.filter({ hasText: 'fresh-model' }).first()
  ).toBeAttached();
});
