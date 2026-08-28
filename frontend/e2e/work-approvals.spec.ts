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

const baseTask = (id: string, title: string) => ({
  id,
  title,
  model: 'llama3.2:3b',
  providerType: 'ollama' as const,
  status: 'completed' as const,
  networkEnabled: true,
  createdAt,
  updatedAt: createdAt,
  messages: [
    {
      id: `${id}-user`,
      taskId: id,
      runId: `${id}-run`,
      role: 'user' as const,
      kind: 'message' as const,
      content: `Build ${title}`,
      createdAt,
    },
  ],
  activeRun: null,
  previewUrl: null,
  previewStatus: 'stopped' as const,
  workspacePath: '/workspace' as const,
});

test('the Auto Review section toggles approvals and manages rules', async ({
  page,
}) => {
  const agentTask = {
    ...baseTask('agent-task-1', 'Chief of Staff'),
    isAgent: true,
    statusBlurb: 'Inbox at zero.',
  };
  await mockLibreWebUiApi(page, { workTasks: [agentTask] });

  // Specific routes registered after the broad mock take precedence.
  const approvalsState = {
    pending: [] as unknown[],
    rules: [
      {
        id: 'rule-1',
        taskId: 'agent-task-1',
        toolName: 'run_command',
        pattern: 'npm',
        createdAt,
      },
    ],
    approvalsEnabled: false,
    policyRequired: false,
  };
  const toggleRequests: Array<Record<string, unknown>> = [];
  const ruleDeletes: string[] = [];
  await page.route(/\/api\/work\/tasks\/agent-task-1\/approvals$/, route => {
    const method = route.request().method();
    if (method === 'PUT') {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      toggleRequests.push(body);
      approvalsState.approvalsEnabled = body.enabled === true;
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: { approvalsEnabled: approvalsState.approvalsEnabled },
        }),
      });
    }
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: approvalsState }),
    });
  });
  await page.route(
    /\/api\/work\/tasks\/agent-task-1\/approval-rules\/[^/]+$/,
    route => {
      const id = new URL(route.request().url()).pathname.split('/').at(-1);
      ruleDeletes.push(id as string);
      approvalsState.rules = approvalsState.rules.filter(
        rule => (rule as { id: string }).id !== id
      );
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: { deleted: true } }),
      });
    }
  );

  await page.goto('/work/agent-task-1');

  const section = page.getByTestId('work-agent-approvals');
  await expect(section).toBeVisible();

  // The earned Always-allow rule is listed with its command scope.
  const rule = page.getByTestId('work-agent-approval-rule');
  await expect(rule).toHaveCount(1);
  await expect(rule.first()).toContainText('run_command');
  await expect(rule.first()).toContainText('npm');

  // The master switch persists the per-task opt-in.
  await section.getByRole('switch').click();
  await expect.poll(() => toggleRequests).toEqual([{ enabled: true }]);

  // Removing the rule round-trips and empties the list.
  await page.getByTestId('work-agent-approval-rule-delete').click();
  await expect.poll(() => ruleDeletes).toEqual(['rule-1']);
  await expect(page.getByTestId('work-agent-approval-rule')).toHaveCount(0);
});

test('a pending approval renders a decision card and posts the verdict', async ({
  page,
}) => {
  const runningTask = {
    ...baseTask('task-live', 'Risky build'),
    status: 'running' as const,
    activeRun: {
      id: 'run-live',
      taskId: 'task-live',
      model: 'llama3.2:3b',
      providerType: 'ollama' as const,
      status: 'running' as const,
      createdAt,
      startedAt: createdAt + 1,
    },
  };
  await mockLibreWebUiApi(page, { workTasks: [runningTask] });

  // The live event stream delivers the pending approval; a static SSE body
  // is enough because the parser processes complete frames.
  const frames = [
    `id: 1\nevent: run_state\ndata: ${JSON.stringify({
      data: {
        status: 'running',
        phase: 'using_tool',
        round: 1,
        roundLimit: 48,
      },
    })}\n\n`,
    `id: 2\nevent: approval\ndata: ${JSON.stringify({
      data: {
        approvalId: 'approval-1',
        toolCallId: 'call-1',
        name: 'run_command',
        summary: { command: 'rm -rf build' },
        status: 'pending',
        expiresAt: createdAt + 3_600_000,
      },
    })}\n\n`,
  ].join('');
  await page.route(
    /\/api\/work\/tasks\/task-live\/runs\/run-live\/events/,
    route =>
      route.fulfill({
        status: 200,
        headers: {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
        },
        body: frames,
      })
  );
  const decisions: Array<{ path: string; body: Record<string, unknown> }> = [];
  await page.route(
    /\/api\/work\/tasks\/task-live\/approvals\/[^/]+$/,
    route => {
      decisions.push({
        path: new URL(route.request().url()).pathname,
        body: route.request().postDataJSON() as Record<string, unknown>,
      });
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: { approvalId: 'approval-1', status: 'approved' },
        }),
      });
    }
  );

  await page.goto('/work/task-live');

  const card = page.getByTestId('work-approval-card');
  await expect(card).toBeVisible();
  await expect(card).toContainText('run_command');
  await expect(card).toContainText('rm -rf build');

  // Deciding posts the verdict; the buttons lock after the first click.
  await page.getByTestId('work-approval-allow-once').click();
  await expect
    .poll(() => decisions)
    .toEqual([
      {
        path: '/api/work/tasks/task-live/approvals/approval-1',
        body: { approve: true, scope: 'once' },
      },
    ]);
  await expect(page.getByTestId('work-approval-allow-always')).toBeDisabled();
});
