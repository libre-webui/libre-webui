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

const now = 1_770_000_000_000;

const nimble = {
  name: 'nimble:latest',
  size: 5_600_000_000,
  digest: 'e2e-nimble',
  modified_at: new Date('2026-10-01T00:00:00.000Z').toISOString(),
  details: {
    format: 'gguf',
    family: 'qwen35',
    families: ['qwen35'],
    parameter_size: '9B',
    quantization_level: 'Q4_K_M',
  },
};
const llama = {
  ...nimble,
  name: 'llama3.2:3b',
  digest: 'e2e-llama',
  details: { ...nimble.details, family: 'llama', families: ['llama'] },
};

const refundQuestions = {
  refund: { type: 'noul', instructions: 'Is a refund being requested?' },
  team: {
    type: 'choice',
    instructions: 'Which team should handle this?',
    criteria: { billing: 'Payments and refunds', technical: null },
  },
};

const decisionSession = {
  id: 'decision-session',
  title: 'Refund triage',
  model: 'nimble:latest',
  providerType: 'ollama' as const,
  createdAt: now,
  updatedAt: now,
  messages: [
    {
      id: 'decision-user',
      role: 'user' as const,
      content: 'I was charged twice. Please refund the extra payment.',
      timestamp: now,
    },
    {
      id: 'decision-reply',
      role: 'assistant' as const,
      content:
        '| Question | Answer | Probability |\n| --- | --- | --- |\n| Is a refund being requested? | yes | 97.0% |',
      timestamp: now + 1,
      model: 'nimble:latest',
      providerMetadata: {
        decision: {
          kind: 'answers',
          mode: 'questions',
          model: 'nimble',
          provider: 'Ollama',
          questions: refundQuestions,
          answers: {
            refund: { type: 'noul', noul: 0.97 },
            team: {
              type: 'choice',
              choice: 'billing',
              probabilities: { billing: 0.91, technical: 0.09 },
              confidence: 0.6,
            },
          },
          usage: { inputTokens: 174, outputTokens: 2 },
        },
      },
    },
  ],
};

async function openPicker(page: Page, current: string) {
  await page
    .locator('main button[aria-haspopup="dialog"]')
    .filter({ hasText: current })
    .first()
    .click();
  const picker = page.getByRole('dialog', { name: 'Select a model' });
  await expect(picker).toBeVisible();
  return picker;
}

async function setup(page: Page, allowed: boolean, withSession = true) {
  const api = await mockLibreWebUiApi(page, {
    models: [llama, nimble],
    sessions: withSession ? [decisionSession] : [],
  });
  await page.addInitScript(() => {
    localStorage.setItem('i18nextLng', 'en');
    localStorage.setItem('auth-token', 'e2e-token');
  });
  await page.route(/\/api\/decisions\/models$/, async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: {
          allowed,
          models: [
            {
              id: 'nimble:latest',
              providerType: 'ollama',
              providerName: 'Ollama',
              images: false,
            },
          ],
        },
      }),
    });
  });
  return api;
}

test('a decision chat shows its answers and saves the questions it asks', async ({
  page,
}) => {
  const api = await setup(page, true);
  await page.goto('/c/decision-session');

  // The reply is drawn from its structured answers, not its text table.
  const result = page.getByTestId('decision-result');
  await expect(result).toBeVisible();
  await expect(result).toContainText('Is a refund being requested?');
  await expect(result.getByTestId('decision-answer').first()).toHaveText('Yes');
  await expect(result).toContainText('97.0%');
  await expect(result).toContainText('billing');
  await expect(result).toContainText('91.0%');
  await expect(result).toContainText('nimble via Ollama');

  // No questions saved yet: the chat runs like `ollama run`.
  const bar = page.getByTestId('decision-questions-bar');
  await expect(bar).toContainText('Send /clear to start over');
  await bar.getByTestId('decision-questions-edit').click();

  const dialog = page.getByTestId('decision-questions-dialog');
  await expect(dialog).toBeVisible();
  await dialog
    .getByLabel('Question', { exact: true })
    .fill('Is the customer angry?');
  await dialog.getByTestId('decision-questions-add').click();
  await dialog.getByRole('radio', { name: 'Score' }).last().click();
  await dialog
    .getByLabel('Question', { exact: true })
    .last()
    .fill('How urgent is this?');
  await dialog.getByLabel('Level 1', { exact: true }).last().fill('Routine');
  await dialog.getByLabel('Level 2', { exact: true }).last().fill('Soon');
  await dialog.getByLabel('Level 3', { exact: true }).last().fill('Immediate');
  await dialog.getByTestId('decision-questions-save').click();

  await expect(dialog).toHaveCount(0);
  await expect(bar).toContainText('Is the customer angry?');
  await expect(bar).toContainText('How urgent is this?');
  const saved = api.sessionUpdateRequests.at(-1);
  expect(saved?.sessionId).toBe('decision-session');
  expect(
    (saved?.updates as { settings?: Record<string, unknown> }).settings
      ?.decisionQuestions
  ).toEqual({
    q1: { type: 'noul', instructions: 'Is the customer angry?' },
    q2: {
      type: 'score',
      instructions: 'How urgent is this?',
      criteria: ['Routine', 'Soon', 'Immediate'],
    },
  });
});

test('the model picker badges decision models and hides them without access', async ({
  page,
}) => {
  await setup(page, true);
  await page.goto('/c/decision-session');
  const picker = await openPicker(page, 'nimble');
  const nimbleRow = picker.locator(
    '[data-testid="model-selector-option"][data-model-value*="nimble"]'
  );
  await expect(nimbleRow).toBeVisible();
  await expect(
    nimbleRow.getByTestId('model-selector-decision-badge')
  ).toHaveText('Decision');
  const llamaRow = picker.locator(
    '[data-testid="model-selector-option"][data-model-value*="llama3.2"]'
  );
  await expect(
    llamaRow.getByTestId('model-selector-decision-badge')
  ).toHaveCount(0);
});

test('an account without decision access is not offered decision models', async ({
  page,
}) => {
  await setup(page, false, false);
  await page.goto('/chat');
  const picker = await openPicker(page, 'llama3.2');
  await expect(
    picker.locator(
      '[data-testid="model-selector-option"][data-model-value="ollama:llama3.2%3A3b"]'
    )
  ).toBeVisible();
  await expect(
    picker.locator(
      '[data-testid="model-selector-option"][data-model-value*="nimble"]'
    )
  ).toHaveCount(0);
});
