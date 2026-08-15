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

test('Stop cancels the exact stream and allows an immediate retry', async ({
  page,
}) => {
  await mockLibreWebUiApi(page, {
    sessions: [
      {
        id: 'cancel-session',
        title: 'Cancellation',
        model: 'llama3.2:3b',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messages: [],
      },
    ],
    chatStream: {
      chunks: ['The first stream is still running.'],
      chunkDelayMs: 100,
      completionDelayMs: 5_000,
    },
  });
  await page.addInitScript(() => {
    localStorage.setItem('i18nextLng', 'en');
    localStorage.setItem('auth-token', 'e2e-token');
  });

  await page.goto('/c/cancel-session');
  await page.waitForLoadState('networkidle');

  const input = page.locator('textarea[rows="1"][dir="auto"]');
  await input.fill('Start a long answer.');
  await input.press('Enter');
  await expect(
    page.getByText('The first stream is still running.')
  ).toBeVisible();

  await page.getByTitle('Stop generation').click();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const messages = (
          window as unknown as { __libreChatCancels?: unknown[] }
        ).__libreChatCancels;
        return messages?.length ?? 0;
      })
    )
    .toBe(1);
  await expect(
    page.getByText('The first stream is still running.')
  ).toHaveCount(0);

  await input.fill('Retry immediately.');
  await input.press('Enter');
  await expect
    .poll(() =>
      page.evaluate(() => {
        const messages = (
          window as unknown as { __libreChatStreams?: unknown[] }
        ).__libreChatStreams;
        return messages?.length ?? 0;
      })
    )
    .toBe(2);
  await expect(page.getByTitle('Stop generation')).toBeVisible();
});
