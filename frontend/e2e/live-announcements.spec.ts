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
const createdAt = new Date('2026-07-26T12:00:00.000Z').getTime();
const polite = (page: Page) => page.getByTestId('live-announcer-polite');
const assertive = (page: Page) => page.getByTestId('live-announcer-assertive');
// Records every non-empty text a live region is given, so "announced once"
// is a count of announcements rather than a check that the text is present.
const recordAnnouncements = async (page: Page) => {
  await page.evaluate(() => {
    const win = window as unknown as {
      __announced: Record<string, string[]>;
    };
    win.__announced = { polite: [], assertive: [] };
    for (const kind of ['polite', 'assertive']) {
      const region = document.querySelector(
        `[data-testid="live-announcer-${kind}"]`
      );
      if (!region) throw new Error(`missing ${kind} region`);
      new MutationObserver(() => {
        const text = region.textContent ?? '';
        if (text) win.__announced[kind].push(text);
      }).observe(region, {
        childList: true,
        characterData: true,
        subtree: true,
      });
    }
  });
};
const announced = (page: Page, kind: 'polite' | 'assertive') =>
  page.evaluate(
    k =>
      (window as unknown as { __announced: Record<string, string[]> })
        .__announced[k],
    kind
  );
const chatSession = (
  id: string,
  messages: Array<Record<string, unknown>> = []
) => ({
  id,
  title: 'Announcements',
  model: 'llama3.2:3b',
  createdAt: Date.now(),
  updatedAt: Date.now(),
  messages,
});
const prepareChat = async (page: Page) => {
  await page.addInitScript(() => {
    localStorage.setItem('i18nextLng', 'en');
    localStorage.setItem('auth-token', 'e2e-token');
  });
};
const send = async (page: Page, text: string) => {
  const input = page.locator('textarea[rows="1"][dir="auto"]');
  await expect(input).toBeVisible();
  await input.fill(text);
  await input.press('Enter');
};
test('both live regions exist up front with the right roles', async ({
  page,
}) => {
  await mockLibreWebUiApi(page, { sessions: [chatSession('regions')] });
  await prepareChat(page);
  await page.goto('/c/regions');
  await expect(polite(page)).toHaveAttribute('role', 'status');
  await expect(polite(page)).toHaveAttribute('aria-live', 'polite');
  await expect(polite(page)).toHaveAttribute('aria-atomic', 'true');
  await expect(assertive(page)).toHaveAttribute('role', 'alert');
  await expect(assertive(page)).toHaveAttribute('aria-live', 'assertive');
  await expect(assertive(page)).toHaveAttribute('aria-atomic', 'true');
});
test('a finished chat reply is announced once as plain text, never per token', async ({
  page,
}) => {
  await mockLibreWebUiApi(page, {
    sessions: [chatSession('announce-reply')],
    chatStream: {
      chunks: ['The build ', 'finished **cleanly** ', 'with `3` warnings.'],
      chunkDelayMs: 300,
      completionDelayMs: 300,
      duplicateCompletion: true,
    },
  });
  await prepareChat(page);
  await page.goto('/c/announce-reply');
  await page.waitForLoadState('networkidle');
  await recordAnnouncements(page);
  await send(page, 'How did it go?');
  await expect(page.getByTestId('chat-scroll-viewport')).toHaveAttribute(
    'aria-busy',
    'true'
  );
  // Mid-stream the reader has heard nothing.
  await expect(page.getByText('The build').first()).toBeVisible();
  expect(await announced(page, 'polite')).toEqual([]);
  await expect(polite(page)).toHaveText('');
  await expect(polite(page)).toContainText(
    'The build finished cleanly with 3 warnings.',
    { timeout: 10_000 }
  );
  await expect(polite(page)).toHaveText(
    'llama3.2:3b replied: The build finished cleanly with 3 warnings.'
  );
  await expect(page.getByTestId('chat-scroll-viewport')).toHaveAttribute(
    'aria-busy',
    'false'
  );
  // Give a stray second announcement (the duplicated completion) time to show.
  await page.waitForTimeout(600);
  const heard = await announced(page, 'polite');
  expect(heard).toHaveLength(1);
  expect(heard[0].split('finished cleanly').length - 1).toBe(1);
  expect(await announced(page, 'assertive')).toEqual([]);
});
test('code blocks are spoken as a phrase and long replies are capped', async ({
  page,
}) => {
  const long = 'This sentence keeps going to make the reply long. '.repeat(40);
  await mockLibreWebUiApi(page, {
    sessions: [chatSession('announce-code')],
    chatStream: {
      chunks: ['Run this:\n\n```sh\nnpm test\n```\n\n', long],
      chunkDelayMs: 100,
      completionDelayMs: 100,
    },
  });
  await prepareChat(page);
  await page.goto('/c/announce-code');
  await page.waitForLoadState('networkidle');
  await send(page, 'Show me how.');
  await expect(polite(page)).toContainText('Run this: code block.', {
    timeout: 10_000,
  });
  const spoken = (await polite(page).textContent()) ?? '';
  expect(spoken).not.toContain('npm test');
  expect(spoken).not.toContain('```');
  expect(spoken.endsWith('…')).toBe(true);
  // The reply is about 2000 characters; the announcement stays near 600.
  expect(spoken.length).toBeLessThan(700);
});
test('loading an existing session announces nothing', async ({ page }) => {
  await mockLibreWebUiApi(page, {
    sessions: [
      chatSession('existing-session', [
        {
          id: 'existing-user',
          role: 'user',
          content: 'An older question',
          timestamp: createdAt,
        },
        {
          id: 'existing-assistant',
          role: 'assistant',
          content: 'An older answer that must stay silent.',
          timestamp: createdAt + 1,
          model: 'llama3.2:3b',
        },
      ]),
      chatSession('other-session', [
        {
          id: 'other-user',
          role: 'user',
          content: 'Another question',
          timestamp: createdAt,
        },
        {
          id: 'other-assistant',
          role: 'assistant',
          content: 'Another settled answer.',
          timestamp: createdAt + 1,
          model: 'llama3.2:3b',
        },
      ]),
    ],
  });
  await prepareChat(page);
  await page.goto('/c/existing-session');
  await page.waitForLoadState('networkidle');
  await expect(
    page.getByText('An older answer that must stay silent.').first()
  ).toBeVisible();
  await recordAnnouncements(page);
  // Switching sessions in the running app is not news either.
  await page.evaluate(() => {
    window.history.pushState({}, '', '/c/other-session');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  await expect(page).toHaveURL(/\/c\/other-session$/);
  await expect(page.getByText('Another settled answer.').first()).toBeVisible();
  await page.waitForTimeout(1_000);
  await expect(polite(page)).toHaveText('');
  await expect(assertive(page)).toHaveText('');
  expect(await announced(page, 'polite')).toEqual([]);
  expect(await announced(page, 'assertive')).toEqual([]);
});
test('stopping a reply announces that generation stopped', async ({ page }) => {
  await mockLibreWebUiApi(page, {
    sessions: [chatSession('announce-stop')],
    chatStream: {
      chunks: ['Still working on it.'],
      chunkDelayMs: 100,
      holdOpen: true,
    },
  });
  await prepareChat(page);
  await page.goto('/c/announce-stop');
  await page.waitForLoadState('networkidle');
  await send(page, 'Start a long answer.');
  await expect(page.getByText('Still working on it.').first()).toBeVisible();
  await expect(polite(page)).toHaveText('');
  await page.getByTitle('Stop generation').click();
  await expect(polite(page)).toHaveText('Generation stopped');
});
const workTask = (id: string, title: string, status: string) => ({
  id,
  title,
  model: 'llama3.2:3b',
  providerType: 'ollama' as const,
  status: status as 'running',
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
  activeRun:
    status === 'running'
      ? {
          id: `${id}-run`,
          taskId: id,
          model: 'llama3.2:3b',
          providerType: 'ollama' as const,
          status: 'running' as const,
          createdAt,
          startedAt: createdAt,
        }
      : null,
  previewUrl: null,
  previewStatus: 'stopped' as const,
  workspacePath: '/workspace' as const,
});
const openRunningWorkTask = async (
  page: Page,
  finalStatus: 'completed' | 'needs_input' | 'failed'
) => {
  const mock = await mockLibreWebUiApi(page, {
    workTasks: [workTask('announce-work', 'Nightly report', 'running')],
    workTaskTransition: {
      taskId: 'announce-work',
      status: finalStatus,
      afterListRequests: Number.MAX_SAFE_INTEGER,
    },
  });
  await page.goto('/work/announce-work');
  await expect(page.getByTestId('work-status')).toBeVisible();
  await recordAnnouncements(page);
  // Opening a task that is mid-run is not a completion.
  await page.waitForTimeout(1_200);
  await expect(polite(page)).toHaveText('');
  await expect(assertive(page)).toHaveText('');
  return mock;
};
test('a Work run that finishes is announced politely, once', async ({
  page,
}) => {
  const mock = await openRunningWorkTask(page, 'completed');
  mock.applyWorkTaskTransition();
  await expect(polite(page)).toHaveText('Nightly report finished.', {
    timeout: 10_000,
  });
  await page.waitForTimeout(2_500);
  expect(await announced(page, 'polite')).toEqual(['Nightly report finished.']);
  expect(await announced(page, 'assertive')).toEqual([]);
});
test('a Work run that needs input is announced assertively', async ({
  page,
}) => {
  const mock = await openRunningWorkTask(page, 'needs_input');
  mock.applyWorkTaskTransition();
  await expect(assertive(page)).toHaveText(
    'Nightly report needs your input or approval.',
    { timeout: 10_000 }
  );
  expect(await announced(page, 'polite')).toEqual([]);
});
test('a Work run that fails is announced assertively', async ({ page }) => {
  const mock = await openRunningWorkTask(page, 'failed');
  mock.applyWorkTaskTransition();
  await expect(assertive(page)).toHaveText('Nightly report failed.', {
    timeout: 10_000,
  });
});
test('opening a finished Work task announces nothing', async ({ page }) => {
  await mockLibreWebUiApi(page, {
    workTasks: [workTask('settled-work', 'Settled report', 'completed')],
  });
  await page.goto('/work/settled-work');
  await expect(page.getByTestId('work-status')).toBeVisible();
  await recordAnnouncements(page);
  await page.waitForTimeout(1_500);
  await expect(polite(page)).toHaveText('');
  await expect(assertive(page)).toHaveText('');
});
test('a live tool approval is announced assertively, but not when replayed on load', async ({
  page,
}) => {
  await mockLibreWebUiApi(page, {
    workTasks: [workTask('approval-work', 'Risky build', 'running')],
  });
  const frame = (id: number, event: string, data: Record<string, unknown>) =>
    `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify({ data })}\n\n`;
  const runState = frame(1, 'run_state', {
    status: 'running',
    phase: 'using_tool',
    round: 1,
    roundLimit: 48,
  });
  const approval = frame(2, 'approval', {
    approvalId: 'approval-live',
    toolCallId: 'call-1',
    name: 'run_command',
    summary: { command: 'rm -rf build' },
    status: 'pending',
    expiresAt: createdAt + 3_600_000,
  });
  // Mirrors the server: the first subscription replays what already
  // happened, and a later reconnect (after=1) delivers the new approval.
  let releaseApproval!: () => void;
  const approvalReleased = new Promise<void>(resolve => {
    releaseApproval = resolve;
  });
  await page.route(
    /\/api\/work\/tasks\/approval-work\/runs\/approval-work-run\/events/,
    async route => {
      const after = Number(
        new URL(route.request().url()).searchParams.get('after')
      );
      if (after >= 1) await approvalReleased;
      await route.fulfill({
        status: 200,
        headers: {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
        },
        body: after >= 1 ? approval : runState,
      });
    }
  );
  await page.goto('/work/approval-work');
  await expect(page.getByTestId('work-status')).toBeVisible();
  await recordAnnouncements(page);
  await page.waitForTimeout(500);
  expect(await announced(page, 'assertive')).toEqual([]);
  releaseApproval();
  await expect(assertive(page)).toHaveText(
    'Risky build needs your approval to run run_command.',
    { timeout: 15_000 }
  );
  expect(await announced(page, 'assertive')).toHaveLength(1);
});
test('an approval already pending when the task opens is not announced', async ({
  page,
}) => {
  await mockLibreWebUiApi(page, {
    workTasks: [workTask('replay-work', 'Replayed build', 'running')],
  });
  const frames = [
    {
      id: 1,
      event: 'run_state',
      data: { status: 'running', phase: 'using_tool' },
    },
    {
      id: 2,
      event: 'approval',
      data: {
        approvalId: 'approval-replayed',
        toolCallId: 'call-2',
        name: 'run_command',
        status: 'pending',
        expiresAt: createdAt + 3_600_000,
      },
    },
  ]
    .map(
      ({ id, event, data }) =>
        `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify({ data })}\n\n`
    )
    .join('');
  await page.route(
    /\/api\/work\/tasks\/replay-work\/runs\/replay-work-run\/events/,
    route =>
      route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        body: frames,
      })
  );
  await page.goto('/work/replay-work');
  await expect(page.getByTestId('work-approval-card').first()).toBeVisible();
  await recordAnnouncements(page);
  await page.waitForTimeout(1_000);
  await expect(assertive(page)).toHaveText('');
});

test('a failed reply is read once, by its assertive error toast', async ({
  page,
}) => {
  const failure = 'The model ran out of memory.';
  await mockLibreWebUiApi(page, {
    sessions: [chatSession('announce-error')],
    chatStream: {
      chunks: ['Partial answer '],
      chunkDelayMs: 100,
      completionDelayMs: 200,
      failWith: failure,
    },
  });
  await prepareChat(page);
  await page.goto('/c/announce-error');
  await page.waitForLoadState('networkidle');
  await recordAnnouncements(page);
  await send(page, 'Try something heavy.');
  const toast = page.getByRole('alert').filter({ hasText: failure });
  await expect(toast).toBeVisible({ timeout: 10_000 });
  await expect(toast).toHaveAttribute('aria-live', 'assertive');
  await expect(page.getByTestId('chat-scroll-viewport')).toHaveAttribute(
    'aria-busy',
    'false'
  );
  // The toast already interrupts; the announcer must not repeat it, and a
  // failed reply is never reported as a finished one.
  await page.waitForTimeout(600);
  expect(await announced(page, 'assertive')).toEqual([]);
  expect(await announced(page, 'polite')).toEqual([]);
});

const backgroundWork = (page: Page, finalStatus: 'completed' | 'failed') =>
  mockLibreWebUiApi(page, {
    workTasks: [
      workTask('open-work', 'Open draft', 'completed'),
      workTask('background-work', 'Nightly report', 'running'),
    ],
    workTaskTransition: {
      taskId: 'background-work',
      status: finalStatus,
      afterListRequests: Number.MAX_SAFE_INTEGER,
    },
  });

test('a background Work task that finishes is announced from the open task', async ({
  page,
}) => {
  const mock = await backgroundWork(page, 'failed');
  await page.goto('/work/open-work');
  await expect(page.getByTestId('work-status')).toBeVisible();
  await recordAnnouncements(page);
  await page.waitForTimeout(1_200);
  expect(await announced(page, 'assertive')).toEqual([]);
  mock.applyWorkTaskTransition();
  await expect(assertive(page)).toHaveText('Nightly report failed.', {
    timeout: 10_000,
  });
  await page.waitForTimeout(2_500);
  expect(await announced(page, 'assertive')).toEqual([
    'Nightly report failed.',
  ]);
  expect(await announced(page, 'polite')).toEqual([]);
});

test('a Work task that finishes while you are elsewhere is announced', async ({
  page,
}) => {
  const mock = await backgroundWork(page, 'completed');
  await page.goto('/work/open-work');
  await expect(page.getByTestId('work-status')).toBeVisible();
  // Leave Work through the app so the known task list stays loaded.
  await page
    .getByTestId('sidebar')
    .getByRole('link', { name: 'Notes' })
    .click();
  await expect(page).toHaveURL(/\/notes$/);
  await recordAnnouncements(page);
  mock.applyWorkTaskTransition();
  await expect(polite(page)).toHaveText('Nightly report finished.', {
    timeout: 15_000,
  });
  expect(await announced(page, 'polite')).toEqual(['Nightly report finished.']);
  // Nothing is running any more, so the background poll stops.
  const requests = mock.workTaskListRequests.length;
  await page.waitForTimeout(6_000);
  expect(mock.workTaskListRequests.length).toBe(requests);
});
