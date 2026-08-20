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

type MockNote = {
  id: string;
  title: string;
  content: string;
  createdAt: number;
  updatedAt: number;
};

const tableNote: MockNote = {
  id: 'table-note',
  title: 'Reading list',
  content: [
    '## Book queue',
    '',
    '| Title | Author | Status |',
    '| --- | --- | --- |',
    '| The Pragmatic Programmer | Hunt and Thomas | Finished |',
    '| The Mythical Man-Month | Fred Brooks | In progress |',
  ].join('\n'),
  createdAt: 1_770_000_000_000,
  updatedAt: 1_770_000_002_000,
};

const htmlNote: MockNote = {
  id: 'html-note',
  title: 'Launch roundup',
  content: [
    '<div align="center"><svg width="150" height="150" viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg"><circle cx="100" cy="85" r="12" fill="#0288D1" stroke="#ECEFF1" stroke-width="2"/></svg></div>',
    '',
    'A <b>bold</b> overview.',
    '',
    '<script>window.notesXss = true;</script>',
    '',
    '<img src="missing.png" onerror="window.notesXss = true">',
  ].join('\n'),
  createdAt: 1_770_000_000_500,
  updatedAt: 1_770_000_000_500,
};

const secondNote: MockNote = {
  id: 'second-note',
  title: 'Release checklist',
  content: '# Ship safely\n\nRun the complete release gate.',
  createdAt: 1_770_000_001_000,
  updatedAt: 1_770_000_001_000,
};

async function mockNotesApi(page: Page, initialNotes: MockNote[]) {
  const notes = structuredClone(initialNotes);

  await page.route(/\/api\/notes(?:\/[^/?]+)?(?:\?.*)?$/, async route => {
    const request = route.request();
    const method = request.method();
    const pathname = new URL(request.url()).pathname;
    const noteId = pathname.match(/\/api\/notes\/([^/]+)$/)?.[1];

    if (method === 'GET' && !noteId) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: notes }),
      });
      return;
    }

    if (method === 'POST' && !noteId) {
      const body = request.postDataJSON() as {
        title: string;
        content: string;
      };
      const created: MockNote = {
        id: 'new-blank-note',
        title: body.title,
        content: body.content,
        createdAt: 1_770_000_003_000,
        updatedAt: 1_770_000_003_000,
      };
      notes.unshift(created);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: created }),
      });
      return;
    }

    if (method === 'PUT' && noteId) {
      const index = notes.findIndex(note => note.id === noteId);
      const updates = request.postDataJSON() as Partial<
        Pick<MockNote, 'title' | 'content'>
      >;
      notes[index] = {
        ...notes[index],
        ...updates,
        updatedAt: 1_770_000_004_000,
      };
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: notes[index] }),
      });
      return;
    }

    await route.fulfill({
      status: 405,
      contentType: 'application/json',
      body: JSON.stringify({ success: false, error: 'Method not allowed' }),
    });
  });
}

test('notes open in Markdown preview and make editing explicit', async ({
  page,
}) => {
  await mockLibreWebUiApi(page);
  await mockNotesApi(page, [tableNote, secondNote]);

  await page.goto('/chat');
  await page.getByRole('link', { name: 'Notes' }).click();
  await page.getByText(tableNote.title, { exact: true }).click();

  const preview = page.getByTestId('notes-preview');
  await expect(preview).toBeVisible();
  await expect(page.getByTestId('notes-title-preview')).toHaveText(
    tableNote.title
  );
  await expect(page.getByTestId('notes-title-editor')).toBeHidden();
  await expect(page.getByTestId('notes-content-editor')).toBeHidden();

  const table = preview.getByRole('table');
  await expect(table).toBeVisible();
  await expect(
    table.getByRole('columnheader', { name: 'Title' })
  ).toBeVisible();
  await expect(
    table.getByRole('columnheader', { name: 'Author' })
  ).toBeVisible();
  await expect(
    table.getByRole('cell', { name: 'The Pragmatic Programmer' })
  ).toBeVisible();
  await expect(table.getByRole('cell', { name: 'In progress' })).toBeVisible();
  await expect(table.locator('..')).toHaveCSS('overflow-x', 'auto');

  const modeToggle = page.getByTestId('notes-preview-toggle');
  await expect(modeToggle).toHaveAccessibleName('Edit');
  await modeToggle.click();
  await expect(page.getByTestId('notes-title-editor')).toHaveValue(
    tableNote.title
  );
  await expect(page.getByTestId('notes-content-editor')).toHaveValue(
    tableNote.content
  );
  await expect(preview).toBeHidden();

  await page.getByText(secondNote.title, { exact: true }).click();
  await expect(preview).toBeVisible();
  await expect(page.getByTestId('notes-title-preview')).toHaveText(
    secondNote.title
  );
  await expect(
    preview.getByRole('heading', { name: 'Ship safely' })
  ).toBeVisible();
  await expect(page.getByTestId('notes-content-editor')).toBeHidden();
});

test('note preview renders inline SVG and basic HTML, sanitized', async ({
  page,
}) => {
  await mockLibreWebUiApi(page);
  await mockNotesApi(page, [htmlNote]);

  await page.goto('/chat');
  await page.getByRole('link', { name: 'Notes' }).click();
  await page.getByText(htmlNote.title, { exact: true }).click();

  const preview = page.getByTestId('notes-preview');
  await expect(preview).toBeVisible();

  // Inline SVG renders as an element, not escaped source text
  await expect(preview.locator('svg circle')).toHaveAttribute('r', '12');
  await expect(preview).not.toContainText('<svg');

  // Basic HTML renders
  await expect(preview.locator('b', { hasText: 'bold' })).toBeVisible();

  // Scripts and event handlers are stripped
  await expect(preview.locator('script')).toHaveCount(0);
  const img = preview.locator('img');
  await expect(img).toHaveCount(1);
  await expect(img).not.toHaveAttribute('onerror', /.+/);
  await expect
    .poll(() => page.evaluate(() => 'notesXss' in window))
    .toBe(false);
});

test('a new blank note opens directly in edit mode', async ({ page }) => {
  await mockLibreWebUiApi(page);
  await mockNotesApi(page, [tableNote]);

  await page.goto('/chat');
  await page.getByRole('link', { name: 'Notes' }).click();
  await page.getByTestId('notes-list').getByTitle('New note').click();

  await expect(page.getByTestId('notes-title-editor')).toHaveValue('');
  await expect(page.getByTestId('notes-content-editor')).toHaveValue('');
  await expect(page.getByTestId('notes-preview')).toBeHidden();
  await expect(page.getByTestId('notes-preview-toggle')).toHaveAccessibleName(
    'Preview'
  );
});
