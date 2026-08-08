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

import { expect, test, type Locator, type Page } from '@playwright/test';
import { mockLibreWebUiApi } from './lib/mockApi';

const startOfToday = new Date().setHours(0, 0, 0, 0);

const gardenSession = () => ({
  id: 'garden-plan',
  title: 'Garden plan',
  model: 'llama3.2:3b',
  messages: [],
  createdAt: startOfToday + 8 * 3_600_000,
  updatedAt: startOfToday + 8 * 3_600_000,
});

const budgetSession = () => ({
  id: 'budget-review',
  title: 'Budget review',
  model: 'llama3.2:3b',
  messages: [],
  createdAt: startOfToday + 9 * 3_600_000,
  updatedAt: startOfToday + 9 * 3_600_000,
});

const workFolder = () => ({
  id: 'work-projects',
  name: 'Work projects',
  createdAt: startOfToday + 1 * 3_600_000,
  updatedAt: startOfToday + 1 * 3_600_000,
});

const scrollRegion = (page: Page) =>
  page.getByTestId('sidebar-session-scroll-region');

const sessionRow = (page: Page, title: string) =>
  scrollRegion(page)
    .locator('div[draggable="true"]')
    .filter({ hasText: title });

const groupLabel = (page: Page, name: string) =>
  scrollRegion(page).getByText(name, { exact: true });

const yOf = async (locator: Locator) => (await locator.boundingBox())?.y ?? -1;

// The sidebar files chats with native HTML5 drag and drop, which Playwright's
// dragTo does not reliably synthesize for React's synthetic handlers. Dispatch
// real DragEvents with an in-page DataTransfer instead, letting React commit
// the draggingSessionId set in dragstart before the drop handler reads it.
const dragSessionTo = async (page: Page, source: Locator, target: Locator) => {
  await source.evaluate(element => {
    const dataTransfer = new DataTransfer();
    element.dispatchEvent(
      new DragEvent('dragstart', {
        bubbles: true,
        cancelable: true,
        dataTransfer,
      })
    );
    (
      window as unknown as {
        __libreDragDataTransfer?: DataTransfer;
      }
    ).__libreDragDataTransfer = dataTransfer;
  });
  await page.waitForTimeout(50);
  await target.evaluate(element => {
    const dataTransfer = (
      window as unknown as { __libreDragDataTransfer?: DataTransfer }
    ).__libreDragDataTransfer;
    element.dispatchEvent(
      new DragEvent('dragover', {
        bubbles: true,
        cancelable: true,
        dataTransfer,
      })
    );
    element.dispatchEvent(
      new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        dataTransfer,
      })
    );
  });
  await page.waitForTimeout(50);
  await source.evaluate(element => {
    element.dispatchEvent(new DragEvent('dragend', { bubbles: true }));
  });
};

const openActionsFor = async (page: Page, title: string) => {
  const row = sessionRow(page, title);
  await row.hover();
  await row.getByTestId('sidebar-session-actions').click();
  await expect(page.getByTestId('sidebar-session-menu')).toBeVisible();
};

test('pinning a chat moves it to the Pinned group and survives a reload', async ({
  page,
}) => {
  const mockApi = await mockLibreWebUiApi(page, {
    sessions: [gardenSession(), budgetSession()],
  });
  await page.addInitScript(() => {
    localStorage.setItem('i18nextLng', 'en');
  });
  await page.goto('/c/garden-plan');

  await expect(sessionRow(page, 'Garden plan')).toBeVisible();
  await expect(sessionRow(page, 'Budget review')).toBeVisible();
  await expect(groupLabel(page, 'Pinned')).toHaveCount(0);

  await openActionsFor(page, 'Garden plan');
  await page.getByRole('menuitem', { name: 'Pin' }).click();

  await expect(groupLabel(page, 'Pinned')).toBeVisible();
  await expect
    .poll(async () => {
      const rowY = await yOf(sessionRow(page, 'Garden plan'));
      const pinnedY = await yOf(groupLabel(page, 'Pinned'));
      const todayY = await yOf(groupLabel(page, 'Today'));
      return rowY > pinnedY && rowY < todayY;
    })
    .toBe(true);

  await page.reload();

  await expect(groupLabel(page, 'Pinned')).toBeVisible();
  await expect
    .poll(async () => {
      const rowY = await yOf(sessionRow(page, 'Garden plan'));
      const pinnedY = await yOf(groupLabel(page, 'Pinned'));
      const todayY = await yOf(groupLabel(page, 'Today'));
      return rowY > pinnedY && rowY < todayY;
    })
    .toBe(true);

  await openActionsFor(page, 'Garden plan');
  await page.getByRole('menuitem', { name: 'Unpin' }).click();

  await expect(groupLabel(page, 'Pinned')).toHaveCount(0);
  await expect
    .poll(
      async () =>
        (await yOf(sessionRow(page, 'Garden plan'))) >
        (await yOf(groupLabel(page, 'Today')))
    )
    .toBe(true);

  expect(mockApi.sessionUpdateRequests.map(request => request.updates)).toEqual(
    [{ pinned: true }, { pinned: false }]
  );
});

test('dragging a chat onto a folder files it and back onto a date group un-files it', async ({
  page,
}) => {
  const mockApi = await mockLibreWebUiApi(page, {
    sessions: [gardenSession(), budgetSession()],
    folders: [workFolder()],
  });
  await page.addInitScript(() => {
    localStorage.setItem('i18nextLng', 'en');
  });
  await page.goto('/c/garden-plan');

  await expect(groupLabel(page, 'Work projects')).toBeVisible();
  await expect(sessionRow(page, 'Budget review')).toBeVisible();

  await expect
    .poll(
      async () =>
        (await yOf(sessionRow(page, 'Budget review'))) >
        (await yOf(groupLabel(page, 'Today')))
    )
    .toBe(true);

  await dragSessionTo(
    page,
    sessionRow(page, 'Budget review'),
    groupLabel(page, 'Work projects')
  );

  await expect
    .poll(async () => {
      const rowY = await yOf(sessionRow(page, 'Budget review'));
      const folderY = await yOf(groupLabel(page, 'Work projects'));
      const todayY = await yOf(groupLabel(page, 'Today'));
      return rowY > folderY && rowY < todayY;
    })
    .toBe(true);
  expect(mockApi.sessionUpdateRequests).toContainEqual({
    sessionId: 'budget-review',
    updates: { folderId: 'work-projects' },
  });

  await dragSessionTo(
    page,
    sessionRow(page, 'Budget review'),
    groupLabel(page, 'Today')
  );

  await expect
    .poll(
      async () =>
        (await yOf(sessionRow(page, 'Budget review'))) >
        (await yOf(groupLabel(page, 'Today')))
    )
    .toBe(true);
  expect(mockApi.sessionUpdateRequests.at(-1)?.updates).toEqual({
    folderId: null,
  });
});
