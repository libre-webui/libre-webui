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

import { expect, test } from '@playwright/test';
import { mockLibreWebUiApi } from './lib/mockApi';

const systemInfo = {
  requiresAuth: true,
  hasUsers: true,
  userCount: 2,
  signupEnabled: true,
  allowUserModelPull: true,
  version: '0.17.0-e2e',
  turnstile: { enabled: false },
};

const now = Date.now();
const day = 86_400_000;

test('administrators open provider usage from the user menu', async ({
  page,
}) => {
  await mockLibreWebUiApi(page, {
    systemInfo,
    authUsers: [
      {
        id: 'admin-user',
        username: 'admin',
        email: 'admin@example.test',
        role: 'admin',
        status: 'active',
        token: 'admin-token',
      },
    ],
    pluginUsage: {
      range: { from: now - 29 * day, to: now, days: 30 },
      totals: {
        calls: 128,
        successfulCalls: 124,
        failedCalls: 4,
        cancelledCalls: 0,
        meteredCalls: 96,
        promptTokens: 910_000,
        completionTokens: 330_000,
        reportedTokens: 1_240_000,
        averageLatencyMs: 1840,
        uniqueUsers: 2,
      },
      series: Array.from({ length: 30 }, (_, index) => ({
        timestamp: now - (29 - index) * day,
        calls: index + 1,
        tokens: (index + 1) * 1200,
        errors: index === 18 ? 2 : 0,
      })),
      plugins: [
        {
          pluginId: 'openai',
          pluginName: 'OpenAI',
          calls: 88,
          tokens: 940_000,
          errors: 2,
          averageLatencyMs: 1580,
        },
        {
          pluginId: 'anthropic',
          pluginName: 'Anthropic',
          calls: 40,
          tokens: 300_000,
          errors: 2,
          averageLatencyMs: 2410,
        },
      ],
      models: [
        {
          model: 'gpt-5.1',
          pluginId: 'openai',
          pluginName: 'OpenAI',
          calls: 88,
          tokens: 940_000,
          errors: 2,
          averageLatencyMs: 1580,
        },
      ],
      capabilities: [
        {
          capability: 'chat',
          calls: 118,
          tokens: 1_240_000,
          inputUnits: 0,
          outputUnits: 0,
        },
        {
          capability: 'image',
          calls: 10,
          tokens: 0,
          inputUnits: 0,
          outputUnits: 16,
        },
      ],
    },
  });
  await page.addInitScript(() => {
    localStorage.setItem('auth-token', 'admin-token');
  });

  await page.goto('/');
  await page.getByRole('button', { name: /admin/i }).last().click();
  await page.getByRole('link', { name: 'Provider Usage' }).click();

  await expect(page).toHaveURL(/\/usage$/);
  await expect(
    page.getByRole('heading', { name: 'Provider Usage' })
  ).toBeVisible();
  await expect(page.getByTestId('plugin-usage-chart')).toBeVisible();
  await expect(page.getByText('1.2M', { exact: true })).toBeVisible();
  await expect(page.getByText('gpt-5.1')).toBeVisible();
  await expect(page.getByText('OpenAI').first()).toBeVisible();
});

test('regular users do not receive the provider usage navigation entry', async ({
  page,
}) => {
  await mockLibreWebUiApi(page, {
    systemInfo,
    authUsers: [
      {
        id: 'regular-user',
        username: 'member',
        email: 'member@example.test',
        role: 'user',
        status: 'active',
        token: 'member-token',
      },
    ],
  });
  await page.addInitScript(() => {
    localStorage.setItem('auth-token', 'member-token');
  });

  await page.goto('/');
  await page
    .getByRole('button', { name: /member/i })
    .last()
    .click();
  await expect(page.getByRole('link', { name: 'Provider Usage' })).toHaveCount(
    0
  );
});
