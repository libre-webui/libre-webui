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

const sentOptions = () =>
  (
    (window as unknown as Record<string, unknown>).__libreChatStreams as
      Array<{ options?: Record<string, unknown> }> | undefined
  )?.map(entry => entry.options ?? {}) ?? [];

test('a message carries only the chat’s own overrides, never the global settings', async ({
  page,
}) => {
  await mockLibreWebUiApi(page, {
    sessions: [
      {
        id: 'session-options',
        title: 'Options',
        model: 'llama3.2:3b',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messages: [],
        settings: { generationOptions: { temperature: 0.31 } },
      },
    ],
  });

  await page.goto('/c/session-options');
  const composer = page.getByRole('textbox', { name: 'Send a message' });
  await expect(composer).toBeVisible();
  await composer.fill('hello');
  await page.keyboard.press('Enter');

  await expect
    .poll(async () => (await page.evaluate(sentOptions)).length)
    .toBeGreaterThan(0);
  const [options] = await page.evaluate(sentOptions);

  // The chat's own override travels with the request.
  expect(options.temperature).toBe(0.31);

  // The application defaults must not: the server applies those itself, after
  // what the model recommends and what the user pinned for that model. Sending
  // them here silently outranked both — a pinned num_predict was overridden by
  // the global one on every request.
  expect(options).not.toHaveProperty('num_predict');
  expect(options).not.toHaveProperty('num_ctx');
  expect(Object.keys(options)).toEqual(['temperature']);
});
