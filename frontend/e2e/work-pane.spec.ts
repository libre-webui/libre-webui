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

const task = (
  id: string,
  title: string,
  assistantMessage: string,
  networkEnabled = false
) => ({
  id,
  title,
  model: 'llama3.2:3b',
  providerType: 'ollama' as const,
  status: 'completed' as const,
  networkEnabled,
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
    {
      id: `${id}-assistant`,
      taskId: id,
      runId: `${id}-run`,
      role: 'assistant' as const,
      kind: 'message' as const,
      content: assistantMessage,
      createdAt: createdAt + 1,
    },
  ],
  activeRun: null,
  previewUrl: null,
  previewStatus: 'stopped' as const,
  workspacePath: '/workspace' as const,
});

test('creates a persistent Work task with networking off by default', async ({
  page,
}) => {
  const mock = await mockLibreWebUiApi(page, {
    workRunResult: {
      assistantMessage: 'The landing page is ready in the task workspace.',
      files: [
        {
          path: 'index.html',
          name: 'index.html',
          type: 'file',
          size: 28,
          modifiedAt: createdAt,
          content: '<main>Calm city builder</main>',
        },
      ],
    },
  });

  await page.goto('/work');

  await expect(page.getByTestId('work-page')).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Start a new Work task' })
  ).toBeVisible();
  await expect(page.getByTestId('work-network-toggle')).not.toBeChecked();

  await page
    .getByTestId('work-composer-input')
    .fill('Build a calm city landing page');
  await page.getByTestId('work-submit-button').click();

  await expect(page).toHaveURL(/\/work\/work-task-1$/);
  await expect(
    page.getByText('The landing page is ready in the task workspace.')
  ).toBeVisible();
  expect(mock.workTaskCreateRequests).toEqual([
    {
      message: 'Build a calm city landing page',
      model: 'llama3.2:3b',
      providerType: 'ollama',
      networkEnabled: false,
    },
  ]);

  await page
    .getByTestId('work-file-item')
    .filter({ hasText: 'index.html' })
    .click();
  await expect(page.getByTestId('work-file-editor')).toHaveValue(
    '<main>Calm city builder</main>'
  );
});

test('offers cloud models and remembers remote disclosure dismissal', async ({
  page,
}) => {
  const model = (
    name: string,
    options: {
      isPlugin?: boolean;
      pluginId?: string;
      pluginName?: string;
    } = {}
  ) => ({
    name,
    size: 0,
    digest: '',
    modified_at: new Date(createdAt).toISOString(),
    details: {
      format: '',
      family: '',
      families: [],
      parameter_size: '',
      quantization_level: '',
    },
    ...options,
  });
  const mock = await mockLibreWebUiApi(page, {
    models: [
      model('llama3.2:3b'),
      model('glm5.2:cloud'),
      model('gpt-5.4'),
      model('gpt-5.4', {
        isPlugin: true,
        pluginId: 'openai',
        pluginName: 'OpenAI GPT',
      }),
      model('nomic-embed-text'),
    ],
    workCapabilities: {
      available: true,
      runtime: 'docker',
      image: 'node:test',
      dockerAvailable: true,
      ollamaAvailable: false,
      pluginAvailable: true,
      runtimeImage: 'node:test',
      limits: {
        maxRounds: 48,
        commandTimeoutMs: 120_000,
        maxOutputChars: 50_000,
      },
    },
  });

  await page.goto('/work');

  await expect(page.getByText('Docker + plugin ready')).toBeVisible();
  await expect(
    page.getByTestId('work-provider-disclosure-popover')
  ).toHaveCount(0);
  const selector = page.getByTestId('work-model-select');
  await expect(selector.locator('option')).toHaveText([
    'llama3.2:3b',
    'glm5.2:cloud',
    'gpt-5.4',
    'gpt-5.4 · OpenAI GPT',
  ]);
  const optionValues = await selector
    .locator('option')
    .evaluateAll(options =>
      options.map(option => (option as HTMLOptionElement).value)
    );
  expect(new Set(optionValues).size).toBe(optionValues.length);

  await selector.selectOption({ label: 'gpt-5.4 · OpenAI GPT' });
  const disclosure = page.getByTestId('work-provider-disclosure-popover');
  await expect(disclosure).toBeVisible();
  await expect(disclosure).toContainText(
    'Conversation and tool output are sent'
  );
  await expect(page.getByTestId('work-provider-disclosure-accent')).toHaveCSS(
    'color',
    'rgb(255, 123, 82)'
  );

  const dismissButton = page.getByTestId('work-provider-disclosure-dismiss');
  await expect(dismissButton).toHaveCSS(
    'background-color',
    'rgb(255, 123, 82)'
  );
  await dismissButton.click();
  await expect(disclosure).toHaveCount(0);
  await expect(selector).toBeFocused();
  expect(mock.preferenceUpdateRequests).toEqual([
    {
      workRemoteProviderDisclosureDismissed: true,
    },
  ]);

  await page.reload();
  await expect(page.getByText('Docker + plugin ready')).toBeVisible();
  await page
    .getByTestId('work-model-select')
    .selectOption({ label: 'gpt-5.4 · OpenAI GPT' });
  await expect(
    page.getByTestId('work-provider-disclosure-popover')
  ).toHaveCount(0);

  await page.getByTestId('work-composer-input').fill('Build with the plugin');
  await page.getByTestId('work-submit-button').click();

  expect(mock.workTaskCreateRequests).toEqual([
    {
      message: 'Build with the plugin',
      model: 'gpt-5.4',
      providerType: 'plugin',
      providerId: 'openai',
      networkEnabled: false,
    },
  ]);
});

test('keeps an in-flight remote disclosure dismissal scoped to its user', async ({
  page,
}) => {
  const systemInfo = {
    requiresAuth: true,
    hasUsers: true,
    userCount: 2,
    allowUserModelPull: true,
    version: '0.10.0-e2e',
    turnstile: { enabled: false },
  };
  const mock = await mockLibreWebUiApi(page, {
    systemInfo,
    authUsers: [
      {
        id: 'user-alice',
        username: 'alice',
        email: 'alice@example.test',
        role: 'admin',
        token: 'alice-token',
      },
      {
        id: 'user-bob',
        username: 'bob',
        email: 'bob@example.test',
        role: 'admin',
        token: 'bob-token',
      },
    ],
    models: [
      {
        name: 'glm5.2:cloud',
        size: 0,
        digest: '',
        modified_at: new Date(createdAt).toISOString(),
        details: {
          format: '',
          family: '',
          families: [],
          parameter_size: '',
          quantization_level: '',
        },
      },
    ],
    deferPreferenceUpdates: true,
  });

  const login = async (username: string) => {
    await page.getByLabel('Username').fill(username);
    await page.getByLabel('Password').fill('password');
    await page.getByRole('button', { name: /sign in/i }).click();
    await expect(page).toHaveURL(url => url.pathname === '/');
  };
  const logout = async (username: string) => {
    await page.getByText(username, { exact: true }).click();
    await page.getByRole('button', { name: 'Log out' }).click();
    await expect(page).toHaveURL(/\/login$/);
  };

  await page.goto('/login');
  await login('alice');
  await page.getByTestId('sidebar-work-button').click();
  await expect(page).toHaveURL(/\/work$/);

  const disclosure = page.getByTestId('work-provider-disclosure-popover');
  await expect(disclosure).toBeVisible();

  const preferenceResponse = page.waitForResponse(
    response =>
      response.request().method() === 'PUT' &&
      new URL(response.url()).pathname === '/api/preferences'
  );
  await page.getByTestId('work-provider-disclosure-dismiss').click();
  await expect.poll(() => mock.preferenceUpdateRequests.length).toBe(1);
  expect(mock.preferenceUpdateUserIds).toEqual(['user-alice']);

  await logout('alice');
  await login('bob');
  await page.getByTestId('sidebar-work-button').click();
  await expect(page).toHaveURL(/\/work$/);
  await expect(disclosure).toBeVisible();

  mock.releasePreferenceUpdates();
  await preferenceResponse;

  await expect(disclosure).toBeVisible();
  await page.reload();
  await expect(disclosure).toBeVisible();

  await logout('bob');
  await login('alice');
  await page.getByTestId('sidebar-work-button').click();
  await expect(page).toHaveURL(/\/work$/);
  await expect(disclosure).toHaveCount(0);
});

test('keeps the remote disclosure open when saving dismissal fails', async ({
  page,
}) => {
  const mock = await mockLibreWebUiApi(page, {
    models: [
      {
        name: 'glm5.2:cloud',
        size: 0,
        digest: '',
        modified_at: new Date(createdAt).toISOString(),
        details: {
          format: '',
          family: '',
          families: [],
          parameter_size: '',
          quantization_level: '',
        },
      },
    ],
    preferenceUpdateFailures: 1,
  });

  await page.goto('/work');

  const disclosure = page.getByTestId('work-provider-disclosure-popover');
  await expect(disclosure).toBeVisible();
  await page.getByTestId('work-provider-disclosure-dismiss').click();

  await expect(disclosure).toBeVisible();
  await expect(
    page.getByText('Could not save the remote provider preference.')
  ).toBeVisible();
  expect(mock.preferenceUpdateRequests).toEqual([
    {
      workRemoteProviderDisclosureDismissed: true,
    },
  ]);
  await expect(
    page.getByTestId('work-provider-disclosure-dismiss')
  ).toBeEnabled();
});

test('loads plugin Work models when Ollama is offline', async ({ page }) => {
  await mockLibreWebUiApi(page, {
    ollamaHealthy: false,
    plugins: [
      {
        id: 'cloud-only',
        name: 'Cloud only',
        type: 'completion',
        endpoint: 'https://provider.example.invalid/v1/chat/completions',
        auth: {
          header: 'Authorization',
          prefix: 'Bearer ',
          key_env: 'CLOUD_ONLY_API_KEY',
        },
        model_map: ['remote-tools-model'],
        active: true,
      },
    ],
    workCapabilities: {
      available: true,
      runtime: 'docker',
      image: 'node:test',
      dockerAvailable: true,
      ollamaAvailable: false,
      pluginAvailable: true,
      runtimeImage: 'node:test',
      limits: {
        maxRounds: 48,
        commandTimeoutMs: 120_000,
        maxOutputChars: 50_000,
      },
    },
  });

  await page.goto('/work');

  await expect(page.getByText('Docker + plugin ready')).toBeVisible();
  await expect(page.getByTestId('work-model-select')).toHaveValue(
    'plugin:cloud-only:remote-tools-model'
  );
  await expect(
    page
      .getByTestId('work-model-select')
      .locator('option', { hasText: 'remote-tools-model · Cloud only' })
  ).toHaveCount(1);
  await expect(page.getByTestId('work-submit-button')).toBeDisabled();
});

test('reopens each task with its own conversation and filesystem', async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem('auth-token', 'e2e-token');
  });
  const taskA = task(
    'workspace-a',
    'Garden planner',
    'Only workspace A contains the garden plan.'
  );
  const taskB = task(
    'workspace-b',
    'Transit planner',
    'Only workspace B contains the transit plan.'
  );

  const mock = await mockLibreWebUiApi(page, {
    systemInfo: {
      requiresAuth: true,
      hasUsers: true,
      userCount: 1,
      allowUserModelPull: true,
      version: '0.10.0-e2e',
      turnstile: { enabled: false },
    },
    workTasks: [taskB, taskA],
    workTaskListDelaysMs: [350],
    workTaskDetailUpdates: {
      'workspace-a': {
        title: 'Garden planner refreshed',
        updatedAt: createdAt + 100,
      },
    },
    workFiles: {
      'workspace-a': [
        {
          path: 'plan.txt',
          name: 'plan.txt',
          type: 'file',
          size: 13,
          modifiedAt: createdAt,
        },
      ],
      'workspace-b': [
        {
          path: 'plan.txt',
          name: 'plan.txt',
          type: 'file',
          size: 14,
          modifiedAt: createdAt,
        },
      ],
    },
    workFileContents: {
      'workspace-a:plan.txt': 'garden-only-a',
      'workspace-b:plan.txt': 'transit-only-b',
    },
  });

  await page.goto('/work/workspace-a');
  const sidebar = page.getByTestId('sidebar');
  const workTaskList = sidebar.getByTestId('sidebar-work-task-list');
  await expect(
    sidebar.getByTestId('sidebar-session-scroll-region')
  ).toHaveCount(0);
  await expect(page.getByTestId('work-task-rail')).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Open Work tasks' })
  ).toHaveCount(0);
  await expect(workTaskList).toBeVisible();
  await expect(workTaskList.getByTestId('sidebar-work-task-item')).toHaveCount(
    2
  );
  await expect(page.getByLabel('Task title')).toHaveValue(
    'Garden planner refreshed'
  );
  await expect(
    workTaskList
      .getByTestId('sidebar-work-task-item')
      .filter({ hasText: 'Garden planner' })
      .getByRole('button')
  ).toHaveAttribute('aria-current', 'page');
  await expect(
    page.getByText('Only workspace A contains the garden plan.')
  ).toBeVisible();
  await page
    .getByTestId('work-file-item')
    .filter({ hasText: 'plan.txt' })
    .click();
  await expect(page.getByTestId('work-file-editor')).toHaveValue(
    'garden-only-a'
  );
  await page
    .getByTestId('work-composer-input')
    .fill('Unsent prompt for workspace A');

  await page
    .getByTestId('sidebar-work-task-item')
    .filter({ hasText: 'Transit planner' })
    .getByRole('button')
    .first()
    .click();
  await expect(page).toHaveURL(/\/work\/workspace-b$/);
  await expect(page.getByTestId('work-composer-input')).toHaveValue('');
  await expect(
    page.getByText('Only workspace B contains the transit plan.')
  ).toBeVisible();
  await page
    .getByTestId('work-file-item')
    .filter({ hasText: 'plan.txt' })
    .click();
  await expect(page.getByTestId('work-file-editor')).toHaveValue(
    'transit-only-b'
  );

  await page
    .getByTestId('sidebar-work-task-item')
    .filter({ hasText: 'Garden planner' })
    .getByRole('button')
    .first()
    .click();
  await expect(page.getByTestId('work-file-item')).toContainText('plan.txt');
  await page
    .getByTestId('work-file-item')
    .filter({ hasText: 'plan.txt' })
    .click();
  await expect(page.getByTestId('work-file-editor')).toHaveValue(
    'garden-only-a'
  );
  expect(mock.workTaskDetailRequests).toEqual(
    expect.arrayContaining(['workspace-a', 'workspace-b'])
  );
});

test('keeps an inactive task deleted when an older poll finishes', async ({
  page,
}) => {
  const activeTask = {
    ...task('active-workspace', 'Active planner', 'Active task response'),
    status: 'running' as const,
  };
  const inactiveTask = task(
    'inactive-workspace',
    'Inactive planner',
    'Inactive task response'
  );
  const mock = await mockLibreWebUiApi(page, {
    workTasks: [inactiveTask, activeTask],
    workTaskListDelaysMs: [0, 1_200],
  });

  await page.goto('/work/active-workspace');
  const inactiveRow = page
    .getByTestId('sidebar-work-task-item')
    .filter({ hasText: inactiveTask.title });
  await expect(inactiveRow).toBeVisible();
  await expect
    .poll(() => mock.workTaskListRequests.length, { timeout: 3_000 })
    .toBeGreaterThanOrEqual(2);

  page.once('dialog', dialog => void dialog.accept());
  await inactiveRow.hover();
  await inactiveRow.getByTestId('sidebar-work-task-delete').click();

  await expect(inactiveRow).toHaveCount(0);
  expect(mock.workTaskDeleteRequests).toEqual(['inactive-workspace']);
  await page.waitForTimeout(1_300);
  await expect(inactiveRow).toHaveCount(0);
});

test('surfaces an initial list failure after a later silent poll fails', async ({
  page,
}) => {
  const activeTask = {
    ...task('list-error-workspace', 'List error task', 'Task detail loaded'),
    status: 'running' as const,
  };
  await mockLibreWebUiApi(page, {
    workTasks: [activeTask],
    workTaskListDelaysMs: [1_500, 1_500, 700, 700],
    workTaskListFailures: [
      'Initial Work task list failed',
      'Initial Work task list failed',
      'Silent Work task poll failed',
      'Silent Work task poll failed',
    ],
  });

  await page.goto('/work/list-error-workspace');

  await expect(page.getByText('Task detail loaded')).toBeVisible();
  await expect(page.getByText('Initial Work task list failed')).toBeVisible({
    timeout: 3_000,
  });
});

test('loads bounded Work history pages without polling full task details', async ({
  page,
}) => {
  const historyTask = {
    ...task(
      'history-workspace',
      'Long-running history',
      'Placeholder response'
    ),
    messages: Array.from({ length: 205 }, (_, messageIndex) => ({
      id: `history-${messageIndex}`,
      taskId: 'history-workspace',
      runId: 'history-run',
      messageIndex,
      role: 'assistant' as const,
      kind: 'message' as const,
      content: `History entry ${String(messageIndex).padStart(3, '0')}`,
      createdAt: createdAt + messageIndex,
    })),
  };
  const mock = await mockLibreWebUiApi(page, {
    workTasks: [historyTask],
  });

  await page.goto('/work/history-workspace');

  await expect(page.getByText('History entry 005')).toHaveCount(1);
  await expect(page.getByText('History entry 004')).toHaveCount(0);
  await expect(page.getByTestId('work-load-older-messages')).toBeVisible();

  await page.getByTestId('work-load-older-messages').click();

  await expect(page.getByText('History entry 000')).toHaveCount(1);
  await expect(page.getByTestId('work-load-older-messages')).toHaveCount(0);
  expect(mock.workMessagePageRequests).toEqual([
    {
      taskId: 'history-workspace',
      before: 5,
      limit: 200,
    },
  ]);
});

test('polls active task summaries and refreshes detail once at completion', async ({
  page,
}) => {
  const runningTask = {
    ...task('summary-poll-workspace', 'Summary polling', 'Earlier result'),
    status: 'running' as const,
    activeRun: {
      id: 'summary-poll-run',
      taskId: 'summary-poll-workspace',
      model: 'llama3.2:3b',
      status: 'running' as const,
      createdAt,
      startedAt: createdAt,
    },
  };
  const mock = await mockLibreWebUiApi(page, {
    workTasks: [runningTask],
    workTaskTransition: {
      taskId: 'summary-poll-workspace',
      status: 'completed',
      afterListRequests: Number.MAX_SAFE_INTEGER,
      messages: [
        {
          id: 'terminal-detail-message',
          taskId: 'summary-poll-workspace',
          runId: 'summary-poll-run',
          role: 'assistant',
          kind: 'message',
          content: 'Loaded only after the summary reported completion.',
          createdAt: createdAt + 2,
        },
      ],
    },
  });

  await page.goto('/work/summary-poll-workspace');
  await expect
    .poll(() => mock.workTaskDetailRequests.length)
    .toBeGreaterThanOrEqual(1);
  await page.waitForTimeout(200);
  const initialDetailRequests = mock.workTaskDetailRequests.length;
  mock.applyWorkTaskTransition();

  await expect(
    page.getByText('Loaded only after the summary reported completion.')
  ).toBeVisible({ timeout: 5000 });
  expect(mock.workTaskListRequests.length).toBeGreaterThanOrEqual(2);
  expect(mock.workTaskDetailRequests.length).toBeGreaterThan(
    initialDetailRequests
  );
  const terminalDetailRequests = mock.workTaskDetailRequests.length;

  await page.waitForTimeout(1300);
  expect(mock.workTaskDetailRequests).toHaveLength(terminalDetailRequests);
});

test('shows tool activity, saves files, and isolates preview content', async ({
  page,
}) => {
  const previewTask = {
    ...task(
      'preview-workspace',
      'Preview project',
      'The preview project is ready.',
      true
    ),
    messages: [
      {
        id: 'preview-user',
        taskId: 'preview-workspace',
        runId: 'preview-run',
        role: 'user' as const,
        kind: 'message' as const,
        content: 'Create the preview',
        createdAt,
      },
      {
        id: 'preview-tool-call',
        taskId: 'preview-workspace',
        runId: 'preview-run',
        role: 'tool' as const,
        kind: 'tool_call' as const,
        content: 'Writing src/main.ts',
        metadata: { name: 'write_file', path: 'src/main.ts' },
        createdAt: createdAt + 1,
      },
      {
        id: 'preview-tool-result',
        taskId: 'preview-workspace',
        runId: 'preview-run',
        role: 'tool' as const,
        kind: 'tool_result' as const,
        content: 'Created /workspace/src/main.ts',
        metadata: { name: 'write_file', path: 'src/main.ts' },
        createdAt: createdAt + 2,
      },
      {
        id: 'preview-assistant',
        taskId: 'preview-workspace',
        runId: 'preview-run',
        role: 'assistant' as const,
        kind: 'message' as const,
        content: 'The preview project is ready.',
        createdAt: createdAt + 3,
      },
    ],
  };
  const mock = await mockLibreWebUiApi(page, {
    workTasks: [previewTask],
    workFiles: {
      'preview-workspace': [
        {
          path: 'src/main.ts',
          name: 'main.ts',
          type: 'file',
          size: 22,
          modifiedAt: createdAt,
        },
      ],
    },
    workFileContents: {
      'preview-workspace:src/main.ts': "document.body.textContent = 'ready';",
    },
  });

  await page.goto('/work/preview-workspace');

  await page.getByTestId('work-activity-tab').click();
  const activityPane = page
    .getByTestId('work-activity-tab')
    .locator('xpath=ancestor::section[1]');
  await expect(activityPane.getByText('Writing src/main.ts')).toBeVisible();
  await expect(
    activityPane.getByText('Created /workspace/src/main.ts')
  ).toBeVisible();

  await page.getByTestId('work-files-tab').click();
  await page
    .getByTestId('work-file-item')
    .filter({ hasText: 'main.ts' })
    .click();
  await page
    .getByTestId('work-file-editor')
    .fill("document.body.textContent = 'saved';");
  await page.getByTestId('work-save-file-button').click();
  await expect
    .poll(() => mock.workFileUpdateRequests)
    .toEqual([
      {
        taskId: 'preview-workspace',
        path: 'src/main.ts',
        content: "document.body.textContent = 'saved';",
        expectedUpdatedAt: createdAt,
      },
    ]);

  await page.getByTestId('work-preview-tab').click();
  await page.getByTestId('work-start-preview-button').click();
  const frame = page.getByTestId('work-preview-frame');
  await expect(frame).toHaveAttribute('src', 'http://127.0.0.1:49173/');
  await expect(frame).toHaveAttribute(
    'sandbox',
    'allow-scripts allow-forms allow-modals allow-downloads'
  );
  await expect(frame).not.toHaveAttribute('sandbox', /allow-same-origin/);
  await expect(frame).not.toHaveAttribute('sandbox', /allow-popups/);
  await expect(frame).toHaveAttribute('referrerpolicy', 'no-referrer');
  expect(new URL((await frame.getAttribute('src')) || '').origin).not.toBe(
    new URL(page.url()).origin
  );

  await page.getByTestId('work-stop-preview-button').click();
  await expect(frame).toHaveCount(0);
  expect(mock.workPreviewRequests).toEqual([
    { taskId: 'preview-workspace', action: 'start', command: undefined },
    { taskId: 'preview-workspace', action: 'stop' },
  ]);
});

test('restores an unsaved file draft after app navigation', async ({
  page,
}) => {
  const draftTask = task(
    'draft-workspace',
    'Draft project',
    'The draft file is ready.'
  );
  await mockLibreWebUiApi(page, {
    workTasks: [draftTask],
    workFiles: {
      'draft-workspace': [
        {
          path: 'draft.txt',
          name: 'draft.txt',
          type: 'file',
          size: 5,
          modifiedAt: createdAt,
        },
      ],
    },
    workFileContents: {
      'draft-workspace:draft.txt': 'saved',
    },
  });

  await page.goto('/work/draft-workspace');
  await page
    .getByTestId('work-file-item')
    .filter({ hasText: 'draft.txt' })
    .click();
  await page.getByTestId('work-file-editor').fill('unsaved local draft');

  const cancelledDialogPromise = page.waitForEvent('dialog');
  const cancelledNavigation = page.getByTestId('sidebar-chat-button').click();
  const cancelledDialog = await cancelledDialogPromise;
  expect(cancelledDialog.message()).toContain(
    'Your unsaved edit will remain as a browser draft.'
  );
  await cancelledDialog.dismiss();
  await cancelledNavigation;
  await expect(page).toHaveURL(/\/work\/draft-workspace$/);
  await expect(page.getByTestId('work-file-editor')).toHaveValue(
    'unsaved local draft'
  );

  const acceptedDialogPromise = page.waitForEvent('dialog');
  const acceptedNavigation = page.getByTestId('sidebar-chat-button').click();
  const acceptedDialog = await acceptedDialogPromise;
  await acceptedDialog.accept();
  await acceptedNavigation;
  await expect(page).toHaveURL(/\/chat$/);

  await page.getByTestId('sidebar-work-button').click();
  await expect(page).toHaveURL(/\/work$/);
  await page
    .getByTestId('sidebar-work-task-item')
    .filter({ hasText: 'Draft project' })
    .getByRole('button')
    .first()
    .click();
  await expect(page).toHaveURL(/\/work\/draft-workspace$/);
  await page
    .getByTestId('work-file-item')
    .filter({ hasText: 'draft.txt' })
    .click();
  await expect(page.getByTestId('work-file-editor')).toHaveValue(
    'unsaved local draft'
  );
});

test('preserves an authenticated user draft across a page refresh', async ({
  page,
}) => {
  const draftTask = task(
    'refresh-draft-workspace',
    'Refresh draft project',
    'The refresh draft file is ready.'
  );
  await mockLibreWebUiApi(page, {
    systemInfo: {
      requiresAuth: true,
      hasUsers: true,
      userCount: 1,
      allowUserModelPull: true,
      version: '0.10.0-e2e',
      turnstile: { enabled: false },
    },
    workTasks: [draftTask],
    workFiles: {
      'refresh-draft-workspace': [
        {
          path: 'draft.txt',
          name: 'draft.txt',
          type: 'file',
          size: 5,
          modifiedAt: createdAt,
        },
      ],
    },
    workFileContents: {
      'refresh-draft-workspace:draft.txt': 'saved',
    },
  });

  await page.goto('/login');
  await page.getByLabel('Username').fill('e2e');
  await page.getByLabel('Password').fill('password');
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page).toHaveURL(/\/$/);

  await page.goto('/work/refresh-draft-workspace');
  await page
    .getByTestId('work-file-item')
    .filter({ hasText: 'draft.txt' })
    .click();
  await page
    .getByTestId('work-file-editor')
    .fill('unsaved draft survives refresh');

  page.once('dialog', dialog => void dialog.accept());
  await page.reload();
  await page
    .getByTestId('work-file-item')
    .filter({ hasText: 'draft.txt' })
    .click();
  await expect(page.getByTestId('work-file-editor')).toHaveValue(
    'unsaved draft survives refresh'
  );
});

test('cancels an active run without removing task files', async ({ page }) => {
  const runningTask = {
    ...task('running-workspace', 'Running project', 'Earlier result'),
    status: 'running' as const,
    activeRun: {
      id: 'active-run',
      taskId: 'running-workspace',
      model: 'llama3.2:3b',
      status: 'running' as const,
      createdAt,
      startedAt: createdAt,
    },
  };
  const mock = await mockLibreWebUiApi(page, {
    workTasks: [runningTask],
    workFiles: {
      'running-workspace': [
        {
          path: 'keep.txt',
          name: 'keep.txt',
          type: 'file',
          size: 4,
          modifiedAt: createdAt,
        },
      ],
    },
    workFileContents: {
      'running-workspace:keep.txt': 'keep',
    },
  });

  await page.goto('/work/running-workspace');
  await page.getByTestId('work-cancel-button').click();

  await expect
    .poll(() => mock.workCancelRequests)
    .toEqual(['running-workspace']);
  await expect(page.getByTestId('work-cancel-button')).toHaveCount(0);
  await page
    .getByTestId('work-file-item')
    .filter({ hasText: 'keep.txt' })
    .click();
  await expect(page.getByTestId('work-file-editor')).toHaveValue('keep');
});

test('explains when the local container runtime is unavailable', async ({
  page,
}) => {
  await mockLibreWebUiApi(page, {
    workCapabilities: {
      available: false,
      runtime: 'docker',
      image: '',
      dockerAvailable: false,
      ollamaAvailable: true,
      runtimeImage: '',
      reason: 'Docker daemon unavailable',
      limits: {
        maxRounds: 48,
        commandTimeoutMs: 120_000,
        maxOutputChars: 50_000,
      },
    },
  });

  await page.goto('/work');

  await expect(page.getByText('Docker daemon unavailable')).toBeVisible();
  await expect(page.getByTestId('work-composer-input')).toBeDisabled();
  await expect(page.getByTestId('work-submit-button')).toBeDisabled();
});
