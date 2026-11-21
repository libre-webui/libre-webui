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

import { expect, test, type Page } from '@playwright/test';
import { mockLibreWebUiApi } from './lib/mockApi';

test.use({ viewport: { width: 1600, height: 900 } });

const baseTimestamp = Date.now() - 60_000;

const session = {
  id: 'wide-mode-session',
  title: 'Wide mode conversation',
  model: 'llama3.2:3b',
  messages: [
    {
      id: 'wide-user-1',
      role: 'user' as const,
      content: 'Write a long paragraph.',
      timestamp: baseTimestamp,
    },
    {
      id: 'wide-assistant-1',
      role: 'assistant' as const,
      content: 'A long answer that would normally wrap at the reading width. '
        .repeat(20)
        .trim(),
      timestamp: baseTimestamp + 1_000,
      model: 'llama3.2:3b',
    },
  ],
  createdAt: baseTimestamp,
  updatedAt: baseTimestamp + 1_000,
};

const widthOf = async (page: Page, testId: string) =>
  (await page.getByTestId(testId).boundingBox())?.width ?? 0;

const composerWidth = async (page: Page) =>
  (await page.getByRole('textbox', { name: 'Send a message' }).boundingBox())
    ?.width ?? 0;

test('wide mode lets the chat column and composer use the whole window', async ({
  page,
}) => {
  await mockLibreWebUiApi(page, {
    sessions: [session],
    preferences: { wideMode: false },
  });
  await page.goto(`/c/${session.id}`);

  await expect(page.getByTestId('chat-messages-column')).toBeVisible();
  // The default reading width is max-w-3xl (48rem at the 15px root).
  await expect
    .poll(() => widthOf(page, 'chat-messages-column'))
    .toBeLessThan(760);
  const narrowComposer = await composerWidth(page);
  expect(narrowComposer).toBeLessThan(760);
  await expect(page.locator('html')).not.toHaveAttribute('data-layout', 'wide');

  await page.evaluate(() => {
    document.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: ',',
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      })
    );
  });
  await expect(page.getByTestId('settings-modal-panel')).toBeVisible();
  const toggle = page.getByTestId('wide-mode-toggle');
  await expect(toggle).toHaveAccessibleName('Wide mode');
  await expect(toggle).not.toBeChecked();

  const preferenceSave = page.waitForRequest(
    request =>
      request.url().endsWith('/api/preferences') &&
      request.method() === 'PUT' &&
      request.postDataJSON().wideMode === true
  );
  await toggle.locator('..').click();
  await preferenceSave;
  await expect(toggle).toBeChecked();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('settings-modal-panel')).toBeHidden();

  await expect(page.locator('html')).toHaveAttribute('data-layout', 'wide');
  await expect
    .poll(() => widthOf(page, 'chat-messages-column'))
    .toBeGreaterThan(1000);
  await expect
    .poll(() => composerWidth(page))
    .toBeGreaterThan(narrowComposer + 250);

  // The full-width column keeps its content clear of the floating chat
  // controls button at the top end of the chat.
  const contentEnd = await page
    .getByTestId('chat-messages-column')
    .evaluate(element => {
      const box = element.getBoundingClientRect();
      return box.right - parseFloat(getComputedStyle(element).paddingRight);
    });
  const controls = await page
    .getByRole('button', { name: 'Chat controls' })
    .boundingBox();
  expect(controls).not.toBeNull();
  expect(controls!.x).toBeGreaterThanOrEqual(contentEnd);

  // The preference is saved to the account, so it survives a reload.
  await page.reload();
  await expect(page.getByTestId('chat-messages-column')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-layout', 'wide');
  await expect
    .poll(() => widthOf(page, 'chat-messages-column'))
    .toBeGreaterThan(1000);
});
