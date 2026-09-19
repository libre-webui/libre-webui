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
import { defaultSystemInfo, mockLibreWebUiApi } from './lib/mockApi';

const model = {
  name: 'provider-model',
  size: 0,
  digest: '',
  modified_at: '',
  isPlugin: true,
  pluginId: 'provider-a',
  pluginName: 'Example Provider',
};

test('a Work engine choice preserves its provider and survives reload', async ({
  page,
}) => {
  const mock = await mockLibreWebUiApi(page, { models: [model] });
  await page.goto('/work');
  const selector = page.getByTestId('work-model-select');
  await expect(selector.locator('option')).toHaveText(['provider-model']);
  await page.getByTestId('work-model-selector-trigger').click();
  const option = page.locator(
    '[data-testid="model-selector-option"][data-model-value="plugin:provider-a:provider-model"]'
  );
  await expect(option).toContainText('via Example Provider');
  await option.click();
  await page.getByTestId('work-engine-select').selectOption('dsh');
  await expect(selector.locator('option')).toHaveText([
    'Select a model',
    'provider-model · Example Provider',
  ]);
  await expect(selector).toHaveValue('plugin:provider-a:provider-model');
  await expect(
    page.getByTestId('work-provider-disclosure-popover')
  ).toBeVisible();
  await page
    .getByTestId('work-composer-input')
    .fill('Build using DeepSeek Harness');
  await page.getByTestId('work-submit-button').click();
  await expect
    .poll(() => mock.workTaskCreateRequests)
    .toEqual([
      {
        message: 'Build using DeepSeek Harness',
        model: 'dsh:provider-model',
        providerType: 'plugin',
        providerId: 'provider-a',
        networkEnabled: true,
      },
    ]);
  await expect(page).toHaveURL(/\/work\/work-task-/);
  await page.reload();
  await expect(page.getByTestId('work-engine-select')).toHaveValue('dsh');
  await expect(selector).toHaveValue('plugin:provider-a:provider-model');
  await expect(page.getByTestId('work-model-selector-trigger')).toContainText(
    'provider-model'
  );
});

test('the opt-out keeps base models available and excludes host agents', async ({
  page,
}) => {
  await mockLibreWebUiApi(page, {
    systemInfo: { ...defaultSystemInfo, cordisEnabled: false },
    models: [
      model,
      {
        name: 'dsh',
        size: 0,
        digest: '',
        modified_at: '',
        isAgent: true,
        agentId: 'dsh',
        agentName: 'DeepSeek Harness',
      },
    ],
  });
  await page.goto('/work');
  await expect(
    page.getByTestId('work-model-select').locator('option')
  ).toHaveText(['provider-model']);
  await expect(page.getByTestId('work-engine-select')).toHaveCount(0);
});

test('authorized regular Work users can choose the sandboxed engine', async ({
  page,
}) => {
  await mockLibreWebUiApi(page, {
    systemInfo: { ...defaultSystemInfo, requiresAuth: true },
    authUsers: [
      {
        id: 'work-user',
        username: 'worker',
        email: null,
        role: 'user',
        status: 'active',
        token: 'work-token',
      },
    ],
    workAccess: { mode: 'all-users', allowed: true },
    models: [model],
  });
  await page.addInitScript(() =>
    localStorage.setItem('auth-token', 'work-token')
  );
  await page.goto('/');
  await page.getByRole('button', { name: 'Work', exact: true }).click();
  await expect(
    page.getByTestId('work-model-select').locator('option')
  ).toHaveText(['provider-model']);
  await expect(page.getByTestId('work-engine-select')).toBeEnabled();
  await page.getByTestId('work-engine-select').selectOption('dsh');
  await expect(page.getByTestId('work-engine-select')).toHaveValue('dsh');
});

test('a saved engine task stays readable after opt-out and can select a base model', async ({
  page,
}) => {
  await mockLibreWebUiApi(page, {
    systemInfo: { ...defaultSystemInfo, cordisEnabled: false },
    models: [model],
    workTasks: [
      {
        id: 'saved-dsh-task',
        title: 'Saved engine task',
        model: 'dsh:provider-model',
        providerType: 'plugin',
        providerId: 'provider-a',
        status: 'completed',
        networkEnabled: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messages: [],
        activeRun: null,
        previewUrl: null,
        previewStatus: 'stopped',
        workspacePath: '/workspace',
      },
    ],
  });
  await page.goto('/work/saved-dsh-task');
  await expect(page.getByTestId('work-model-select')).toHaveValue(
    'plugin:provider-a:provider-model'
  );
  await expect(page.getByTestId('work-model-selector-trigger')).toContainText(
    'provider-model'
  );
  await expect(page.getByTestId('work-composer-input')).toBeDisabled();
  await expect(page.getByTestId('work-engine-select')).toHaveValue('dsh');
  await page.getByTestId('work-engine-select').selectOption('libre');
  await expect(page.getByTestId('work-model-select')).toHaveValue(
    'plugin:provider-a:provider-model'
  );
  await expect(page.getByTestId('work-composer-input')).toBeEnabled();
});

for (const engine of ['libre', 'dsh']) {
  test(`changing the model preserves the independently selected ${engine} engine`, async ({
    page,
  }) => {
    const mock = await mockLibreWebUiApi(page, {
      models: [
        model,
        {
          ...model,
          name: 'codex-model',
          pluginId: 'provider-b',
          pluginName: 'Other Provider',
        },
      ],
    });
    await page.goto('/work');
    const selector = page.getByTestId('work-model-select');
    await expect(selector.locator('option')).toHaveText([
      'provider-model',
      'codex-model',
    ]);
    await expect(
      page.getByTestId('work-engine-select').locator('option')
    ).toHaveText(['Libre WebUI', 'DeepSeek Harness']);
    await page.getByTestId('work-engine-select').selectOption('dsh');
    await selector.selectOption('plugin:provider-b:codex-model');
    await expect(page.getByTestId('work-engine-select')).toHaveValue('dsh');
    await expect(selector).toHaveValue('plugin:provider-b:codex-model');
    await expect(selector.locator('option')).toHaveText([
      'Select a model',
      'provider-model · Example Provider',
      'codex-model · Other Provider',
    ]);
    await page.getByTestId('work-engine-select').selectOption(engine);
    await page
      .getByTestId('work-composer-input')
      .fill('Use the chosen engine and model');
    await page.getByTestId('work-submit-button').click();
    await expect
      .poll(() => mock.workTaskCreateRequests)
      .toEqual([
        {
          message: 'Use the chosen engine and model',
          model: `${engine === 'dsh' ? 'dsh:' : ''}codex-model`,
          providerType: 'plugin',
          providerId: 'provider-b',
          networkEnabled: true,
        },
      ]);
  });
}

test('the engine control stays labeled and contained on a narrow Arabic layout', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockLibreWebUiApi(page, { models: [model] });
  await page.addInitScript(() => localStorage.setItem('i18nextLng', 'ar'));
  await page.goto('/work');
  const engine = page.getByTestId('work-engine-select');
  await expect(engine).toHaveAccessibleName('المحرك');
  await engine.selectOption('dsh');
  await expect(engine).toHaveValue('dsh');
  const control = await engine.boundingBox();
  const surface = await page.getByTestId('work-composer-surface').boundingBox();
  expect(control).not.toBeNull();
  expect(surface).not.toBeNull();
  expect(control.x).toBeGreaterThanOrEqual(surface.x);
  expect(control.x + control.width).toBeLessThanOrEqual(
    surface.x + surface.width
  );
});

for (const saved of [false, true]) {
  test(`a delayed model switch preserves a newer engine choice on a ${saved ? 'saved' : 'new'} task`, async ({
    page,
  }) => {
    const mock = await mockLibreWebUiApi(page, {
      models: [model, { ...model, name: 'next-model' }],
      workTasks: saved
        ? [
            {
              id: 'engine-race',
              title: 'Engine selection race',
              model: model.name,
              providerType: 'plugin',
              providerId: model.pluginId,
              status: 'completed',
              networkEnabled: true,
              createdAt: Date.now(),
              updatedAt: Date.now(),
              messages: [],
              activeRun: null,
              previewUrl: null,
              previewStatus: 'stopped',
              workspacePath: '/workspace',
            },
          ]
        : [],
    });
    await page.goto(saved ? '/work/engine-race' : '/work');
    await expect(page.getByTestId('work-model-select')).toHaveValue(
      'plugin:provider-a:provider-model'
    );
    let releaseRunning = () => {};
    const runningBlocked = new Promise<void>(resolve => {
      releaseRunning = resolve;
    });
    let modelSwitchPending = false;
    await page.route('**/api/ollama/running', async route => {
      modelSwitchPending = true;
      await runningBlocked;
      await route.fulfill({ json: { success: true, data: [] } });
    });
    try {
      await page.getByTestId('work-model-selector-trigger').click();
      await page
        .locator(
          '[data-testid="model-selector-option"][data-model-value="plugin:provider-a:next-model"]'
        )
        .click();
      await expect.poll(() => modelSwitchPending).toBe(true);
      await page.getByTestId('work-engine-select').selectOption('dsh');
      await expect(page.getByTestId('work-engine-select')).toHaveValue('dsh');
      releaseRunning();
      await expect(page.getByTestId('work-model-select')).toHaveValue(
        'plugin:provider-a:next-model'
      );
      await expect(page.getByTestId('work-engine-select')).toHaveValue('dsh');
      await page
        .getByTestId('work-composer-input')
        .fill('Use the latest engine');
      await page.getByTestId('work-submit-button').click();
      await expect
        .poll(() =>
          (saved ? mock.workRunRequests : mock.workTaskCreateRequests).at(-1)
        )
        .toMatchObject({
          message: 'Use the latest engine',
          model: 'dsh:next-model',
          providerType: 'plugin',
          providerId: 'provider-a',
        });
    } finally {
      releaseRunning();
    }
  });
}

const chatDshProvider = 'gateway/team';
const chatDshRawModel = 'lab/model:latest';
const chatDshSelection = `dsh:lwui:plugin:${encodeURIComponent(chatDshProvider)}:${encodeURIComponent(chatDshRawModel)}`;
const workChoiceKey = (providerId: string) =>
  `plugin:${encodeURIComponent(providerId)}:${encodeURIComponent(chatDshRawModel)}`;

async function setupChatDshHandoff(
  page: import('@playwright/test').Page,
  available = true
) {
  const preferences = {
    defaultModel: chatDshSelection,
    defaultProviderType: 'agent',
    defaultProviderId: 'dsh',
  };
  const mock = await mockLibreWebUiApi(page, {
    systemInfo: {
      ...defaultSystemInfo,
      requiresAuth: true,
      agentCliModelsEnabled: true,
      cordisEnabled: true,
    },
    preferences,
    authUsers: [
      {
        id: 'work-handoff-admin',
        username: 'admin',
        email: null,
        role: 'admin',
        status: 'active',
        token: 'work-handoff-token',
        preferences,
      },
    ],
    models: [
      { name: chatDshRawModel, size: 0, digest: '', modified_at: '' },
      {
        ...model,
        name: chatDshRawModel,
        pluginId: 'other-provider',
        pluginName: 'Other Provider',
      },
      ...(available
        ? [
            {
              ...model,
              name: chatDshRawModel,
              pluginId: chatDshProvider,
              pluginName: 'Chosen Gateway',
            },
          ]
        : []),
    ],
  });
  await page.addInitScript(() =>
    localStorage.setItem('auth-token', 'work-handoff-token')
  );
  await page.route('**/api/agent-clis/models', route =>
    route.fulfill({
      json: {
        success: true,
        data: [
          {
            id: 'dsh',
            agentId: 'dsh',
            name: 'DeepSeek Harness',
            command: '',
            binaryPath: '',
          },
          ...(available
            ? [
                {
                  id: chatDshSelection,
                  agentId: 'dsh',
                  name: `DeepSeek Harness · ${chatDshRawModel} (Chosen Gateway)`,
                  command: '',
                  binaryPath: '',
                },
              ]
            : []),
        ],
      },
    })
  );
  return mock;
}

test('a selected Chat DSH model becomes the same Work engine and exact provider across reload', async ({
  page,
}) => {
  const mock = await setupChatDshHandoff(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Work', exact: true }).click();
  const engine = page.getByTestId('work-engine-select');
  const selectedModel = page.getByTestId('work-model-select');
  await expect(engine).toHaveValue('dsh');
  await expect(selectedModel).toHaveValue(workChoiceKey(chatDshProvider));
  await page.reload();
  await expect(engine).toHaveValue('dsh');
  await expect(selectedModel).toHaveValue(workChoiceKey(chatDshProvider));
  await expect(
    page.getByTestId('work-provider-disclosure-popover')
  ).toBeVisible();

  for (const providerId of ['other-provider', chatDshProvider]) {
    await selectedModel.selectOption(workChoiceKey(providerId));
    await expect(engine).toHaveValue('dsh');
    await expect(selectedModel).toHaveValue(workChoiceKey(providerId));
  }
  await page
    .getByTestId('work-composer-input')
    .fill('Continue with the Chat model in Work');
  await page.getByTestId('work-submit-button').click();
  await expect
    .poll(() => mock.workTaskCreateRequests.at(-1))
    .toMatchObject({
      message: 'Continue with the Chat model in Work',
      model: `dsh:${chatDshRawModel}`,
      providerType: 'plugin',
      providerId: chatDshProvider,
    });
  await expect(page).toHaveURL(/\/work\/work-task-/);
  await page.reload();
  await expect(engine).toHaveValue('dsh');
  await expect(selectedModel).toHaveValue(workChoiceKey(chatDshProvider));
});

test('an unavailable Chat DSH provider remains selected until the user explicitly chooses a replacement', async ({
  page,
}) => {
  const mock = await setupChatDshHandoff(page, false);
  await page.goto('/work');
  const selectedModel = page.getByTestId('work-model-select');
  await expect(page.getByTestId('work-engine-select')).toHaveValue('dsh');
  await expect(selectedModel).toHaveValue(workChoiceKey(chatDshProvider));
  await expect(page.getByTestId('work-model-unavailable')).toContainText(
    chatDshProvider
  );
  await expect(page.getByTestId('work-composer-input')).toBeDisabled();
  await expect(page.getByTestId('work-submit-button')).toBeDisabled();
  expect(mock.workTaskCreateRequests).toEqual([]);
  await page.reload();
  await expect(selectedModel).toHaveValue(workChoiceKey(chatDshProvider));
  await expect(page.getByTestId('work-composer-input')).toBeDisabled();

  await selectedModel.selectOption(workChoiceKey('other-provider'));
  await expect(page.getByTestId('work-engine-select')).toHaveValue('dsh');
  await expect(selectedModel).toHaveValue(workChoiceKey('other-provider'));
  await expect(page.getByTestId('work-model-unavailable')).toHaveCount(0);
  await expect(page.getByTestId('work-composer-input')).toBeEnabled();
  await page
    .getByTestId('work-composer-input')
    .fill('Use the explicitly chosen replacement');
  await page.getByTestId('work-submit-button').click();
  await expect
    .poll(() => mock.workTaskCreateRequests.at(-1))
    .toMatchObject({
      model: `dsh:${chatDshRawModel}`,
      providerType: 'plugin',
      providerId: 'other-provider',
    });
});
