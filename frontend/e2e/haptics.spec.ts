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

test.use({
  viewport: { width: 390, height: 844 },
  isMobile: true,
});

const session = {
  id: 'haptic-session',
  title: 'Haptic test conversation',
  model: 'llama3.2:3b',
  messages: [],
  createdAt: Date.now(),
  updatedAt: Date.now(),
};

test('Android haptic feedback is opt-in and fires for mobile actions', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const hapticWindow = window as Window & {
      __hapticPatterns: Array<number | number[]>;
    };
    hapticWindow.__hapticPatterns = [];
    Object.defineProperty(navigator, 'maxTouchPoints', {
      configurable: true,
      value: 1,
    });
    Object.defineProperty(navigator, 'vibrate', {
      configurable: true,
      value: (pattern: number | number[]) => {
        hapticWindow.__hapticPatterns.push(pattern);
        return true;
      },
    });
  });
  await mockLibreWebUiApi(page, {
    sessions: [session],
    preferences: { hapticFeedbackEnabled: false },
  });
  await page.goto('/chat');

  await expect(
    page.getByRole('textbox', { name: 'Send a message' })
  ).toBeVisible();
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
  await expect(page.getByTestId('settings-modal-panel')).toBeVisible();
  const toggle = page.getByTestId('haptic-feedback-toggle');
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAccessibleName('Haptic feedback (Android)');

  const preferenceSave = page.waitForRequest(
    request =>
      request.url().endsWith('/api/preferences') &&
      request.method() === 'PUT' &&
      request.postDataJSON().hapticFeedbackEnabled === true
  );
  await toggle.locator('..').click();
  await preferenceSave;
  await expect(toggle).toBeChecked();

  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as Window & {
              __hapticPatterns: Array<number | number[]>;
            }
          ).__hapticPatterns
      )
    )
    .toEqual([8]);

  await page.keyboard.press('Escape');
  // The compact rail no longer lists sessions; expand the sidebar first.
  await page.getByTestId('sidebar-mobile-chats').click();
  await page
    .getByRole('heading', { name: 'Haptic test conversation', exact: true })
    .click();

  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as Window & {
              __hapticPatterns: Array<number | number[]>;
            }
          ).__hapticPatterns
      )
    )
    // Enable-toggle, sidebar expand, and session select each vibrate once.
    .toEqual([8, 8, 8]);
});
