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

const baseTimestamp = Date.UTC(2026, 6, 15, 18, 0, 0);

const userPrompts = [
  'Plan a small native garden for a shaded courtyard.',
  'Turn that plan into a weekend checklist.',
  'Which plants are safest around pets?',
  'Estimate a modest materials budget.',
  'Rewrite the plan for a very small balcony.',
  'Summarize the final design in five clear steps.',
];

const longResponse = (turn: number) =>
  Array.from(
    { length: 8 },
    (_, paragraph) =>
      `Turn ${turn}, detail ${paragraph + 1}. This paragraph provides enough practical context to make the conversation taller than the available chat viewport.`
  ).join('\n\n');

const historyMessages = [
  {
    id: 'history-system',
    role: 'system' as const,
    content: 'Keep answers practical and concise.',
    timestamp: baseTimestamp,
  },
  ...userPrompts.flatMap((content, index) => [
    {
      id: `history-user-${index + 1}`,
      role: 'user' as const,
      content,
      timestamp: baseTimestamp + index * 2_000 + 1_000,
    },
    {
      id: `history-assistant-${index + 1}`,
      role: 'assistant' as const,
      content: longResponse(index + 1),
      timestamp: baseTimestamp + index * 2_000 + 2_000,
      model: 'llama3.2:3b',
    },
  ]),
];

const mockHistorySession = async (
  page: Parameters<typeof mockLibreWebUiApi>[0]
) => {
  await mockLibreWebUiApi(page, {
    sessions: [
      {
        id: 'history-rail-session',
        title: 'History rail',
        model: 'llama3.2:3b',
        createdAt: baseTimestamp,
        updatedAt: baseTimestamp + 20_000,
        messages: historyMessages,
      },
    ],
  });
};

test('history rail represents user turns and navigates the chat viewport', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await mockHistorySession(page);
  await page.goto('/c/history-rail-session');

  const viewport = page.getByTestId('chat-scroll-viewport');
  const rail = page.getByTestId('conversation-history-rail');
  const markers = page.getByTestId('conversation-history-marker');
  const anchors = page.getByTestId('conversation-turn-anchor');

  await expect(viewport).toBeVisible();
  await expect(rail).toBeVisible();
  await expect(markers).toHaveCount(userPrompts.length);
  await expect(anchors).toHaveCount(userPrompts.length);

  const currentMarkers = page.locator(
    '[data-testid="conversation-history-marker"][aria-current="location"]'
  );
  await expect(currentMarkers).toHaveCount(1);

  const maxScrollTop = await viewport.evaluate(
    element => element.scrollHeight - element.clientHeight
  );
  expect(maxScrollTop).toBeGreaterThan(0);

  const initialCurrentIndex = await markers.evaluateAll(elements =>
    elements.findIndex(
      element => element.getAttribute('aria-current') === 'location'
    )
  );
  const targetIndex = initialCurrentIndex === 3 ? 0 : 3;
  const targetMarker = markers.nth(targetIndex);
  const targetAnchor = anchors.nth(targetIndex);
  const initialScrollTop = await viewport.evaluate(
    element => element.scrollTop
  );

  await targetMarker.hover();
  const preview = page.getByRole('tooltip');
  await expect(preview).toBeVisible();
  await expect(preview).toContainText(userPrompts[targetIndex]);
  await targetMarker.focus();
  await page.keyboard.press('Escape');
  await expect(preview).toBeHidden();

  await targetMarker.click();

  await expect(targetMarker).toHaveAttribute('aria-current', 'location');
  await expect
    .poll(async () =>
      Math.abs(
        (await viewport.evaluate(element => element.scrollTop)) -
          initialScrollTop
      )
    )
    .toBeGreaterThan(1);
  await expect
    .poll(async () => {
      const viewportBox = await viewport.boundingBox();
      const anchorBox = await targetAnchor.boundingBox();
      if (!viewportBox || !anchorBox) return false;

      return (
        anchorBox.y >= viewportBox.y - 1 &&
        anchorBox.y < viewportBox.y + viewportBox.height
      );
    })
    .toBe(true);

  await targetMarker.focus();
  await page.keyboard.press('Home');
  await expect(markers.first()).toHaveAttribute('aria-current', 'location');

  await viewport.evaluate(element => {
    element.scrollTop = element.scrollHeight;
    element.dispatchEvent(new Event('scroll', { bubbles: true }));
  });

  await expect(markers.last()).toHaveAttribute('aria-current', 'location');
  await expect(currentMarkers).toHaveCount(1);
});

test('history preview follows the active regenerated branch', async ({
  page,
}) => {
  await mockLibreWebUiApi(page, {
    sessions: [
      {
        id: 'branched-history-session',
        title: 'Branched history',
        model: 'llama3.2:3b',
        createdAt: baseTimestamp,
        updatedAt: baseTimestamp + 10_000,
        messages: [
          {
            id: 'branch-user-1',
            role: 'user',
            content: userPrompts[0],
            timestamp: baseTimestamp + 1_000,
          },
          {
            id: 'branch-assistant-1',
            role: 'assistant',
            content: 'First answer.',
            timestamp: baseTimestamp + 2_000,
            model: 'llama3.2:3b',
          },
          {
            id: 'branch-user-2',
            role: 'user',
            content: userPrompts[1],
            timestamp: baseTimestamp + 3_000,
          },
          {
            id: 'branch-assistant-original',
            role: 'assistant',
            content: 'Original answer that is no longer active.',
            timestamp: baseTimestamp + 4_000,
            model: 'llama3.2:3b',
            branchIndex: 0,
            isActive: false,
          },
          {
            id: 'branch-assistant-regenerated',
            role: 'assistant',
            content: 'Active regenerated answer.',
            timestamp: baseTimestamp + 4_500,
            model: 'llama3.2:3b',
            parentId: 'branch-assistant-original',
            branchIndex: 1,
            isActive: true,
          },
          {
            id: 'branch-user-3',
            role: 'user',
            content: userPrompts[2],
            timestamp: baseTimestamp + 5_000,
          },
          {
            id: 'branch-assistant-3',
            role: 'assistant',
            content: 'Third answer.',
            timestamp: baseTimestamp + 6_000,
            model: 'llama3.2:3b',
          },
        ],
      },
    ],
  });
  await page.goto('/c/branched-history-session');

  const markers = page.getByTestId('conversation-history-marker');
  await expect(markers).toHaveCount(3);
  await expect(page.getByTestId('conversation-turn-anchor')).toHaveCount(3);
  await markers.nth(1).hover();
  const preview = page.getByRole('tooltip');
  await expect(preview).toContainText('Active regenerated answer.');
  await expect(preview).not.toContainText(
    'Original answer that is no longer active.'
  );
});

test('history navigation stays put while the latest response streams', async ({
  page,
}) => {
  const streamChunks = Array.from(
    { length: 7 },
    (_, index) =>
      `Streaming segment ${index}. ${'A growing response keeps the live tail moving. '.repeat(10)}\n\n`
  );
  await mockLibreWebUiApi(page, {
    sessions: [
      {
        id: 'streaming-history-session',
        title: 'Streaming history',
        model: 'llama3.2:3b',
        createdAt: baseTimestamp,
        updatedAt: baseTimestamp + 20_000,
        messages: historyMessages,
      },
    ],
    chatStream: {
      chunks: streamChunks,
      chunkDelayMs: 120,
      completionDelayMs: 700,
    },
  });
  await page.addInitScript(() => {
    localStorage.setItem('i18nextLng', 'en');
  });
  await page.goto('/c/streaming-history-session');

  const input = page.locator('textarea[dir="auto"]');
  await input.fill('Add one final recommendation.');
  await input.press('Enter');
  await expect(page.locator('body')).toContainText('Streaming segment 0.');

  const viewport = page.getByTestId('chat-scroll-viewport');
  const markers = page.getByTestId('conversation-history-marker');
  const firstMarker = markers.first();
  const firstAnchor = page.getByTestId('conversation-turn-anchor').first();
  await expect(markers).toHaveCount(userPrompts.length + 1);
  await firstMarker.click();
  await expect(firstMarker).toHaveAttribute('aria-current', 'location');

  await expect(page.locator('body')).toContainText('Streaming segment 4.');
  await expect(firstMarker).toHaveAttribute('aria-current', 'location');
  await expect
    .poll(async () => {
      const viewportBox = await viewport.boundingBox();
      const anchorBox = await firstAnchor.boundingBox();
      if (!viewportBox || !anchorBox) return false;
      return (
        anchorBox.y >= viewportBox.y - 1 &&
        anchorBox.y < viewportBox.y + viewportBox.height
      );
    })
    .toBe(true);
  expect(
    await viewport.evaluate(
      element => element.scrollHeight - element.scrollTop - element.clientHeight
    )
  ).toBeGreaterThan(100);
});

test('history rail mirrors its position and preview in Arabic', async ({
  page,
}) => {
  await mockHistorySession(page);
  await page.addInitScript(() => {
    localStorage.setItem('i18nextLng', 'ar');
  });
  await page.goto('/c/history-rail-session');

  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  const viewport = page.getByTestId('chat-scroll-viewport');
  const rail = page.getByTestId('conversation-history-rail');
  await expect(rail).toHaveAttribute('aria-label', 'سجل المحادثة');

  const marker = page.getByTestId('conversation-history-marker').nth(1);
  await marker.hover();
  const preview = page.getByRole('tooltip');
  await expect(preview).toBeVisible();

  const viewportBox = await viewport.boundingBox();
  const railBox = await rail.boundingBox();
  const previewBox = await preview.boundingBox();
  expect(viewportBox).not.toBeNull();
  expect(railBox).not.toBeNull();
  expect(previewBox).not.toBeNull();
  expect(railBox!.x).toBeGreaterThan(viewportBox!.x + viewportBox!.width / 2);
  expect(previewBox!.x + previewBox!.width).toBeLessThanOrEqual(railBox!.x + 1);
});

test.describe('compact desktop history rail', () => {
  test.use({ viewport: { width: 1024, height: 768 } });

  test('remains available in a desktop-sized window', async ({ page }) => {
    await mockHistorySession(page);
    await page.goto('/c/history-rail-session');

    await expect(page.getByTestId('conversation-history-rail')).toBeVisible();
    await expect(page.getByTestId('conversation-history-marker')).toHaveCount(
      userPrompts.length
    );

    const railBox = await page
      .getByTestId('conversation-history-rail')
      .boundingBox();
    const firstAnchorBox = await page
      .getByTestId('conversation-turn-anchor')
      .first()
      .boundingBox();
    expect(railBox).not.toBeNull();
    expect(firstAnchorBox).not.toBeNull();
    expect(railBox!.x + railBox!.width).toBeLessThanOrEqual(
      firstAnchorBox!.x + 1
    );
  });
});

test.describe('mobile history rail', () => {
  test.use({
    viewport: { width: 390, height: 844 },
    isMobile: true,
  });

  test('history rail stays out of the mobile chat layout', async ({ page }) => {
    await mockHistorySession(page);
    await page.goto('/c/history-rail-session');

    await expect(page.getByTestId('chat-scroll-viewport')).toBeVisible();
    await expect(page.getByTestId('conversation-history-rail')).toBeHidden();
  });
});
