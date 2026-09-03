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

const session = (id: string, content: string) => ({
  id,
  title: id,
  model: 'llama3.2:3b',
  createdAt: Date.now(),
  updatedAt: Date.now(),
  messages: [
    {
      id: `${id}-user`,
      role: 'user' as const,
      content: 'Explain.',
      timestamp: Date.now(),
    },
    {
      id: `${id}-assistant`,
      role: 'assistant' as const,
      model: 'llama3.2:3b',
      content,
      timestamp: Date.now(),
    },
  ],
});

test('KaTeX loads only for messages that contain math', async ({ page }) => {
  await mockLibreWebUiApi(page, {
    sessions: [
      session('plain-session', 'Just **markdown** with a [link](https://x.y).'),
      session(
        'math-session',
        'Energy is $E = mc^2$ and\n\n$$\n\\int_0^1 x\\,dx\n$$'
      ),
    ],
  });
  await page.addInitScript(() => {
    localStorage.setItem('i18nextLng', 'en');
    localStorage.setItem('auth-token', 'e2e-token');
  });
  const requested: string[] = [];
  page.on('request', request => requested.push(request.url()));

  await page.goto('/c/plain-session');
  await expect(
    page.locator('.prose strong', { hasText: 'markdown' })
  ).toBeVisible();
  await page.waitForLoadState('networkidle');
  expect(requested.filter(url => /katex/i.test(url))).toEqual([]);

  await page.goto('/c/math-session');
  // Inline and display math both typeset once the KaTeX chunk arrives.
  await expect(page.locator('.katex')).toHaveCount(2);
  await expect(page.locator('.katex-display')).toHaveCount(1);
  await expect(page.locator('.katex').first()).toBeVisible();
  expect(requested.some(url => /katex/i.test(url))).toBe(true);
});
