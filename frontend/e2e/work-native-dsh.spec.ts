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
import type { WorkCapabilities, WorkModelOption } from '../src/types/work';
import { defaultSystemInfo, mockLibreWebUiApi } from './lib/mockApi';

const nativeModels: WorkModelOption[] = [
  {
    model: 'deepseek-v4-flash',
    providerType: 'dsh',
    providerId: 'deepseek',
    key: 'dsh:deepseek:deepseek-v4-flash',
    label: 'Flash · DeepSeek',
    remote: true,
  },
  {
    model: 'deepseek-v4-pro',
    providerType: 'dsh',
    providerId: 'deepseek',
    key: 'dsh:deepseek:deepseek-v4-pro',
    label: 'Pro · DeepSeek',
    remote: true,
  },
];
const plugin = {
  id: 'lwui-provider',
  name: 'LWUI Provider',
  type: 'completion' as const,
  active: true,
  endpoint: 'https://provider.example.invalid/v1/chat/completions',
  auth: { header: 'Authorization', key_env: 'FIXTURE_KEY' },
  model_map: ['provider-model', 'next-model'],
};
const nativeTask = {
  id: 'native-work-task',
  title: 'Native DSH task',
  model: nativeModels[0].model,
  providerType: 'dsh' as const,
  providerId: 'deepseek',
  status: 'completed' as const,
  networkEnabled: true,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  messages: [],
  activeRun: null,
  previewUrl: null,
  previewStatus: 'stopped' as const,
  workspacePath: '/workspace' as const,
};
async function setup(
  page: Page,
  {
    lwui = true,
    status = 'ready',
    saved = false,
    role = 'admin',
    chatNative = false,
    theme = 'dark',
  }: {
    lwui?: boolean;
    status?: 'ready' | 'unavailable' | 'disabled';
    saved?: boolean;
    role?: 'admin' | 'user';
    chatNative?: boolean;
    theme?: 'light' | 'dark';
  } = {}
) {
  let nativeStatus = status;
  const capabilities = (): WorkCapabilities => ({
    available: lwui || nativeStatus === 'ready',
    runtime: 'docker',
    image: 'fixture-runtime',
    runtimeAvailable: true,
    ollamaAvailable: false,
    pluginAvailable: lwui,
    nativeDsh: {
      status: nativeStatus,
      models: nativeStatus === 'ready' ? nativeModels : [],
    },
  });
  const modelPreferences = chatNative
    ? {
        defaultModel: `dsh:native:deepseek:${nativeModels[0].model}`,
        defaultProviderType: 'agent',
        defaultProviderId: 'dsh',
      }
    : {
        defaultModel: lwui ? 'provider-model' : '',
        defaultProviderType: lwui ? 'plugin' : null,
        defaultProviderId: lwui ? 'lwui-provider' : null,
      };
  const preferences = {
    ...modelPreferences,
    theme: {
      mode: theme,
      accent: 'blue',
      adaptToAccent: false,
      customAccent: '#2563eb',
    },
  };
  const systemInfo = {
    ...defaultSystemInfo,
    requiresAuth: role === 'user',
    ollamaEnabled: false,
  };
  const mock = await mockLibreWebUiApi(page, {
    systemInfo,
    models: [],
    plugins: lwui ? [plugin] : [],
    preferences,
    workCapabilities: capabilities(),
    workTasks: saved ? [nativeTask] : [],
    ...(role === 'user'
      ? {
          authUsers: [
            {
              id: 'regular-user',
              username: 'worker',
              email: null,
              role: 'user' as const,
              status: 'active' as const,
              token: 'regular-token',
              preferences,
            },
          ],
          workAccess: { mode: 'all-users' as const, allowed: true },
        }
      : {}),
  });
  if (role === 'user')
    await page.addInitScript(() =>
      localStorage.setItem('auth-token', 'regular-token')
    );
  await page.route('**/api/work/capabilities', route =>
    route.fulfill({ json: { success: true, data: capabilities() } })
  );
  await page.route('**/api/ollama/settings', route =>
    route.fulfill({
      json: {
        success: true,
        data: { enabled: false, baseUrl: 'http://localhost:11434' },
      },
    })
  );
  if (chatNative)
    await page.route('**/api/agent-clis/models', route =>
      route.fulfill({
        json: {
          success: true,
          data: [
            {
              id: `dsh:native:deepseek:${nativeModels[0].model}`,
              agentId: 'dsh',
              name: 'DeepSeek Harness · Flash',
              command: '',
              binaryPath: '',
            },
          ],
        },
      })
    );
  return {
    mock,
    setStatus: (next: typeof status) => {
      nativeStatus = next;
    },
  };
}

for (const theme of ['light', 'dark'] as const) {
  test(`native Flash and Pro are selectable with no LWUI models in ${theme} mode`, async ({
    page,
  }) => {
    const { mock } = await setup(page, { lwui: false, theme });
    await page.goto('/work');
    if (theme === 'dark')
      await expect(page.locator('html')).toHaveClass(/dark/);
    else await expect(page.locator('html')).not.toHaveClass(/dark/);
    const engine = page.getByTestId('work-engine-select');
    await expect(engine).toBeEnabled();
    await engine.selectOption('dsh');
    const selector = page.getByTestId('work-model-select');
    await expect(
      selector.locator('optgroup[label="Native DSH models"] option')
    ).toHaveText(['Flash · DeepSeek', 'Pro · DeepSeek']);
    await expect(selector.locator('option', { hasText: 'Ollama' })).toHaveCount(
      0
    );
    await expect(page.getByTestId('work-submit-button')).toBeDisabled();
    await selector.selectOption(nativeModels[0].key);
    await expect(
      page.getByTestId('work-provider-disclosure-popover')
    ).toBeVisible();
    await page
      .getByTestId('work-composer-input')
      .fill('Build with native Flash');
    await page.getByTestId('work-submit-button').click();
    await expect
      .poll(() => mock.workTaskCreateRequests.at(-1))
      .toMatchObject({
        model: 'deepseek-v4-flash',
        providerType: 'dsh',
        providerId: 'deepseek',
      });
    await expect(page).toHaveURL(/\/work\/work-task-/);
    await page.reload();
    await expect(engine).toHaveValue('dsh');
    await expect(selector).toHaveValue(nativeModels[0].key);
  });
}

test('switching a saved native task to Libre requires an explicit compatible model', async ({
  page,
}) => {
  await setup(page, { saved: true });
  const writes: Record<string, unknown>[] = [];
  page.on('request', request => {
    if (
      request.url().endsWith('/api/work/tasks/native-work-task') &&
      request.method() === 'PATCH'
    )
      writes.push(request.postDataJSON());
  });
  await page.goto('/work/native-work-task');
  const engine = page.getByTestId('work-engine-select');
  await expect(engine).toHaveValue('dsh');
  await engine.selectOption('libre');
  await expect(page.getByTestId('work-model-selector-trigger')).toContainText(
    'Select a model'
  );
  await expect(page.getByTestId('work-submit-button')).toBeDisabled();
  expect(writes).toEqual([]);
  await page.getByTestId('work-model-selector-trigger').click();
  await page
    .locator(
      '[data-testid="model-selector-option"][data-model-value="plugin:lwui-provider:provider-model"]'
    )
    .click();
  await expect
    .poll(() => writes.at(-1))
    .toMatchObject({
      model: 'provider-model',
      providerType: 'plugin',
      providerId: 'lwui-provider',
    });
  await expect(engine).toHaveValue('libre');
  await engine.selectOption('dsh');
  const selector = page.getByTestId('work-model-select');
  await expect(
    selector.locator('optgroup[label="Libre WebUI models"] option')
  ).toHaveText([
    'provider-model · LWUI Provider',
    'next-model · LWUI Provider',
  ]);
  await selector.selectOption(nativeModels[1].key);
  await expect
    .poll(() => writes.at(-1))
    .toMatchObject({
      model: 'deepseek-v4-pro',
      providerType: 'dsh',
      providerId: 'deepseek',
    });
  await page.reload();
  await expect(engine).toHaveValue('dsh');
  await expect(selector).toHaveValue(nativeModels[1].key);
});

test('an unavailable native selection stays explicit until its catalogue recovers', async ({
  page,
}) => {
  const { mock, setStatus } = await setup(page, {
    saved: true,
    status: 'unavailable',
  });
  await page.goto('/work/native-work-task');
  const selector = page.getByTestId('work-model-select');
  await expect(selector).toHaveValue(nativeModels[0].key);
  await expect(page.getByTestId('work-model-unavailable')).toContainText(
    'deepseek'
  );
  await expect(page.getByTestId('work-composer-input')).toBeDisabled();
  await expect(page.getByTestId('work-submit-button')).toBeDisabled();
  expect(mock.workRunRequests).toEqual([]);
  await page.reload();
  await expect(selector).toHaveValue(nativeModels[0].key);
  setStatus('ready');
  await page.getByTestId('work-model-refresh').click();
  await expect(page.getByTestId('work-model-unavailable')).toHaveCount(0);
  await expect(selector).toHaveValue(nativeModels[0].key);
  await expect(
    selector.locator(`option[value="${nativeModels[0].key}"]`)
  ).toHaveText('Flash · DeepSeek');
  await expect(page.getByTestId('work-composer-input')).toBeEnabled();
});

test('native catalogue entries are not exposed to regular Work users', async ({
  page,
}) => {
  await setup(page, { role: 'user' });
  await page.goto('/');
  await page.getByRole('button', { name: 'Work', exact: true }).click();
  await page.getByTestId('work-engine-select').selectOption('dsh');
  const selector = page.getByTestId('work-model-select');
  await expect(
    selector.locator('optgroup[label="Native DSH models"]')
  ).toHaveCount(0);
  await expect(selector.locator('option', { hasText: 'Flash' })).toHaveCount(0);
  await expect(
    selector.locator('optgroup[label="Libre WebUI models"] option')
  ).toHaveCount(2);
});

test('a native Chat alias keeps its exact provider and raw model in Work', async ({
  page,
}) => {
  const { mock } = await setup(page, { chatNative: true });
  await page.goto('/work');
  await expect(page.getByTestId('work-engine-select')).toHaveValue('dsh');
  await expect(page.getByTestId('work-model-select')).toHaveValue(
    nativeModels[0].key
  );
  await page
    .getByTestId('work-composer-input')
    .fill('Continue with native Flash');
  await page.getByTestId('work-submit-button').click();
  await expect
    .poll(() => mock.workTaskCreateRequests.at(-1))
    .toMatchObject({
      model: 'deepseek-v4-flash',
      providerType: 'dsh',
      providerId: 'deepseek',
    });
});

test('a completed native pick supersedes an older delayed LWUI model choice', async ({
  page,
}) => {
  const { mock } = await setup(page);
  await page.goto('/work');
  let release = () => {};
  const blocked = new Promise<void>(resolve => {
    release = resolve;
  });
  let waiting = false;
  await page.route('**/api/ollama/running', async route => {
    waiting = true;
    await blocked;
    await route.fulfill({ json: { success: true, data: [] } });
  });
  try {
    await page.getByTestId('work-model-selector-trigger').click();
    await page
      .locator(
        '[data-testid="model-selector-option"][data-model-value="plugin:lwui-provider:next-model"]'
      )
      .click();
    await expect.poll(() => waiting).toBe(true);
    await page.getByTestId('work-engine-select').selectOption('dsh');
    await page
      .getByTestId('work-model-select')
      .selectOption(nativeModels[0].key);
    const response = page.waitForResponse(response =>
      response.url().endsWith('/api/ollama/running')
    );
    release();
    await (await response).finished();
    await page.evaluate(
      () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
    );
    await expect(page.getByTestId('work-model-select')).toHaveValue(
      nativeModels[0].key
    );
    await page
      .getByTestId('work-composer-input')
      .fill('Keep the newest native choice');
    await page.getByTestId('work-submit-button').click();
    await expect
      .poll(() => mock.workTaskCreateRequests.at(-1))
      .toMatchObject({
        model: 'deepseek-v4-flash',
        providerType: 'dsh',
        providerId: 'deepseek',
      });
  } finally {
    release();
  }
});
