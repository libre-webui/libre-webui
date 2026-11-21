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

test.use({ viewport: { width: 1440, height: 900 } });

const baseTimestamp = Date.now() - 120_000;

const statistics = {
  prompt_eval_count: 120,
  eval_count: 147,
  tokens_per_second: 47.6,
  total_duration: 4_640_000_000,
  prompt_eval_duration: 210_000_000,
  eval_duration: 3_090_000_000,
  load_duration: 40_000_000,
  model: 'llama3.2:3b',
};

const session = {
  id: 'reading-layout-session',
  title: 'Reading layout',
  model: 'llama3.2:3b',
  messages: [1, 2, 3].flatMap(turn => [
    {
      id: `reading-user-${turn}`,
      role: 'user' as const,
      content: `Question number ${turn}`,
      timestamp: baseTimestamp + turn * 2_000,
    },
    {
      id: `reading-assistant-${turn}`,
      role: 'assistant' as const,
      content: `Answer number ${turn}.`,
      timestamp: baseTimestamp + turn * 2_000 + 1_000,
      model: 'llama3.2:3b',
      statistics,
    },
  ]),
  createdAt: baseTimestamp,
  updatedAt: baseTimestamp + 7_000,
};

const models = [
  {
    name: 'llama3.2:3b',
    size: 2_048_000_000,
    digest: 'reading-llama',
    modified_at: new Date('2026-06-21T00:00:00.000Z').toISOString(),
    details: {
      format: 'gguf',
      family: 'llama',
      families: ['llama'],
      parameter_size: '3B',
      quantization_level: 'Q4_0',
    },
  },
  {
    name: 'qwen3:8b',
    size: 5_200_000_000,
    digest: 'reading-qwen',
    modified_at: new Date('2026-06-21T00:00:00.000Z').toISOString(),
    details: {
      format: 'gguf',
      family: 'qwen3',
      families: ['qwen3'],
      parameter_size: '8B',
      quantization_level: 'Q4_K_M',
    },
  },
];

async function openChat(page: Page) {
  await mockLibreWebUiApi(page, {
    sessions: [session],
    models,
    chatStream: { chunks: ['Fresh ', 'reply'], finalChunk: '.' },
  });
  // Routes registered later win, so these override the shared mock.
  await page.route('**/api/search/config', route =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: { enabled: true, available: true, allowed: true },
      }),
    })
  );
  await page.route('**/api/chat/sessions/*/followups', route =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: { suggestions: ['Tell me more', 'Give an example'] },
      }),
    })
  );
  await page.goto(`/c/${session.id}`);
  await expect(page.getByTestId('chat-messages-column')).toBeVisible();
}

test('replies keep one quiet action row and the header holds the controls', async ({
  page,
}) => {
  await openChat(page);

  // Chat controls live in the header row, above the scrolling messages.
  const header = page.getByTestId('chat-session-header');
  const controls = header.getByRole('button', { name: 'Chat controls' });
  await expect(controls).toBeVisible();
  const controlsBox = await controls.boundingBox();
  const viewportBox = await page
    .getByTestId('chat-scroll-viewport')
    .boundingBox();
  expect(controlsBox!.y + controlsBox!.height).toBeLessThanOrEqual(
    viewportBox!.y
  );

  // Stats share the action row; the latest reply keeps it in view while an
  // older one waits for hover.
  const assistantRows = page
    .getByTestId('message-action-row')
    .filter({ has: page.getByTestId('generation-stats') });
  await expect(assistantRows).toHaveCount(3);
  await expect(assistantRows.last()).toHaveCSS('opacity', '1');
  await expect(assistantRows.first()).toHaveCSS('opacity', '0');
  await page.getByText('Answer number 1.').hover();
  await expect(assistantRows.first()).toHaveCSS('opacity', '1');

  // The token count opens the breakdown; there is no separate Details row.
  await expect(page.getByRole('button', { name: 'Details' })).toHaveCount(0);
  const tokens = assistantRows
    .last()
    .getByRole('button', { name: '147 tokens' });
  await expect(tokens).toHaveAttribute('aria-expanded', 'false');
  await tokens.click();
  await expect(tokens).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByText('Prompt tokens:')).toBeVisible();

  // The footer names the model instead of a generic "LLM".
  await expect(
    page.getByText(
      'llama3.2:3b can make mistakes. Verify important information.'
    )
  ).toBeVisible();
});

test('web search and compare move into the + menu and return when active', async ({
  page,
}) => {
  await openChat(page);

  const webSearchOn = page.getByRole('button', {
    name: 'Web search on — replies use live results',
  });
  await expect(page.getByTestId('composer-compare-toggle')).toHaveCount(0);
  await expect(webSearchOn).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Search the web for this message' })
  ).toHaveCount(0);

  const plus = page.getByRole('button', {
    name: 'Attachments and advanced features',
  });
  await plus.click();
  await page
    .getByRole('button', { name: 'Search the web for this message' })
    .click();
  // On, it joins the toolbar so one click turns it off again.
  await expect(webSearchOn).toBeVisible();
  await expect(webSearchOn).toHaveAttribute('aria-pressed', 'true');
  await webSearchOn.click();
  await expect(webSearchOn).toHaveCount(0);

  await plus.click();
  await page.getByTestId('composer-menu-compare').click();
  const compareMenu = page.getByTestId('composer-compare-menu');
  await expect(compareMenu).toBeVisible();
  await compareMenu.getByText('qwen3:8b').click();
  await page.keyboard.press('Escape');
  await expect(compareMenu).toBeHidden();
  // A picked model keeps the compare control in the toolbar.
  await expect(page.getByTestId('composer-compare-toggle')).toBeVisible();
  await expect(page.getByTestId('composer-compare-toggle')).toContainText('+1');
});

test('follow-ups sit under the reply text and the timeline stays faint', async ({
  page,
}) => {
  await openChat(page);

  const rail = page.getByTestId('conversation-history-rail').locator('ol');
  await expect(rail).toHaveCSS('opacity', '0.4');
  await page.getByTestId('conversation-history-marker').first().hover();
  await expect(rail).toHaveCSS('opacity', '1');

  const textbox = page.getByRole('textbox', { name: 'Send a message' });
  await textbox.fill('One more question');
  await textbox.press('Enter');
  await expect(
    page.getByTestId('chat-messages-column').getByText('Fresh reply.')
  ).toBeVisible();

  const followUps = page.getByTestId('follow-up-suggestions');
  await expect(followUps).toBeVisible();
  await expect(followUps).toHaveAccessibleName('Follow up');
  const chip = followUps.getByRole('button', { name: 'Tell me more' });
  await expect(chip).toBeVisible();
  const chipBox = await chip.boundingBox();
  const replyBox = await page
    .getByTestId('chat-messages-column')
    .getByText('Fresh reply.')
    .boundingBox();
  expect(Math.abs(chipBox!.x - replyBox!.x)).toBeLessThanOrEqual(2);
});
