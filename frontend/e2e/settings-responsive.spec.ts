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
import en from '../src/i18n/locales/en.json' with { type: 'json' };
import ar from '../src/i18n/locales/ar.json' with { type: 'json' };
import { mockLibreWebUiApi } from './lib/mockApi';
import { openSettingsTab } from './lib/settingsTab';

const description =
  'Help colleagues review their project work, explain the important decisions, and prepare a clear update that everyone can understand without opening another application.';
const longName = 'Project review and preparation for the entire workspace team';
const metadata = 'workspace-project-preparation-and-review-'.repeat(3);
const timestamp = 1_770_000_000_000;
const skill = {
  id: 'responsive-skill',
  slug: metadata,
  name: longName,
  description,
  instructions: 'Review the project and explain the decisions.',
  enabled: true,
  version: 12,
  createdAt: timestamp,
  updatedAt: timestamp,
  ownerUserId: 'responsive-admin',
};
const prompt = {
  id: 'responsive-prompt',
  slug: metadata,
  title: longName,
  description,
  content: 'Prepare a project update for the team.',
  variables: [],
  tags: [metadata, 'team updates'],
  version: 12,
  createdAt: timestamp,
  updatedAt: timestamp,
  ownerUserId: 'responsive-admin',
};
const server = {
  id: 'responsive-server',
  name: longName,
  description,
  kind: 'openapi',
  authMode: 'bearer',
  enabled: true,
  hasCredential: false,
  baseUrl: `https://api.example.test/${metadata}`,
  accessMode: 'all-users',
  specRevision: 12,
  specDigest: metadata,
  createdAt: timestamp,
  updatedAt: timestamp,
};
const serverTool = {
  name: metadata.replaceAll('-', '_'),
  description,
  sideEffect: true,
  enabled: true,
};

async function prepareSettings(page: Page, language: 'en' | 'ar') {
  await mockLibreWebUiApi(page, {
    systemInfo: {
      requiresAuth: true,
      hasUsers: true,
      userCount: 1,
      version: '0.25.0-e2e',
      turnstile: { enabled: false },
    },
    authUsers: [
      {
        id: 'responsive-admin',
        username: 'admin',
        email: 'admin@example.test',
        role: 'admin',
        token: 'responsive-token',
        preferences: {
          theme: {
            mode: language === 'ar' ? 'dark' : 'light',
            accent: 'blue',
            adaptToAccent: false,
            customAccent: '#2563eb',
          },
        },
      },
    ],
  });
  const fixtures: Record<string, unknown> = {
    '/api/skills': [skill],
    '/api/skills/responsive-skill/files': [],
    '/api/prompts': [prompt],
    '/api/tools/servers': [server],
    '/api/tools/approvals': { pending: [], standing: [] },
    '/api/tools/servers/responsive-server': { server, tools: [serverTool] },
  };
  await page.route(/\/api\/(skills|prompts|tools)(?:\/.*)?$/, async route => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() === 'GET' && path in fixtures) {
      await route.fulfill({ json: { success: true, data: fixtures[path] } });
      return;
    }
    await route.fallback();
  });
  await page.addInitScript(language => {
    localStorage.setItem('auth-token', 'responsive-token');
    localStorage.setItem('i18nextLng', language);
  }, language);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
}

async function expectReadable(prose: Locator, container: Locator) {
  const available = await container.evaluate(element => {
    const style = getComputedStyle(element);
    return (
      element.clientWidth -
      parseFloat(style.paddingLeft) -
      parseFloat(style.paddingRight)
    );
  });
  await expect(prose).toBeVisible();
  await expect
    .poll(() =>
      prose.evaluate(element => element.getBoundingClientRect().width)
    )
    .toBeGreaterThanOrEqual(Math.min(240, available) - 2);
}

async function expectNoOverflow(container: Locator) {
  await expect
    .poll(() =>
      container.evaluate(element => element.scrollWidth - element.clientWidth)
    )
    .toBeLessThanOrEqual(1);
}

async function expectContained(container: Locator) {
  await expectNoOverflow(container);
  const bounds = await container.boundingBox();
  expect(bounds).not.toBeNull();
  for (const button of await container.locator('button:visible').all()) {
    const action = await button.boundingBox();
    expect(action).not.toBeNull();
    expect(action!.x).toBeGreaterThanOrEqual(bounds!.x - 1);
    expect(action!.x + action!.width).toBeLessThanOrEqual(
      bounds!.x + bounds!.width + 1
    );
    expect(action!.width).toBeGreaterThan(20);
  }
}

const layouts = [
  ...[320, 390, 640, 768, 900, 1280].map(width => ({
    width,
    language: 'en' as const,
  })),
  { width: 768, language: 'ar' as const },
];
const libraries = [
  { tab: 'skills', row: 'skill-row', prefix: 'skill', nameInput: 'skill-name' },
  {
    tab: 'prompts',
    row: 'prompt-row',
    prefix: 'prompt',
    nameInput: 'prompt-title',
  },
  {
    tab: 'tools',
    row: 'tool-server-row',
    prefix: 'tool-server',
    nameInput: 'tool-server-name',
  },
] as const;

for (const { width, language } of layouts) {
  for (const library of libraries) {
    test(`${library.tab} text and actions fit ${width}px ${language} Settings`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: 960 });
      await prepareSettings(page, language);
      await openSettingsTab(page, library.tab);
      const surface = page.getByTestId(`${library.tab}-page`);
      const header = surface.locator('header');
      const row = surface.getByTestId(library.row);
      await expect(row).toHaveCount(1);
      await page.screenshot({
        path: testInfo.outputPath(`${library.tab}-${width}-${language}.png`),
      });
      await expectReadable(header.locator('p'), header);
      await expectContained(header);
      await expectReadable(row.getByText(description, { exact: true }), row);
      await expectContained(row);
      await expectNoOverflow(page.getByTestId('settings-scroll-region'));

      await page.getByTestId(`${library.prefix}-new`).click();
      const modal = page.getByTestId(`${library.prefix}-modal`);
      await expect(modal).toBeVisible();
      await expect(page.getByTestId(library.nameInput)).toHaveValue('');
      await page.keyboard.press('Escape');
      await row.getByTestId(`${library.prefix}-edit`).click();
      await expect(modal).toBeVisible();
      await expect(page.getByTestId(library.nameInput)).toHaveValue(longName);
      await page.keyboard.press('Escape');

      if (library.tab === 'tools') {
        await row.getByTestId('tool-credential-toggle').click();
        const credential = row.getByTestId('tool-credential-panel');
        await expect(credential).toBeVisible();
        await expectContained(credential);
        await expectContained(row);
        await row.getByTestId('tool-credential-toggle').click();
        await row.getByTestId('tool-server-expand').click();
        const tool = row.getByTestId('tool-server-tool');
        await expect(tool).toHaveCount(1);
        await expectReadable(
          tool.getByText(description, { exact: true }),
          tool
        );
        await expectContained(tool);
        await expectContained(row);
        await page.screenshot({
          path: testInfo.outputPath(`tools-expanded-${width}-${language}.png`),
        });
      }
    });
  }

  test(`default theme description and choices fit ${width}px ${language} Settings`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 960 });
    await prepareSettings(page, language);
    await openSettingsTab(page, 'users');
    const translations = language === 'ar' ? ar : en;
    const settings = page.getByTestId('settings-scroll-region');
    await settings
      .getByRole('tab', {
        name: translations.userManager.sections.defaults,
        exact: true,
      })
      .click();
    const group = settings.getByRole('radiogroup', {
      name: translations.userManager.defaultTheme.title,
    });
    const card = group.locator('../..');
    await expect(group.getByRole('radio')).toHaveCount(4);
    await expect(group.getByRole('radio').first()).toBeEnabled();
    await page.screenshot({
      path: testInfo.outputPath(`defaults-${width}-${language}.png`),
    });
    await expectReadable(
      card.getByText(translations.userManager.defaultTheme.description, {
        exact: true,
      }),
      card
    );
    await expectContained(card);
    await expectNoOverflow(settings);
    const pureBlack = group.getByRole('radio', {
      name: translations.settings.appearance.theme.amoled,
      exact: true,
    });
    const saved = page.waitForResponse(
      response =>
        response.url().endsWith('/api/preferences/default-theme') &&
        response.request().method() === 'PUT'
    );
    await pureBlack.click();
    await saved;
    await expect(pureBlack).toHaveAttribute('aria-checked', 'true');
  });
}
