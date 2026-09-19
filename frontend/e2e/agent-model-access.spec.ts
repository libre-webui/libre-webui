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

for (const toggle of ['cli', 'cordis', 'claw'] as const) {
  test(`changing ${toggle} access updates only its Chat model access without a reload`, async ({
    page,
  }) => {
    let clawEnabled = false;
    let cliEnabled = toggle !== 'cli';
    let cordisEnabled = toggle !== 'cordis';
    let modelReads = 0;
    await mockLibreWebUiApi(page, {
      systemInfo: {
        ...defaultSystemInfo,
        requiresAuth: true,
        agentsEnabled: clawEnabled,
        agentCliModelsEnabled: cliEnabled,
        cordisEnabled,
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
      const models = cliEnabled
        ? [
            ...legacy,
            ...(cordisEnabled
              ? [
                  {
                    id: 'dsh',
                    name: 'DeepSeek Harness',
                    agentId: 'dsh',
                    command: '',
                    binaryPath: '',
                  },
                ]
              : []),
          ]
        : [];
      await route.fulfill({ json: { success: true, data: models } });
    });
    await page.route('**/api/libre-claw/access', async route => {
      if (route.request().method() === 'PUT')
        clawEnabled = route.request().postDataJSON().enabled;
      await route.fulfill({
        json: {
          success: true,
          data: { enabled: clawEnabled, lockedByEnv: false },
        },
      });
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
    await page.route('**/api/cordis/access', async route => {
      if (route.request().method() === 'PUT')
        cordisEnabled = route.request().postDataJSON().enabled;
      await route.fulfill({
        json: { success: true, enabled: cordisEnabled, lockedByEnv: false },
      });
    });
    await page.goto('/chat');
    let picker = await openPicker(page);
    for (const agent of legacy) {
      await expect(picker.getByText(agent.name, { exact: true })).toHaveCount(
        toggle === 'cli' ? 0 : 1
      );
    }
    await expect(
      picker.getByText('DeepSeek Harness', { exact: true })
    ).toHaveCount(toggle === 'claw' ? 1 : 0);
    await expect(
      picker.getByText('plugin-chat-model', { exact: true })
    ).toBeVisible();
    await page.keyboard.press('Escape');
    // The chat category remains available even while Libre Claw navigation is off.
    await expect(
      page
        .getByRole('navigation', { name: 'Explore' })
        .getByRole('link', { name: 'Agents', exact: true })
    ).toHaveCount(0);

    await openAccess(page);
    await expect(
      page
        .getByTestId('agent-access-settings')
        .getByRole('heading', { name: 'Libre Claw', exact: true })
    ).toBeVisible();
    await expect(
      page
        .getByTestId('agent-cli-access-settings')
        .getByRole('heading', { name: 'Agent CLI models', exact: true })
    ).toBeVisible();
    const card = page.getByTestId(
      toggle === 'cli'
        ? 'agent-cli-access-settings'
        : toggle === 'claw'
          ? 'agent-access-settings'
          : 'cordis-access-settings'
    );
    await expect(card.getByRole('checkbox')).not.toBeChecked();
    const previousReads = modelReads;
    await card.locator('label').click();
    await expect.poll(() => modelReads).toBeGreaterThan(previousReads);
    await expect(card.getByRole('checkbox')).toBeEnabled();
    await page.keyboard.press('Escape');
    picker = await openPicker(page);
    await expect(picker.getByText('Agents (4)', { exact: true })).toBeVisible();
    for (const agent of legacy) {
      await expect(picker.getByText(agent.name, { exact: true })).toHaveCount(
        1
      );
    }
    await expect(
      picker.getByText('DeepSeek Harness', { exact: true })
    ).toBeVisible();
    await expect(
      picker.getByText('plugin-chat-model', { exact: true })
    ).toBeVisible();
    await page.keyboard.press('Escape');

    await openAccess(page);
    const beforeDisable = modelReads;
    await card.locator('label').click();
    await expect.poll(() => modelReads).toBeGreaterThan(beforeDisable);
    await expect(card.getByRole('checkbox')).toBeEnabled();
    await page.keyboard.press('Escape');
    picker = await openPicker(page);
    await expect(
      picker.getByText('DeepSeek Harness', { exact: true })
    ).toHaveCount(toggle === 'claw' ? 1 : 0);
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
