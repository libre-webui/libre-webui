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

/**
 * Geometry of the composer card that owns the first textarea on the page.
 * The card stacks the text row above a controls row; every visible control
 * in that row shares one centre line, and the row hugs the card's inset
 * symmetrically.
 */
const measureBar = () => {
  const textarea = document.querySelector('textarea');
  if (!textarea) throw new Error('no composer');
  let bar: HTMLElement | null = textarea.parentElement;
  while (bar && !bar.className.includes('rounded-[')) {
    bar = bar.parentElement;
  }
  if (!bar) throw new Error('no composer bar');

  const row = bar.lastElementChild;
  if (!(row instanceof HTMLElement)) throw new Error('no controls row');

  const box = bar.getBoundingClientRect();
  const textBox = textarea.getBoundingClientRect();
  const rowBox = row.getBoundingClientRect();
  // The model pill is hidden on narrow screens, and the layout spacer is a
  // zero-height flex filler; both measure empty there.
  const items = Array.from(row.children)
    .map(child => child.getBoundingClientRect())
    .filter(rect => rect.height > 0 && rect.width > 0);
  const centres = items.map(item => item.top + item.height / 2);

  return {
    centreSpread: Math.max(...centres) - Math.min(...centres),
    insetStart: items[0].left - box.left,
    insetEnd: box.right - items[items.length - 1].right,
    rowGap: rowBox.top - textBox.bottom,
  };
};

test('everything on the composer bar sits on one centre line', async ({
  page,
}) => {
  await mockLibreWebUiApi(page, { sessions: [] });
  await page.goto('/chat');
  await expect(page.getByPlaceholder(/^message/i).first()).toBeVisible();

  const welcome = await page.evaluate(measureBar);
  // Sub-pixel: the controls all share the model pill's centre line.
  expect(welcome.centreSpread).toBeLessThan(1);
  expect(Math.abs(welcome.insetStart - welcome.insetEnd)).toBeLessThan(0.5);
  // The controls row sits below the text row, never overlapping it.
  expect(welcome.rowGap).toBeGreaterThanOrEqual(-0.5);

  // Narrow screens give buttons a 44px touch target; the row follows.
  await page.setViewportSize({ width: 390, height: 780 });
  await page.waitForTimeout(300);
  const narrow = await page.evaluate(measureBar);
  expect(narrow.centreSpread).toBeLessThan(1);
  expect(Math.abs(narrow.insetStart - narrow.insetEnd)).toBeLessThan(0.5);

  // Typing past one line grows the text row; the controls keep sharing one
  // centre line beneath it.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page
    .getByPlaceholder(/^message/i)
    .first()
    .fill('one\ntwo\nthree');
  await page.waitForTimeout(300);
  const grown = await page.evaluate(measureBar);
  expect(grown.centreSpread).toBeLessThan(1);
  expect(grown.rowGap).toBeGreaterThanOrEqual(-0.5);
});
