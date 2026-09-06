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
import { defaultSystemInfo, mockLibreWebUiApi } from './lib/mockApi';
import { openSettingsModal, selectSettingsTab } from './lib/settingsTab';

test('settings tabs support vertical keyboard navigation and skip disabled tabs', async ({
  page,
}) => {
  await mockLibreWebUiApi(page, {
    systemInfo: { ...defaultSystemInfo, ollamaEnabled: false },
  });
  await page.goto('/chat');
  const panel = await openSettingsModal(page);
  const tabs = panel.getByRole('tablist');
  const appearance = panel.getByTestId('settings-tab-appearance');
  const data = panel.getByTestId('settings-tab-data');
  await expect(tabs).toHaveAttribute('aria-orientation', 'vertical');
  await expect(tabs.locator('[tabindex="0"]')).toHaveCount(1);
  await expect(panel.getByRole('tabpanel')).toHaveAccessibleName('Appearance');

  await appearance.focus();
  await page.keyboard.press('ArrowDown');
  await expect(data).toBeFocused();
  await expect(data).toHaveAttribute('aria-selected', 'true');
  await expect(panel.getByRole('tabpanel')).toHaveAccessibleName('Data');
  await page.keyboard.press('ArrowUp');
  await expect(appearance).toBeFocused();

  await selectSettingsTab(panel, 'models');
  await page.keyboard.press('ArrowDown');
  await expect(panel.getByTestId('settings-tab-generation')).toBeFocused();
  await expect(panel.getByTestId('settings-tab-model-manager')).toBeDisabled();

  await page.keyboard.press('End');
  await expect(tabs.locator('[role="tab"]:enabled').last()).toBeFocused();
  await page.keyboard.press('Home');
  await expect(appearance).toBeFocused();
  await expect(tabs.locator('[tabindex="0"]')).toHaveCount(1);
});

test('settings search keeps disabled sections closed and announces empty results', async ({
  page,
}) => {
  await mockLibreWebUiApi(page, {
    systemInfo: { ...defaultSystemInfo, ollamaEnabled: false },
  });
  await page.goto('/chat');
  const panel = await openSettingsModal(page);
  const search = panel.getByRole('searchbox', { name: 'Search' });
  await search.fill('download');
  const modelManager = panel.getByTestId('settings-tab-model-manager');
  await expect(modelManager).toBeDisabled();
  await expect(modelManager).toHaveAttribute('aria-selected', 'false');
  await expect(panel.getByRole('tabpanel')).toHaveAccessibleName('Appearance');

  await search.fill('no-such-setting');
  await expect(panel.getByRole('status')).toHaveText('No results found');
  await expect(panel.getByRole('tab')).toHaveCount(0);
  await search.clear();
  await expect(panel.getByRole('status')).toHaveCount(0);
  await expect(panel.getByTestId('settings-tab-appearance')).toHaveAttribute(
    'aria-selected',
    'true'
  );

  await search.fill('temperature');
  await expect(panel.getByTestId('settings-tab-generation')).toHaveAttribute(
    'aria-selected',
    'true'
  );
  await expect(panel.getByRole('tabpanel')).toHaveAccessibleName('Generation');
});

test('settings starts each section at the top after switching tabs', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1024, height: 620 });
  await mockLibreWebUiApi(page);
  await page.goto('/chat');
  const panel = await openSettingsModal(page);
  const content = panel.getByTestId('settings-scroll-region');
  await content.evaluate(element => {
    element.scrollTop = element.scrollHeight;
  });
  await expect
    .poll(() => content.evaluate(element => element.scrollTop))
    .toBeGreaterThan(0);

  await selectSettingsTab(panel, 'models');
  await expect
    .poll(() => content.evaluate(element => element.scrollTop))
    .toBe(0);
  await expect
    .poll(() =>
      content.evaluate(element => element.scrollHeight - element.clientHeight)
    )
    .toBeGreaterThan(0);
  await content.evaluate(element => {
    element.scrollTop = element.scrollHeight;
  });
  await selectSettingsTab(panel, 'appearance');
  await expect
    .poll(() => content.evaluate(element => element.scrollTop))
    .toBe(0);
});

test('mobile settings keyboard navigation follows the visual direction in LTR and RTL', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockLibreWebUiApi(page);
  await page.goto('/chat');
  const panel = await openSettingsModal(page);
  const appearance = panel.getByTestId('settings-tab-appearance');
  const data = panel.getByTestId('settings-tab-data');
  await expect(panel.getByRole('tablist')).toHaveAttribute(
    'aria-orientation',
    'horizontal'
  );
  await appearance.focus();
  await page.keyboard.press('ArrowRight');
  await expect(data).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(appearance).toBeFocused();

  await page.getByTestId('language-switcher-select').selectOption('ar');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await appearance.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(data).toBeFocused();
  await expect(data).toBeInViewport();
  await page.keyboard.press('ArrowRight');
  await expect(appearance).toBeFocused();
});
