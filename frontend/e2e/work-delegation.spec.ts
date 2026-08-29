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

const createdAt = new Date('2026-07-26T12:00:00.000Z').getTime();

const agentTask = (id: string, title: string) => ({
  id,
  title,
  model: 'llama3.2:3b',
  providerType: 'ollama' as const,
  status: 'completed' as const,
  networkEnabled: true,
  createdAt,
  updatedAt: createdAt,
  isAgent: true,
  messages: [
    {
      id: `${id}-user`,
      taskId: id,
      runId: `${id}-run`,
      role: 'user' as const,
      kind: 'message' as const,
      content: `${title} duties`,
      createdAt,
    },
  ],
  activeRun: null,
  previewUrl: null,
  previewStatus: 'stopped' as const,
  workspacePath: '/workspace' as const,
});

test('typing @ in the composer suggests other agents and inserts the mention', async ({
  page,
}) => {
  await mockLibreWebUiApi(page, {
    workTasks: [
      agentTask('agent-chief', 'Chief of Staff'),
      agentTask('agent-researcher', 'Researcher'),
    ],
  });
  await page.goto('/work/agent-chief');

  const input = page.getByTestId('work-composer-input');
  await input.click();
  await input.fill('Ask @Res');
  const menu = page.getByTestId('work-mention-menu');
  await expect(menu).toBeVisible();
  const options = page.getByTestId('work-mention-option');
  await expect(options).toHaveCount(1);
  await expect(options.first()).toContainText('@Researcher');
  // The current agent never suggests itself.
  await expect(menu).not.toContainText('Chief of Staff');

  await options.first().click();
  await expect(input).toHaveValue('Ask @Researcher ');
  await expect(menu).toHaveCount(0);

  // Escape closes the menu without inserting.
  await input.fill('Ask @Researcher and @');
  await expect(page.getByTestId('work-mention-menu')).toBeVisible();
  await input.press('Escape');
  await expect(page.getByTestId('work-mention-menu')).toHaveCount(0);
});

test('delegated requests and reports render with attribution labels', async ({
  page,
}) => {
  const researcher = agentTask('agent-researcher', 'Researcher');
  researcher.messages = [
    {
      id: 'delegated-request',
      taskId: 'agent-researcher',
      runId: 'run-delegated',
      role: 'user' as const,
      kind: 'message' as const,
      content: 'Please research the market.',
      createdAt,
      metadata: {
        delegation: {
          fromTaskId: 'agent-chief',
          fromRunId: 'run-chief',
          fromAgent: 'Chief of Staff',
        },
      },
    } as (typeof researcher.messages)[number],
  ];
  const chief = agentTask('agent-chief', 'Chief of Staff');
  chief.messages = [
    {
      id: 'delegation-report',
      taskId: 'agent-chief',
      runId: null,
      role: 'user' as const,
      kind: 'message' as const,
      content:
        'Report from Researcher — the delegated request finished.\n\nThe top number is 42.',
      createdAt,
      metadata: {
        delegationReport: {
          fromTaskId: 'agent-researcher',
          fromAgent: 'Researcher',
          status: 'completed',
        },
      },
    } as unknown as (typeof chief.messages)[number],
  ];
  await mockLibreWebUiApi(page, { workTasks: [chief, researcher] });

  await page.goto('/work/agent-researcher');
  const requestLabel = page.getByTestId('work-delegation-label');
  await expect(requestLabel).toBeVisible();
  await expect(requestLabel).toContainText('Delegated by Chief of Staff');

  await page.goto('/work/agent-chief');
  const reportLabel = page.getByTestId('work-delegation-label');
  await expect(reportLabel).toBeVisible();
  await expect(reportLabel).toContainText('Report from Researcher');
});
