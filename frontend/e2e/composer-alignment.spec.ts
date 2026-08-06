/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
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

/** Geometry of the composer bar that owns the first textarea on the page. */
const measureBar = () => {
  const textarea = document.querySelector('textarea');
  if (!textarea) throw new Error('no composer');
  let bar: HTMLElement | null = textarea.parentElement;
  while (bar && !bar.className.includes('rounded-[')) {
    bar = bar.parentElement;
  }
  if (!bar) throw new Error('no composer bar');

  const box = bar.getBoundingClientRect();
  // The model pill is hidden on narrow screens and measures zero there.
  const items = Array.from(bar.children)
    .map(child => child.getBoundingClientRect())
    .filter(rect => rect.height > 0);
  const centres = items.map(item => item.top + item.height / 2);

  return {
    centreSpread: Math.max(...centres) - Math.min(...centres),
    bottomSpread:
      Math.max(...items.map(i => i.bottom)) -
      Math.min(...items.map(i => i.bottom)),
    insetStart: items[0].left - box.left,
    insetEnd: box.right - items[items.length - 1].right,
  };
};

test('everything on the composer bar sits on one centre line', async ({
  page,
}) => {
  await mockLibreWebUiApi(page, { sessions: [] });
  await page.goto('/chat');
  await expect(page.getByPlaceholder(/^message/i).first()).toBeVisible();

  const welcome = await page.evaluate(measureBar);
  // Sub-pixel: the parts are all the same height as the model pill.
  expect(welcome.centreSpread).toBeLessThan(1);
  expect(Math.abs(welcome.insetStart - welcome.insetEnd)).toBeLessThan(0.5);

  // Narrow screens give buttons a 44px touch target; the text row follows.
  await page.setViewportSize({ width: 390, height: 780 });
  await page.waitForTimeout(300);
  const narrow = await page.evaluate(measureBar);
  expect(narrow.centreSpread).toBeLessThan(1);
  expect(Math.abs(narrow.insetStart - narrow.insetEnd)).toBeLessThan(0.5);

  // Typing past one line keeps the controls level with the last line.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page
    .getByPlaceholder(/^message/i)
    .first()
    .fill('one\ntwo\nthree');
  await page.waitForTimeout(300);
  const grown = await page.evaluate(measureBar);
  expect(grown.bottomSpread).toBeLessThan(1);
});
