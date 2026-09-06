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

const session = {
  id: 'composer-polish',
  title: 'Composer polish',
  model: 'llama3.2:3b',
  createdAt: 1_710_000_000_000,
  updatedAt: 1_710_000_100_000,
  messages: [],
};

for (const mode of ['light', 'dark'] as const) {
  for (const view of ['welcome', 'conversation'] as const) {
    test(`${view} composer uses neutral submit states and a visible focus boundary in ${mode} mode`, async ({
      page,
    }) => {
      await mockLibreWebUiApi(page, {
        sessions: [session],
        preferences: {
          theme: {
            mode,
            accent: 'blue',
            adaptToAccent: false,
            customAccent: '#2563eb',
          },
        },
      });
      await page.goto(view === 'welcome' ? '/chat' : `/c/${session.id}`);
      const composer = page.locator('[data-composer-box]');
      const textarea = composer.locator('textarea');
      const send = composer.getByRole('button', { name: 'Send message' });
      await expect(textarea).toBeVisible();
      if (mode === 'dark')
        await expect(page.locator('html')).toHaveClass(/dark/);
      else await expect(page.locator('html')).not.toHaveClass(/dark/);

      const colors = await page.evaluate(() => {
        const style = getComputedStyle(document.documentElement);
        const color = (token: string) =>
          `rgb(${style.getPropertyValue(`--color-${token}`).trim().split(/\s+/).join(', ')})`;
        return {
          ink: color('ink'),
          inverse: color('ink-inverse'),
          disabledText: color('ink-subtle'),
        };
      });
      await expect(send).toBeDisabled();
      await expect(send).toHaveCSS('color', colors.disabledText);
      await expect(send).toHaveCSS('opacity', '1');
      const disabledFill = await send.evaluate(
        element => getComputedStyle(element).backgroundColor
      );
      expect(disabledFill).not.toBe(colors.ink);

      await textarea.evaluate(element => element.blur());
      const unfocused = await composer.evaluate(element => {
        const style = getComputedStyle(element);
        return { border: style.borderColor, shadow: style.boxShadow };
      });
      await textarea.fill('A calm and readable composer.');
      await expect(send).toBeEnabled();
      await expect(send).toHaveCSS('background-color', colors.ink);
      await expect(send).toHaveCSS('color', colors.inverse);
      await expect
        .poll(() =>
          composer.evaluate(element => getComputedStyle(element).borderColor)
        )
        .not.toBe(unfocused.border);
      await expect
        .poll(() =>
          composer.evaluate(element => getComputedStyle(element).boxShadow)
        )
        .not.toBe(unfocused.shadow);

      await send.hover();
      await expect(send).toHaveCSS('background-color', colors.ink);
      await expect(send).toHaveCSS('color', colors.inverse);

      await page.emulateMedia({ reducedMotion: 'reduce' });
      for (const element of [composer, send]) {
        const duration = await element.evaluate(node =>
          Number.parseFloat(getComputedStyle(node).transitionDuration)
        );
        expect(duration).toBeLessThan(0.001);
      }
    });
  }
}

test('chat toolbar controls share a consistent desktop height and retain mobile touch targets', async ({
  page,
}) => {
  await mockLibreWebUiApi(page, { sessions: [session] });
  for (const route of ['/chat', `/c/${session.id}`]) {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(route);
    const composer = page.locator('[data-composer-box]');
    await expect(composer.locator('textarea')).toBeVisible();
    const desktopHeight = await page.evaluate(
      () =>
        Number.parseFloat(getComputedStyle(document.documentElement).fontSize) *
        2.25
    );
    const model = composer.locator('button[aria-haspopup="dialog"]');
    await expect(model).toBeVisible();
    await expect(model).toHaveCSS('height', `${desktopHeight}px`);
    const context = composer.locator('[role="meter"], [role="img"][tabindex]');
    if (route !== '/chat') {
      await expect(context).toHaveCSS('height', `${desktopHeight}px`);
    }

    const buttonHeights = () =>
      composer
        .getByRole('button')
        .evaluateAll(buttons =>
          buttons.map(button => button.getBoundingClientRect().height)
        );
    expect((await buttonHeights()).length).toBeGreaterThanOrEqual(4);
    await expect
      .poll(async () =>
        (await buttonHeights()).every(
          height => Math.abs(height - desktopHeight) < 0.01
        )
      )
      .toBe(true);

    const thinking = composer.locator('button[aria-haspopup="menu"]');
    await thinking.click();
    await page.getByRole('menuitemradio', { name: 'Off', exact: true }).click();
    await expect(thinking).toHaveAttribute('aria-pressed', 'false');
    await expect(thinking).toHaveCSS('height', `${desktopHeight}px`);
    await thinking.click();
    await page.getByRole('menuitemradio', { name: 'On', exact: true }).click();
    await expect(thinking).toHaveAttribute('aria-pressed', 'true');
    await expect(thinking).toHaveCSS('height', `${desktopHeight}px`);

    await page.setViewportSize({ width: 390, height: 780 });
    await expect(model).toBeHidden();
    if (route !== '/chat') await expect(context).toHaveCSS('height', '44px');
    await expect
      .poll(async () => (await buttonHeights()).every(height => height >= 44))
      .toBe(true);
  }
});
