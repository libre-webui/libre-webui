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
import { openSettingsTab } from './lib/settingsTab';

type MockPromptVariable = {
  name: string;
  type: 'text' | 'number' | 'select' | 'boolean';
  label?: string;
  required?: boolean;
  default?: string;
  options?: string[];
};

type MockPrompt = {
  id: string;
  slug: string;
  title: string;
  description?: string;
  content: string;
  variables: MockPromptVariable[];
  tags: string[];
  version: number;
  createdAt: number;
  updatedAt: number;
  ownerUserId: string;
};

type MockRevision = {
  version: number;
  content: string;
  variables: MockPromptVariable[];
  createdAt: number;
};

const seededPrompt: MockPrompt = {
  id: 'prompt-standup',
  slug: 'standup',
  title: 'Daily standup',
  description: 'Turns yesterday into a standup update',
  content: 'Write a standup update from these notes.',
  variables: [],
  tags: ['work'],
  version: 1,
  createdAt: 1_770_000_000_000,
  updatedAt: 1_770_000_000_000,
  ownerUserId: 'e2e-user',
};

/**
 * In-memory prompt library: revisions accumulate on every write so the
 * version history and rollback the page drives are the real thing rather
 * than a canned response.
 */
async function mockPromptsApi(page: Page, initialPrompts: MockPrompt[]) {
  const prompts = structuredClone(initialPrompts);
  const revisions = new Map<string, MockRevision[]>(
    prompts.map(prompt => [
      prompt.id,
      [
        {
          version: prompt.version,
          content: prompt.content,
          variables: prompt.variables,
          createdAt: prompt.createdAt,
        },
      ],
    ])
  );
  const createRequests: Array<Record<string, unknown>> = [];
  const updateRequests: Array<{ id: string; body: Record<string, unknown> }> =
    [];
  const rollbackRequests: Array<{ id: string; version: number }> = [];
  const deleteRequests: string[] = [];
  let nextId = prompts.length + 1;
  let clock = 1_770_000_100_000;

  const recordRevision = (prompt: MockPrompt) => {
    const list = revisions.get(prompt.id) ?? [];
    list.unshift({
      version: prompt.version,
      content: prompt.content,
      variables: prompt.variables,
      createdAt: prompt.updatedAt,
    });
    revisions.set(prompt.id, list);
  };

  await page.route(/\/api\/prompts(?:\/.*)?$/, async route => {
    const request = route.request();
    const method = request.method();
    const path = new URL(request.url()).pathname;

    const fulfill = async (data: unknown) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data }),
      });
    };

    if (path === '/api/prompts' && method === 'GET') {
      await fulfill(prompts);
      return;
    }

    if (path === '/api/prompts' && method === 'POST') {
      const body = request.postDataJSON() as Partial<MockPrompt>;
      createRequests.push(body as Record<string, unknown>);
      clock += 1000;
      const created: MockPrompt = {
        id: `prompt-${nextId++}`,
        slug: body.slug ?? '',
        title: body.title ?? '',
        description: body.description,
        content: body.content ?? '',
        variables: body.variables ?? [],
        tags: body.tags ?? [],
        version: 1,
        createdAt: clock,
        updatedAt: clock,
        ownerUserId: 'e2e-user',
      };
      prompts.push(created);
      recordRevision(created);
      await fulfill(created);
      return;
    }

    const versionsMatch = path.match(/^\/api\/prompts\/([^/]+)\/versions$/);
    if (versionsMatch && method === 'GET') {
      await fulfill(revisions.get(versionsMatch[1]) ?? []);
      return;
    }

    const rollbackMatch = path.match(/^\/api\/prompts\/([^/]+)\/rollback$/);
    if (rollbackMatch && method === 'POST') {
      const id = rollbackMatch[1];
      const body = request.postDataJSON() as { version: number };
      rollbackRequests.push({ id, version: body.version });
      const prompt = prompts.find(item => item.id === id);
      const revision = revisions
        .get(id)
        ?.find(item => item.version === body.version);
      if (!prompt || !revision) {
        await route.fulfill({
          status: 404,
          contentType: 'application/json',
          body: JSON.stringify({ success: false, error: 'Not found' }),
        });
        return;
      }
      clock += 1000;
      prompt.content = revision.content;
      prompt.variables = revision.variables;
      prompt.version += 1;
      prompt.updatedAt = clock;
      recordRevision(prompt);
      await fulfill(prompt);
      return;
    }

    const promptMatch = path.match(/^\/api\/prompts\/([^/]+)$/);
    if (promptMatch && method === 'PUT') {
      const id = promptMatch[1];
      const body = request.postDataJSON() as Partial<MockPrompt>;
      updateRequests.push({ id, body: body as Record<string, unknown> });
      const prompt = prompts.find(item => item.id === id);
      if (!prompt) {
        await route.fulfill({
          status: 404,
          contentType: 'application/json',
          body: JSON.stringify({ success: false, error: 'Not found' }),
        });
        return;
      }
      clock += 1000;
      Object.assign(prompt, body, {
        version: prompt.version + 1,
        updatedAt: clock,
      });
      recordRevision(prompt);
      await fulfill(prompt);
      return;
    }

    if (promptMatch && method === 'DELETE') {
      const id = promptMatch[1];
      deleteRequests.push(id);
      const index = prompts.findIndex(item => item.id === id);
      if (index >= 0) prompts.splice(index, 1);
      await fulfill({ id, deleted: true });
      return;
    }

    await route.fulfill({
      status: 405,
      contentType: 'application/json',
      body: JSON.stringify({ success: false, error: 'Method not allowed' }),
    });
  });

  return { createRequests, updateRequests, rollbackRequests, deleteRequests };
}

test('the prompt library lists what the API returns', async ({ page }) => {
  await mockLibreWebUiApi(page);
  await mockPromptsApi(page, [seededPrompt]);

  await page.goto('/');
  await openSettingsTab(page, 'prompts');
  await expect(page.getByTestId('prompts-page')).toBeVisible();

  const row = page.getByTestId('prompt-row');
  await expect(row).toHaveCount(1);
  await expect(row).toContainText(seededPrompt.title);
  await expect(row).toContainText(`/${seededPrompt.slug}`);
  await expect(row).toContainText('v1');
  await expect(row).toContainText('work');
});

test('the prompt library explains itself when nothing is saved yet', async ({
  page,
}) => {
  await mockLibreWebUiApi(page);
  await mockPromptsApi(page, []);

  await page.goto('/');
  await openSettingsTab(page, 'prompts');
  await expect(page.getByTestId('prompts-page')).toBeVisible();
  await expect(page.getByTestId('prompt-row')).toHaveCount(0);
  await expect(page.getByText('No prompts yet')).toBeVisible();
});

test('a prompt is created from the modal and lands in the list', async ({
  page,
}) => {
  await mockLibreWebUiApi(page);
  const promptsApi = await mockPromptsApi(page, []);

  await page.goto('/');
  await openSettingsTab(page, 'prompts');
  await expect(page.getByTestId('prompts-page')).toBeVisible();

  await page.getByTestId('prompt-new').click();
  await expect(page.getByTestId('prompt-modal')).toBeVisible();
  await page.getByTestId('prompt-slug').fill('weekly-report');
  await page.getByTestId('prompt-title').fill('Weekly report');
  await page
    .getByTestId('prompt-content')
    .fill('Summarize what shipped this week.');
  await page.getByTestId('prompt-save').click();

  await expect(page.getByTestId('prompt-modal')).toHaveCount(0);
  const row = page
    .getByTestId('prompt-row')
    .filter({ hasText: 'Weekly report' });
  await expect(row).toBeVisible();
  await expect(row).toContainText('/weekly-report');

  expect(promptsApi.createRequests).toHaveLength(1);
  expect(promptsApi.createRequests[0]).toEqual({
    slug: 'weekly-report',
    title: 'Weekly report',
    content: 'Summarize what shipped this week.',
    variables: [],
    tags: [],
  });
});

test('prompt library round-trips create, versions, and rollback through the UI', async ({
  page,
}) => {
  await mockLibreWebUiApi(page);
  const promptsApi = await mockPromptsApi(page, []);

  await page.goto('/');
  await openSettingsTab(page, 'prompts');
  await expect(page.getByTestId('prompts-page')).toBeVisible();

  // Create the first version.
  await page.getByTestId('prompt-new').click();
  await page.getByTestId('prompt-slug').fill('retro');
  await page.getByTestId('prompt-title').fill('Retro notes');
  await page.getByTestId('prompt-content').fill('First draft of the retro.');
  await page.getByTestId('prompt-save').click();

  const row = page.getByTestId('prompt-row').filter({ hasText: 'Retro notes' });
  await expect(row).toContainText('v1');

  // Edit it so the history has something to roll back to.
  await row.getByTestId('prompt-edit').click();
  await expect(page.getByTestId('prompt-modal')).toBeVisible();
  await page.getByTestId('prompt-content').fill('Second draft of the retro.');
  await page.getByTestId('prompt-save').click();
  await expect(page.getByTestId('prompt-modal')).toHaveCount(0);
  await expect(row).toContainText('v2');
  expect(promptsApi.updateRequests).toHaveLength(1);

  // The history lists both revisions, newest first, and marks the live one.
  await row.getByTestId('prompt-history').click();
  const history = page.getByTestId('prompt-history-modal');
  await expect(history).toBeVisible();
  const entries = history.getByTestId('version-history-entry');
  await expect(entries).toHaveCount(2);
  await expect(entries.first()).toContainText('v2');
  await expect(entries.first()).toContainText('Current');
  await expect(entries.first()).toContainText('Second draft of the retro.');
  await expect(entries.last()).toContainText('First draft of the retro.');

  // The live version cannot roll back onto itself.
  await expect(entries.first().getByTestId('version-rollback')).toBeDisabled();

  await entries.last().getByTestId('version-rollback').click();
  await expect(history).toHaveCount(0);

  expect(promptsApi.rollbackRequests).toHaveLength(1);
  expect(promptsApi.rollbackRequests[0].version).toBe(1);

  // Rolling back saves the picked revision as a new version.
  await expect(row).toContainText('v3');
});
