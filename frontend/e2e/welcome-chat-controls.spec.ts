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

test('chat controls are available before a chat exists', async ({ page }) => {
  await mockLibreWebUiApi(page, { sessions: [] });
  await page.goto('/chat');

  const controls = page.getByTitle('Chat controls');
  const incognito = page.getByRole('button', { name: /incognito/i });
  await expect(controls).toBeVisible();

  // The two live in the same corner, controls on the outer side.
  const controlsBox = await controls.boundingBox();
  const incognitoBox = await incognito.boundingBox();
  expect(incognitoBox!.x + incognitoBox!.width).toBeLessThanOrEqual(
    controlsBox!.x
  );

  const panel = page.getByTestId('chat-controls-panel');
  await expect(panel).toBeHidden();

  await controls.click();
  await expect(panel).toBeVisible();

  // The composer keeps its place beside the panel rather than under it.
  const panelBox = await panel.boundingBox();
  const composerBox = await page
    .getByPlaceholder(/^message/i)
    .first()
    .boundingBox();
  expect(composerBox!.x + composerBox!.width).toBeLessThanOrEqual(panelBox!.x);

  await page
    .getByPlaceholder(/instructions that apply/i)
    .fill('Answer only in haiku.');
  const temperature = page.locator('input[type="number"]').first();
  await temperature.fill('0.31');
  await temperature.dispatchEvent('change');

  // Saving with no session yet keeps the choices for the chat about to start.
  await page.getByRole('button', { name: /^save$/i }).click();
  await expect(panel).toBeHidden();

  await controls.click();
  await expect(page.getByPlaceholder(/instructions that apply/i)).toHaveValue(
    'Answer only in haiku.'
  );
  await expect(page.locator('input[type="number"]').first()).toHaveValue(
    '0.31'
  );
});
