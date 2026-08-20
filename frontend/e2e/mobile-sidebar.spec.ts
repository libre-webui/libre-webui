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

test.use({
  viewport: { width: 390, height: 844 },
  isMobile: true,
});

const mobileSession = {
  id: 'mobile-readable-session',
  title: 'Readable mobile conversation',
  model: 'llama3.2:3b',
  messages: [
    {
      id: 'mobile-readable-message',
      role: 'user' as const,
      content: 'Keep this conversation preview off small screens.',
      timestamp: Date.now(),
    },
  ],
  createdAt: Date.now(),
  updatedAt: Date.now(),
};

test('mobile navigation compacts the sidebar and pushes content aside', async ({
  page,
}) => {
  await mockLibreWebUiApi(page);

  await page.goto('/chat');

  const sidebar = page.getByTestId('sidebar');
  const appContent = page.getByTestId('app-shell-content');
  await expect(sidebar).toBeVisible();

  const expandedBox = await sidebar.boundingBox();
  expect(expandedBox).not.toBeNull();
  expect(expandedBox!.width).toBeGreaterThan(200);

  await page.getByRole('link', { name: 'Personas' }).click();
  await expect(
    page.getByRole('heading', { name: 'Personas', exact: true })
  ).toBeVisible();

  await expect
    .poll(async () => (await sidebar.boundingBox())?.width ?? 0)
    .toBeLessThan(100);
  await expect
    .poll(async () => (await appContent.boundingBox())?.x ?? 0)
    .toBeGreaterThan(50);
});

test('mobile sidebar keeps titles readable without hover previews', async ({
  page,
}) => {
  await mockLibreWebUiApi(page, { sessions: [mobileSession] });

  await page.goto('/chat');

  const sidebar = page.getByTestId('sidebar');
  const sidebarBox = await sidebar.boundingBox();
  expect(sidebarBox).not.toBeNull();
  expect(sidebarBox!.width).toBeGreaterThanOrEqual(290);

  await expect(sidebar.getByText(/Libre/).first()).toBeVisible();
  const sessionTitle = sidebar.getByText(mobileSession.title, { exact: true });
  await expect(sessionTitle).toBeVisible();

  const titleBox = await sessionTitle.boundingBox();
  expect(titleBox).not.toBeNull();
  expect(titleBox!.width).toBeGreaterThan(120);

  await sessionTitle.hover();
  await page.waitForTimeout(650);
  await expect(page.getByRole('tooltip')).toHaveCount(0);

  await page.getByTestId('sidebar-session-actions-mobile').click();
  const actionSheet = page.getByTestId('sidebar-session-actions-sheet');
  await expect(actionSheet).toBeVisible();
  await expect(actionSheet.getByText(mobileSession.title)).toBeVisible();
  await actionSheet.getByRole('button', { name: 'Close' }).click();
  await expect(actionSheet).toBeHidden();
  await expect(page.getByRole('tooltip')).toHaveCount(0);

  const chatsButton = page.getByTestId('sidebar-mobile-chats');
  await expect(chatsButton).toBeVisible();
  await expect(chatsButton).toHaveAccessibleName(/Chats \(1\)/);
  await expect(sessionTitle).toBeHidden();

  await chatsButton.click();
  await expect(sessionTitle).toBeVisible();
  await expect
    .poll(async () => (await sidebar.boundingBox())?.width ?? 0)
    .toBeGreaterThan(290);
});

test('Arabic mobile navigation mirrors the sidebar and content offset', async ({
  page,
}) => {
  await mockLibreWebUiApi(page);
  await page.addInitScript(() => {
    localStorage.setItem('i18nextLng', 'ar');
  });

  await page.goto('/chat');

  const sidebar = page.getByTestId('sidebar');
  const appContent = page.getByTestId('app-shell-content');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(sidebar).toBeVisible();

  const expandedBox = await sidebar.boundingBox();
  expect(expandedBox).not.toBeNull();
  expect(expandedBox!.x + expandedBox!.width).toBeCloseTo(390, 0);

  await page.locator('a[href="/personas"]').click();
  await page.waitForURL('**/personas');

  await expect
    // Compact rail is w-16 (4rem) against the app's 15px root font.
    .poll(async () => (await sidebar.boundingBox())?.width ?? 0)
    .toBeCloseTo(60, 0);

  await expect
    .poll(async () => {
      const compactSidebarBox = await sidebar.boundingBox();
      const compactContentBox = await appContent.boundingBox();
      if (!compactSidebarBox || !compactContentBox)
        return Number.POSITIVE_INFINITY;

      return (
        compactContentBox.x + compactContentBox.width - compactSidebarBox.x
      );
    })
    .toBeLessThanOrEqual(3);
});
