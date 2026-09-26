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
import { defaultSystemInfo, mockLibreWebUiApi } from './lib/mockApi';

interface MockSession {
  id: string;
  title: string;
  model: string | null;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

const mockStrands = async (page: Page) => {
  const sessions: MockSession[] = [];
  const turnBodies: unknown[] = [];
  const createBodies: unknown[] = [];
  const patchBodies: unknown[] = [];
  await mockLibreWebUiApi(page, {
    systemInfo: {
      ...defaultSystemInfo,
      requiresAuth: true,
      strandsAccess: 'admins',
    },
    authUsers: [
      {
        id: 'admin',
        username: 'admin',
        email: null,
        role: 'admin',
        status: 'active',
        token: 'admin-token',
      },
    ],
  });
  await page.addInitScript(() =>
    localStorage.setItem('auth-token', 'admin-token')
  );
  await page.route('**/api/strands/**', async route => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace(/^\/api\/strands/, '');
    const method = route.request().method();
    if (path === '/health') {
      await route.fulfill({
        json: {
          success: true,
          data: {
            available: true,
            harnessVersion: '0.1.1',
            sdkVersion: '1.19.0',
          },
        },
      });
      return;
    }
    if (path === '/models') {
      await route.fulfill({
        json: {
          success: true,
          data: [
            {
              id: 'ollama:fixture-agent',
              name: 'fixture-agent',
              providerType: 'ollama',
              providerId: null,
              providerName: 'Ollama',
            },
            {
              id: 'ollama:fixture-coder',
              name: 'fixture-coder',
              providerType: 'ollama',
              providerId: null,
              providerName: 'Ollama',
            },
          ],
        },
      });
      return;
    }
    if (path === '/sessions' && method === 'GET') {
      await route.fulfill({ json: { success: true, data: sessions } });
      return;
    }
    if (path === '/sessions' && method === 'POST') {
      const body = route.request().postDataJSON() as { model?: string | null };
      createBodies.push(body);
      const session: MockSession = {
        id: '00000000-0000-4000-8000-000000000001',
        title: 'New session',
        model: body.model ?? null,
        createdAt: 1,
        updatedAt: 1,
        messageCount: 0,
      };
      sessions.unshift(session);
      await route.fulfill({
        status: 201,
        json: { success: true, data: session },
      });
      return;
    }
    const session = sessions[0];
    if (session && path === `/sessions/${session.id}` && method === 'PATCH') {
      const body = route.request().postDataJSON() as { model?: string | null };
      patchBodies.push(body);
      if (body.model !== undefined) session.model = body.model;
      await route.fulfill({ json: { success: true, data: session } });
      return;
    }
    if (session && path === `/sessions/${session.id}` && method === 'GET') {
      await route.fulfill({
        json: {
          success: true,
          data: { session, messages: [], running: false },
        },
      });
      return;
    }
    if (
      session &&
      path === `/sessions/${session.id}/messages` &&
      method === 'POST'
    ) {
      turnBodies.push(route.request().postDataJSON());
      session.messageCount = 2;
      const events = [
        { type: 'turn-start', sessionId: session.id, messageId: 'reply-1' },
        {
          type: 'tool-start',
          toolUseId: 'tool-1',
          name: 'write',
          input: { path: '/workspace/notes.txt', content: 'hello' },
        },
        {
          type: 'tool-result',
          toolUseId: 'tool-1',
          status: 'success',
          output: 'Wrote 1 lines to /workspace/notes.txt.',
        },
        { type: 'text', text: 'Saved the note.' },
        {
          type: 'done',
          stopReason: 'endTurn',
          usage: { inputTokens: 20, outputTokens: 4 },
        },
      ];
      await route.fulfill({
        status: 200,
        contentType: 'application/x-ndjson',
        body: events.map(event => `${JSON.stringify(event)}\n`).join(''),
      });
      return;
    }
    await route.fulfill({
      status: 404,
      json: { success: false, error: 'not mocked' },
    });
  });
  return { sessions, turnBodies, createBodies, patchBodies };
};

test('an admin creates a Strands session and streams a turn with a tool call', async ({
  page,
}) => {
  const { turnBodies } = await mockStrands(page);

  await page.goto('/strands');
  const strandsPage = page.getByTestId('strands-page');
  await expect(strandsPage).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Strands' })).toBeVisible();

  await page.getByTestId('strands-new-session').click();
  const input = page.getByTestId('strands-input');
  await expect(input).toBeEnabled();
  await input.fill('Save a note');
  await page.getByTestId('strands-send').click();

  await expect(page.getByTestId('strands-user-message')).toContainText(
    'Save a note'
  );
  const reply = page.getByTestId('strands-assistant-message').last();
  await expect(reply).toContainText('Saved the note.');
  await expect(page.getByTestId('strands-tool-trace')).toContainText('write');
  expect(turnBodies).toEqual([{ text: 'Save a note' }]);
});

test('the Strands model selector works before a session exists and on an open session', async ({
  page,
}) => {
  const { createBodies, patchBodies } = await mockStrands(page);

  await page.goto('/strands');
  const select = page.getByTestId('strands-model-select');
  await expect(select).toBeEnabled();
  await select.selectOption('ollama:fixture-coder');

  await page.getByTestId('strands-input').fill('Hello');
  await page.getByTestId('strands-send').click();
  await expect(
    page.getByTestId('strands-assistant-message').last()
  ).toContainText('Saved the note.');
  expect(createBodies).toEqual([{ model: 'ollama:fixture-coder' }]);
  await expect(select).toHaveValue('ollama:fixture-coder');

  await select.selectOption('ollama:fixture-agent');
  await expect(select).toHaveValue('ollama:fixture-agent');
  await expect
    .poll(() => patchBodies)
    .toEqual([{ model: 'ollama:fixture-agent' }]);

  await select.selectOption('');
  await expect(select).toHaveValue('');
  await expect
    .poll(() => patchBodies[patchBodies.length - 1])
    .toEqual({ model: null });
});
