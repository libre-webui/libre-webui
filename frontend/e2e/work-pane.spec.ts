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
  networkEnabled = true
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

test('keeps the configured user wallpaper visible behind Work', async ({
  page,
}) => {
  const wallpaper = `data:image/svg+xml,${encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#315b65"/></svg>'
  )}`;
  await mockLibreWebUiApi(page, {
    systemInfo: {
      requiresAuth: true,
      hasUsers: true,
      userCount: 1,
      version: '0.15.0-e2e',
      turnstile: { enabled: false },
    },
    authUsers: [
      {
        id: 'wallpaper-user',
        username: 'robin',
        email: 'robin@example.test',
        role: 'admin',
        token: 'wallpaper-token',
        preferences: {
          backgroundSettings: {
            enabled: true,
            imageUrl: wallpaper,
            blurAmount: 0,
            opacity: 0.8,
          },
        },
      },
    ],
    workTasks: [
      task(
        'wallpaper-workspace',
        'Wallpaper workspace',
        'The wallpaper stays visible behind Work.'
      ),
    ],
  });
  await page.addInitScript(() => {
    localStorage.setItem('auth-token', 'wallpaper-token');
  });

  await page.goto('/work/wallpaper-workspace');

  await expect(page.getByTestId('app-background')).toHaveCSS(
    'background-image',
    /data:image\/svg\+xml/
  );
  await expect(page.getByTestId('work-page')).toHaveCSS(
    'background-color',
    'rgba(0, 0, 0, 0)'
  );
  await expect(page.getByTestId('work-conversation-panel')).toHaveCSS(
    'background-color',
    'rgba(0, 0, 0, 0)'
  );
  await expect(
    page.getByText('The wallpaper stays visible behind Work.')
  ).toBeVisible();
});

test('uses the Libre identity and authenticated user avatar in Work', async ({
  page,
}) => {
  const avatar = `data:image/svg+xml,${encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" rx="32" fill="#ff7b52"/><text x="32" y="39" text-anchor="middle" font-size="24" fill="white">R</text></svg>'
  )}`;
  await mockLibreWebUiApi(page, {
    systemInfo: {
      requiresAuth: true,
      hasUsers: true,
      userCount: 1,
      version: '0.15.0-e2e',
      turnstile: { enabled: false },
    },
    authUsers: [
      {
        id: 'avatar-user',
        username: 'robin',
        email: 'robin@example.test',
        role: 'admin',
        token: 'avatar-token',
        avatar,
        preferences: {
          theme: {
            mode: 'light',
            adaptToAccent: false,
            accent: 'custom',
            customAccent: '#ff7b52',
          },
        },
      },
    ],
    workTasks: [
      task(
        'avatar-workspace',
        'Avatar workspace',
        'The workspace identities now match Chat.'
      ),
    ],
  });
  await page.addInitScript(() => {
    localStorage.setItem('auth-token', 'avatar-token');
  });

  await page.goto('/work/avatar-workspace');

  const userAvatar = page.getByTestId('work-user-avatar');
  await expect(userAvatar).toHaveCount(1);
  const userImage = userAvatar.getByRole('img', { name: 'robin' });
  await expect(userImage).toBeVisible();
  await expect(userImage).toHaveAttribute('src', avatar);
  await expect
    .poll(() =>
      userImage.evaluate(image => (image as HTMLImageElement).naturalWidth)
    )
    .toBeGreaterThan(0);

  const assistantAvatar = page.getByTestId('work-assistant-avatar');
  await expect(assistantAvatar).toHaveCount(1);
  await expect(assistantAvatar).toHaveAttribute('aria-label', 'Libre WebUI');
  // The avatar is the drawn mark, not the wordmark; the accessible name above
  // is what carries the product name.
  await expect(assistantAvatar.locator('svg')).toHaveCount(1);

  const html = page.locator('html');
  await expect(html).not.toHaveClass(/dark/);
  await page.getByRole('button', { name: 'Switch to dark mode' }).click();
  await expect(html).toHaveClass(/dark/);
  await expect(userImage).toBeVisible();
  await expect(assistantAvatar).toBeVisible();
});

test('creates a persistent Work task without exposing network controls', async ({
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
  const landing = page.getByTestId('work-landing');
  await expect(landing).toBeVisible();
  await expect(page.getByTestId('work-landing-composer')).toHaveAttribute(
    'data-variant',
    'landing'
  );
  await expect(page.getByTestId('work-task-composer')).toHaveCount(0);
  await expect(page.getByTestId('work-workspace-note')).toContainText(
    'Each task keeps its own files and history.'
  );
  await expect(page.getByTestId('work-workspace-note')).toHaveAttribute(
    'role',
    'note'
  );
  await expect(
    page.getByText('Every task gets its own container and files.')
  ).toHaveCount(0);
  // rounded-[1.6rem] against the app's 15px root font.
  await expect(page.getByTestId('work-composer-surface')).toHaveCSS(
    'border-radius',
    '24px'
  );
  const modelTrigger = page.getByTestId('work-model-selector-trigger');
  await expect(modelTrigger).toBeVisible();
  await expect(modelTrigger).toHaveAttribute('aria-haspopup', 'dialog');
  // rounded-xl (0.75rem) against the app's 15px root font.
  await expect(modelTrigger).toHaveCSS('border-radius', '11.25px');
  const runtimeStatus = page.getByTestId('work-runtime-status');
  await expect(runtimeStatus).toContainText('Runtime ready');
  await expect(runtimeStatus).toHaveAttribute('title', /Docker ready/);
  await expect(runtimeStatus).toHaveCSS(
    'background-color',
    'rgb(52, 211, 153)'
  );
  await expect(page.getByText(/Docker \+ Ollama ready/)).toHaveCount(0);
  await expect(page.getByTestId('work-network-toggle')).toHaveCount(0);
  await expect(page.getByText(/Network (?:on|off)/)).toHaveCount(0);

  await page
    .getByTestId('work-composer-input')
    .fill('Build a calm city landing page');
  await page.getByTestId('work-submit-button').click();

  await expect(page).toHaveURL(/\/work\/work-task-1$/);
  await expect(page.getByTestId('work-landing')).toHaveCount(0);
  await expect(page.getByTestId('work-task-composer')).toHaveAttribute(
    'data-variant',
    'task'
  );
  await expect(
    page.getByText('The landing page is ready in the task workspace.')
  ).toBeVisible();
  expect(mock.workTaskCreateRequests).toEqual([
    {
      message: 'Build a calm city landing page',
      model: 'llama3.2:3b',
      providerType: 'ollama',
      networkEnabled: true,
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

test('hires a persona as a pinned agent with avatar and status blurb', async ({
  page,
}) => {
  const agentTask = {
    ...task(
      'agent-task-1',
      'Chief of Staff',
      'Inbox triage finished for today.'
    ),
    isAgent: true,
    personaId: 'persona-1',
    statusBlurb: 'Inbox at zero. 2 replies ready.',
  };
  const mock = await mockLibreWebUiApi(page, {
    personas: [
      {
        id: 'persona-1',
        name: 'Chief of Staff',
        description: 'Keeps the inbox at zero.',
        model: 'llama3.2:3b',
        parameters: { system_prompt: 'Track the inbox.' },
        user_id: 'mock-user',
        created_at: createdAt,
        updated_at: createdAt,
      },
    ],
    workTasks: [
      agentTask,
      task('adhoc-task-1', 'One-off refactor', 'The refactor is done.'),
    ],
    workRunResult: {
      assistantMessage: 'Reporting for duty.',
      files: [],
    },
  });

  await page.goto('/work');
  await expect(page.getByTestId('work-landing')).toBeVisible();

  // Hired agents sit in their own pinned group above ad-hoc tasks.
  await expect(
    page.getByRole('heading', { name: 'Agents', exact: true })
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Work tasks', exact: true })
  ).toBeVisible();
  const rows = page.getByTestId('sidebar-work-task-item');
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toHaveAttribute('data-agent', 'true');
  await expect(rows.first()).toContainText('Chief of Staff');
  await expect(page.getByTestId('sidebar-work-agent-avatar')).toBeVisible();
  await expect(page.getByTestId('sidebar-work-agent-blurb')).toHaveText(
    'Inbox at zero. 2 replies ready.'
  );
  await expect(rows.last()).not.toHaveAttribute('data-agent', 'true');

  // The landing view offers the persona picker; hiring one marks the
  // created task as an agent.
  const personaSelect = page.getByTestId('work-persona');
  await expect(personaSelect).toBeVisible();
  await personaSelect.selectOption('persona-1');
  await expect(
    page.getByText(
      'This task becomes a named agent: it keeps the persona, stays pinned in the sidebar, and reports a one-line status after each run.'
    )
  ).toBeVisible();

  await page.getByTestId('work-composer-input').fill('Clear my inbox');
  await page.getByTestId('work-submit-button').click();

  await expect(page).toHaveURL(/\/work\/work-task-3$/);
  expect(mock.workTaskCreateRequests).toEqual([
    {
      message: 'Clear my inbox',
      model: 'llama3.2:3b',
      providerType: 'ollama',
      networkEnabled: true,
      personaId: 'persona-1',
      isAgent: true,
    },
  ]);
  // The new hire joins the pinned agent group immediately.
  await expect(page.getByTestId('sidebar-work-task-item')).toHaveCount(3);
  await expect(
    page.locator('[data-testid="sidebar-work-task-item"][data-agent="true"]')
  ).toHaveCount(2);
});

test('shows a readable LTR model name without changing its identifier', async ({
  page,
}) => {
  const modelName = 'hf.co/prism-ml/Ternary-Bonsai-27B';
  await mockLibreWebUiApi(page, {
    models: [
      {
        name: modelName,
        size: 0,
        digest: 'ternary-bonsai-e2e',
        modified_at: new Date(createdAt).toISOString(),
        details: {
          format: 'gguf',
          family: 'ternary',
          families: ['ternary'],
          parameter_size: '27B',
          quantization_level: 'Q4_K_M',
        },
      },
    ],
  });

  await page.goto('/work');

  const selector = page.getByTestId('work-model-select');
  await expect(selector).toHaveAttribute('dir', 'ltr');
  await expect(selector).toHaveValue(
    'ollama:hf.co%2Fprism-ml%2FTernary-Bonsai-27B'
  );
  await expect(selector.locator('option')).toHaveText(['Ternary Bonsai 27B']);

  const trigger = page.getByTestId('work-model-selector-trigger');
  await expect(trigger).toContainText('Ternary Bonsai 27B');
  await expect(trigger).toHaveAttribute('title', modelName);
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await trigger.click();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  await expect(
    page.getByRole('dialog', { name: 'Select a model' })
  ).toBeVisible();
  const modelOption = page.locator(
    '[data-testid="model-selector-option"][data-model-value="ollama:hf.co%2Fprism-ml%2FTernary-Bonsai-27B"]'
  );
  await expect(modelOption).toContainText('Ternary Bonsai 27B');
  await expect(modelOption).toHaveAttribute('aria-pressed', 'true');
  await modelOption.press('Enter');
  await expect(
    page.getByRole('dialog', { name: 'Select a model' })
  ).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test('shows the complete live Ollama catalogue in the shared selector', async ({
  page,
}) => {
  const libraryModels = Array.from({ length: 75 }, (_, index) => ({
    name: `catalogue-model-${index + 1}`,
    description: `Ollama catalogue model ${index + 1}`,
    category:
      index % 3 === 0 ? 'general' : index % 3 === 1 ? 'coding' : 'reasoning',
    sizes: ['7b'],
    pulls: `${index + 1}K`,
    tags: ['tools'],
  }));
  await mockLibreWebUiApi(page, { libraryModels });

  await page.goto('/work');
  await page.getByTestId('work-model-selector-trigger').click();
  await page.getByRole('button', { name: 'Ollama' }).click();

  await expect(
    page.getByText('catalogue-model-75', { exact: true })
  ).toHaveCount(1);
  await expect(
    page.getByRole('button', { name: 'General', exact: true })
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Coding', exact: true })
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Reasoning', exact: true })
  ).toBeVisible();
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
      runtimeAvailable: true,
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

  await expect(page.getByTestId('work-runtime-status')).toContainText(
    'Runtime ready'
  );
  await expect(
    page.getByTestId('work-provider-disclosure-popover')
  ).toHaveCount(0);
  const selector = page.getByTestId('work-model-select');
  await expect(selector.locator('option')).toHaveText([
    'llama3.2:3b',
    'glm5.2:cloud',
    'gpt-5.4',
    'gpt-5.4',
  ]);
  const optionValues = await selector
    .locator('option')
    .evaluateAll(options =>
      options.map(option => (option as HTMLOptionElement).value)
    );
  expect(new Set(optionValues).size).toBe(optionValues.length);

  const selectorTrigger = page.getByTestId('work-model-selector-trigger');
  await selectorTrigger.click();
  const pluginOption = page.locator(
    '[data-testid="model-selector-option"][data-model-value="plugin:openai:gpt-5.4"]'
  );
  await expect(pluginOption).toHaveCount(1);
  await expect(pluginOption).toContainText('via OpenAI GPT');
  await pluginOption.click();
  await expect(selector).toHaveValue('plugin:openai:gpt-5.4');
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
  await expect(selectorTrigger).toBeFocused();
  expect(mock.preferenceUpdateRequests).toEqual([
    {
      workRemoteProviderDisclosureDismissed: true,
    },
  ]);

  await page.reload();
  await expect(page.getByTestId('work-runtime-status')).toContainText(
    'Runtime ready'
  );
  await page.getByTestId('work-model-selector-trigger').click();
  await page
    .locator(
      '[data-testid="model-selector-option"][data-model-value="plugin:openai:gpt-5.4"]'
    )
    .click();
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
      networkEnabled: true,
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
    await page.getByRole('button', { name: 'Sign In', exact: true }).click();
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
      runtimeAvailable: true,
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

  await expect(page.getByTestId('work-runtime-status')).toContainText(
    'Runtime ready'
  );
  await expect(page.getByTestId('work-model-select')).toHaveValue(
    'plugin:cloud-only:remote-tools-model'
  );
  await expect(
    page
      .getByTestId('work-model-select')
      .locator('option', { hasText: 'remote-tools-model' })
  ).toHaveCount(1);
  await expect(page.getByTestId('work-model-selector-trigger')).toContainText(
    'remote-tools-model'
  );
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

test('keeps task positions stable and uses the requested status palette', async ({
  page,
}) => {
  const statuses = [
    {
      raw: 'idle' as const,
      label: 'Idle',
      color: 'rgb(255, 255, 255)',
    },
    {
      raw: 'preparing' as const,
      label: 'Thinking',
      color: 'rgb(48, 121, 255)',
    },
    {
      raw: 'running' as const,
      label: 'Thinking',
      color: 'rgb(48, 121, 255)',
    },
    {
      raw: 'completed' as const,
      label: 'Complete',
      color: 'rgb(76, 212, 117)',
    },
    {
      raw: 'cancelled' as const,
      label: 'Needs input',
      color: 'rgb(255, 204, 0)',
    },
    {
      raw: 'failed' as const,
      label: 'Error',
      color: 'rgb(255, 61, 129)',
    },
  ];
  const statusTasks = statuses.map(status => ({
    ...task(
      `status-${status.raw}`,
      `${status.label} task`,
      `${status.label} response`
    ),
    status: status.raw,
  }));
  await mockLibreWebUiApi(page, {
    workTasks: statusTasks,
  });

  await page.goto('/work/status-idle');

  const list = page.getByTestId('sidebar-work-task-list');
  const taskIds = async () =>
    list
      .getByTestId('sidebar-work-task-item')
      .evaluateAll(items =>
        items.map(item => item.getAttribute('data-task-id'))
      );
  await expect(list.getByTestId('sidebar-work-task-item')).toHaveCount(
    statuses.length
  );
  const initialOrder = await taskIds();

  for (const expected of statuses) {
    const row = list.locator(
      `[data-testid="sidebar-work-task-item"][data-task-id="status-${expected.raw}"]`
    );
    const sidebarIndicator = row.getByTestId('sidebar-work-task-status');
    await expect(sidebarIndicator).toHaveCSS(
      'background-color',
      expected.color
    );
    await expect(sidebarIndicator).toHaveAttribute(
      'data-status-label',
      expected.label
    );

    await row.click();
    await expect(page).toHaveURL(new RegExp(`/work/status-${expected.raw}$`));
    await expect(page.getByTestId('work-status')).toContainText(expected.label);
    await expect(page.getByTestId('work-status-indicator')).toHaveCSS(
      'background-color',
      expected.color
    );
    expect(await taskIds()).toEqual(initialOrder);
  }
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
  await inactiveRow.getByTestId('sidebar-work-task-actions').click();
  await page.getByTestId('sidebar-work-task-delete').click();

  await expect(inactiveRow).toHaveCount(0);
  expect(mock.workTaskDeleteRequests).toEqual(['inactive-workspace']);
  await page.waitForTimeout(1_300);
  await expect(inactiveRow).toHaveCount(0);
});

test('deletes the selected sidebar task directly without a second dirty prompt', async ({
  page,
}) => {
  const selectedTask = task(
    'selected-delete-workspace',
    'Delete this workspace',
    'The editable file is ready.'
  );
  const mock = await mockLibreWebUiApi(page, {
    workTasks: [selectedTask],
    workFiles: {
      'selected-delete-workspace': [
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
      'selected-delete-workspace:draft.txt': 'saved',
    },
  });

  await page.goto('/work/selected-delete-workspace');
  await page
    .getByTestId('work-file-item')
    .filter({ hasText: 'draft.txt' })
    .click();
  await page.getByTestId('work-file-editor').fill('unsaved');

  const selectedRow = page.locator(
    '[data-testid="sidebar-work-task-item"][data-task-id="selected-delete-workspace"]'
  );
  await selectedRow.hover();
  await selectedRow.getByTestId('sidebar-work-task-actions').click();
  const deleteButton = page.getByTestId('sidebar-work-task-delete');
  await expect(deleteButton).toBeVisible();

  const dialogs: string[] = [];
  page.on('dialog', dialog => {
    dialogs.push(dialog.message());
    void dialog.accept();
  });
  await deleteButton.click();

  await expect(page).toHaveURL(/\/work$/);
  await expect(
    page.getByRole('heading', { name: 'Start a new Work task' })
  ).toBeVisible();
  expect(dialogs).toHaveLength(1);
  expect(dialogs[0]).toContain(
    'Delete “Delete this workspace” and its workspace permanently?'
  );
  expect(mock.workTaskDeleteRequests).toEqual(['selected-delete-workspace']);
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

test('renders live reasoning, tokens, skills, and tool activity from the Work event stream', async ({
  page,
}) => {
  const liveTask = {
    ...task(
      'live-stream-workspace',
      'Live workspace',
      'An earlier result remains in history.'
    ),
    status: 'running' as const,
    messages: [
      ...task(
        'live-stream-workspace',
        'Live workspace',
        'An earlier result remains in history.'
      ).messages,
      {
        id: 'persisted-provider-reasoning',
        taskId: 'live-stream-workspace',
        runId: 'earlier-run',
        role: 'assistant' as const,
        kind: 'reasoning' as const,
        content: 'Persisted provider reasoning.',
        createdAt: createdAt + 2,
      },
      {
        id: 'persisted-live-tool-call',
        taskId: 'live-stream-workspace',
        runId: 'live-stream-run',
        role: 'assistant' as const,
        kind: 'tool_call' as const,
        content: 'Calling read_file',
        metadata: {
          name: 'read_file',
          toolCallId: 'call-read',
          path: 'package.json',
        },
        createdAt: createdAt + 3,
      },
      {
        id: 'persisted-live-tool-result',
        taskId: 'live-stream-workspace',
        runId: 'live-stream-run',
        role: 'tool' as const,
        kind: 'tool_result' as const,
        content: '{"name":"calm-city"}',
        metadata: {
          name: 'read_file',
          toolCallId: 'call-read',
        },
        createdAt: createdAt + 4,
      },
    ],
    activeRun: {
      id: 'live-stream-run',
      taskId: 'live-stream-workspace',
      model: 'llama3.2:3b',
      providerType: 'ollama' as const,
      status: 'running' as const,
      createdAt,
      startedAt: createdAt,
    },
  };
  await mockLibreWebUiApi(page, {
    workTasks: [liveTask],
  });

  await page.route(
    '**/api/work/tasks/live-stream-workspace/runs/live-stream-run/events?**',
    async route => {
      const after = Number(
        new URL(route.request().url()).searchParams.get('after')
      );
      const events = [
        {
          id: 1,
          type: 'run_state',
          taskId: liveTask.id,
          runId: 'live-stream-run',
          timestamp: createdAt + 10,
          data: {
            status: 'running',
            phase: 'thinking',
            round: 1,
            roundLimit: 48,
          },
        },
        {
          id: 2,
          type: 'skill_loaded',
          taskId: liveTask.id,
          runId: 'live-stream-run',
          timestamp: createdAt + 11,
          data: {
            id: 'web-app',
            name: 'Web app workflow',
            description:
              'Inspect, implement, and verify a browser application.',
          },
        },
        {
          id: 3,
          type: 'reasoning_delta',
          taskId: liveTask.id,
          runId: 'live-stream-run',
          timestamp: createdAt + 12,
          data: {
            delta: 'I will inspect the project structure.',
            total: 'I will inspect the project structure.',
          },
        },
        {
          id: 4,
          type: 'tool_call',
          taskId: liveTask.id,
          runId: 'live-stream-run',
          timestamp: createdAt + 13,
          data: {
            toolCallId: 'call-read',
            name: 'read_file',
            arguments: { path: 'package.json' },
          },
        },
        {
          id: 5,
          type: 'tool_result',
          taskId: liveTask.id,
          runId: 'live-stream-run',
          timestamp: createdAt + 14,
          data: {
            toolCallId: 'call-read',
            name: 'read_file',
            content: '{"name":"calm-city"}',
          },
        },
        {
          id: 6,
          type: 'assistant_delta',
          taskId: liveTask.id,
          runId: 'live-stream-run',
          timestamp: createdAt + 15,
          data: {
            delta: 'I am building the calm city now.',
            total: 'I am building the calm city now.',
          },
        },
      ];
      const snapshot = {
        id: Math.max(0, after),
        type: 'snapshot',
        taskId: liveTask.id,
        runId: 'live-stream-run',
        timestamp: createdAt + 9,
        data: {
          task: {
            ...liveTask,
            messages: liveTask.messages.map((message, messageIndex) => ({
              ...message,
              messageIndex,
            })),
            hasMoreMessages: false,
          },
        },
      };
      const body = [snapshot, ...events.filter(event => event.id > after)]
        .map(
          event =>
            `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(
              event
            )}\n\n`
        )
        .join('');
      await route.fulfill({
        status: 200,
        headers: {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
        },
        body,
      });
    }
  );

  await page.goto('/work/live-stream-workspace');

  const liveRun = page.getByTestId('work-live-run').first();
  await expect(liveRun).toBeVisible();
  const liveRunMessage = page.getByTestId('work-live-run-message');
  // The avatar is the drawn mark, not text; its accessible name carries the
  // product name, as asserted for the conversation avatar above.
  await expect(
    liveRunMessage.getByTestId('work-assistant-avatar')
  ).toHaveAttribute('aria-label', 'Libre WebUI');
  await expect(liveRun).toContainText('1/48');
  await expect(liveRun).toContainText('Workspace skills · 1');
  await expect(liveRun).not.toContainText('Web app workflow');
  await expect(liveRun).toContainText('I am building the calm city now.');
  await expect(liveRun).toContainText(/Generated tokens:\s*≈\d+/);

  const timelineEntries = liveRun
    .getByTestId('work-live-timeline')
    .locator('> *');
  await expect(timelineEntries.nth(0)).toHaveAttribute(
    'data-testid',
    'work-live-reasoning'
  );
  await expect(timelineEntries.nth(1)).toHaveAttribute(
    'data-testid',
    'work-live-tool'
  );
  await expect(timelineEntries.nth(2)).toContainText(
    'I am building the calm city now.'
  );

  const liveReasoning = liveRun.getByTestId('work-live-reasoning');
  await expect(liveReasoning).not.toHaveAttribute('open');
  await liveReasoning.locator('summary').click();
  await expect(liveReasoning).toContainText(
    'I will inspect the project structure.'
  );

  const liveTool = liveRun.getByTestId('work-live-tool');
  await expect(liveTool).toContainText('read_file');
  await liveTool.getByRole('button').click();
  await expect(liveTool).toContainText('package.json');
  await expect(liveTool).toContainText('calm-city');

  const activityTab = page.getByTestId('work-activity-tab');
  await expect(activityTab).toContainText('1');
  await activityTab.click();
  const activityPanel = page.locator('#work-workspace-panel-activity');
  await expect(
    activityPanel.getByText('read_file', { exact: true })
  ).toHaveCount(1);

  const persistedReasoning = page.getByTestId('work-provider-reasoning');
  await expect(persistedReasoning).not.toHaveAttribute('open');
  await persistedReasoning.locator('summary').click();
  await expect(persistedReasoning).toContainText(
    'Persisted provider reasoning.'
  );
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
  const previewToolbar = page.getByTestId('work-workspace-toolbar');
  const startPreviewButton = previewToolbar.getByTestId(
    'work-start-preview-button'
  );
  await expect(
    previewToolbar.getByRole('textbox', { name: 'Optional start command' })
  ).toBeVisible();
  const accent600 = await page.evaluate(
    () =>
      `rgb(${getComputedStyle(document.documentElement)
        .getPropertyValue('--color-primary-600')
        .trim()
        .split(/\s+/)
        .join(', ')})`
  );
  await expect(startPreviewButton).toHaveCSS('background-color', accent600);
  await expect(startPreviewButton).toHaveCSS('color', 'rgb(255, 255, 255)');
  await startPreviewButton.click();
  const frame = page.getByTestId('work-preview-frame');
  await expect(frame).toHaveAttribute(
    'src',
    `http://127.0.0.1:3001/api/work/previews/preview-workspace/49173.${'N'.repeat(22)}.${'S'.repeat(43)}/`
  );
  await expect(frame).toHaveAttribute(
    'sandbox',
    'allow-scripts allow-forms allow-modals allow-downloads allow-pointer-lock'
  );
  await expect(frame).not.toHaveAttribute('sandbox', /allow-same-origin/);
  await expect(frame).not.toHaveAttribute('sandbox', /allow-popups/);
  await expect(frame).toHaveAttribute('referrerpolicy', 'no-referrer');
  await expect(
    page
      .frameLocator('[data-testid="work-preview-frame"]')
      .getByTestId('mock-work-preview')
  ).toHaveText('Isolated Work preview');
  await expect(
    page
      .frameLocator('[data-testid="work-preview-frame"]')
      .getByTestId('mock-work-preview')
  ).toHaveAttribute('data-module-loaded', 'true');
  expect(new URL((await frame.getAttribute('src')) || '').origin).not.toBe(
    new URL(page.url()).origin
  );

  await previewToolbar.getByTestId('work-stop-preview-button').press('Enter');
  await expect(frame).toHaveCount(0);
  expect(mock.workPreviewRequests).toEqual([
    { taskId: 'preview-workspace', action: 'start', command: undefined },
    { taskId: 'preview-workspace', action: 'stop' },
  ]);
});

test('resizes the Work conversation and workspace with pointer and keyboard controls', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const splitTask = task(
    'resizable-workspace',
    'Resizable workspace',
    'Drag the divider to make room.'
  );
  await mockLibreWebUiApi(page, {
    workTasks: [splitTask],
  });

  await page.goto('/work/resizable-workspace');

  const splitPane = page.getByTestId('work-split-pane');
  const conversation = page.getByTestId('work-conversation-panel');
  const workspace = page.getByTestId('work-workspace-panel');
  const resizer = page.getByTestId('work-split-resizer');
  await expect(resizer).toBeVisible();
  await expect(resizer).toHaveAttribute('role', 'separator');
  await expect(resizer).toHaveAttribute('aria-orientation', 'vertical');
  await expect(resizer).toHaveAttribute('aria-valuenow', '45');

  await resizer.focus();
  await resizer.press('ArrowRight');
  await expect(resizer).toHaveAttribute('aria-valuenow', '47');
  await resizer.press('Enter');
  await expect(resizer).toHaveAttribute('aria-valuenow', '45');

  const beforeConversation = await conversation.boundingBox();
  const beforeWorkspace = await workspace.boundingBox();
  const handle = await resizer.boundingBox();
  expect(beforeConversation).not.toBeNull();
  expect(beforeWorkspace).not.toBeNull();
  expect(handle).not.toBeNull();

  await page.mouse.move(
    (handle?.x ?? 0) + (handle?.width ?? 0) / 2,
    (handle?.y ?? 0) + (handle?.height ?? 0) / 2
  );
  await page.mouse.down();
  await expect(splitPane).toHaveAttribute('data-resizing', 'true');
  await expect(page.getByTestId('work-split-drag-shield')).toBeVisible();
  await page.mouse.move(
    (handle?.x ?? 0) + (handle?.width ?? 0) / 2 + 100,
    (handle?.y ?? 0) + (handle?.height ?? 0) / 2,
    { steps: 5 }
  );
  await page.mouse.up();
  await expect(splitPane).toHaveAttribute('data-resizing', 'false');

  const afterConversation = await conversation.boundingBox();
  const afterWorkspace = await workspace.boundingBox();
  expect(
    (afterConversation?.width ?? 0) - (beforeConversation?.width ?? 0)
  ).toBeGreaterThan(70);
  expect(
    (beforeWorkspace?.width ?? 0) - (afterWorkspace?.width ?? 0)
  ).toBeGreaterThan(70);
  const persistedPercent = await resizer.getAttribute('aria-valuenow');
  expect(Number(persistedPercent)).toBeGreaterThan(45);

  await page.reload();
  await expect(page.getByTestId('work-split-resizer')).toHaveAttribute(
    'aria-valuenow',
    persistedPercent || ''
  );
});

test('mirrors the translated Work workspace and resize controls in Arabic', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const rtlTask = task(
    'rtl-workspace',
    'مساحة عمل عربية',
    'اكتملت المهمة داخل مساحة العمل.'
  );
  await mockLibreWebUiApi(page, {
    workTasks: [rtlTask],
    workFiles: {
      'rtl-workspace': [
        {
          path: 'src/rtl.ts',
          name: 'rtl.ts',
          type: 'file',
          size: 24,
          modifiedAt: createdAt,
        },
      ],
    },
    workFileContents: {
      'rtl-workspace:src/rtl.ts': 'const direction = "ltr";\n',
    },
  });
  await page.addInitScript(() => {
    localStorage.setItem('i18nextLng', 'ar');
  });

  await page.goto('/work/rtl-workspace');

  await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByTestId('work-task-title')).toHaveAttribute(
    'dir',
    'auto'
  );
  await expect(page.getByTestId('work-status')).toContainText('مكتمل');
  await expect(page.getByTestId('work-composer-input')).toHaveAttribute(
    'placeholder',
    'صِف ما تريد بناءه أو تغييره…'
  );
  await expect(page.getByTestId('work-composer-input')).toHaveAttribute(
    'dir',
    'auto'
  );
  await expect(page.getByTestId('work-model-select')).toHaveAttribute(
    'dir',
    'ltr'
  );
  await expect(page.getByTestId('work-model-select')).toHaveCSS(
    'direction',
    'ltr'
  );
  await expect(
    page.getByTestId('work-model-selector-trigger')
  ).toHaveAccessibleName('نموذج العمل: llama3.2:3b');
  await expect(page.getByTestId('work-model-select')).toHaveAttribute(
    'aria-hidden',
    'true'
  );
  await expect(page.getByTestId('sidebar-work-button')).toHaveAccessibleName(
    'العمل'
  );

  const conversation = page.getByTestId('work-conversation-panel');
  const workspace = page.getByTestId('work-workspace-panel');
  const resizer = page.getByTestId('work-split-resizer');
  await expect(resizer).toHaveAttribute(
    'aria-label',
    'تغيير حجم المحادثة ومساحة العمل'
  );
  await expect(resizer).toHaveAttribute(
    'aria-valuetext',
    'المحادثة 45٪، مساحة العمل 55٪'
  );

  const conversationBox = await conversation.boundingBox();
  const workspaceBox = await workspace.boundingBox();
  expect(conversationBox).not.toBeNull();
  expect(workspaceBox).not.toBeNull();
  expect(conversationBox!.x).toBeGreaterThan(workspaceBox!.x);

  await resizer.focus();
  await resizer.press('ArrowLeft');
  await expect(resizer).toHaveAttribute('aria-valuenow', '47');
  await resizer.press('ArrowRight');
  await expect(resizer).toHaveAttribute('aria-valuenow', '45');

  const beforeConversation = await conversation.boundingBox();
  const handle = await resizer.boundingBox();
  expect(beforeConversation).not.toBeNull();
  expect(handle).not.toBeNull();

  await page.mouse.move(
    handle!.x + handle!.width / 2,
    handle!.y + handle!.height / 2
  );
  await page.mouse.down();
  await page.mouse.move(
    handle!.x + handle!.width / 2 - 100,
    handle!.y + handle!.height / 2,
    { steps: 5 }
  );
  await page.mouse.up();

  const afterConversation = await conversation.boundingBox();
  expect(afterConversation).not.toBeNull();
  expect(afterConversation!.width - beforeConversation!.width).toBeGreaterThan(
    70
  );

  const filesTab = page.getByTestId('work-files-tab');
  const activityTab = page.getByTestId('work-activity-tab');
  const previewTab = page.getByTestId('work-preview-tab');
  await expect(filesTab).toHaveAttribute(
    'aria-controls',
    'work-workspace-panel-files'
  );
  await expect(activityTab).not.toHaveAttribute('aria-controls');
  await page.getByTestId('work-file-item').click();
  await expect(page.getByTestId('work-file-editor')).toHaveCSS(
    'direction',
    'ltr'
  );
  await filesTab.focus();
  await filesTab.press('ArrowLeft');
  await expect(activityTab).toBeFocused();
  await expect(activityTab).toHaveAttribute(
    'aria-controls',
    'work-workspace-panel-activity'
  );
  await expect(filesTab).not.toHaveAttribute('aria-controls');

  await previewTab.click();
  await expect(
    page.getByRole('textbox', { name: 'أمر تشغيل اختياري' })
  ).toHaveAttribute('dir', 'auto');

  await page.goto('/work/missing');
  await expect(
    page.getByRole('heading', { name: 'مهمة العمل هذه غير متاحة' })
  ).toBeVisible();
  const newTaskButton = page.getByRole('button', {
    name: 'بدء مهمة جديدة',
  });
  await expect(newTaskButton.locator('svg')).toHaveCSS(
    'transform',
    'matrix(-1, 0, 0, -1, 0, 0)'
  );
});

test('formats and highlights workspace code in dark and light mode', async ({
  page,
}) => {
  const rawCard = 'export function Card(){return <article>Calm</article>}';
  const codeTask = task(
    'code-workspace',
    'Code workspace',
    '```tsx\nexport function Card(){return <article>Calm</article>}\n```'
  );
  const mock = await mockLibreWebUiApi(page, {
    workTasks: [codeTask],
    workFiles: {
      'code-workspace': [
        {
          path: 'src/Card.tsx',
          name: 'Card.tsx',
          type: 'file',
          size: 59,
          modifiedAt: createdAt,
        },
      ],
    },
    workFileContents: {
      'code-workspace:src/Card.tsx': rawCard,
    },
  });

  await page.goto('/work/code-workspace');
  await page
    .getByTestId('work-file-item')
    .filter({ hasText: 'Card.tsx' })
    .click();

  const editor = page.getByTestId('work-file-editor');
  const editorShell = editor.locator('xpath=..');
  const highlight = page.getByTestId('work-file-highlight');
  const workspaceToolbar = page.getByTestId('work-workspace-toolbar');

  await expect(editor).toHaveAttribute('data-language', 'tsx');
  await expect(editorShell).toHaveAttribute('data-highlighted', 'true');
  await expect(highlight).toBeVisible();
  await expect.poll(() => highlight.locator('span').count()).toBeGreaterThan(2);
  await expect(
    workspaceToolbar.getByTestId('work-format-file-button')
  ).toBeVisible();
  await expect(
    workspaceToolbar.getByTestId('work-save-file-button')
  ).toBeVisible();
  await expect(page.getByTestId('work-files-tab')).toHaveAttribute(
    'aria-selected',
    'true'
  );
  await page.getByTestId('work-files-tab').focus();
  await page.getByTestId('work-files-tab').press('ArrowRight');
  await expect(page.getByTestId('work-activity-tab')).toHaveAttribute(
    'aria-selected',
    'true'
  );
  await page.getByTestId('work-activity-tab').press('End');
  await expect(page.getByTestId('work-preview-tab')).toHaveAttribute(
    'aria-selected',
    'true'
  );
  await page.getByTestId('work-preview-tab').press('Home');
  await expect(page.getByTestId('work-files-tab')).toHaveAttribute(
    'aria-selected',
    'true'
  );

  const scrollSource = Array.from(
    { length: 40 },
    (_, index) =>
      `export const value${index} = "${'workspace-scroll-check-'.repeat(5)}";`
  ).join('\n');
  await editor.fill(scrollSource);
  await expect(editorShell).toHaveAttribute('data-highlighted', 'true');
  const scrollPosition = await editor.evaluate(element => {
    element.scrollTop = 180;
    element.scrollLeft = 90;
    element.dispatchEvent(new Event('scroll', { bubbles: true }));
    return { left: element.scrollLeft, top: element.scrollTop };
  });
  expect(scrollPosition.left).toBeGreaterThan(0);
  expect(scrollPosition.top).toBeGreaterThan(0);
  await expect
    .poll(() =>
      page
        .getByTestId('work-file-highlight-content')
        .evaluate(element => element.style.transform)
    )
    .toBe(
      `translate3d(${-scrollPosition.left}px, ${-scrollPosition.top}px, 0px)`
    );
  await editor.fill(rawCard);
  await expect(editorShell).toHaveAttribute('data-highlighted', 'true');

  const editorToken = highlight
    .locator('span')
    .filter({ hasText: 'export' })
    .first();
  const darkTokenColor = await editorToken.evaluate(
    element => getComputedStyle(element).color
  );
  const darkCodeBackground = await page
    .getByTestId('code-block')
    .evaluate(element => getComputedStyle(element).backgroundColor);

  await page.getByRole('button', { name: 'Switch to light mode' }).click();
  await expect(
    page.getByRole('button', { name: 'Switch to dark mode' })
  ).toBeVisible();

  const lightTokenColor = await editorToken.evaluate(
    element => getComputedStyle(element).color
  );
  const lightCodeBackground = await page
    .getByTestId('code-block')
    .evaluate(element => getComputedStyle(element).backgroundColor);
  expect(lightTokenColor).not.toBe(darkTokenColor);
  expect(lightCodeBackground).not.toBe(darkCodeBackground);

  await page.getByTestId('work-format-file-button').click();
  await expect(editor).toHaveValue(
    'export function Card() {\n  return <article>Calm</article>;\n}\n'
  );
  const accent600 = await page.evaluate(
    () =>
      `rgb(${getComputedStyle(document.documentElement)
        .getPropertyValue('--color-primary-600')
        .trim()
        .split(/\s+/)
        .join(', ')})`
  );
  await expect(page.getByTestId('work-save-file-button')).toHaveCSS(
    'background-color',
    accent600
  );
  await expect(page.getByTestId('work-save-file-button')).toHaveCSS(
    'color',
    'rgb(255, 255, 255)'
  );
  await editor.press('Control+s');
  await expect
    .poll(() => mock.workFileUpdateRequests)
    .toEqual([
      {
        taskId: 'code-workspace',
        path: 'src/Card.tsx',
        content:
          'export function Card() {\n  return <article>Calm</article>;\n}\n',
        expectedUpdatedAt: createdAt,
      },
    ]);
});

test('keeps unsupported and large workspace files readable when highlighting falls back', async ({
  page,
}) => {
  const largeSource = `export const payload = "${'x'.repeat(20_100)}";`;
  const fallbackTask = task(
    'fallback-workspace',
    'Fallback workspace',
    'Fallback files are ready.'
  );
  await mockLibreWebUiApi(page, {
    workTasks: [fallbackTask],
    workFiles: {
      'fallback-workspace': [
        {
          path: 'notes.txt',
          name: 'notes.txt',
          type: 'file',
          size: 18,
          modifiedAt: createdAt,
        },
        {
          path: 'src/Large.ts',
          name: 'Large.ts',
          type: 'file',
          size: largeSource.length,
          modifiedAt: createdAt,
        },
        {
          path: 'broken.json',
          name: 'broken.json',
          type: 'file',
          size: 11,
          modifiedAt: createdAt,
        },
      ],
    },
    workFileContents: {
      'fallback-workspace:notes.txt': 'Readable plain text',
      'fallback-workspace:src/Large.ts': largeSource,
      'fallback-workspace:broken.json': '{"missing":}',
    },
  });

  await page.goto('/work/fallback-workspace');
  const editor = page.getByTestId('work-file-editor');
  const editorShell = editor.locator('xpath=..');
  const formatButton = page.getByTestId('work-format-file-button');

  await page
    .getByTestId('work-file-item')
    .filter({ hasText: 'notes.txt' })
    .click();
  await expect(editor).toHaveValue('Readable plain text');
  await expect(editorShell).toHaveAttribute('data-highlighted', 'false');
  await expect(page.getByTestId('work-file-highlight')).toHaveCount(0);
  expect(
    await editor.evaluate(
      element => getComputedStyle(element).webkitTextFillColor
    )
  ).not.toBe('rgba(0, 0, 0, 0)');
  await expect(formatButton).toBeDisabled();

  await page
    .getByTestId('work-file-item')
    .filter({ hasText: 'Large.ts' })
    .click();
  await expect(editor).toHaveValue(largeSource);
  await expect(editorShell).toHaveAttribute('data-highlighted', 'false');
  await expect(page.getByText('Plain text · large file')).toBeVisible();
  await expect(page.getByTestId('work-file-highlight')).toHaveCount(0);
  expect(
    await editor.evaluate(
      element => getComputedStyle(element).webkitTextFillColor
    )
  ).not.toBe('rgba(0, 0, 0, 0)');

  await page
    .getByTestId('work-file-item')
    .filter({ hasText: 'broken.json' })
    .click();
  await expect(formatButton).toBeEnabled();
  await formatButton.click();
  await expect(page.getByText(/Could not format.*broken\.json/i)).toBeVisible();
  await expect(editor).toBeEnabled();
  await expect(formatButton).toBeEnabled();
  await expect(editor).toHaveValue('{"missing":}');
});

test('keeps the current workspace draft editable when saving fails', async ({
  page,
}) => {
  const failureTask = task(
    'save-failure',
    'Save failure',
    'The editable file is ready.'
  );
  await mockLibreWebUiApi(page, {
    workTasks: [failureTask],
    workFileUpdateFailure: 'Current save failed.',
    workFiles: {
      'save-failure': [
        {
          path: 'src/value.ts',
          name: 'value.ts',
          type: 'file',
          size: 23,
          modifiedAt: createdAt,
        },
      ],
    },
    workFileContents: {
      'save-failure:src/value.ts': 'export const value = 1;',
    },
  });

  await page.goto('/work/save-failure');
  await page
    .getByTestId('work-file-item')
    .filter({ hasText: 'value.ts' })
    .click();
  const editor = page.getByTestId('work-file-editor');
  const saveButton = page.getByTestId('work-save-file-button');
  await editor.fill('export const value = 2;');

  const failedSaveResponsePromise = page.waitForResponse(
    response =>
      response.request().method() === 'PUT' &&
      response.url().includes('/work/tasks/save-failure/file')
  );
  await saveButton.click();
  expect((await failedSaveResponsePromise).status()).toBe(500);

  await expect(
    page.getByRole('status').filter({ hasText: 'Current save failed.' })
  ).toBeVisible();
  await expect(editor).toHaveValue('export const value = 2;');
  await expect(editor).toBeEnabled();
  await expect(saveButton).toBeEnabled();
  await expect(saveButton).not.toHaveAttribute('aria-busy', 'true');
});

test('ignores a file save that finishes after switching tasks', async ({
  page,
}) => {
  const firstTask = task(
    'delayed-save-a',
    'Delayed save A',
    'The first file is ready.'
  );
  const secondTask = task(
    'delayed-save-b',
    'Delayed save B',
    'The second file is ready.'
  );
  const mock = await mockLibreWebUiApi(page, {
    workTasks: [firstTask, secondTask],
    deferWorkFileUpdates: true,
    workFileUpdateFailure: 'Deferred save failed.',
    workFiles: {
      'delayed-save-a': [
        {
          path: 'first.ts',
          name: 'first.ts',
          type: 'file',
          size: 20,
          modifiedAt: createdAt,
        },
      ],
      'delayed-save-b': [
        {
          path: 'second.ts',
          name: 'second.ts',
          type: 'file',
          size: 21,
          modifiedAt: createdAt,
        },
      ],
    },
    workFileContents: {
      'delayed-save-a:first.ts': 'export const first=1',
      'delayed-save-b:second.ts': 'export const second=2',
    },
  });

  await page.goto('/work/delayed-save-a');
  await page
    .getByTestId('work-file-item')
    .filter({ hasText: 'first.ts' })
    .click();
  await page.getByTestId('work-file-editor').fill('export const first = 10;');
  await page.getByTestId('work-save-file-button').click();
  await expect.poll(() => mock.workFileUpdateRequests.length).toBe(1);

  const switchDialogPromise = page.waitForEvent('dialog');
  const switchTask = page
    .getByTestId('sidebar-work-task-item')
    .filter({ hasText: 'Delayed save B' })
    .click();
  const switchDialog = await switchDialogPromise;
  await switchDialog.accept();
  await switchTask;
  await expect(page).toHaveURL(/\/work\/delayed-save-b$/);

  await page
    .getByTestId('work-file-item')
    .filter({ hasText: 'second.ts' })
    .click();
  await page.getByTestId('work-file-editor').fill('export const second = 20;');

  const failedSaveResponsePromise = page.waitForResponse(
    response =>
      response.request().method() === 'PUT' &&
      response.url().includes('/work/tasks/delayed-save-a/file')
  );
  mock.releaseWorkFileUpdates();
  const failedSaveResponse = await failedSaveResponsePromise;
  expect(failedSaveResponse.status()).toBe(500);
  await page.evaluate(
    () =>
      new Promise<void>(resolve => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      })
  );
  await expect(page.getByTestId('work-save-file-button')).toBeEnabled();
  await expect(page.getByText('Deferred save failed.')).toHaveCount(0);
  await expect(page.getByText('File saved.')).toHaveCount(0);
  await expect(page.getByTestId('work-file-editor')).toHaveValue(
    'export const second = 20;'
  );

  const leaveDialogPromise = page.waitForEvent('dialog');
  const leaveAttempt = page.getByTestId('sidebar-chat-button').click();
  const leaveDialog = await leaveDialogPromise;
  expect(leaveDialog.message()).toContain(
    'Your unsaved edit will remain as a browser draft.'
  );
  await leaveDialog.dismiss();
  await leaveAttempt;
  await expect(page).toHaveURL(/\/work\/delayed-save-b$/);
});

test('preserves edits typed while the same workspace file is saving', async ({
  page,
}) => {
  const saveTask = task(
    'same-file-save',
    'Same file save',
    'The editable file is ready.'
  );
  const mock = await mockLibreWebUiApi(page, {
    workTasks: [saveTask],
    deferWorkFileUpdates: true,
    workFiles: {
      'same-file-save': [
        {
          path: 'src/value.ts',
          name: 'value.ts',
          type: 'file',
          size: 23,
          modifiedAt: createdAt,
        },
      ],
    },
    workFileContents: {
      'same-file-save:src/value.ts': 'export const value = 1;',
    },
  });

  await page.goto('/work/same-file-save');
  await page
    .getByTestId('work-file-item')
    .filter({ hasText: 'value.ts' })
    .click();
  const editor = page.getByTestId('work-file-editor');
  const saveButton = page.getByTestId('work-save-file-button');

  await editor.fill('export const value = 2;');
  await saveButton.click();
  await expect.poll(() => mock.workFileUpdateRequests.length).toBe(1);
  await editor.fill('export const value = 3;');

  mock.releaseWorkFileUpdates();
  await expect(saveButton).toBeEnabled();
  await expect(editor).toHaveValue('export const value = 3;');

  await saveButton.click();
  await expect.poll(() => mock.workFileUpdateRequests.length).toBe(2);
  expect(mock.workFileUpdateRequests[1]).toMatchObject({
    taskId: 'same-file-save',
    path: 'src/value.ts',
    content: 'export const value = 3;',
  });
  expect(mock.workFileUpdateRequests[1]?.expectedUpdatedAt).toBeGreaterThan(
    createdAt
  );
  mock.releaseWorkFileUpdates();
  await expect(saveButton).not.toHaveAttribute('aria-busy', 'true');
  await expect(saveButton).toBeDisabled();
  await expect(editor).toHaveValue('export const value = 3;');
});

test('keeps the compact task surface switch in the task header', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const compactTask = task(
    'compact-workspace',
    'Compact workspace',
    'The workspace is ready.'
  );
  await mockLibreWebUiApi(page, {
    workTasks: [compactTask],
    workFiles: {
      'compact-workspace': [
        {
          path: 'README.md',
          name: 'README.md',
          type: 'file',
          size: 7,
          modifiedAt: createdAt,
        },
      ],
    },
    workFileContents: {
      'compact-workspace:README.md': '# Ready',
    },
  });

  await page.goto('/work/compact-workspace');

  // The expanded mobile sidebar intentionally overlays the page until the
  // user collapses it. This test targets the task surface beneath that layer.
  await page.getByTestId('sidebar-toggle-size').click();

  const surfaceSwitch = page.getByRole('group', { name: 'Task surface' });
  await expect(surfaceSwitch).toBeVisible();
  await expect(page.getByTestId('work-split-resizer')).not.toBeVisible();
  await expect(
    page.getByTestId('work-model-selector-trigger-mobile')
  ).toBeVisible();
  await expect(
    page.getByTestId('work-model-selector-trigger')
  ).not.toBeVisible();
  await expect(page.getByTestId('work-compact-status')).toHaveAccessibleName(
    'Status: Complete'
  );
  expect(
    await surfaceSwitch.evaluate(element => element.parentElement?.tagName)
  ).toBe('HEADER');
  await expect(
    surfaceSwitch.getByRole('button', { name: 'Conversation' })
  ).toHaveAttribute('aria-pressed', 'true');

  await surfaceSwitch.getByRole('button', { name: 'Workspace' }).click();
  await expect(page.getByTestId('work-files-tab')).toBeVisible();
  await expect(
    surfaceSwitch.getByRole('button', { name: 'Workspace' })
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('work-composer-input')).not.toBeVisible();
  await page
    .getByTestId('work-file-item')
    .filter({ hasText: 'README.md' })
    .click();

  const workspaceToolbar = page.getByTestId('work-workspace-toolbar');
  await expect(
    workspaceToolbar.getByTestId('work-format-file-button')
  ).toBeVisible();
  await expect(
    workspaceToolbar.getByTestId('work-save-file-button')
  ).toBeVisible();
  const toolbarBox = await workspaceToolbar.boundingBox();
  expect(toolbarBox).not.toBeNull();
  expect(toolbarBox?.x).toBeGreaterThanOrEqual(0);
  expect((toolbarBox?.x ?? 0) + (toolbarBox?.width ?? 0)).toBeLessThanOrEqual(
    390
  );
  const filesToolbarMetrics = await workspaceToolbar.evaluate(element => {
    const toolbar = element.getBoundingClientRect();
    const childrenContained = [...element.children].every(child => {
      const bounds = child.getBoundingClientRect();
      return (
        bounds.left >= toolbar.left - 1 && bounds.right <= toolbar.right + 1
      );
    });
    return {
      childrenContained,
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    };
  });
  expect(filesToolbarMetrics.scrollWidth).toBeLessThanOrEqual(
    filesToolbarMetrics.clientWidth
  );
  expect(filesToolbarMetrics.childrenContained).toBe(true);

  await workspaceToolbar.getByTestId('work-preview-tab').click();
  await expect(
    workspaceToolbar.getByRole('textbox', { name: 'Optional start command' })
  ).toBeVisible();
  await expect(
    workspaceToolbar.getByTestId('work-start-preview-button')
  ).toBeVisible();
  const previewToolbarMetrics = await workspaceToolbar.evaluate(element => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  expect(previewToolbarMetrics.scrollWidth).toBeLessThanOrEqual(
    previewToolbarMetrics.clientWidth
  );

  const taskActionsButton = page.getByTestId('work-task-actions-button');
  await expect(taskActionsButton).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByTestId('work-delete-task-button')).toHaveCount(0);
  await taskActionsButton.click();
  await expect(taskActionsButton).toHaveAttribute('aria-expanded', 'true');
  const deleteTaskButton = page.getByTestId('work-delete-task-button');
  await expect(deleteTaskButton).toBeFocused();
  await deleteTaskButton.press('ArrowDown');
  await expect(deleteTaskButton).toBeFocused();
  await deleteTaskButton.press('Escape');
  await expect(taskActionsButton).toBeFocused();
  await expect(taskActionsButton).toHaveAttribute('aria-expanded', 'false');
  await expect(deleteTaskButton).toHaveCount(0);

  await taskActionsButton.press('ArrowDown');
  await expect(deleteTaskButton).toBeFocused();
  const deleteDialogPromise = page.waitForEvent('dialog');
  const deleteActivation = deleteTaskButton.press('Enter');
  const deleteDialog = await deleteDialogPromise;
  expect(deleteDialog.message()).toContain(
    'Delete “Compact workspace” and its workspace permanently?'
  );
  await deleteDialog.accept();
  await deleteActivation;
  await expect(page).toHaveURL(/\/work$/);
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
  await page.getByRole('button', { name: 'Sign In', exact: true }).click();
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
      runtimeAvailable: false,
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

  await expect(page.getByTestId('work-runtime-status')).toContainText(
    'Runtime unavailable'
  );
  await expect(page.getByTestId('work-runtime-status')).toHaveAttribute(
    'title',
    'Docker daemon unavailable'
  );
  await expect(page.getByText('Docker daemon unavailable')).toBeVisible();
  await expect(page.getByText('Docker daemon unavailable')).toHaveAttribute(
    'dir',
    'auto'
  );
  await expect(page.getByTestId('work-composer-input')).toBeDisabled();
  await expect(page.getByTestId('work-submit-button')).toBeDisabled();
});

test('the terminal tab opens a shell session and reports deployment limits', async ({
  page,
}) => {
  const terminalTask = task(
    'terminal-workspace',
    'Terminal workspace',
    'The workspace is ready.'
  );
  await mockLibreWebUiApi(page, { workTasks: [terminalTask] });

  const socketUrls: string[] = [];
  await page.exposeFunction('recordTerminalSocket', (url: string) => {
    socketUrls.push(url);
  });
  // The terminal talks to a WebSocket the mock API cannot serve; stub the
  // constructor so the tab's connect/ready path is still exercised end to end.
  await page.addInitScript(() => {
    type RealWebSocket = typeof window.WebSocket;
    class StubSocket extends EventTarget {
      static readonly OPEN = 1;
      readonly OPEN = 1;
      readyState = 1;
      binaryType = 'arraybuffer';
      onmessage: ((event: MessageEvent) => void) | null = null;
      onclose: (() => void) | null = null;
      onerror: (() => void) | null = null;
      sent: string[] = [];
      constructor(url: string) {
        super();
        (
          window as unknown as {
            recordTerminalSocket: (value: string) => void;
          }
        ).recordTerminalSocket(url);
        setTimeout(() => {
          this.onmessage?.(
            new MessageEvent('message', {
              data: JSON.stringify({ type: 'ready' }),
            })
          );
          const encoder = new TextEncoder();
          this.onmessage?.(
            new MessageEvent('message', {
              data: encoder.encode('libre@sandbox:/workspace$ ').buffer,
            })
          );
        }, 10);
      }
      send(payload: string) {
        this.sent.push(payload);
      }
      close() {
        this.readyState = 3;
        this.onclose?.();
      }
    }
    Object.defineProperty(window, 'WebSocket', {
      configurable: true,
      writable: true,
      value: StubSocket as unknown as RealWebSocket,
    });
  });

  await page.goto('/work/terminal-workspace');

  await page.getByTestId('work-terminal-tab').click();
  const panel = page.getByTestId('work-terminal-panel');
  await expect(panel).toHaveAttribute('data-status', 'connected');
  await expect(page.getByTestId('work-terminal-surface')).toBeVisible();
  await expect(panel).toContainText('libre@sandbox:/workspace$');

  // Exactly one terminal socket, scoped to this task.
  const terminalSockets = socketUrls.filter(url =>
    url.includes('/ws/work-terminal')
  );
  expect(terminalSockets).toHaveLength(1);
  const socketUrl = new URL(terminalSockets[0]);
  expect(socketUrl.pathname).toBe('/ws/work-terminal');
  expect(socketUrl.searchParams.get('taskId')).toBe('terminal-workspace');
  expect(socketUrl.searchParams.get('ticket')).toBe('e2e-websocket-ticket');
  expect(socketUrl.searchParams.has('token')).toBe(false);
  expect(socketUrl.protocol).toMatch(/^wss?:$/);
});

test('the terminal explains when a deployment cannot offer it', async ({
  page,
}) => {
  await mockLibreWebUiApi(page, {
    workTasks: [
      task('no-terminal-workspace', 'No terminal', 'The workspace is ready.'),
    ],
    workCapabilities: {
      available: true,
      runtime: 'docker',
      image: 'ghcr.io/libre-webui/work-runtime:0.1.0-e2e',
      runtimeAvailable: true,
      ollamaAvailable: true,
      runtimeImage: 'ghcr.io/libre-webui/work-runtime:0.1.0-e2e',
      limits: {
        maxRounds: 48,
        commandTimeoutMs: 120_000,
        maxOutputChars: 50_000,
      },
      terminal: {
        available: false,
        reason: 'The Work terminal needs the Docker Engine socket.',
        maxSessionsPerTask: 2,
        idleTimeoutMs: 900_000,
      },
    },
  });

  await page.goto('/work/no-terminal-workspace');
  await page.getByTestId('work-terminal-tab').click();

  await expect(page.getByTestId('work-terminal-panel')).toHaveAttribute(
    'data-status',
    'unavailable'
  );
  await expect(page.getByTestId('work-terminal-status')).toContainText(
    'needs the Docker Engine socket'
  );
  await expect(page.getByTestId('work-terminal-surface')).toHaveCount(0);
  await expect(page.getByTestId('work-terminal-reconnect-button')).toHaveCount(
    0
  );
});

test('manages local workspace Git without exposing remote credentials', async ({
  page,
}) => {
  const gitTask = task(
    'git-workspace',
    'Git workspace',
    'The local repository is ready.'
  );
  const mock = await mockLibreWebUiApi(page, {
    workTasks: [gitTask],
    workGitStatuses: {
      'git-workspace': {
        initialized: true,
        branch: 'main',
        detached: false,
        head: 'abc123456789',
        ahead: 0,
        behind: 0,
        changes: [
          {
            path: 'src/app.ts',
            indexStatus: '.',
            workingTreeStatus: 'M',
            staged: false,
          },
        ],
        branches: ['main'],
        commits: [
          {
            hash: 'abc123456789',
            shortHash: 'abc1234',
            author: 'Robin',
            authoredAt: '2026-08-02T12:00:00.000Z',
            subject: 'Initial workspace',
          },
        ],
      },
    },
    workGitDiffs: {
      'git-workspace:': [
        'diff --git a/src/app.ts b/src/app.ts',
        'index 1111111..2222222 100644',
        '--- a/src/app.ts',
        '+++ b/src/app.ts',
        '@@ -1,1 +1,2 @@',
        " const app = 'libre';",
        '+export const ready = true;',
        '',
      ].join('\n'),
      'git-workspace:src/app.ts':
        'diff --git a/src/app.ts b/src/app.ts\n+export const ready = true;\n',
    },
  });

  await page.goto('/work/git-workspace');
  await page.getByTestId('work-git-tab').click();

  await expect(page.getByTestId('work-git-panel')).toBeVisible();
  await expect(page.getByText('Initial workspace')).toBeVisible();
  await expect(page.getByText(/Local Git only/)).toBeVisible();
  await expect(page.getByRole('button', { name: /push/i })).toHaveCount(0);

  // The review view opens with every changed file rendered as a rich diff,
  // and the toolbar totals the whole working tree.
  await expect(page.getByTestId('work-git-total-stats')).toHaveText('+1 −0');
  const reviewFile = page.getByTestId('work-git-review-file');
  await expect(reviewFile).toHaveCount(1);
  await expect(reviewFile).toContainText('src/app.ts');
  await expect(reviewFile).toContainText('export const ready = true;');

  // Filtering narrows the changes list without any network traffic.
  await page.getByTestId('work-git-filter').fill('nothing-matches-this');
  await expect(page.getByTestId('work-git-change')).toHaveCount(0);
  await page.getByTestId('work-git-filter').clear();

  await page.getByTestId('work-git-change').click();
  await expect(page.getByTestId('work-git-diff')).toContainText(
    'export const ready = true;'
  );
  await page.getByTestId('work-git-all-changes-button').click();
  await expect(page.getByTestId('work-git-review-file')).toBeVisible();
  await page.getByTestId('work-git-change').click();
  await expect(page.getByTestId('work-git-diff')).toContainText(
    'export const ready = true;'
  );

  await page.getByRole('checkbox', { name: 'Select src/app.ts' }).check();
  await page.getByTestId('work-git-stage-button').click();
  await expect(page.getByTestId('work-git-commit-button')).toBeDisabled();
  await page.getByTestId('work-git-commit-input').fill('Save app changes');
  await expect(page.getByTestId('work-git-commit-button')).toBeEnabled();
  await page.getByTestId('work-git-commit-button').click();
  await expect(page.getByText('Save app changes')).toBeVisible();

  await page.getByTestId('work-git-branch-input').fill('feature/local-ui');
  await page.getByTestId('work-git-create-branch-button').click();
  await expect(
    page
      .getByTestId('work-git-branch-select')
      .locator('option[value="feature/local-ui"]')
  ).toHaveCount(1);
  await page
    .getByTestId('work-git-branch-select')
    .selectOption('feature/local-ui');

  // The panel fetches the full working-tree diff after the initial status
  // and again after staging changes the tree; committing empties the tree,
  // so no refetch follows the commit, branch, or switch actions.
  await expect
    .poll(() => mock.workGitRequests.map(request => request.action))
    .toEqual([
      'status',
      'diff',
      'diff',
      'diff',
      'stage',
      'diff',
      'commit',
      'branch',
      'switch',
    ]);
  expect(
    mock.workGitRequests.find(request => request.action === 'stage')
  ).toMatchObject({ paths: ['src/app.ts'] });
  expect(
    mock.workGitRequests.find(request => request.action === 'commit')
  ).toMatchObject({ message: 'Save app changes' });
});
