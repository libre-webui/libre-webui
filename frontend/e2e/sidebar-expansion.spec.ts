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

import { expect, test, type Page } from '@playwright/test';
import { mockLibreWebUiApi } from './lib/mockApi';

test.use({ timezoneId: 'UTC' });

const imageUrl = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600">' +
    '<defs><linearGradient id="sky"><stop stop-color="#517e97"/><stop offset="1" stop-color="#dfb583"/></linearGradient></defs>' +
    '<rect width="800" height="600" fill="url(#sky)"/>' +
    '<path d="M0 460L200 220L390 440L610 270L800 480V600H0Z" fill="#263f49"/></svg>'
)}`;

async function openWallpaperHome(
  page: Page,
  mode: 'dark' | 'celestial',
  reducedMotion = false,
  language: 'en' | 'ar' = 'en'
) {
  await page.emulateMedia({
    reducedMotion: reducedMotion ? 'reduce' : 'no-preference',
  });
  await page.clock.setFixedTime(new Date('2026-09-05T00:00:00Z'));
  await mockLibreWebUiApi(page, {
    systemInfo: {
      requiresAuth: true,
      hasUsers: true,
      userCount: 1,
      version: '0.25.0-e2e',
      turnstile: { enabled: false },
    },
    authRole: 'admin',
    preferences: {
      theme: {
        mode,
        accent: 'blue',
        adaptToAccent: false,
        customAccent: '#2563eb',
      },
      backgroundSettings: {
        enabled: true,
        imageUrl,
        blurAmount: 0,
        opacity: 0.8,
      },
    },
  });
  await page.addInitScript(language => {
    localStorage.setItem('i18nextLng', language);
    localStorage.setItem('auth-token', 'e2e-token');
  }, language);
  await page.goto('/');
  await expect(page.getByTestId('home-page')).toBeVisible();
  if (mode === 'celestial')
    await expect(page.locator('html')).toHaveClass(/dark/);
  await expect(page.getByTestId('app-background')).toHaveAttribute(
    'data-state',
    'ready'
  );
  await expect(page.getByTestId('app-background')).toBeVisible();
}

async function sampleToggle(page: Page, testId: string) {
  return page.evaluate(async testId => {
    const sidebar = document.querySelector<HTMLElement>(
      '[data-testid="sidebar"]'
    )!;
    const content = document.querySelector<HTMLElement>(
      '[data-testid="app-shell-content"]'
    )!;
    const wallpaper = document.querySelector<HTMLElement>(
      '[data-testid="app-background"]'
    )!;
    const spacer = document.querySelector<HTMLElement>(
      '[data-sidebar-layout-spacer]'
    )!;
    const snapshot = () => {
      const rail = sidebar.getBoundingClientRect();
      const body = content.getBoundingClientRect();
      const imageStyle = getComputedStyle(wallpaper);
      const centerOf = (testId: string) => {
        const bounds = sidebar
          .querySelector<HTMLElement>(`[data-testid="${testId}"]`)!
          .getBoundingClientRect();
        return bounds.x + bounds.width / 2;
      };
      return {
        sidebarWidth: rail.width,
        sidebarLeft: rail.left,
        sidebarRight: rail.right,
        contentLeft: body.left,
        contentRight: body.right,
        sidebarTransition: getComputedStyle(sidebar).transition,
        spacerTransition: getComputedStyle(spacer).transition,
        compact: Boolean(
          sidebar.querySelector('[data-testid="sidebar-rail-expand"]')
        ),
        chatCenterX: centerOf('sidebar-chat-button'),
        searchCenterX: centerOf('sidebar-search-button'),
        footerCenters: [
          ...sidebar.querySelectorAll<HTMLElement>(
            '[data-testid="notification-bell"], [data-testid="sidebar-rail-settings-button"], [data-testid="sidebar-rail-user-menu-button"]'
          ),
        ].map(element => {
          const bounds = element.getBoundingClientRect();
          return {
            name: element.dataset.testid,
            x: bounds.x + bounds.width / 2,
          };
        }),
        wallpaperVisible:
          imageStyle.visibility !== 'hidden' &&
          imageStyle.display !== 'none' &&
          parseFloat(imageStyle.opacity) > 0,
      };
    };
    const frames = [snapshot()];
    const button = document.querySelector<HTMLButtonElement>(
      `[data-testid="${testId}"]`
    )!;
    button.click();
    await new Promise<void>(resolve => {
      const started = performance.now();
      let stableFrames = 0;
      const sample = () => {
        const frame = snapshot();
        const previous = frames.at(-1)!;
        stableFrames =
          Math.abs(frame.sidebarWidth - previous.sidebarWidth) < 0.01
            ? stableFrames + 1
            : 0;
        frames.push(frame);
        const elapsed = performance.now() - started;
        const moving = sidebar
          .getAnimations()
          .some(animation => animation.playState === 'running');
        if ((elapsed > 60 && stableFrames >= 3 && !moving) || elapsed > 1500)
          resolve();
        else requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    return frames;
  }, testId);
}

function expectDesktopFrames(
  frames: Awaited<ReturnType<typeof sampleToggle>>,
  animated: boolean
) {
  for (const frame of frames) {
    expect(
      Math.abs(frame.contentLeft - frame.sidebarRight),
      JSON.stringify(frame)
    ).toBeLessThanOrEqual(1);
    expect(frame.wallpaperVisible).toBe(true);
  }
  const first = frames[0].sidebarWidth;
  const last = frames.at(-1)!.sidebarWidth;
  expect(Math.abs(last - first)).toBeGreaterThan(100);
  const intermediate = frames.filter(
    frame =>
      frame.sidebarWidth > Math.min(first, last) + 1 &&
      frame.sidebarWidth < Math.max(first, last) - 1
  );
  if (animated) expect(intermediate.length).toBeGreaterThan(0);
  else expect(intermediate).toHaveLength(0);
}

function expectCollapsedControls(
  frames: Awaited<ReturnType<typeof sampleToggle>>
) {
  const final = frames.at(-1)!;
  expect(final.compact).toBe(true);
  expect(final.footerCenters).toHaveLength(3);
  const railCenter = (final.sidebarLeft + final.sidebarRight) / 2;
  for (const frame of frames.slice(1).filter(frame => frame.compact)) {
    expect(
      Math.abs(frame.chatCenterX - railCenter),
      JSON.stringify(frame)
    ).toBeLessThanOrEqual(1);
    expect(
      Math.abs(frame.searchCenterX - railCenter),
      JSON.stringify(frame)
    ).toBeLessThanOrEqual(1);
    for (const footer of frame.footerCenters) {
      expect(
        Math.abs(footer.x - railCenter),
        JSON.stringify({ footer, frame })
      ).toBeLessThanOrEqual(1);
    }
  }
}

for (const width of [900, 1280]) {
  for (const mode of ['dark', 'celestial'] as const) {
    test(`${mode} sidebar and content expand together at ${width}px with wallpaper visible`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await openWallpaperHome(page, mode);
      const sidebar = page.getByTestId('sidebar');
      await expect(sidebar).toHaveCSS('border-inline-end-width', '0px');
      await expect(sidebar).toHaveCSS('box-shadow', 'none');
      const collapse = await sampleToggle(page, 'sidebar-toggle-size');
      expectDesktopFrames(collapse, true);
      expectCollapsedControls(collapse);
      expect(collapse.at(-1)!.sidebarWidth).toBeLessThan(90);
      const expand = await sampleToggle(page, 'sidebar-rail-expand');
      expectDesktopFrames(expand, true);
      expect(expand.at(-1)!.sidebarWidth).toBeGreaterThan(200);
      await expect(sidebar).toHaveCSS('border-inline-end-width', '0px');
      await expect(sidebar).toHaveCSS('box-shadow', 'none');
      await page.screenshot({
        path: testInfo.outputPath(`expanded-wallpaper-${width}-${mode}.png`),
      });
    });
  }
}

test('mobile RTL expansion keeps the content offset and wallpaper stable', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openWallpaperHome(page, 'celestial', false, 'ar');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  const collapse = await sampleToggle(page, 'sidebar-toggle-size');
  expectCollapsedControls(collapse);
  const railWidth = collapse.at(-1)!.sidebarWidth;
  expect(railWidth).toBeLessThan(90);
  const expand = await sampleToggle(page, 'sidebar-rail-expand');
  for (const frame of [...collapse, ...expand]) {
    expect(
      Math.abs(frame.contentRight - (390 - railWidth)),
      JSON.stringify(frame)
    ).toBeLessThanOrEqual(1);
    expect(frame.contentLeft).toBeCloseTo(0, 0);
    expect(frame.wallpaperVisible).toBe(true);
  }
  await expect(page.getByTestId('sidebar')).toHaveCSS(
    'border-inline-end-width',
    '0px'
  );
  await expect(page.getByTestId('sidebar')).toHaveCSS('box-shadow', 'none');
  await page.screenshot({
    path: testInfo.outputPath('expanded-wallpaper-mobile-rtl.png'),
  });
});

test('reduced motion changes sidebar size without animated intermediate widths', async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 900 });
  await openWallpaperHome(page, 'celestial', true);
  const collapse = await sampleToggle(page, 'sidebar-toggle-size');
  expectDesktopFrames(collapse, false);
  expectCollapsedControls(collapse);
  expectDesktopFrames(await sampleToggle(page, 'sidebar-rail-expand'), false);
});
