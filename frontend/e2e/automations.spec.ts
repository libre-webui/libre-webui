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

type MockAutomation = {
  id: string;
  name: string;
  instructions: string;
  triggers: { kind: string; hour?: number; minute?: number }[];
  notify: 'app' | 'off';
  status: 'active' | 'paused';
  nextRunAt?: number;
  createdAt: number;
  updatedAt: number;
};

const digest: MockAutomation = {
  id: 'digest-automation',
  name: 'AI news digest',
  instructions: 'Summarize the most important AI news from the last 24 hours.',
  triggers: [{ kind: 'daily', hour: 8, minute: 0 }],
  notify: 'app',
  status: 'active',
  nextRunAt: Date.now() + 60 * 60 * 1000,
  createdAt: 1_770_000_000_000,
  updatedAt: 1_770_000_000_000,
};

const finishedRun = {
  id: 'run-1',
  automationId: digest.id,
  scheduledFor: Date.now() - 60 * 60 * 1000,
  startedAt: Date.now() - 60 * 60 * 1000,
  finishedAt: Date.now() - 59 * 60 * 1000,
  status: 'succeeded',
  sessionId: 'digest-session',
  seen: false,
  createdAt: Date.now() - 60 * 60 * 1000,
};

async function mockAutomationsApi(page: Page) {
  const automations = [structuredClone(digest)];

  await page.route(/\/api\/automations(?:\/.*)?(?:\?.*)?$/, async route => {
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

    if (path.endsWith('/runs/summary')) {
      await fulfill({
        unseenCount: 1,
        days: Array.from({ length: 30 }, (_, index) => ({
          succeeded: index === 29 ? 1 : 0,
          failed: 0,
        })),
      });
      return;
    }
    if (path.endsWith('/runs/seen')) {
      await fulfill({ marked: 1 });
      return;
    }
    if (path.endsWith('/runs')) {
      await fulfill([finishedRun]);
      return;
    }
    if (path.endsWith('/occurrences')) {
      await fulfill([]);
      return;
    }
    if (method === 'GET' && path.endsWith('/api/automations')) {
      await fulfill(automations);
      return;
    }
    if (method === 'POST' && path.endsWith('/api/automations')) {
      const body = request.postDataJSON() as Partial<MockAutomation>;
      const created: MockAutomation = {
        id: `automation-${automations.length + 1}`,
        name: body.name ?? '',
        instructions: body.instructions ?? '',
        triggers: body.triggers ?? [],
        notify: body.notify ?? 'app',
        status: 'active',
        nextRunAt: Date.now() + 30 * 60 * 1000,
        createdAt: 1_770_000_002_000,
        updatedAt: 1_770_000_002_000,
      };
      automations.push(created);
      await fulfill(created);
      return;
    }

    await route.fulfill({
      status: 405,
      contentType: 'application/json',
      body: JSON.stringify({ success: false, error: 'Method not allowed' }),
    });
  });
}

test('automations list their schedule and create from the modal', async ({
  page,
}) => {
  await mockLibreWebUiApi(page);
  await mockAutomationsApi(page);

  await page.goto('/automations');
  const row = page
    .getByTestId('automation-row')
    .filter({ hasText: digest.name });
  await expect(row).toBeVisible();
  await expect(row).toContainText('Active');
  await expect(row).toContainText('Daily at');

  // Templates offer one-click starting points.
  await expect(page.getByTestId('automation-template').first()).toBeVisible();

  // Create a new automation.
  await page.getByTestId('automation-new').click();
  await expect(page.getByTestId('automation-modal')).toBeVisible();
  await page.getByTestId('automation-name').fill('Weekly review');
  await page
    .getByTestId('automation-instructions')
    .fill('Wrap the week for me.');
  await page.getByTestId('automation-save').click();
  await expect(page.getByTestId('automation-modal')).toHaveCount(0);
  await expect(
    page.getByTestId('automation-row').filter({ hasText: 'Weekly review' })
  ).toBeVisible();
});

test('the runs tab shows history and opens the produced chat', async ({
  page,
}) => {
  await mockLibreWebUiApi(page);
  await mockAutomationsApi(page);

  await page.goto('/automations');
  await page.getByTestId('automations-tab-runs').click();
  await expect(page.getByTestId('automation-run-strip')).toBeVisible();
  const runList = page.getByTestId('automation-run-list');
  await expect(runList).toContainText(digest.name);
  await expect(page.getByTestId('automation-run-open')).toBeVisible();
});
