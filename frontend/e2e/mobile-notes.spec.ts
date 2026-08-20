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

const mobileNote = {
  id: 'mobile-note',
  title: 'A note with a visible title',
  content: [
    '# Mobile preview',
    '',
    'The editor and preview stay inside the page.',
    '',
    '| Chapter title | Author commentary | Detailed reading notes |',
    '| --- | --- | --- |',
    '| The Mythical Man-Month revisited | Still holds up decades later | Adding people to a late project makes it later |',
  ].join('\n'),
  createdAt: Date.now(),
  updatedAt: Date.now(),
};

test('notes preview wide Markdown tables without mobile page overflow', async ({
  page,
}) => {
  await mockLibreWebUiApi(page);
  await page.route(/\/api\/notes(?:\/[^/?]+)?(?:\?.*)?$/, async route => {
    if (route.request().method() !== 'GET') {
      await route.fulfill({
        status: 405,
        contentType: 'application/json',
        body: JSON.stringify({ success: false, error: 'Method not allowed' }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: [mobileNote] }),
    });
  });

  await page.goto('/chat');
  await page.getByRole('link', { name: 'Notes' }).click();
  await expect(page).toHaveURL(/\/notes$/);

  const noteList = page.getByTestId('notes-list');
  const noteEditor = page.getByTestId('notes-editor');
  await expect(noteList).toBeVisible();
  await expect(noteEditor).toBeHidden();

  await page.getByText(mobileNote.title, { exact: true }).click();
  await expect(noteList).toBeHidden();
  await expect(noteEditor).toBeVisible();
  await expect(page.getByTestId('notes-title-preview')).toHaveText(
    mobileNote.title
  );
  await expect(page.getByTestId('notes-content-editor')).toBeHidden();

  const editorBox = await noteEditor.boundingBox();
  expect(editorBox).not.toBeNull();
  expect(editorBox!.width).toBeGreaterThan(280);

  const preview = page.getByTestId('notes-preview');
  await expect(preview).toBeVisible();
  await expect(
    preview.getByRole('heading', { name: 'Mobile preview' })
  ).toBeVisible();
  const previewBox = await preview.boundingBox();
  expect(previewBox).not.toBeNull();
  expect(previewBox!.width).toBeCloseTo(editorBox!.width, 0);

  const table = preview.getByRole('table');
  await expect(
    table.getByRole('columnheader', { name: 'Chapter title' })
  ).toBeVisible();
  await expect(
    table.getByRole('cell', { name: 'The Mythical Man-Month revisited' })
  ).toBeVisible();

  const containment = await table.evaluate(element => {
    const wrapper = element.parentElement;
    if (!wrapper) throw new Error('Expected a table overflow wrapper');
    const bounds = wrapper.getBoundingClientRect();
    return {
      wrapperOverflowX: getComputedStyle(wrapper).overflowX,
      wrapperHasHorizontalScroll: wrapper.scrollWidth > wrapper.clientWidth,
      wrapperLeft: bounds.left,
      wrapperRight: bounds.right,
      viewportWidth: document.documentElement.clientWidth,
      documentWidth: document.documentElement.scrollWidth,
    };
  });
  expect(containment.wrapperOverflowX).toBe('auto');
  expect(containment.wrapperHasHorizontalScroll).toBe(true);
  expect(containment.wrapperLeft).toBeGreaterThanOrEqual(previewBox!.x);
  expect(containment.wrapperRight).toBeLessThanOrEqual(
    previewBox!.x + previewBox!.width
  );
  expect(containment.documentWidth).toBeLessThanOrEqual(
    containment.viewportWidth
  );

  await page.getByTestId('notes-preview-toggle').click();
  await expect(page.getByTestId('notes-title-editor')).toHaveValue(
    mobileNote.title
  );
  await expect(page.getByTestId('notes-content-editor')).toBeVisible();
  await expect(preview).toBeHidden();

  await page.getByTestId('notes-mobile-back').click();
  await expect(noteList).toBeVisible();
  await expect(noteEditor).toBeHidden();
});
