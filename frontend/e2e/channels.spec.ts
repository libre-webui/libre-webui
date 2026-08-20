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

import { expect, test, type Page } from '@playwright/test';
import { mockLibreWebUiApi } from './lib/mockApi';

type MockMessage = {
  id: string;
  channelId: string;
  parentId?: string;
  authorKind: 'user' | 'model';
  author: { userId: string; username: string } | null;
  content: string;
  createdAt: number;
  updatedAt: number;
  replyCount?: number;
  reactions?: Array<{ emoji: string; count: number; mine: boolean }>;
};

const CHANNEL = {
  id: 'chan-1',
  type: 'public',
  name: 'engineering',
  createdBy: 'user-1',
  createdAt: 1_770_000_000_000,
  updatedAt: 1_770_000_000_000,
  role: 'owner',
  isMember: true,
  unreadCount: 2,
  latestMessageAt: 1_770_000_100_000,
};

async function mockChannelsApi(page: Page) {
  const messages: MockMessage[] = [
    {
      id: 'msg-1',
      channelId: CHANNEL.id,
      authorKind: 'user',
      author: { userId: 'user-2', username: 'sam' },
      content: 'Deploy is green across the board',
      createdAt: 1_770_000_050_000,
      updatedAt: 1_770_000_050_000,
      replyCount: 1,
      reactions: [{ emoji: '🎉', count: 2, mine: false }],
    },
  ];

  await page.route(/\/api\/channels(?:\/.*)?(?:\?.*)?$/, async route => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace(/^\/api/, '');
    const method = route.request().method();

    const respond = async (data: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data }),
      });

    if (method === 'GET' && path === '/channels') return respond([CHANNEL]);
    if (method === 'GET' && path === `/channels/${CHANNEL.id}`) {
      return respond(CHANNEL);
    }
    if (method === 'GET' && path === `/channels/${CHANNEL.id}/messages`) {
      return respond(messages.filter(message => !message.parentId));
    }
    if (method === 'POST' && path === `/channels/${CHANNEL.id}/messages`) {
      const body = route.request().postDataJSON() as { content: string };
      const created: MockMessage = {
        id: `msg-${messages.length + 1}`,
        channelId: CHANNEL.id,
        authorKind: 'user',
        author: { userId: 'user-1', username: 'robin' },
        content: body.content,
        createdAt: 1_770_000_200_000 + messages.length,
        updatedAt: 1_770_000_200_000 + messages.length,
      };
      messages.push(created);
      return respond(created, 201);
    }
    if (method === 'POST' && path === `/channels/${CHANNEL.id}/read`) {
      return respond(undefined);
    }
    if (method === 'GET' && path === '/channels/messages/msg-1/thread') {
      return respond([
        messages[0],
        {
          id: 'msg-reply',
          channelId: CHANNEL.id,
          parentId: 'msg-1',
          authorKind: 'user',
          author: { userId: 'user-1', username: 'robin' },
          content: 'Confirmed on my side too',
          createdAt: 1_770_000_060_000,
          updatedAt: 1_770_000_060_000,
        },
      ]);
    }
    if (method === 'GET' && path === `/channels/${CHANNEL.id}/events`) {
      return route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: '',
      });
    }
    if (method === 'GET' && path === `/channels/${CHANNEL.id}/pins`) {
      return respond([]);
    }
    if (method === 'GET' && path === `/channels/${CHANNEL.id}/members`) {
      return respond([
        {
          userId: 'user-1',
          username: 'robin',
          role: 'owner',
          joinedAt: 1_770_000_000_000,
        },
        {
          userId: 'user-2',
          username: 'sam',
          role: 'member',
          joinedAt: 1_770_000_000_500,
        },
      ]);
    }
    return route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({ success: false, error: `Unhandled ${path}` }),
    });
  });
}

test('channels list, timeline, threads, and composer work end to end', async ({
  page,
}) => {
  await mockLibreWebUiApi(page);
  await mockChannelsApi(page);
  await page.goto('/channels');

  // The channel list shows the seeded channel with its unread badge.
  const channelItem = page.getByTestId('channel-item');
  await expect(channelItem).toHaveCount(1);
  await expect(page.getByTestId('channel-unread')).toHaveText('2');

  // Selecting it renders the timeline with authors, reactions, and replies.
  await channelItem.click();
  await expect(page.getByTestId('channel-title')).toHaveText('engineering');
  const message = page.getByTestId('channel-message');
  await expect(message).toContainText('Deploy is green across the board');
  await expect(message).toContainText('sam');
  await expect(page.getByTestId('channel-reaction')).toContainText('🎉 2');

  // The thread panel opens from the reply count.
  await page.getByTestId('channel-reply-count').click();
  const thread = page.getByTestId('channel-thread');
  await expect(thread).toBeVisible();
  await expect(thread).toContainText('Confirmed on my side too');

  // Posting from the composer appends to the timeline.
  await page.getByTestId('channel-composer').fill('Shipping the docs next');
  await page.getByTestId('channel-send').click();
  await expect(
    page.getByTestId('channel-timeline').getByTestId('channel-message').last()
  ).toContainText('Shipping the docs next');

  // Members panel lists both members with the owner role marked.
  await page.getByTestId('channel-members-toggle').click();
  await expect(page.getByTestId('channel-member')).toHaveCount(2);
});

test('the notification bell surfaces the inbox', async ({ page }) => {
  await mockLibreWebUiApi(page);
  await page.route(/\/api\/notifications\/unread-count$/, route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: { count: 3 } }),
    })
  );
  await page.route(/\/api\/notifications\?.*$/, route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: [
          {
            id: 'note-1',
            type: 'channel-mention',
            title: 'sam mentioned you in #engineering',
            body: 'Deploy is green across the board',
            href: '/channels?channel=chan-1',
            createdAt: 1_770_000_050_000,
          },
        ],
      }),
    })
  );
  await page.goto('/chat');

  const bell = page.getByTestId('notification-bell');
  await expect(bell).toBeVisible();
  await expect(page.getByTestId('notification-unread-badge')).toHaveText('3');

  await bell.click();
  const panel = page.getByTestId('notification-panel');
  await expect(panel).toBeVisible();
  await expect(page.getByTestId('notification-item')).toContainText(
    'sam mentioned you in #engineering'
  );
});
