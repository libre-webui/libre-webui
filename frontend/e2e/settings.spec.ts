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

test('admin provider settings are collapsed, inherited, sparse, and retryable', async ({
  page,
}) => {
  const mockApi = await mockLibreWebUiApi(page, {
    authRole: 'admin',
    systemInfo: {
      requiresAuth: true,
      hasUsers: true,
      userCount: 2,
      allowUserModelPull: true,
      version: '0.10.0-e2e',
      turnstile: { enabled: false },
    },
    plugins: [
      {
        id: 'custom-provider',
        name: 'Custom Provider',
        type: 'completion',
        endpoint: 'https://provider.example/v1/chat/completions',
        auth: {
          header: 'Authorization',
          prefix: 'Bearer ',
          key_env: 'CUSTOM_PROVIDER_API_KEY',
        },
        model_map: ['custom-model'],
        active: true,
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
  await expect(page.getByText(/Default endpoint/)).toHaveCount(0);
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
  const baseUrlInput = page.getByLabel('Base URL', { exact: true });
  await expect(baseUrlInput).toHaveValue('');
  await expect(baseUrlInput).toHaveAttribute(
    'placeholder',
    'Use provider default (https://provider.example/v1)'
  );
  const modelIdInput = page.getByLabel('Model ID', { exact: true });
  await expect(modelIdInput).toHaveValue('');
  await expect(modelIdInput).toHaveAttribute(
    'placeholder',
    'Use provider default (custom-model)'
  );

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
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => mockApi.pluginVariableUpdateRequests.length).toBe(1);
  expect(mockApi.pluginVariableUpdateRequests[0]).toEqual({
    pluginId: 'custom-provider',
    variables: {},
    unset: ['endpoint'],
  });

  const secretInput = page.getByLabel('Secret Header', { exact: true });
  await expect(secretInput).toHaveAttribute('type', 'password');
  await secretInput.fill('temporary-plaintext-secret');
  await page.getByRole('button', { name: 'Show Secret Header value' }).click();
  await expect(secretInput).toHaveAttribute('type', 'text');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => mockApi.pluginVariableUpdateRequests.length).toBe(2);
  expect(mockApi.pluginVariableUpdateRequests[1]).toEqual({
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
      allowUserModelPull: true,
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
  await page.getByRole('tab', { name: 'Text-to-Speech' }).click();

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
  await page.getByRole('tab', { name: 'Text-to-Speech' }).click();
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
  await page.getByRole('tab', { name: 'Image Generation' }).click();

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
  await page.getByRole('tab', { name: 'Image Generation' }).click();
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
