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

import { expect, Page } from '@playwright/test';

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

/**
 * Opens the settings modal and switches to a tab by its visible label. Exact
 * matching matters: the defaults tab is "Model" and the manager tab is
 * "Models".
 */
export async function openSettingsTab(page: Page, label: string) {
  const panel = await openSettingsModal(page);
  const tab = panel.getByRole('tab', { name: label, exact: true });
  await tab.scrollIntoViewIfNeeded();
  await tab.click();
  await expect(tab).toHaveAttribute('aria-selected', 'true');
  return panel;
}
