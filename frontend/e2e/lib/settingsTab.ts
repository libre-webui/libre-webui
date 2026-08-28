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

import { expect, type Locator, type Page } from '@playwright/test';

/**
 * Opens the settings modal with the Ctrl+, shortcut. The keydown is dispatched
 * on the document so the app's global handler sees it regardless of focus.
 */
export async function openSettingsModal(page: Page) {
  const panel = page.getByTestId('settings-modal-panel');
  // The shortcut handler mounts with the app shell, so the first keydown can
  // land before anything listens; poll until the modal actually opens.
  await expect
    .poll(
      async () => {
        await page.evaluate(() => {
          document.dispatchEvent(
            new KeyboardEvent('keydown', {
              key: ',',
              ctrlKey: true,
              bubbles: true,
              cancelable: true,
            })
          );
        });
        return panel.count();
      },
      { timeout: 15000 }
    )
    .toBeGreaterThan(0);
  await expect(panel).toBeVisible();
  return panel;
}

/** Switches tabs by the stable internal ID instead of translated copy. */
export async function selectSettingsTab(panel: Locator, tabId: string) {
  const tab = panel.getByTestId(`settings-tab-${tabId}`);
  await tab.scrollIntoViewIfNeeded();
  await tab.click();
  await expect(tab).toHaveAttribute('aria-selected', 'true');
}

/** Opens the settings modal and selects a tab by its stable internal ID. */
export async function openSettingsTab(page: Page, tabId: string) {
  const panel = await openSettingsModal(page);
  await selectSettingsTab(panel, tabId);
  return panel;
}
