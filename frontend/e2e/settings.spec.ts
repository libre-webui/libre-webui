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
import { mockLibreWebUiApi } from './lib/mockApi';

const providerWorkspaceSystemInfo = {
  requiresAuth: true,
  hasUsers: true,
  userCount: 2,
  version: '0.15.0-e2e',
  turnstile: { enabled: false },
};

const createProviderWorkspacePlugins = () => [
  {
    id: 'openai-cloud',
    name: 'OpenAI Cloud',
    type: 'completion' as const,
    endpoint: 'https://api.openai.com/v1/responses',
    api_mode: 'responses' as const,
    auth: {
      header: 'Authorization',
      prefix: 'Bearer ',
      key_env: 'OPENAI_API_KEY',
    },
    model_map: ['gpt-cloud'],
    active: true,
  },
  {
    id: 'local-gateway',
    name: 'Local AI Gateway',
    type: 'completion' as const,
    endpoint: 'http://ai-gateway:8080/v1/chat/completions',
    api_mode: 'chat_completions' as const,
    auth: {
      header: 'Authorization',
      prefix: 'Bearer ',
      key_env: 'LOCAL_GATEWAY_API_KEY',
    },
    model_map: ['legacy-model'],
    active: false,
    variables: [
      {
        name: 'endpoint',
        type: 'string' as const,
        label: 'API Endpoint',
        required: true,
      },
      {
        name: 'temperature',
        type: 'number' as const,
        label: 'Temperature',
        default: 0.7,
        min: 0,
        max: 2,
      },
    ],
  },
  {
    id: 'anthropic-cloud',
    name: 'Anthropic Cloud',
    type: 'completion' as const,
    endpoint: 'https://api.anthropic.com/v1/messages',
    auth: {
      header: 'x-api-key',
      key_env: 'ANTHROPIC_API_KEY',
    },
    model_map: ['claude-cloud'],
    active: false,
  },
];

async function openPluginSettings(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('auth-token', 'e2e-token');
  });
  await page.goto('/chat');
  await expect(page.getByRole('textbox', { name: 'Message...' })).toBeVisible();
  await page.keyboard.press('Control+,');
  await page.getByRole('tab', { name: 'Plugins' }).click();
  await expect(page.getByTestId('provider-workspace')).toBeVisible();
}

test('settings modal lazy-loads and switches languages from async locale chunks', async ({
  page,
}) => {
  await mockLibreWebUiApi(page);
  await page.goto('/chat');

  await expect(page.getByRole('textbox', { name: 'Message...' })).toBeVisible();
  await page.keyboard.press('Control+,');

  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();

  await page.getByTestId('language-switcher-select').selectOption('fr');

  await expect(page.getByRole('heading', { name: 'Paramètres' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Langue' })).toBeVisible();

  await page.getByTestId('language-switcher-select').selectOption('ar');
  await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');

  await page.getByTestId('language-switcher-select').selectOption('en');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
});

test('vision model selection persists the exact provider-qualified model', async ({
  page,
}) => {
  const mockApi = await mockLibreWebUiApi(page, {
    plugins: createProviderWorkspacePlugins(),
  });
  await page.addInitScript(() => {
    localStorage.setItem('auth-token', 'e2e-token');
  });
  await page.goto('/chat');
  await expect(page.getByRole('textbox', { name: 'Message...' })).toBeVisible();

  await page.keyboard.press('Control+,');
  await page.getByRole('tab', { name: 'Model' }).click();

  const visionModel = page.getByTestId('vision-model-select');
  await visionModel.selectOption({ label: 'gpt-cloud · OpenAI Cloud' });

  await expect
    .poll(() =>
      mockApi.preferenceUpdateRequests.find(
        request => request.visionModel === 'gpt-cloud'
      )
    )
    .toEqual({
      visionModel: 'gpt-cloud',
      visionProviderType: 'plugin',
      visionProviderId: 'openai-cloud',
    });

  await page.reload();
  await expect(page.getByRole('textbox', { name: 'Message...' })).toBeVisible();
  await page.keyboard.press('Control+,');
  await page.getByRole('tab', { name: 'Model' }).click();
  await expect(page.getByTestId('vision-model-select')).toHaveValue(
    'plugin:openai-cloud:gpt-cloud'
  );
});

test('provider workspace searches, selects, and collapses configuration on provider change', async ({
  page,
}) => {
  await mockLibreWebUiApi(page, {
    authRole: 'admin',
    systemInfo: providerWorkspaceSystemInfo,
    plugins: createProviderWorkspacePlugins(),
  });
  await openPluginSettings(page);

  const providerList = page.getByTestId('provider-list');
  const providerDetail = page.getByTestId('provider-detail');
  const search = page.getByRole('searchbox', { name: 'Search providers' });
  const openAiProvider = providerList.getByRole('button', {
    name: /OpenAI Cloud/,
  });

  await expect(openAiProvider).toHaveAttribute('aria-current', 'true');
  await expect(
    providerDetail.getByText('OpenAI Cloud', { exact: true }).first()
  ).toBeVisible();
  await expect(
    providerDetail.getByRole('button', {
      name: 'Configure',
      exact: true,
    })
  ).toHaveAttribute('aria-expanded', 'false');
  await expect(providerDetail.getByLabel(/API endpoint/i)).toHaveCount(0);

  await search.fill('gateway');
  await expect(openAiProvider).toHaveCount(0);
  const localProvider = providerList.getByRole('button', {
    name: /Local AI Gateway/,
  });
  await expect(localProvider).toBeVisible();
  await localProvider.click();
  await expect(localProvider).toHaveAttribute('aria-current', 'true');
  await expect(
    providerDetail.getByText('Local AI Gateway', { exact: true }).first()
  ).toBeVisible();

  const configure = providerDetail.getByRole('button', {
    name: 'Configure',
    exact: true,
  });
  await expect(configure).toHaveAttribute('aria-expanded', 'false');
  await configure.click();
  await expect(configure).toHaveAttribute('aria-expanded', 'true');
  await expect(providerDetail.getByLabel(/API endpoint/i)).toBeVisible();
  await expect(
    providerDetail.getByRole('button', { name: /Advanced parameters/ })
  ).toHaveAttribute('aria-expanded', 'false');
  await expect(
    providerDetail.getByLabel('Temperature', { exact: true })
  ).toHaveCount(0);

  await search.fill('anthropic');
  const anthropicProvider = providerList.getByRole('button', {
    name: /Anthropic Cloud/,
  });
  await anthropicProvider.click();
  await expect(anthropicProvider).toHaveAttribute('aria-current', 'true');
  await expect(
    providerDetail.getByText('Anthropic Cloud', { exact: true }).first()
  ).toBeVisible();
  await expect(
    providerDetail.getByRole('button', {
      name: 'Configure',
      exact: true,
    })
  ).toHaveAttribute('aria-expanded', 'false');
  await expect(providerDetail.getByLabel(/API endpoint/i)).toHaveCount(0);
});

test('provider model refresh targets the selection and replaces its catalog', async ({
  page,
}) => {
  const localGateway = createProviderWorkspacePlugins()[1];
  localGateway.active = true;
  const mockApi = await mockLibreWebUiApi(page, {
    authRole: 'admin',
    systemInfo: providerWorkspaceSystemInfo,
    plugins: [localGateway],
    pluginDiscoveryResults: {
      'local-gateway': ['gateway-chat', 'gateway-code'],
    },
    pluginDiscoveryDelayMs: 700,
  });
  await openPluginSettings(page);

  const providerList = page.getByTestId('provider-list');
  const providerDetail = page.getByTestId('provider-detail');
  const catalog = page.getByTestId('provider-model-catalog');
  const localProvider = providerList.getByRole('button', {
    name: /Local AI Gateway/,
  });
  const refreshModels = providerDetail.getByRole('button', {
    name: /Refresh(?:ing)? models/,
  });

  await expect(localProvider).toHaveAttribute('aria-current', 'true');
  await expect(
    providerDetail.getByRole('button', {
      name: 'Deactivate',
      exact: true,
    })
  ).toBeVisible();
  await expect(
    catalog.getByText('legacy-model', { exact: true })
  ).toBeVisible();

  await refreshModels.click();
  await expect
    .poll(() => mockApi.pluginDiscoveryRequests)
    .toEqual(['local-gateway']);
  await expect(refreshModels).toBeDisabled();
  await expect(refreshModels).toHaveAttribute('aria-busy', 'true');

  await expect(
    catalog.getByText('gateway-chat', { exact: true })
  ).toBeVisible();
  await expect(
    catalog.getByText('gateway-code', { exact: true })
  ).toBeVisible();
  await expect(catalog.getByText('legacy-model', { exact: true })).toHaveCount(
    0
  );
  await expect(refreshModels).toBeEnabled();
  await expect(refreshModels).toHaveAttribute('aria-busy', 'false');
  await expect(localProvider).toHaveAttribute('aria-current', 'true');
});

test('provider model refresh failure preserves the catalog and unlocks retry', async ({
  page,
}) => {
  const localGateway = createProviderWorkspacePlugins()[1];
  const mockApi = await mockLibreWebUiApi(page, {
    authRole: 'admin',
    systemInfo: providerWorkspaceSystemInfo,
    plugins: [localGateway],
    pluginDiscoveryFailures: {
      'local-gateway': 'Provider catalog unavailable',
    },
  });
  await openPluginSettings(page);

  const catalog = page.getByTestId('provider-model-catalog');
  const refreshModels = page
    .getByTestId('provider-detail')
    .getByRole('button', { name: 'Refresh models', exact: true });

  await refreshModels.click();
  await expect
    .poll(() => mockApi.pluginDiscoveryRequests)
    .toEqual(['local-gateway']);
  await expect(
    page.getByText('Provider catalog unavailable', { exact: true })
  ).toBeVisible();
  await expect(
    catalog.getByText('legacy-model', { exact: true })
  ).toBeVisible();
  await expect(refreshModels).toBeEnabled();
  await expect(refreshModels).toHaveAttribute('aria-busy', 'false');
});

test('parallel provider refreshes retain independent busy state', async ({
  page,
}) => {
  const [openAiCloud, localGateway] = createProviderWorkspacePlugins();
  localGateway.active = true;
  const mockApi = await mockLibreWebUiApi(page, {
    authRole: 'admin',
    systemInfo: providerWorkspaceSystemInfo,
    plugins: [openAiCloud, localGateway],
    pluginDiscoveryResults: {
      'openai-cloud': ['gpt-refreshed'],
      'local-gateway': ['gateway-refreshed'],
    },
    pluginDiscoveryDelayMs: 1_800,
  });
  await openPluginSettings(page);

  const providerList = page.getByTestId('provider-list');
  const providerDetail = page.getByTestId('provider-detail');
  const catalog = page.getByTestId('provider-model-catalog');
  const openAiProvider = providerList.getByRole('button', {
    name: /OpenAI Cloud/,
  });
  const localProvider = providerList.getByRole('button', {
    name: /Local AI Gateway/,
  });

  await providerDetail
    .getByRole('button', { name: 'Refresh models', exact: true })
    .click();
  await page.waitForTimeout(500);
  await localProvider.click();
  await providerDetail
    .getByRole('button', { name: 'Refresh models', exact: true })
    .click();
  await expect
    .poll(() => mockApi.pluginDiscoveryRequests)
    .toEqual(['openai-cloud', 'local-gateway']);

  await openAiProvider.click();
  await expect(
    catalog.getByText('gpt-refreshed', { exact: true })
  ).toBeVisible();

  await localProvider.click();
  const localRefresh = providerDetail.getByRole('button', {
    name: 'Refresh models',
    exact: true,
  });
  await expect(localRefresh).toBeDisabled();
  await expect(localRefresh).toHaveAttribute('aria-busy', 'true');
  await expect(
    catalog.getByText('gateway-refreshed', { exact: true })
  ).toBeVisible();
  await expect(localRefresh).toBeEnabled();
  await expect(localRefresh).toHaveAttribute('aria-busy', 'false');
});

test('provider workspace is two-pane on desktop and stacked without overflow on mobile', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await mockLibreWebUiApi(page, {
    authRole: 'admin',
    systemInfo: providerWorkspaceSystemInfo,
    plugins: createProviderWorkspacePlugins(),
  });
  await openPluginSettings(page);

  const readLayout = () =>
    page.evaluate(() => {
      const workspace = document.querySelector(
        '[data-testid="provider-workspace"]'
      );
      const list = document.querySelector('[data-testid="provider-list"]');
      const detail = document.querySelector('[data-testid="provider-detail"]');
      if (!workspace || !list || !detail) {
        throw new Error('Provider workspace layout is incomplete');
      }

      const workspaceRect = workspace.getBoundingClientRect();
      const listRect = list.getBoundingClientRect();
      const detailRect = detail.getBoundingClientRect();
      return {
        workspace: {
          left: workspaceRect.left,
          right: workspaceRect.right,
          width: workspaceRect.width,
        },
        list: {
          left: listRect.left,
          right: listRect.right,
          top: listRect.top,
          bottom: listRect.bottom,
          width: listRect.width,
        },
        detail: {
          left: detailRect.left,
          right: detailRect.right,
          top: detailRect.top,
          bottom: detailRect.bottom,
          width: detailRect.width,
        },
        viewportWidth: window.innerWidth,
        documentWidth: document.documentElement.scrollWidth,
      };
    });

  const desktop = await readLayout();
  expect(desktop.list.right).toBeLessThanOrEqual(desktop.detail.left + 1);
  expect(
    Math.min(desktop.list.bottom, desktop.detail.bottom) -
      Math.max(desktop.list.top, desktop.detail.top)
  ).toBeGreaterThan(0);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId('provider-workspace')).toBeVisible();
  const mobile = await readLayout();
  expect(mobile.detail.top).toBeGreaterThanOrEqual(mobile.list.bottom - 1);
  expect(mobile.list.width).toBeLessThanOrEqual(mobile.workspace.width + 1);
  expect(mobile.detail.width).toBeLessThanOrEqual(mobile.workspace.width + 1);
  expect(mobile.documentWidth).toBeLessThanOrEqual(mobile.viewportWidth + 1);
});

test('admin provider settings are collapsed, inherited, sparse, and retryable', async ({
  page,
}) => {
  const mockApi = await mockLibreWebUiApi(page, {
    authRole: 'admin',
    systemInfo: {
      requiresAuth: true,
      hasUsers: true,
      userCount: 2,
      version: '0.10.0-e2e',
      turnstile: { enabled: false },
    },
    plugins: [
      {
        id: 'custom-provider',
        name: 'Custom Provider',
        type: 'completion',
        endpoint: 'https://provider.example/v1/chat/completions',
        api_mode: 'responses',
        base_url: 'https://provider.example/v1',
        api_path: '/responses',
        auth: {
          header: 'Authorization',
          prefix: 'Bearer ',
          key_env: 'CUSTOM_PROVIDER_API_KEY',
        },
        model_map: ['custom-model'],
        active: true,
        capabilities: {
          image: {
            endpoint: 'https://provider.example/v1/images/generations',
            config: {
              endpoint_variable: 'custom_image_endpoint',
            },
          },
        },
        variables: [
          {
            name: 'endpoint',
            type: 'string',
            label: 'API Endpoint',
            required: true,
          },
          {
            name: 'base_url',
            type: 'string',
            label: 'Base URL',
            required: true,
          },
          {
            name: 'api_path',
            type: 'string',
            label: 'API Path',
            required: true,
          },
          {
            name: 'api_mode',
            type: 'select',
            label: 'API Mode',
            required: true,
            options: ['chat_completions', 'responses'],
          },
          {
            name: 'custom_image_endpoint',
            type: 'string',
            label: 'Custom Image Endpoint',
            required: true,
          },
          {
            name: 'model_id',
            type: 'string',
            label: 'Model ID',
            default: 'custom-model',
          },
          {
            name: 'temperature',
            type: 'number',
            label: 'Temperature',
            default: 0.7,
            min: 0,
            max: 2,
          },
          {
            name: 'stream',
            type: 'boolean',
            label: 'Stream Response',
            default: true,
          },
          {
            name: 'secret_header',
            type: 'string',
            label: 'Secret Header',
            sensitive: true,
          },
        ],
      },
    ],
    pluginVariables: {
      'custom-provider': {
        endpoint: {
          name: 'endpoint',
          value: 'https://custom.example/v1/chat/completions',
          is_sensitive: false,
          has_value: true,
        },
        base_url: {
          name: 'base_url',
          value: 'https://provider.example/v1',
          is_sensitive: false,
          has_value: false,
        },
        model_id: {
          name: 'model_id',
          value: 'custom-model',
          is_sensitive: false,
          has_value: false,
        },
        temperature: {
          name: 'temperature',
          value: 0.7,
          is_sensitive: false,
          has_value: false,
        },
        stream: {
          name: 'stream',
          value: true,
          is_sensitive: false,
          has_value: false,
        },
        secret_header: {
          name: 'secret_header',
          value: '••••••••',
          is_sensitive: true,
          has_value: true,
        },
      },
    },
    pluginVariableResetFailures: 1,
    pluginMutationRefreshDelayMs: 300,
  });

  await page.addInitScript(() => {
    localStorage.setItem('auth-token', 'e2e-token');
  });
  await page.goto('/chat');
  await expect(page.getByRole('textbox', { name: 'Message...' })).toBeVisible();
  await page.keyboard.press('Control+,');

  await page.getByRole('tab', { name: 'Generation', exact: true }).click();
  const generationDisclosure = page.getByRole('button', {
    name: /Advanced generation settings/,
  });
  await expect(generationDisclosure).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByText(/^Temperature/)).toHaveCount(0);
  await generationDisclosure.click();
  await expect(generationDisclosure).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByText(/^Temperature/)).toBeVisible();

  await page.getByRole('tab', { name: 'Plugins' }).click();
  await expect(
    page.getByRole('button', { name: 'Upload Plugin', exact: true })
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Add JSON', exact: true })
  ).toBeVisible();
  const providerDisclosure = page.getByRole('button', {
    name: 'Configure',
    exact: true,
  });
  await expect(providerDisclosure).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByText('API Endpoint', { exact: true })).toHaveCount(0);
  await providerDisclosure.click();
  await expect(providerDisclosure).toHaveAttribute('aria-expanded', 'true');

  const apiKeyInput = page.getByLabel('API Key', { exact: true });
  await expect(apiKeyInput).toHaveAttribute('type', 'password');
  await page.getByRole('button', { name: 'Show API key' }).click();
  await expect(apiKeyInput).toHaveAttribute('type', 'text');
  await expect(
    page.getByRole('button', { name: 'Hide API key' })
  ).toBeVisible();

  const endpointInput = page.getByLabel('API Endpoint');
  await expect(endpointInput).toHaveValue(
    'https://custom.example/v1/chat/completions'
  );
  const baseUrlInput = page.getByLabel('Base URL');
  await expect(baseUrlInput).toHaveValue('');
  await expect(baseUrlInput).toHaveAttribute(
    'placeholder',
    'Use provider default (https://provider.example/v1)'
  );
  const apiPathInput = page.getByLabel('API Path');
  await expect(apiPathInput).toHaveValue('');
  await expect(apiPathInput).toHaveAttribute(
    'placeholder',
    'Use provider default (/responses)'
  );
  const apiModeInput = page.getByLabel('API Mode');
  await expect(apiModeInput).toHaveValue('');
  await expect(apiModeInput.locator('option:checked')).toHaveText(
    'Use provider default (responses)'
  );
  const customImageEndpointInput = page.getByLabel('Custom Image Endpoint');
  await expect(customImageEndpointInput).toHaveValue('');
  await expect(customImageEndpointInput).toHaveAttribute(
    'placeholder',
    'Use provider default (https://provider.example/v1/images/generations)'
  );
  const modelIdInput = page.getByLabel('Model ID', { exact: true });
  await expect(modelIdInput).toHaveValue('');
  await expect(modelIdInput).toHaveAttribute(
    'placeholder',
    'Use provider default (custom-model)'
  );

  const httpWarning = page.getByText(
    'HTTP does not encrypt credentials or traffic. Use it only on a trusted network.',
    { exact: true }
  );
  await expect(httpWarning).toHaveCount(0);
  await endpointInput.fill('ftp://ai-gateway:8080/v1/chat/completions');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(
    page.getByText('API endpoints must use HTTP or HTTPS.', { exact: true })
  ).toBeVisible();
  expect(mockApi.pluginVariableUpdateRequests).toHaveLength(0);

  await endpointInput.fill('http://ai-gateway:8080/v1/chat/completions');
  await expect(httpWarning).toBeVisible();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => mockApi.pluginVariableUpdateRequests.length).toBe(1);
  expect(mockApi.pluginVariableUpdateRequests[0]).toEqual({
    pluginId: 'custom-provider',
    variables: {
      endpoint: 'http://ai-gateway:8080/v1/chat/completions',
    },
    unset: [],
  });

  const providerAdvancedDisclosure = page.getByRole('button', {
    name: /Advanced parameters/,
  });
  await expect(providerAdvancedDisclosure).toHaveAttribute(
    'aria-expanded',
    'false'
  );
  await expect(page.getByText(/^Temperature/)).toHaveCount(0);
  await providerAdvancedDisclosure.click();

  const temperatureInput = page.getByLabel('Temperature', { exact: true });
  await expect(temperatureInput).toHaveValue('');
  await expect(temperatureInput).toHaveAttribute(
    'placeholder',
    'Use provider default (0.7)'
  );

  await endpointInput.fill('');
  await baseUrlInput.fill('https://temporary.example/v1');
  await baseUrlInput.fill('');
  await apiPathInput.fill('/chat/completions');
  await apiPathInput.fill('');
  await apiModeInput.selectOption('chat_completions');
  await apiModeInput.selectOption('');
  await customImageEndpointInput.fill(
    'http://image-gateway:8080/v1/images/generations'
  );
  await expect(httpWarning).toBeVisible();
  await customImageEndpointInput.fill('');
  await expect(httpWarning).toHaveCount(0);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => mockApi.pluginVariableUpdateRequests.length).toBe(2);
  expect(mockApi.pluginVariableUpdateRequests[1]).toEqual({
    pluginId: 'custom-provider',
    variables: {},
    unset: ['endpoint'],
  });

  const secretInput = page.getByLabel('Secret Header', { exact: true });
  await expect(secretInput).toHaveAttribute('type', 'password');
  await expect(secretInput).toBeDisabled();
  await secretInput.fill('temporary-plaintext-secret');
  await page.getByRole('button', { name: 'Show Secret Header value' }).click();
  await expect(secretInput).toHaveAttribute('type', 'text');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => mockApi.pluginVariableUpdateRequests.length).toBe(3);
  expect(mockApi.pluginVariableUpdateRequests[2]).toEqual({
    pluginId: 'custom-provider',
    variables: { secret_header: 'temporary-plaintext-secret' },
    unset: [],
  });
  await expect(secretInput).toHaveValue('');
  await expect(secretInput).toHaveAttribute('type', 'password');
  await expect(
    page.getByRole('button', { name: 'Show Secret Header value' })
  ).toBeVisible();

  await temperatureInput.fill('1.2');
  await page
    .getByRole('button', { name: 'Reset to Defaults', exact: true })
    .click();
  await expect.poll(() => mockApi.pluginVariableResetRequests).toBe(1);
  await expect(page.getByText('Failed to reset variables')).toBeVisible();
  await expect(temperatureInput).toHaveValue('1.2');

  await page
    .getByRole('button', { name: 'Reset to Defaults', exact: true })
    .click();
  await expect.poll(() => mockApi.pluginVariableResetRequests).toBe(2);
  await expect(temperatureInput).toBeDisabled();
  await expect(temperatureInput).toBeEnabled();
  await expect(temperatureInput).toHaveValue('');
});

test('users can activate providers and save keys and generation overrides without routing controls', async ({
  page,
}) => {
  const mockApi = await mockLibreWebUiApi(page, {
    authRole: 'user',
    systemInfo: {
      requiresAuth: true,
      hasUsers: true,
      userCount: 2,
      version: '0.10.0-e2e',
      turnstile: { enabled: false },
    },
    plugins: [
      {
        id: 'user-provider',
        name: 'User Provider',
        type: 'completion',
        endpoint: 'https://provider.example/v1/chat/completions',
        auth: {
          header: 'Authorization',
          prefix: 'Bearer ',
          key_env: 'USER_PROVIDER_API_KEY',
        },
        model_map: ['user-model'],
        active: false,
        variables: [
          {
            name: 'endpoint',
            type: 'string',
            label: 'API Endpoint',
            required: true,
          },
          {
            name: 'base_url',
            type: 'string',
            label: 'Base URL',
            default: 'https://provider.example/v1',
          },
          {
            name: 'model_id',
            type: 'string',
            label: 'Model ID',
            default: 'user-model',
          },
          {
            name: 'temperature',
            type: 'number',
            label: 'Temperature',
            default: 0.7,
            min: 0,
            max: 2,
          },
        ],
      },
    ],
    pluginVariables: {
      'user-provider': {
        temperature: {
          name: 'temperature',
          value: 0.7,
          is_sensitive: false,
          has_value: false,
        },
      },
    },
    pluginMutationRefreshDelayMs: 300,
  });

  await page.addInitScript(() => {
    localStorage.setItem('auth-token', 'e2e-token');
  });
  await page.goto('/chat');
  await expect(page.getByRole('textbox', { name: 'Message...' })).toBeVisible();
  await page.keyboard.press('Control+,');
  await page.getByRole('tab', { name: 'Plugins' }).click();

  await expect(
    page.getByRole('button', { name: 'Upload Plugin', exact: true })
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Add JSON', exact: true })
  ).toHaveCount(0);
  await expect(page.getByTitle('Export plugin')).toHaveCount(0);
  await expect(page.getByTitle('Delete plugin')).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Activate', exact: true })
  ).toBeVisible();

  const configure = page.getByRole('button', {
    name: 'Configure',
    exact: true,
  });
  await expect(configure).toHaveAttribute('aria-expanded', 'false');
  await configure.click();

  await expect(page.getByLabel('API Key', { exact: true })).toBeVisible();
  await expect(page.getByLabel('API Endpoint')).toHaveCount(0);
  await expect(page.getByLabel('Base URL', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Model ID', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Connection', { exact: true })).toHaveCount(0);

  const apiKeyInput = page.getByLabel('API Key', { exact: true });
  await apiKeyInput.fill('user-owned-key');
  await page.getByRole('button', { name: 'Save API Key', exact: true }).click();
  await expect
    .poll(() => mockApi.pluginCredentialUpdateRequests.length)
    .toBe(1);
  expect(mockApi.pluginCredentialUpdateRequests[0]).toEqual({
    pluginId: 'user-provider',
    apiKey: 'user-owned-key',
  });
  await expect(apiKeyInput).toBeDisabled();
  await expect(apiKeyInput).toBeEnabled();
  await expect(configure).toHaveAttribute('aria-expanded', 'true');

  const advanced = page.getByRole('button', {
    name: /Advanced parameters/,
  });
  await expect(advanced).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByLabel('Temperature', { exact: true })).toHaveCount(0);
  await advanced.click();

  const temperatureInput = page.getByLabel('Temperature', { exact: true });
  await expect(temperatureInput).toHaveValue('');
  await temperatureInput.fill('0.4');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => mockApi.pluginVariableUpdateRequests.length).toBe(1);
  expect(mockApi.pluginVariableUpdateRequests[0]).toEqual({
    pluginId: 'user-provider',
    variables: { temperature: 0.4 },
    unset: [],
  });
});

test('theme preference survives refresh and retries a failed save', async ({
  page,
}) => {
  await mockLibreWebUiApi(page, {
    preferences: {
      theme: {
        mode: 'light',
        adaptToAccent: false,
        accent: 'blue',
        customAccent: '#2563eb',
      },
    },
    preferenceUpdateFailures: 1,
  });
  await page.addInitScript(() => {
    localStorage.setItem('auth-token', 'e2e-token');
  });
  await page.goto('/chat');

  const html = page.locator('html');
  await expect(page.getByRole('textbox', { name: 'Message...' })).toBeVisible();
  await expect(html).not.toHaveClass(/dark/);

  await page.keyboard.press('Control+,');
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();

  const failedSave = page.waitForResponse(
    response =>
      response.url().endsWith('/api/preferences') &&
      response.request().method() === 'PUT'
  );
  await page.getByRole('button', { name: 'Dark', exact: true }).click();
  await expect(html).toHaveClass(/dark/);
  await expect((await failedSave).status()).toBe(500);

  await page.reload();
  await expect(page.getByRole('textbox', { name: 'Message...' })).toBeVisible();
  await expect(html).toHaveClass(/dark/);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const value = localStorage.getItem('libre-webui-app-state');
        return value ? JSON.parse(value).state.themeSyncPending : undefined;
      })
    )
    .toBe(false);

  await page.keyboard.press('Control+,');
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await page.keyboard.press('Escape');

  const successfulSave = page.waitForResponse(
    response =>
      response.url().endsWith('/api/preferences') &&
      response.request().method() === 'PUT' &&
      response.status() === 200 &&
      response.request().postData()?.includes('"mode":"light"') === true
  );
  await page.getByRole('button', { name: 'Switch to light mode' }).click();
  await successfulSave;
  await expect(html).not.toHaveClass(/dark/);

  await page.reload();
  await expect(html).not.toHaveClass(/dark/);
});

test('accent palette can adapt the full light and dark interface and persists', async ({
  page,
}) => {
  await mockLibreWebUiApi(page, {
    preferences: {
      theme: {
        mode: 'light',
        adaptToAccent: false,
        accent: 'blue',
        customAccent: '#2563eb',
      },
    },
  });
  await page.addInitScript(() => {
    localStorage.setItem('auth-token', 'e2e-token');
  });
  await page.goto('/chat');
  await expect(page.getByRole('textbox', { name: 'Message...' })).toBeVisible();

  const getThemeSnapshot = () =>
    page.evaluate(() => {
      const root = document.documentElement;
      const sidebar = document.querySelector<HTMLElement>(
        '[data-testid="sidebar"]'
      );
      const settingsPanel = document.querySelector<HTMLElement>(
        '[data-testid="settings-modal-panel"]'
      );

      if (!sidebar) {
        throw new Error('Sidebar not found');
      }

      const styles = getComputedStyle(root);
      return {
        mode: root.classList.contains('dark') ? 'dark' : 'light',
        style: root.dataset.themeStyle,
        accent: root.dataset.accent,
        primary: styles.getPropertyValue('--color-primary-500').trim(),
        canvas: styles.getPropertyValue('--color-canvas').trim(),
        surface: styles.getPropertyValue('--color-surface').trim(),
        surfaceRaised: styles.getPropertyValue('--color-surface-raised').trim(),
        ink: styles.getPropertyValue('--color-ink').trim(),
        inkMuted: styles.getPropertyValue('--color-ink-muted').trim(),
        gray50: styles.getPropertyValue('--color-gray-50').trim(),
        gray100: styles.getPropertyValue('--color-gray-100').trim(),
        dark100: styles.getPropertyValue('--color-dark-100').trim(),
        inlineGray100: root.style.getPropertyValue('--color-gray-100').trim(),
        sidebar: getComputedStyle(sidebar).backgroundColor,
        settingsPanel: settingsPanel
          ? getComputedStyle(settingsPanel).backgroundColor
          : null,
      };
    });

  const getChannelSpread = (color: string) => {
    const channels = color.split(/\s+/).map(Number);
    return Math.max(...channels) - Math.min(...channels);
  };

  const getContrastRatio = (foreground: string, background: string) => {
    const getLuminance = (color: string) => {
      const channels = color.split(/\s+/).map(Number);
      const linear = channels.map(channel => {
        const value = channel / 255;
        return value <= 0.03928
          ? value / 12.92
          : Math.pow((value + 0.055) / 1.055, 2.4);
      });
      return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
    };

    const foregroundLuminance = getLuminance(foreground);
    const backgroundLuminance = getLuminance(background);
    const lighter = Math.max(foregroundLuminance, backgroundLuminance);
    const darker = Math.min(foregroundLuminance, backgroundLuminance);
    return (lighter + 0.05) / (darker + 0.05);
  };

  // The sidebar transitions from the pre-hydration shell color. Wait for the
  // saved neutral palette before comparing later accent-only updates.
  await expect
    .poll(async () => (await getThemeSnapshot()).sidebar)
    .toBe('rgb(241, 245, 249)');
  const initialTheme = await getThemeSnapshot();
  expect(initialTheme.style).toBe('default');
  expect(initialTheme.inlineGray100).toBe('');
  expect(initialTheme.gray100).toBe('241 245 249');
  expect(initialTheme.canvas).toBe('247 247 245');

  await page.keyboard.press('Control+,');
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  const defaultSettingsPanel = (await getThemeSnapshot()).settingsPanel;
  expect(defaultSettingsPanel).not.toBeNull();
  await page.getByRole('button', { name: 'Use Rose accent' }).click();

  await expect.poll(async () => (await getThemeSnapshot()).accent).toBe('rose');
  const neutralRoseTheme = await getThemeSnapshot();
  expect(neutralRoseTheme.primary).not.toBe(initialTheme.primary);
  expect(neutralRoseTheme.sidebar).toBe(initialTheme.sidebar);
  expect(neutralRoseTheme.settingsPanel).toBe(defaultSettingsPanel);

  await page.getByRole('button', { name: 'Adapt to accent' }).click();
  await expect
    .poll(async () => (await getThemeSnapshot()).style)
    .toBe('accent');
  await expect
    .poll(async () => (await getThemeSnapshot()).sidebar)
    .not.toBe(initialTheme.sidebar);
  const adaptedRoseTheme = await getThemeSnapshot();
  expect(adaptedRoseTheme.inlineGray100).not.toBe('');
  expect(adaptedRoseTheme.gray100).not.toBe(initialTheme.gray100);
  expect(getChannelSpread(adaptedRoseTheme.gray100)).toBeGreaterThanOrEqual(8);
  expect(adaptedRoseTheme.canvas).not.toBe(initialTheme.canvas);
  expect(adaptedRoseTheme.surface).not.toBe('255 255 255');
  expect(adaptedRoseTheme.surfaceRaised).not.toBe('255 255 255');
  expect(adaptedRoseTheme.sidebar).not.toBe(initialTheme.sidebar);
  expect(adaptedRoseTheme.settingsPanel).not.toBe(defaultSettingsPanel);
  expect(
    getContrastRatio(adaptedRoseTheme.inkMuted, adaptedRoseTheme.canvas)
  ).toBeGreaterThanOrEqual(4.5);

  await page.locator('input[type="color"]').fill('#7c2d92');
  await expect
    .poll(async () => (await getThemeSnapshot()).accent)
    .toBe('custom');
  await expect
    .poll(async () => (await getThemeSnapshot()).sidebar)
    .not.toBe(adaptedRoseTheme.sidebar);
  const adaptedCustomTheme = await getThemeSnapshot();
  expect(adaptedCustomTheme.sidebar).not.toBe(adaptedRoseTheme.sidebar);
  expect(
    getContrastRatio(adaptedCustomTheme.ink, adaptedCustomTheme.canvas)
  ).toBeGreaterThanOrEqual(4.5);
  expect(
    getContrastRatio(adaptedCustomTheme.inkMuted, adaptedCustomTheme.canvas)
  ).toBeGreaterThanOrEqual(4.5);

  await page.getByRole('button', { name: 'Dark', exact: true }).click();
  await expect(page.locator('html')).toHaveClass(/dark/);
  await expect
    .poll(async () => (await getThemeSnapshot()).sidebar)
    .not.toBe(adaptedCustomTheme.sidebar);
  const adaptedDarkTheme = await getThemeSnapshot();
  expect(adaptedDarkTheme.mode).toBe('dark');
  expect(adaptedDarkTheme.style).toBe('accent');
  expect(adaptedDarkTheme.dark100).toBe(adaptedCustomTheme.dark100);
  expect(adaptedDarkTheme.sidebar).not.toBe(adaptedCustomTheme.sidebar);
  expect(
    getContrastRatio(adaptedDarkTheme.ink, adaptedDarkTheme.canvas)
  ).toBeGreaterThanOrEqual(4.5);

  await page.getByRole('button', { name: /^Default/ }).click();
  await expect
    .poll(async () => (await getThemeSnapshot()).style)
    .toBe('default');
  await expect
    .poll(async () => (await getThemeSnapshot()).sidebar)
    .toBe('rgb(10, 10, 11)');
  const defaultDarkTheme = await getThemeSnapshot();
  expect(defaultDarkTheme.inlineGray100).toBe('');
  expect(defaultDarkTheme.canvas).toBe('13 13 12');

  await page.getByRole('button', { name: 'Adapt to accent' }).click();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const value = localStorage.getItem('libre-webui-app-state');
        return value ? JSON.parse(value).state.themeSyncPending : undefined;
      })
    )
    .toBe(false);

  const savedTheme = await getThemeSnapshot();
  await page.keyboard.press('Escape');
  await page.reload();
  await expect(page.getByRole('textbox', { name: 'Message...' })).toBeVisible();

  const restoredTheme = await getThemeSnapshot();
  expect(restoredTheme.mode).toBe('dark');
  expect(restoredTheme.style).toBe('accent');
  expect(restoredTheme.accent).toBe('custom');
  expect(restoredTheme.primary).toBe(savedTheme.primary);
  expect(restoredTheme.canvas).toBe(savedTheme.canvas);
  expect(restoredTheme.sidebar).toBe(savedTheme.sidebar);
});

test('TTS keeps the selected provider for shared model aliases and generation', async ({
  page,
}) => {
  const mockApi = await mockLibreWebUiApi(page, {
    preferences: {
      ttsSettings: {
        enabled: true,
        autoPlay: false,
        model: 'tts-1-hd',
        voice: 'alloy',
        speed: 1,
        pluginId: '',
        streamSentences: false,
      },
    },
    ttsModels: [
      {
        model: 'tts-1-hd',
        plugin: 'openai-tts',
        config: {
          voices: ['alloy'],
          default_voice: 'alloy',
          formats: ['mp3'],
          default_format: 'mp3',
        },
      },
      {
        model: 'tts-1-hd',
        plugin: 'kyutai-tts-1.6b',
        config: {
          voices: ['alba'],
          default_voice: 'alba',
          formats: ['wav'],
          default_format: 'wav',
        },
      },
    ],
    ttsPlugins: [
      {
        id: 'openai-tts',
        name: 'OpenAI TTS',
        models: ['tts-1-hd'],
      },
      {
        id: 'kyutai-tts-1.6b',
        name: 'Kyutai TTS 1.6B',
        models: ['tts-1-hd'],
      },
    ],
  });
  await page.addInitScript(() => {
    localStorage.setItem('auth-token', 'e2e-token');

    class MockAudio {
      currentTime = 0;
      onended: ((event: Event) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;

      pause() {}

      play() {
        queueMicrotask(() => this.onended?.(new Event('ended')));
        return Promise.resolve();
      }
    }

    Object.defineProperty(window, 'Audio', {
      configurable: true,
      value: MockAudio,
    });
  });

  await page.goto('/chat');
  await expect(page.getByRole('textbox', { name: 'Message...' })).toBeVisible();
  await page.keyboard.press('Control+,');
  await page.getByRole('tab', { name: 'Speech' }).click();

  const modelSelect = page.getByRole('combobox', { name: 'TTS Model' });
  await expect(modelSelect).toHaveValue('openai-tts::tts-1-hd');

  const testButton = page.getByRole('button', { name: 'Test', exact: true });
  await testButton.click();
  await expect.poll(() => mockApi.ttsGenerationRequests.length).toBe(1);
  expect(mockApi.ttsGenerationRequests[0]).toMatchObject({
    model: 'tts-1-hd',
    pluginId: 'openai-tts',
    voice: 'alloy',
    response_format: 'mp3',
  });
  await expect(testButton).toBeEnabled();
  mockApi.ttsGenerationRequests.length = 0;

  await modelSelect.selectOption({
    label: 'tts-1-hd (kyutai-tts-1.6b)',
  });
  await expect(modelSelect).toHaveValue('kyutai-tts-1.6b::tts-1-hd');
  await expect(page.getByRole('combobox', { name: 'Voice' })).toHaveValue(
    'alba'
  );

  await page.getByRole('button', { name: 'Save Settings' }).click();
  await testButton.click();

  await expect.poll(() => mockApi.ttsGenerationRequests.length).toBe(1);
  expect(mockApi.ttsGenerationRequests[0]).toMatchObject({
    model: 'tts-1-hd',
    pluginId: 'kyutai-tts-1.6b',
    voice: 'alba',
    response_format: 'wav',
  });

  await page.reload();
  await expect(page.getByRole('textbox', { name: 'Message...' })).toBeVisible();
  await page.keyboard.press('Control+,');
  await page.getByRole('tab', { name: 'Speech' }).click();
  await expect(page.getByRole('combobox', { name: 'TTS Model' })).toHaveValue(
    'kyutai-tts-1.6b::tts-1-hd'
  );
});

test('image generation keeps duplicate model providers distinct through save and generation', async ({
  page,
}) => {
  const sharedModel = 'shared-image-model';
  const mockApi = await mockLibreWebUiApi(page, {
    preferences: {
      imageGenSettings: {
        enabled: true,
        model: sharedModel,
        size: '1024x1024',
        quality: 'standard',
        style: 'vivid',
        pluginId: 'image-provider-one',
      },
    },
    imageGenModels: [
      {
        model: sharedModel,
        plugin: 'image-provider-one',
        config: {
          sizes: ['1024x1024'],
          default_size: '1024x1024',
          qualities: ['standard'],
          default_quality: 'standard',
          styles: ['natural', 'vivid'],
          default_style: 'natural',
        },
      },
      {
        model: sharedModel,
        plugin: 'image-provider-two',
        config: {
          sizes: ['1024x1024'],
          default_size: '1024x1024',
          qualities: ['standard'],
          default_quality: 'standard',
          styles: ['natural', 'vivid'],
          default_style: 'natural',
        },
      },
    ],
    imageGenPlugins: [
      {
        id: 'image-provider-one',
        name: 'Image Provider One',
        models: [sharedModel],
        config: {
          sizes: ['1024x1024'],
          default_size: '1024x1024',
          qualities: ['standard'],
          default_quality: 'standard',
          styles: ['natural', 'vivid'],
          default_style: 'natural',
        },
      },
      {
        id: 'image-provider-two',
        name: 'Image Provider Two',
        models: [sharedModel],
        config: {
          sizes: ['1024x1024'],
          default_size: '1024x1024',
          qualities: ['standard'],
          default_quality: 'standard',
          styles: ['natural', 'vivid'],
          default_style: 'natural',
        },
      },
    ],
  });

  await page.goto('/chat');
  await expect(page.getByRole('textbox', { name: 'Message...' })).toBeVisible();
  await page.keyboard.press('Control+,');
  await page.getByRole('tab', { name: 'Images' }).click();

  const imageSettingsPanel = page.getByRole('tabpanel');
  const modelSelect = imageSettingsPanel.locator('select').first();
  await expect(modelSelect.locator('option')).toHaveText([
    'Select a model',
    `${sharedModel} (image-provider-one)`,
    `${sharedModel} (image-provider-two)`,
  ]);
  await expect(modelSelect).toHaveValue(`image-provider-one::${sharedModel}`);

  await modelSelect.selectOption(`image-provider-two::${sharedModel}`);
  await page.getByRole('button', { name: 'Save Settings' }).click();

  await expect
    .poll(() =>
      mockApi.preferenceUpdateRequests.find(
        request => request.imageGenSettings !== undefined
      )
    )
    .toMatchObject({
      imageGenSettings: {
        enabled: true,
        model: sharedModel,
        pluginId: 'image-provider-two',
      },
    });

  await page.reload();
  await expect(page.getByRole('textbox', { name: 'Message...' })).toBeVisible();
  await page.keyboard.press('Control+,');
  await page.getByRole('tab', { name: 'Images' }).click();
  await expect(
    page.getByRole('tabpanel').locator('select').first()
  ).toHaveValue(`image-provider-two::${sharedModel}`);

  await page.keyboard.press('Escape');
  await expect(imageSettingsPanel).toBeHidden();
  await page.goto('/gallery');
  await expect(page).toHaveURL(/\/gallery$/);
  await page
    .getByRole('button', { name: 'Generate Image', exact: true })
    .click();

  const imageDialog = page.getByRole('dialog', { name: 'Generate Image' });
  const imageDialogSelects = imageDialog.locator('select');
  await expect(imageDialogSelects.nth(0)).toHaveValue('image-provider-two');
  await expect(imageDialogSelects.nth(1)).toHaveValue(sharedModel);
  await imageDialog
    .getByPlaceholder('Describe the image you want to create...')
    .fill('A provider-qualified image');
  await imageDialog
    .getByRole('button', { name: 'Generate', exact: true })
    .click();

  await expect.poll(() => mockApi.imageGenerationRequests.length).toBe(1);
  expect(mockApi.imageGenerationRequests[0]).toMatchObject({
    model: sharedModel,
    pluginId: 'image-provider-two',
    prompt: 'A provider-qualified image',
    size: '1024x1024',
    quality: 'standard',
    style: 'vivid',
  });
});

test('disabled image generation prevents the gallery action', async ({
  page,
}) => {
  await mockLibreWebUiApi(page, {
    preferences: {
      imageGenSettings: {
        enabled: false,
        model: 'disabled-image-model',
        size: '1024x1024',
        quality: 'standard',
        style: 'vivid',
        pluginId: 'disabled-image-provider',
      },
    },
    imageGenPlugins: [
      {
        id: 'disabled-image-provider',
        name: 'Disabled Image Provider',
        models: ['disabled-image-model'],
      },
    ],
  });

  await page.goto('/gallery');

  const generateImageButton = page.getByRole('button', {
    name: 'Generate Image',
    exact: true,
  });
  await expect(generateImageButton).toBeDisabled();
  await expect(
    page.getByRole('dialog', { name: 'Generate Image' })
  ).toHaveCount(0);
});
