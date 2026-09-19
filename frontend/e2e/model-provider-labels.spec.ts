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
import { defaultSystemInfo, mockLibreWebUiApi } from './lib/mockApi';
import { openSettingsTab } from './lib/settingsTab';

const agents = [
  { id: 'dsh', agentId: 'dsh', name: 'DeepSeek Harness', command: '' },
  { id: 'claude', agentId: 'claude', name: 'Claude Code', command: 'claude' },
  {
    id: 'codex:gpt-5.6-sol',
    agentId: 'codex',
    name: 'Codex · GPT-5.6 Sol',
    command: 'codex',
  },
  {
    id: 'opencode:openai/gpt-5',
    agentId: 'opencode',
    name: 'OpenCode · OpenAI / GPT-5',
    command: 'opencode',
  },
  { id: 'pi', agentId: 'pi', name: 'Pi', command: 'pi' },
].map(agent => ({
  ...agent,
  binaryPath: agent.command ? `/fixture/bin/${agent.command}` : '',
}));

const cloudPlugin = {
  id: 'openai-cloud',
  name: 'OpenAI Cloud',
  type: 'completion' as const,
  endpoint: 'https://api.openai.com/v1/chat/completions',
  api_mode: 'chat_completions' as const,
  auth: {
    header: 'Authorization',
    prefix: 'Bearer ',
    key_env: 'OPENAI_API_KEY',
  },
  model_map: ['gpt-cloud'],
  active: true,
};
const localModel = {
  name: 'local-chat:3b',
  model: 'local-chat:3b',
  size: 2_000_000_000,
  digest: 'fixture-local',
  modified_at: '2026-09-19T00:00:00Z',
  details: {
    family: 'llama',
    parameter_size: '3B',
    format: 'gguf',
    quantization_level: 'Q4_0',
  },
};
const agentKey = (agent: (typeof agents)[number]) =>
  `agent:${encodeURIComponent(agent.agentId)}:${encodeURIComponent(agent.id)}`;

async function setup(
  page: Page,
  {
    theme = 'dark',
    language = 'en',
    ollamaEnabled = false,
    taskModel = '',
  }: {
    theme?: 'light' | 'dark';
    language?: 'en' | 'ar';
    ollamaEnabled?: boolean;
    taskModel?: string;
  } = {}
) {
  const preferences = {
    defaultModel: ollamaEnabled ? localModel.name : 'gpt-cloud',
    defaultProviderType: ollamaEnabled ? 'ollama' : 'plugin',
    defaultProviderId: ollamaEnabled ? null : cloudPlugin.id,
    titleSettings: { autoTitle: true, taskModel },
    theme: {
      mode: theme,
      adaptToAccent: false,
      accent: 'blue',
      customAccent: '#2563eb',
    },
  };
  const systemInfo = {
    ...defaultSystemInfo,
    requiresAuth: true,
    agentsEnabled: false,
    agentCliModelsEnabled: true,
    cordisEnabled: true,
    ollamaEnabled,
  };
  await mockLibreWebUiApi(page, {
    systemInfo,
    models: ollamaEnabled ? [localModel] : [],
    plugins: [cloudPlugin],
    preferences,
    authUsers: [
      {
        id: 'provider-label-admin',
        username: 'admin',
        email: null,
        role: 'admin',
        status: 'active',
        token: 'provider-label-token',
        preferences,
      },
    ],
  });
  await page.addInitScript(
    ({ language }) => {
      localStorage.setItem('auth-token', 'provider-label-token');
      localStorage.setItem('i18nextLng', language);
    },
    { language }
  );
  await page.route('**/api/agent-clis/models', route =>
    route.fulfill({ json: { success: true, data: agents } })
  );
  await page.route('**/api/ollama/settings', route =>
    route.fulfill({
      json: {
        success: true,
        data: { enabled: ollamaEnabled, baseUrl: 'http://localhost:11434' },
      },
    })
  );
  await page.route('**/api/ollama/health', route =>
    route.fulfill({
      json: {
        success: true,
        data: {
          status: ollamaEnabled ? 'ok' : 'disabled',
          enabled: ollamaEnabled,
        },
      },
    })
  );
  const defaultWrites: Array<{
    model: string;
    providerType: string;
    providerId: string | null;
  }> = [];
  let persistedPreferences: Record<string, unknown> = { ...preferences };
  await page.route('**/api/preferences/default-model', async route => {
    const body = route
      .request()
      .postDataJSON() as (typeof defaultWrites)[number];
    defaultWrites.push(body);
    persistedPreferences = {
      ...persistedPreferences,
      defaultModel: body.model,
      defaultProviderType: body.providerType,
      defaultProviderId: body.providerId,
    };
    await route.fulfill({
      json: { success: true, data: persistedPreferences },
    });
  });
  const initialPreferences = page.waitForResponse(
    response =>
      new URL(response.url()).pathname === '/api/preferences' &&
      response.request().method() === 'GET'
  );
  await page.goto('/chat');
  persistedPreferences = { ...(await (await initialPreferences).json()).data };
  // Keep the fixture's preference writes durable across a browser reload.
  await page.route('**/api/preferences', async route => {
    if (route.request().method() === 'PUT')
      persistedPreferences = {
        ...persistedPreferences,
        ...route.request().postDataJSON(),
      };
    await route.fulfill({
      json: { success: true, data: persistedPreferences },
    });
  });
  const panel = await openSettingsTab(page, 'models');
  await expect(
    panel
      .getByTestId('default-model-select')
      .locator('option', { hasText: 'DeepSeek Harness' })
  ).toHaveCount(1);
  return { panel, defaultWrites };
}

for (const theme of ['light', 'dark'] as const) {
  test(`settings retain agent and plugin identities with Ollama disabled in ${theme} mode`, async ({
    page,
  }) => {
    const { panel, defaultWrites } = await setup(page, { theme });
    const defaults = panel.getByTestId('default-model-select');
    const vision = panel.getByTestId('vision-model-select');
    const task = panel.getByTestId('task-model-select');
    for (const agent of agents) {
      await expect(
        defaults.locator(`option[value="${agentKey(agent)}"]`)
      ).toHaveText(`${agent.name} (Agent)`);
      await expect(
        vision.locator(`option[value="${agentKey(agent)}"]`)
      ).toHaveText(`${agent.name} · Agent`);
      await expect(
        task.locator(`option[value="${agentKey(agent)}"]`)
      ).toHaveText(`${agent.name} · Agent`);
    }
    await expect(
      defaults.locator('option[value="plugin:openai-cloud:gpt-cloud"]')
    ).toHaveText('gpt-cloud (OpenAI Cloud)');
    await expect(
      vision.locator('option[value="plugin:openai-cloud:gpt-cloud"]')
    ).toHaveText('gpt-cloud · OpenAI Cloud');
    await expect(
      task.locator('option[value="plugin:openai-cloud:gpt-cloud"]')
    ).toHaveText('gpt-cloud · OpenAI Cloud');
    for (const selector of [defaults, vision, task])
      await expect(
        selector.locator('option', { hasText: 'Ollama' })
      ).toHaveCount(0);

    await defaults.selectOption(agentKey(agents[0]));
    await expect
      .poll(() => defaultWrites.at(-1))
      .toEqual({ model: 'dsh', providerType: 'agent', providerId: 'dsh' });
    const info = panel.getByTestId('current-model-info');
    await expect(info.getByText('Provider:', { exact: true })).toBeVisible();
    await expect(info).not.toContainText('common.provider');
    await expect(
      info.getByText('DeepSeek Harness', { exact: true })
    ).toBeVisible();
    await expect(info.getByText('Agent', { exact: true })).toBeVisible();
    await expect(info).not.toContainText('Ollama');
    for (const label of ['Size:', 'Family:', 'Format:'])
      await expect(info.getByText(label, { exact: true })).toHaveCount(0);

    await page.reload();
    const reloaded = await openSettingsTab(page, 'models');
    await expect(reloaded.getByTestId('default-model-select')).toHaveValue(
      agentKey(agents[0])
    );
    await expect(
      reloaded
        .getByTestId('current-model-info')
        .getByText('DeepSeek Harness', { exact: true })
    ).toBeVisible();
  });
}

test('an actual enabled Ollama model retains its provider label and concrete metadata', async ({
  page,
}) => {
  const { panel } = await setup(page, { ollamaEnabled: true });
  const defaults = panel.getByTestId('default-model-select');
  await expect(
    defaults.locator('option[value="ollama:local-chat%3A3b"]')
  ).toHaveText('local-chat:3b (Ollama)');
  await defaults.selectOption('ollama:local-chat%3A3b');
  const info = panel.getByTestId('current-model-info');
  await expect(info.getByText('Provider:', { exact: true })).toBeVisible();
  await expect(info.getByText('Ollama', { exact: true })).toBeVisible();
  await expect(info.getByText('3B', { exact: true })).toBeVisible();
  await expect(info.getByText('llama', { exact: true })).toBeVisible();
  await expect(info.getByText('gguf', { exact: true })).toBeVisible();
  await expect(defaults.locator('option[value="agent:dsh:dsh"]')).toHaveText(
    'DeepSeek Harness (Agent)'
  );
});

test('agent provider labels remain translated and correctly grouped in Arabic', async ({
  page,
}) => {
  const { panel } = await setup(page, { language: 'ar', theme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  const defaults = panel.getByTestId('default-model-select');
  await expect(defaults.locator('option[value="agent:dsh:dsh"]')).toHaveText(
    'DeepSeek Harness (الوكيل)'
  );
  await expect(
    panel
      .getByTestId('vision-model-select')
      .locator('option[value="agent:dsh:dsh"]')
  ).toHaveText('DeepSeek Harness · الوكيل');
  await expect(
    panel
      .getByTestId('task-model-select')
      .locator('option[value="agent:dsh:dsh"]')
  ).toHaveText('DeepSeek Harness · الوكيل');
  await expect(defaults.locator('option', { hasText: 'Ollama' })).toHaveCount(
    0
  );
  await defaults.selectOption(agentKey(agents[0]));
  const info = panel.getByTestId('current-model-info');
  await expect(info.getByText('المزود:', { exact: true })).toBeVisible();
  await expect(info.getByText('الوكيل', { exact: true })).toBeVisible();
  await expect(info).not.toContainText('common.provider');
});

test('the current-running task choice appears once without a synthetic legacy model', async ({
  page,
}) => {
  const sentinel = '__current_running_model__';
  const { panel } = await setup(page, { taskModel: sentinel });
  const task = panel.getByTestId('task-model-select');
  await expect(task).toHaveValue(sentinel);
  await expect(task.locator(`option[value="${sentinel}"]`)).toHaveCount(1);
  await expect(
    task.getByRole('option', { name: 'Use current running model', exact: true })
  ).toHaveCount(1);
  await expect(task.locator(`option[value="legacy:${sentinel}"]`)).toHaveCount(
    0
  );
  await expect(task.locator('option', { hasText: sentinel })).toHaveCount(0);
  await page.reload();
  const reloaded = (await openSettingsTab(page, 'models')).getByTestId(
    'task-model-select'
  );
  await expect(reloaded).toHaveValue(sentinel);
  await expect(reloaded.locator(`option[value="${sentinel}"]`)).toHaveCount(1);
  await expect(reloaded.locator('option', { hasText: sentinel })).toHaveCount(
    0
  );
});
