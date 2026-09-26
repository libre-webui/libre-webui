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

const legacy = [
  { id: 'pi', name: 'Pi' },
  {
    id: 'opencode:test-model',
    name: 'OpenCode · Test Model',
    agentId: 'opencode',
  },
  { id: 'codex', name: 'Codex' },
].map(agent => ({
  ...agent,
  agentId: agent.agentId ?? agent.id,
  command: agent.agentId ?? agent.id,
  binaryPath: '/fixture/bin/agent',
}));

const strandsAgent = {
  id: 'strands',
  name: 'Strands',
  agentId: 'strands',
  command: 'strands',
  binaryPath: '',
};

type StrandsMode = 'disabled' | 'admins' | 'all-users';

async function openPicker(page: Page) {
  await page
    .locator('main button[aria-haspopup="dialog"]')
    .filter({ hasText: 'llama3.2:3b' })
    .first()
    .click();
  const picker = page.getByRole('dialog', { name: 'Select a model' });
  await expect(picker).toBeVisible();
  return picker;
}

async function openAccess(page: Page) {
  await page.keyboard.press('Control+,');
  await page.getByRole('tab', { name: 'User Management', exact: true }).click();
  await page
    .getByRole('tab', { name: 'Access & policies', exact: true })
    .click();
}

for (const toggle of ['cli', 'strands'] as const) {
  test(`changing ${toggle} access updates only its Chat model access without a reload`, async ({
    page,
  }) => {
    let cliEnabled = toggle !== 'cli';
    let strandsMode: StrandsMode = toggle === 'strands' ? 'disabled' : 'admins';
    let modelReads = 0;
    await mockLibreWebUiApi(page, {
      systemInfo: {
        ...defaultSystemInfo,
        requiresAuth: true,
        agentCliModelsEnabled: cliEnabled,
        strandsAccess: strandsMode,
      },
      authUsers: [
        {
          id: 'admin',
          username: 'admin',
          email: null,
          role: 'admin',
          status: 'active',
          token: 'admin-token',
        },
      ],
      models: [
        { name: 'llama3.2:3b', size: 0, digest: '', modified_at: '' },
        {
          name: 'plugin-chat-model',
          size: 0,
          digest: '',
          modified_at: '',
          isPlugin: true,
          pluginId: 'separate-provider',
          pluginName: 'Separate Provider',
        },
      ],
    });
    await page.addInitScript(() =>
      localStorage.setItem('auth-token', 'admin-token')
    );
    await page.route('**/api/agent-clis/models', async route => {
      modelReads += 1;
      // Mirrors the backend: installed CLIs follow the CLI opt-in, while the
      // embedded Strands engine follows its own access mode.
      const models = [
        ...(cliEnabled ? legacy : []),
        ...(strandsMode !== 'disabled' ? [strandsAgent] : []),
      ];
      await route.fulfill({ json: { success: true, data: models } });
    });
    await page.route('**/api/agent-clis/access', async route => {
      if (route.request().method() === 'PUT')
        cliEnabled = route.request().postDataJSON().enabled;
      await route.fulfill({
        json: {
          success: true,
          data: { enabled: cliEnabled, lockedByEnv: false },
        },
      });
    });
    await page.route('**/api/strands/access', async route => {
      if (route.request().method() === 'PUT')
        strandsMode = route.request().postDataJSON().mode;
      await route.fulfill({
        json: {
          success: true,
          data: { mode: strandsMode, lockedByEnv: false },
        },
      });
    });
    await page.goto('/chat');
    let picker = await openPicker(page);
    for (const agent of legacy) {
      await expect(picker.getByText(agent.name, { exact: true })).toHaveCount(
        toggle === 'cli' ? 0 : 1
      );
    }
    await expect(picker.getByText('Strands', { exact: true })).toHaveCount(
      toggle === 'strands' ? 0 : 1
    );
    await expect(
      picker.getByText('plugin-chat-model', { exact: true })
    ).toBeVisible();
    await page.keyboard.press('Escape');

    await openAccess(page);
    await expect(
      page
        .getByTestId('agent-cli-access-settings')
        .getByRole('heading', { name: 'Agent CLI models', exact: true })
    ).toBeVisible();
    await expect(
      page
        .getByTestId('strands-access-settings')
        .getByRole('heading', { name: 'Strands engine', exact: true })
    ).toBeVisible();

    const enable = async () => {
      const previousReads = modelReads;
      if (toggle === 'cli') {
        const card = page.getByTestId('agent-cli-access-settings');
        await expect(card.getByRole('checkbox')).not.toBeChecked();
        await card.locator('label').click();
        await expect.poll(() => modelReads).toBeGreaterThan(previousReads);
        await expect(card.getByRole('checkbox')).toBeEnabled();
      } else {
        const select = page.getByTestId('strands-access-mode');
        await expect(select).toHaveValue('disabled');
        await select.selectOption('admins');
        await expect.poll(() => modelReads).toBeGreaterThan(previousReads);
        await expect(select).toBeEnabled();
      }
    };
    const disable = async () => {
      const previousReads = modelReads;
      if (toggle === 'cli') {
        const card = page.getByTestId('agent-cli-access-settings');
        await card.locator('label').click();
        await expect.poll(() => modelReads).toBeGreaterThan(previousReads);
        await expect(card.getByRole('checkbox')).toBeEnabled();
      } else {
        const select = page.getByTestId('strands-access-mode');
        await select.selectOption('disabled');
        await expect.poll(() => modelReads).toBeGreaterThan(previousReads);
        await expect(select).toBeEnabled();
      }
    };

    await enable();
    await page.keyboard.press('Escape');
    picker = await openPicker(page);
    await expect(picker.getByText('Agents (4)', { exact: true })).toBeVisible();
    for (const agent of legacy) {
      await expect(picker.getByText(agent.name, { exact: true })).toHaveCount(
        1
      );
    }
    await expect(picker.getByText('Strands', { exact: true })).toBeVisible();
    await expect(
      picker.getByText('plugin-chat-model', { exact: true })
    ).toBeVisible();
    await page.keyboard.press('Escape');

    await openAccess(page);
    await disable();
    await page.keyboard.press('Escape');
    picker = await openPicker(page);
    await expect(picker.getByText('Strands', { exact: true })).toHaveCount(
      toggle === 'strands' ? 0 : 1
    );
    for (const agent of legacy) {
      await expect(picker.getByText(agent.name, { exact: true })).toHaveCount(
        toggle === 'cli' ? 0 : 1
      );
    }
    await expect(
      picker.getByText('plugin-chat-model', { exact: true })
    ).toBeVisible();
  });
}
