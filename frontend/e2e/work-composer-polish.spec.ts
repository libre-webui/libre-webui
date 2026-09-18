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

import { expect, test, type Locator, type Page } from '@playwright/test';
import { mockLibreWebUiApi } from './lib/mockApi';

const modelName = 'local-research-and-software-development-assistant:32b';
const createdAt = 1_780_000_000_000;
const model = {
  name: modelName,
  size: 20_000_000_000,
  digest: 'work-polish-model',
  modified_at: new Date(createdAt).toISOString(),
  details: {
    format: 'gguf',
    family: 'llama',
    families: ['llama'],
    parameter_size: '32B',
    quantization_level: 'Q4_0',
  },
};

async function assertContained(control: Locator, container: Locator) {
  const controlBox = await control.boundingBox();
  const containerBox = await container.boundingBox();
  expect(controlBox).not.toBeNull();
  expect(containerBox).not.toBeNull();
  expect(controlBox!.x).toBeGreaterThanOrEqual(containerBox!.x);
  expect(controlBox!.x + controlBox!.width).toBeLessThanOrEqual(
    containerBox!.x + containerBox!.width
  );
  expect(controlBox!.y).toBeGreaterThanOrEqual(containerBox!.y);
  expect(controlBox!.y + controlBox!.height).toBeLessThanOrEqual(
    containerBox!.y + containerBox!.height
  );
}

async function setPageLanguage(page: Page, language: string) {
  await page.addInitScript(locale => {
    localStorage.setItem('i18nextLng', locale);
  }, language);
}

const nativeModels = ['flash', 'pro'].map(name => ({
  model: `deepseek-v4-${name}`,
  providerType: 'dsh' as const,
  providerId: 'deepseek',
  key: `dsh:deepseek:deepseek-v4-${name}`,
  label: `${name === 'flash' ? 'Flash' : 'Pro'} · DeepSeek`,
  remote: true,
}));

async function openConfiguredLanding(
  page: Page,
  mode: 'light' | 'dark',
  language = 'en'
) {
  await mockLibreWebUiApi(page, {
    models: [model],
    preferences: {
      defaultModel: modelName,
      defaultProviderType: 'ollama',
      theme: {
        mode,
        adaptToAccent: false,
        accent: 'blue',
        customAccent: '#2563eb',
      },
    },
    personas: [
      {
        id: 'researcher',
        name: 'Research assistant',
        model: modelName,
        parameters: {},
        user_id: 'user-1',
        created_at: createdAt,
        updated_at: createdAt,
      },
    ],
    sttModels: [{ model: 'whisper', plugin: 'local-speech' }],
    workCapabilities: {
      available: true,
      runtime: 'docker',
      runtimeAvailable: true,
      ollamaAvailable: true,
      image: 'work-test',
      nativeDsh: { status: 'ready', models: nativeModels },
      hostWorkspaces: { enabled: true, roots: ['/projects'] },
    },
  });
  await page.route('**/api/work/policies', route =>
    route.fulfill({
      json: {
        success: true,
        data: [
          { id: 'local-policy', name: 'Local workspace', guiEnabled: true },
        ],
      },
    })
  );
  await setPageLanguage(page, language);
  await page.goto('/work');
  await expect(page.getByTestId('work-engine-select')).toBeEnabled();
}

for (const mode of ['light', 'dark'] as const) {
  test(`desktop landing aligns labeled engine and model controls with a visible Run action in ${mode}`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await openConfiguredLanding(page, mode);
    const landing = page.getByTestId('work-landing');
    await expect(
      landing.getByRole('heading', { name: 'What would you like to work on?' })
    ).toBeVisible();
    const input = page.getByTestId('work-composer-input');
    await input.fill(
      'Build a dashboard that compares this month’s project results.'
    );
    const engine = page.getByTestId('work-engine-select');
    const localModel = page.getByTestId('work-model-selector-trigger');
    await expect(engine).toHaveAccessibleName('Engine');
    await expect(
      page
        .getByTestId('work-composer-toolbar')
        .getByText('Model', { exact: true })
    ).toBeVisible();
    const engineBox = (await engine.boundingBox())!;
    const localBox = (await localModel.boundingBox())!;
    expect(engineBox.y + engineBox.height).toBeCloseTo(
      localBox.y + localBox.height,
      0
    );
    await engine.selectOption('dsh');
    const nativeModel = page.getByTestId('work-model-select');
    await nativeModel.selectOption(nativeModels[0].key);
    await page.getByTestId('work-provider-disclosure-dismiss').click();
    await expect(nativeModel).toBeFocused();
    const send = page.getByTestId('work-submit-button');
    await expect(send.getByText('Run', { exact: true })).toBeVisible();
    await expect(send).toBeEnabled();
    const surface = page.getByTestId('work-composer-surface');
    const controls = [engine, nativeModel, send];
    for (const control of controls) {
      await assertContained(control, surface);
      expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    const boxes = await Promise.all(
      controls.map(control => control.boundingBox())
    );
    const bottom = boxes[0]!.y + boxes[0]!.height;
    for (const box of boxes.slice(1))
      expect(box!.y + box!.height).toBeCloseTo(bottom, 0);
    expect((await input.boundingBox())!.height).toBeGreaterThanOrEqual(100);
    await landing.screenshot({
      path: testInfo.outputPath(`work-landing-desktop-${mode}.png`),
    });
  });
}

for (const variant of [
  { mode: 'light' as const, language: 'en' },
  { mode: 'dark' as const, language: 'ar' },
]) {
  test(`native landing controls stack at 320px and preserve drafts and dismissal focus in ${variant.language}`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 320, height: 844 });
    await openConfiguredLanding(page, variant.mode, variant.language);
    await page.getByTestId('sidebar-toggle-size').click();
    const input = page.getByTestId('work-composer-input');
    const draft = 'Build a local research dashboard without losing this draft.';
    await input.fill(draft);
    const engine = page.getByTestId('work-engine-select');
    await engine.selectOption('dsh');
    const nativeModel = page.getByTestId('work-model-select');
    await expect(
      nativeModel.locator('optgroup').first().locator('option')
    ).toHaveText(['Flash · DeepSeek', 'Pro · DeepSeek']);
    await nativeModel.selectOption(nativeModels[0].key);
    await expect(input).toHaveValue(draft);
    await expect(
      page.getByTestId('work-provider-disclosure-popover')
    ).toBeVisible();
    await page.getByTestId('work-provider-disclosure-dismiss').click();
    await expect(
      page.getByTestId('work-provider-disclosure-popover')
    ).toHaveCount(0);
    await expect(nativeModel).toBeFocused();
    await nativeModel.selectOption(nativeModels[1].key);
    await expect(input).toHaveValue(draft);
    await engine.selectOption('libre');
    await expect(input).toHaveValue(draft);
    await engine.selectOption('dsh');
    await nativeModel.selectOption(nativeModels[1].key);
    await expect(input).toHaveValue(draft);
    await expect(nativeModel).toHaveValue(nativeModels[1].key);
    await page.getByTestId('work-host-path').fill('/projects/research');
    const surface = page.getByTestId('work-composer-surface');
    const send = page.getByTestId('work-submit-button');
    await expect(send).toBeEnabled();
    for (const control of [
      engine,
      nativeModel,
      send,
      page.getByTestId('work-model-refresh'),
    ]) {
      await control.scrollIntoViewIfNeeded();
      await expect(control).toBeInViewport({ ratio: 1 });
      await assertContained(control, surface);
      expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    const engineBox = (await engine.boundingBox())!;
    const modelBox = (await nativeModel.boundingBox())!;
    expect(engineBox.y + engineBox.height).toBeLessThan(modelBox.y);
    await expect(page.locator('html')).toHaveAttribute(
      'dir',
      variant.language === 'ar' ? 'rtl' : 'ltr'
    );
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            document.documentElement.scrollWidth -
            document.documentElement.clientWidth
        )
      )
      .toBeLessThanOrEqual(1);
    // Capture the whole narrow flow after proving controls remain reachable
    // in the shorter viewport; the scroll container clips element screenshots.
    await page.setViewportSize({ width: 320, height: 1400 });
    const landing = page.getByTestId('work-landing');
    await landing.evaluate(element => element.parentElement?.scrollTo(0, 0));
    await landing.screenshot({
      path: testInfo.outputPath(`work-landing-mobile-${variant.language}.png`),
    });
  });
}

for (const mode of ['light', 'dark'] as const) {
  for (const language of ['en', 'ar']) {
    test(`configured mobile Work landing stays usable in ${mode} ${language}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 320, height: 844 });
      await mockLibreWebUiApi(page, {
        models: [
          model,
          {
            ...model,
            name: 'external-planner',
            isPlugin: true,
            pluginId: 'remote-provider',
            pluginName: 'Remote provider',
          },
        ],
        preferences: {
          defaultModel: modelName,
          theme: {
            mode,
            adaptToAccent: false,
            accent: 'blue',
            customAccent: '#2563eb',
          },
        },
        personas: [
          {
            id: 'researcher',
            name: 'Research and development assistant',
            model: modelName,
            parameters: {},
            user_id: 'user-1',
            created_at: createdAt,
            updated_at: createdAt,
          },
        ],
      });
      await page.route('**/api/work/policies', route =>
        route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            success: true,
            data: [{ id: 'local-policy', name: 'Restricted local workspace' }],
          }),
        })
      );
      await page.route('**/api/work/capabilities', route =>
        route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            success: true,
            data: {
              available: true,
              runtime: 'docker',
              runtimeAvailable: true,
              ollamaAvailable: true,
              image: 'work-test',
              hostWorkspaces: { enabled: true, roots: ['/projects'] },
            },
          }),
        })
      );
      await setPageLanguage(page, language);
      await page.goto('/work');
      await page.getByTestId('sidebar-toggle-size').click();

      const options = page.getByTestId('work-landing-options');
      const surface = page.getByTestId('work-composer-surface');
      const policy = page.getByTestId('work-policy');
      const persona = page.getByTestId('work-persona');
      const folder = page.getByTestId('work-host-path');
      await policy.selectOption('local-policy');
      await persona.selectOption('researcher');
      const folderHint = folder.locator('+ p');
      const emptyFolderHint = await folderHint.textContent();
      await folder.fill('/projects/a-long-project-folder-name');
      await expect(folderHint).not.toHaveText(emptyFolderHint!);
      await expect(folder).toHaveAttribute('dir', 'ltr');
      await expect(policy).toHaveValue('local-policy');
      await expect(persona).toHaveValue('researcher');

      for (const control of [policy, persona, folder, folderHint]) {
        await control.scrollIntoViewIfNeeded();
        await expect(control).toBeInViewport({ ratio: 1 });
        await assertContained(control, options);
      }
      const input = page.getByTestId('work-composer-input');
      await input.fill('Build a local research dashboard');
      await input.scrollIntoViewIfNeeded();
      expect((await input.boundingBox())!.height).toBeGreaterThanOrEqual(70);
      const mobileModel = page.getByTestId(
        'work-model-selector-trigger-mobile'
      );
      await expect(mobileModel).toBeVisible();
      await assertContained(mobileModel, surface);
      await assertContained(page.getByTestId('work-submit-button'), surface);
      const optionsBox = (await options.boundingBox())!;
      const surfaceBox = (await surface.boundingBox())!;
      expect(optionsBox.x).toBeCloseTo(surfaceBox.x, 0);
      expect(optionsBox.width).toBeCloseTo(surfaceBox.width, 0);
      expect(optionsBox.y + optionsBox.height).toBeLessThan(surfaceBox.y);
      expect(surfaceBox.x).toBeGreaterThanOrEqual(0);
      expect(surfaceBox.x + surfaceBox.width).toBeLessThanOrEqual(320);
      await expect(page.getByTestId('work-submit-button')).toBeEnabled();
      await mobileModel.click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await page
        .locator(
          '[data-testid="model-selector-option"][data-model-value="plugin:remote-provider:external-planner"]'
        )
        .click();
      const disclosure = page.getByTestId('work-provider-disclosure-popover');
      await expect(disclosure).toBeVisible();
      const disclosureBox = (await disclosure.boundingBox())!;
      const optionsAfterDisclosure = (await options.boundingBox())!;
      expect(
        optionsAfterDisclosure.y + optionsAfterDisclosure.height
      ).toBeLessThan(disclosureBox.y);
      expect(disclosureBox.y + disclosureBox.height).toBeLessThan(
        (await surface.boundingBox())!.y
      );
    });

    test(`running Work controls fit a narrow desktop pane in ${mode} ${language}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 1280, height: 900 });
      await mockLibreWebUiApi(page, {
        models: [model],
        preferences: {
          defaultModel: modelName,
          theme: {
            mode,
            adaptToAccent: false,
            accent: 'blue',
            customAccent: '#2563eb',
          },
        },
        sttModels: [{ model: 'whisper', plugin: 'local-speech' }],
        workTasks: [
          {
            id: 'narrow-work',
            title: 'Research dashboard',
            model: modelName,
            providerType: 'ollama',
            status: 'running',
            networkEnabled: false,
            createdAt,
            updatedAt: createdAt,
            messages: [],
            activeRun: {
              id: 'narrow-run',
              taskId: 'narrow-work',
              model: modelName,
              providerType: 'ollama',
              status: 'running',
              createdAt,
            },
            previewStatus: 'stopped',
            workspacePath: '/workspace',
          },
        ],
      });
      await setPageLanguage(page, language);
      await page.goto('/work/narrow-work');
      const resizer = page.getByTestId('work-split-resizer');
      await resizer.press('Home');
      const pane = page.getByTestId('work-conversation-panel');
      await expect
        .poll(async () => (await pane.boundingBox())!.width)
        .toBeCloseTo(360, 0);
      const surface = page.getByTestId('work-composer-surface');
      await assertContained(surface, pane);
      const input = page.getByTestId('work-composer-input');
      await input.fill('Keep the output concise');
      const controls = [
        page.getByTestId('work-model-selector-trigger'),
        page.getByTestId('work-voice-input'),
        page.getByTestId('work-cancel-button'),
        page.getByTestId('work-submit-button'),
      ];
      for (const control of controls) {
        await expect(control).toBeVisible();
        await assertContained(control, surface);
      }
      const boxes = await Promise.all(
        controls.map(control => control.boundingBox())
      );
      const horizontal = boxes
        .map(box => box!)
        .sort((left, right) => left.x - right.x);
      for (let index = 1; index < horizontal.length; index++) {
        expect(
          horizontal[index - 1].x + horizontal[index - 1].width
        ).toBeLessThan(horizontal[index].x);
      }
      await expect(page.getByTestId('work-submit-button')).toBeEnabled();
    });
  }
}
