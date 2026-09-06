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

async function useLanguage(page: Page, language: string) {
  await page.addInitScript(locale => {
    localStorage.setItem('i18nextLng', locale);
  }, language);
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
      await useLanguage(page, language);
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
      await useLanguage(page, language);
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
