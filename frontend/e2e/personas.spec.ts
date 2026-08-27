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

test('persona editor uses one primary save action without closing', async ({
  page,
}) => {
  await mockLibreWebUiApi(page, { personas: [] });

  let createRequests = 0;
  let updateRequests = 0;
  let releaseCreate!: () => void;
  const createResponse = new Promise<void>(resolve => {
    releaseCreate = resolve;
  });
  const savedPersona = {
    id: 'persona-created',
    user_id: 'e2e-user',
    name: 'Saved Persona',
    description: '',
    model: 'llama3.2:3b',
    parameters: {
      temperature: 0.7,
      top_p: 0.9,
      top_k: 40,
      context_window: 4096,
      max_tokens: 1024,
      system_prompt: '',
      repeat_penalty: 1.1,
      presence_penalty: 0,
      frequency_penalty: 0,
    },
    created_at: Date.now(),
    updated_at: Date.now(),
  };

  await page.route('**/api/personas', async route => {
    if (route.request().method() !== 'POST') {
      await route.fallback();
      return;
    }
    createRequests += 1;
    await createResponse;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: savedPersona }),
    });
  });
  await page.route('**/api/personas/persona-created', async route => {
    if (route.request().method() !== 'PUT') {
      await route.fallback();
      return;
    }
    updateRequests += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: { ...savedPersona, updated_at: Date.now() },
      }),
    });
  });

  await page.goto('/personas');
  await page
    .getByRole('button', { name: 'Create Persona', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Create New Persona' })
  ).toBeVisible();

  const form = page.locator('form');
  await form.getByPlaceholder('Enter persona name').fill('Saved Persona');
  await form.locator('select').first().selectOption('llama3.2:3b');

  const save = form.getByRole('button', { name: 'Save', exact: true });
  await expect(save).toHaveCount(1);
  await expect(save).toHaveClass(/\bbg-ink\b/);
  await expect(
    form.getByRole('button', { name: 'Save & Close', exact: true })
  ).toHaveCount(0);
  await expect(
    form.getByRole('button', { name: 'Create', exact: true })
  ).toHaveCount(0);

  const createRequest = page.waitForRequest(
    request =>
      request.method() === 'POST' &&
      new URL(request.url()).pathname === '/api/personas'
  );
  await save.click();
  await createRequest;
  await expect(
    form.getByRole('button', { name: 'Saving...', exact: true })
  ).toBeDisabled();
  releaseCreate();

  await expect(
    page.getByRole('heading', { name: 'Edit Persona' })
  ).toBeVisible();
  await expect(form.getByText('Saved', { exact: true })).toBeVisible();

  const updateRequest = page.waitForRequest(
    request =>
      request.method() === 'PUT' &&
      new URL(request.url()).pathname === '/api/personas/persona-created'
  );
  await save.click();
  await updateRequest;

  expect(createRequests).toBe(1);
  expect(updateRequests).toBe(1);
  await expect(
    page.getByRole('heading', { name: 'Edit Persona' })
  ).toBeVisible();
});
