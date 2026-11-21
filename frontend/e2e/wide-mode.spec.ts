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

// Three turns, so the conversation history rail renders as well.
const session = {
  id: 'wide-mode-session',
  title: 'Wide mode conversation',
  model: 'llama3.2:3b',
  messages: [1, 2, 3].flatMap(turn => [
    {
      id: `wide-user-${turn}`,
      role: 'user' as const,
      content: `Write long paragraph number ${turn}.`,
      timestamp: baseTimestamp + turn * 2_000,
    },
    {
      id: `wide-assistant-${turn}`,
      role: 'assistant' as const,
      content: `${'A long answer that would normally wrap at the reading width. '
        .repeat(20)
        .trim()}\n\n\`\`\`js\nconst turn = ${turn};\n\`\`\``,
      timestamp: baseTimestamp + turn * 2_000 + 1_000,
      model: 'llama3.2:3b',
    },
  ]),
  createdAt: baseTimestamp,
  updatedAt: baseTimestamp + 7_000,
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

  // The chat controls sit in the header row above the messages, never on
  // top of the full-width column.
  const viewportBox = await page
    .getByTestId('chat-scroll-viewport')
    .boundingBox();
  const controls = await page
    .getByRole('button', { name: 'Chat controls' })
    .boundingBox();
  expect(controls).not.toBeNull();
  expect(controls!.y + controls!.height).toBeLessThanOrEqual(viewportBox!.y);

  // Running text keeps a readable measure while code uses the full width.
  const paragraph = page
    .getByText('A long answer that would normally wrap', { exact: false })
    .first();
  const paragraphBox = await paragraph.boundingBox();
  const codeBox = await page.getByTestId('code-block').first().boundingBox();
  expect(paragraphBox!.width).toBeLessThan(900);
  expect(codeBox!.width).toBeGreaterThan(1000);

  // The history rail leaves the middle of the chat for the start edge, still
  // clear of the messages.
  const rail = page.getByTestId('conversation-history-rail');
  await expect(rail).toBeVisible();
  const columnBox = await page
    .getByTestId('chat-messages-column')
    .boundingBox();
  const railBox = await rail.boundingBox();
  const firstAnchorBox = await page
    .getByTestId('conversation-turn-anchor')
    .first()
    .boundingBox();
  expect(railBox!.x).toBeLessThan(columnBox!.x + 16);
  expect(railBox!.x + railBox!.width).toBeLessThanOrEqual(
    firstAnchorBox!.x + 1
  );

  // The preference is saved to the account, so it survives a reload.
  await page.reload();
  await expect(page.getByTestId('chat-messages-column')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-layout', 'wide');
  await expect
    .poll(() => widthOf(page, 'chat-messages-column'))
    .toBeGreaterThan(1000);
});
