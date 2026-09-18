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
import type { ChatSession } from '../src/types';
import { defaultSystemInfo, mockLibreWebUiApi } from './lib/mockApi';
import { openSettingsTab } from './lib/settingsTab';

const MODEL_A = 'dsh:lwui:plugin:codex-oauth:gpt-5.6-sol';
const MODEL_B = 'dsh:lwui:plugin:local-gateway:lab%2Fmodel%3Alatest';
const CURRENT_MODEL = '__current_running_model__';
const TITLE = 'DSH Provider-Specific Conversation';
const REPLY = 'The selected DSH model answered successfully.';
const SESSION_ID = 'dsh-selected-model-session';
const names = {
  [MODEL_A]: 'DeepSeek Harness · gpt-5.6-sol (Codex (ChatGPT))',
  [MODEL_B]: 'DeepSeek Harness · lab/model:latest (Local Gateway)',
};
const key = (model: string) => `agent:dsh:${encodeURIComponent(model)}`;
const plugins = [
  { id: 'codex-oauth', name: 'Codex (ChatGPT)', model_map: ['gpt-5.6-sol'] },
  {
    id: 'local-gateway',
    name: 'Local Gateway',
    model_map: ['lab/model:latest'],
  },
].map(plugin => ({
  ...plugin,
  type: 'completion' as const,
  active: true,
  endpoint: 'https://provider.example.invalid/v1/chat/completions',
  api_mode: 'chat_completions' as const,
  auth: { header: 'Authorization', key_env: 'FIXTURE_KEY' },
}));
const agents = [
  { id: 'dsh', agentId: 'dsh', name: 'DeepSeek Harness' },
  { id: MODEL_A, agentId: 'dsh', name: names[MODEL_A] },
  { id: MODEL_B, agentId: 'dsh', name: names[MODEL_B] },
  { id: 'codex', agentId: 'codex', name: 'Codex' },
  {
    id: 'opencode:openai/gpt-5',
    agentId: 'opencode',
    name: 'OpenCode · GPT-5',
  },
  { id: 'pi', agentId: 'pi', name: 'Pi' },
].map(agent => ({
  ...agent,
  command: agent.agentId === 'dsh' ? '' : agent.agentId,
  binaryPath: '',
}));

type Generation = { sessionId: string; body: Record<string, unknown> };
async function setup(page: Page) {
  let agentCatalog: typeof agents | null = agents;
  const preferences = {
    defaultModel: 'gpt-5.6-sol',
    defaultProviderType: 'plugin',
    defaultProviderId: 'codex-oauth',
    titleSettings: {
      autoTitle: true,
      taskModel: '',
      taskProviderType: null,
      taskProviderId: null,
    },
  };
  const systemInfo = {
    ...defaultSystemInfo,
    requiresAuth: true,
    agentsEnabled: false,
    agentCliModelsEnabled: true,
    cordisEnabled: true,
    ollamaEnabled: false,
  };
  await mockLibreWebUiApi(page, {
    systemInfo,
    models: [],
    plugins,
    preferences,
    authUsers: [
      {
        id: 'dsh-ui-admin',
        username: 'admin',
        email: null,
        role: 'admin',
        status: 'active',
        token: 'dsh-ui-token',
        preferences,
      },
    ],
    chatStream: { chunks: [REPLY], completionDelayMs: 100 },
  });
  await page.addInitScript(() =>
    localStorage.setItem('auth-token', 'dsh-ui-token')
  );
  await page.route('**/api/agent-clis/models', route =>
    agentCatalog === null
      ? route.fulfill({
          status: 503,
          json: {
            success: false,
            error: 'Agent catalog temporarily unavailable',
          },
        })
      : route.fulfill({ json: { success: true, data: agentCatalog } })
  );
  await page.route('**/api/ollama/settings', route =>
    route.fulfill({
      json: {
        success: true,
        data: { enabled: false, baseUrl: 'http://localhost:11434' },
      },
    })
  );
  await page.route('**/api/ollama/health', route =>
    route.fulfill({
      json: { success: true, data: { status: 'disabled', enabled: false } },
    })
  );
  await page.route('**/api/ollama/running', route =>
    route.fulfill({ json: { success: true, data: [] } })
  );

  const defaultWrites: Array<Record<string, unknown>> = [];
  const preferenceWrites: Array<Record<string, unknown>> = [];
  const creates: Array<Record<string, unknown>> = [];
  const generations: Generation[] = [];
  const titles: Array<Record<string, unknown>> = [];
  const sessions = new Map<string, ChatSession>();
  let savedPreferences: Record<string, unknown> = { ...preferences };
  await page.route('**/api/preferences/default-model', async route => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    defaultWrites.push(body);
    savedPreferences = {
      ...savedPreferences,
      defaultModel: body.model,
      defaultProviderType: body.providerType,
      defaultProviderId: body.providerId,
    };
    await route.fulfill({ json: { success: true, data: savedPreferences } });
  });
  await page.route('**/api/chat/sessions', async route => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON() as {
        model: string;
        providerType: 'agent';
        providerId: string;
        title?: string;
      };
      creates.push(body);
      const session: ChatSession = {
        id: SESSION_ID,
        title: body.title ?? 'New Chat',
        model: body.model,
        providerType: body.providerType,
        providerId: body.providerId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messages: [],
      };
      sessions.set(session.id, session);
      return route.fulfill({ json: { success: true, data: session } });
    }
    return route.fulfill({
      json: { success: true, data: [...sessions.values()] },
    });
  });
  await page.route(`**/api/chat/sessions/${SESSION_ID}`, async route => {
    const session = sessions.get(SESSION_ID);
    if (!session)
      return route.fulfill({ status: 404, json: { success: false } });
    if (route.request().method() === 'PUT')
      Object.assign(session, route.request().postDataJSON());
    return route.fulfill({ json: { success: true, data: session } });
  });
  await page.route(
    `**/api/chat/sessions/${SESSION_ID}/generate-title`,
    async route => {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      titles.push({ sessionId: SESSION_ID, ...body });
      const session = sessions.get(SESSION_ID)!;
      session.title = TITLE;
      session.updatedAt = Date.now();
      await route.fulfill({
        json: {
          success: true,
          data: {
            title: TITLE,
            source: 'plugin',
            updatedAt: session.updatedAt,
          },
        },
      });
    }
  );
  await page.exposeFunction(
    'recordDshFixtureGeneration',
    (generation: Generation) => {
      generations.push(generation);
      const session = sessions.get(generation.sessionId)!;
      session.messages.push(
        {
          id: String(generation.body.userMessageId),
          role: 'user',
          content: String(generation.body.message),
          timestamp: Date.now(),
        },
        {
          id: String(generation.body.assistantMessageId),
          role: 'assistant',
          content: REPLY,
          model: session.model,
          timestamp: Date.now(),
        }
      );
    }
  );
  const firstPreferences = page.waitForResponse(
    response =>
      new URL(response.url()).pathname === '/api/preferences' &&
      response.request().method() === 'GET'
  );
  await page.goto('/chat');
  savedPreferences = { ...(await (await firstPreferences).json()).data };
  await page.route('**/api/preferences', async route => {
    if (route.request().method() === 'PUT') {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      preferenceWrites.push(body);
      savedPreferences = { ...savedPreferences, ...body };
    }
    await route.fulfill({ json: { success: true, data: savedPreferences } });
  });
  // The shared browser fixture owns the SSE transport. Observe the actual
  // enqueue request and persist its messages in this fixture's session store.
  await page.evaluate(() => {
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = new URL(
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
        location.href
      );
      const match = url.pathname.match(
        /^\/api\/chat\/sessions\/([^/]+)\/generations$/
      );
      if (match && init?.method === 'POST') {
        await (
          window as unknown as {
            recordDshFixtureGeneration(value: {
              sessionId: string;
              body: Record<string, unknown>;
            }): Promise<void>;
          }
        ).recordDshFixtureGeneration({
          sessionId: decodeURIComponent(match[1]),
          body: JSON.parse(String(init.body)),
        });
      }
      return originalFetch(input, init);
    };
  });
  return {
    defaultWrites,
    preferenceWrites,
    creates,
    generations,
    titles,
    sessions,
    setAgentCatalog: (catalog: typeof agents | null) => {
      agentCatalog = catalog;
    },
    savedPreferences: () => structuredClone(savedPreferences),
  };
}

async function openChatModels(page: Page) {
  await page
    .locator('main button[aria-haspopup="dialog"]')
    .filter({ hasText: /gpt-5.6-sol|DeepSeek Harness/ })
    .first()
    .click();
  const picker = page.getByRole('dialog', { name: 'Select a model' });
  await expect(picker).toBeVisible();
  return picker;
}

test('model-specific DSH choices keep opaque IDs in Chat, default, vision and task selectors', async ({
  page,
}) => {
  const fixture = await setup(page);
  const picker = await openChatModels(page);
  for (const model of [MODEL_A, MODEL_B]) {
    await expect(
      picker.locator(`[data-model-value="${key(model)}"]`)
    ).toContainText(names[model]);
  }
  await expect(
    picker.locator('[data-model-value="agent:dsh:dsh"]')
  ).toContainText('DeepSeek Harness');
  await expect(
    picker.locator('[data-model-value="agent:codex:codex"]')
  ).toContainText('Codex');
  await expect(
    picker.locator('[data-model-value="agent:pi:pi"]')
  ).toContainText('Pi');
  await expect(
    picker.locator('[data-model-value="plugin:codex-oauth:gpt-5.6-sol"]')
  ).toBeVisible();
  await page.keyboard.press('Escape');
  const panel = await openSettingsTab(page, 'models');
  for (const id of [
    'default-model-select',
    'vision-model-select',
    'task-model-select',
  ]) {
    const selector = panel.getByTestId(id);
    for (const model of [MODEL_A, MODEL_B]) {
      await expect(
        selector.locator(`option[value="${key(model)}"]`)
      ).toContainText(names[model]);
    }
  }
  await panel.getByTestId('default-model-select').selectOption(key(MODEL_A));
  await expect
    .poll(() => fixture.defaultWrites.at(-1))
    .toEqual({ model: MODEL_A, providerType: 'agent', providerId: 'dsh' });
  await panel.getByTestId('task-model-select').selectOption(key(MODEL_B));
  await expect
    .poll(
      () =>
        fixture.preferenceWrites.findLast(write => 'titleSettings' in write)
          ?.titleSettings
    )
    .toEqual({
      autoTitle: true,
      taskModel: MODEL_B,
      taskProviderType: 'agent',
      taskProviderId: 'dsh',
    });
  await panel.getByTestId('vision-model-select').selectOption(key(MODEL_A));
  await expect
    .poll(() =>
      fixture.preferenceWrites.findLast(write => 'visionModel' in write)
    )
    .toEqual({
      visionModel: MODEL_A,
      visionProviderType: 'agent',
      visionProviderId: 'dsh',
    });
  await page.reload();
  const reloaded = await openSettingsTab(page, 'models');
  await expect(reloaded.getByTestId('default-model-select')).toHaveValue(
    key(MODEL_A)
  );
  await expect(reloaded.getByTestId('task-model-select')).toHaveValue(
    key(MODEL_B)
  );
  await expect(reloaded.getByTestId('vision-model-select')).toHaveValue(
    key(MODEL_A)
  );
});

for (const titleMode of ['explicit', 'current-running'] as const) {
  test(`a selected DSH provider model creates, streams and titles a chat with ${titleMode} title routing`, async ({
    page,
  }) => {
    const fixture = await setup(page);
    const panel = await openSettingsTab(page, 'models');
    await panel.getByTestId('default-model-select').selectOption(key(MODEL_A));
    await panel
      .getByTestId('task-model-select')
      .selectOption(titleMode === 'explicit' ? key(MODEL_B) : CURRENT_MODEL);
    await page.keyboard.press('Escape');
    const picker = await openChatModels(page);
    await picker.locator(`[data-model-value="${key(MODEL_A)}"]`).click();
    const prompt = 'Explain the selected model and name this conversation';
    const input = page.getByRole('textbox', {
      name: 'Message...',
      exact: true,
    });
    await input.fill(prompt);
    await input.press('Enter');
    await expect
      .poll(() => fixture.creates.at(-1))
      .toMatchObject({
        model: MODEL_A,
        providerType: 'agent',
        providerId: 'dsh',
      });
    await expect.poll(() => fixture.generations.length).toBe(1);
    expect(fixture.generations[0].sessionId).toBe(SESSION_ID);
    expect(fixture.generations[0].body.message).toBe(prompt);
    expect(fixture.sessions.get(SESSION_ID)).toMatchObject({
      model: MODEL_A,
      providerType: 'agent',
      providerId: 'dsh',
    });
    await expect
      .poll(() => fixture.titles)
      .toEqual([
        {
          sessionId: SESSION_ID,
          message: prompt,
          model: titleMode === 'explicit' ? MODEL_B : CURRENT_MODEL,
          providerType: titleMode === 'explicit' ? 'agent' : null,
          providerId: titleMode === 'explicit' ? 'dsh' : null,
        },
      ]);
    await expect(
      page
        .getByTestId('sidebar-session-scroll-region')
        .getByText(TITLE, { exact: true })
    ).toBeVisible();
    await expect(
      page.getByText('Chat title generated', { exact: true })
    ).toBeVisible();
    await expect(
      page.getByText('Could not generate a title; using the message preview', {
        exact: true,
      })
    ).toHaveCount(0);
    await expect(page.getByText(REPLY, { exact: true })).toBeVisible();
    await expect(page.getByTitle('Stop generation')).toHaveCount(0);
    await page.reload();
    await expect(
      page
        .getByTestId('sidebar-session-scroll-region')
        .getByText(TITLE, { exact: true })
    ).toBeVisible();
    await expect(page.getByText(REPLY, { exact: true })).toBeVisible();
  });
}

for (const availability of ['missing alias', 'offline catalog'] as const) {
  test(`reload preserves the configured DSH identity with a ${availability} and never chooses a plugin fallback`, async ({
    page,
  }) => {
    const fixture = await setup(page);
    const panel = await openSettingsTab(page, 'models');
    await panel.getByTestId('default-model-select').selectOption(key(MODEL_A));
    await expect
      .poll(() => fixture.defaultWrites.at(-1))
      .toEqual({ model: MODEL_A, providerType: 'agent', providerId: 'dsh' });
    fixture.setAgentCatalog(
      availability === 'missing alias'
        ? agents.filter(agent => agent.id !== MODEL_A)
        : null
    );
    fixture.defaultWrites.length = 0;
    fixture.preferenceWrites.length = 0;
    await page.reload();
    const reloaded = await openSettingsTab(page, 'models');
    const selector = reloaded.getByTestId('default-model-select');
    await expect(selector).toHaveValue(key(MODEL_A));
    await expect(
      selector.locator(`option[value="${key(MODEL_A)}"]`)
    ).toContainText('unavailable');
    await expect(
      selector.locator('option[value="plugin:codex-oauth:gpt-5.6-sol"]')
    ).toHaveCount(1);
    const unavailable = `Selected model "${MODEL_A}" is unavailable from dsh. Reactivate that provider or select another model.`;
    await expect(
      page.getByText(unavailable, { exact: true }).first()
    ).toBeVisible();
    await expect(
      page.getByText(
        `Selected model "${MODEL_A}" is unavailable from Ollama. Reactivate that provider or select another model.`,
        { exact: true }
      )
    ).toHaveCount(0);
    expect(fixture.defaultWrites).toEqual([]);
    expect(
      fixture.preferenceWrites.filter(write => 'defaultModel' in write)
    ).toEqual([]);
    expect(fixture.savedPreferences()).toMatchObject({
      defaultModel: MODEL_A,
      defaultProviderType: 'agent',
      defaultProviderId: 'dsh',
    });
    // A restored catalogue makes the same choice usable again; there is no
    // intervening preference write selecting the first provider model.
    fixture.setAgentCatalog(agents);
    await page.keyboard.press('Escape');
    const recovered = await openSettingsTab(page, 'models');
    await expect(recovered.getByTestId('default-model-select')).toHaveValue(
      key(MODEL_A)
    );
    await expect(
      recovered
        .getByTestId('default-model-select')
        .locator(`option[value="${key(MODEL_A)}"]`)
    ).toHaveText(`${names[MODEL_A]} (Agent)`);
    expect(fixture.defaultWrites).toEqual([]);
  });
}
