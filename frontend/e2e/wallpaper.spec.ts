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
import { createHash } from 'node:crypto';
import { mockLibreWebUiApi } from './lib/mockApi';
import { openSettingsTab } from './lib/settingsTab';

test.use({ timezoneId: 'UTC' });

// Opaque, self-contained source: no user files or image-host requests.
const sourceSvg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="100">' +
  '<defs><linearGradient id="sky"><stop stop-color="#335b74"/>' +
  '<stop offset="1" stop-color="#e8b98a"/></linearGradient></defs>' +
  '<rect width="160" height="100" fill="url(#sky)"/>' +
  '<path d="M0 85L48 20L90 75L126 40L160 90V100H0Z" fill="#193746"/>' +
  '<circle cx="125" cy="22" r="10" fill="#fff3cb"/></svg>';
const wallpaper = `data:image/svg+xml,${encodeURIComponent(sourceSvg)}`;
const landscapeSvg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="1440" height="900">' +
  '<defs><linearGradient id="sky" x1="0" y1="0" x2="1" y2="0">' +
  '<stop stop-color="#9ebfde"/><stop offset="0.5" stop-color="#dae7f2"/>' +
  '<stop offset="1" stop-color="#fff5df"/></linearGradient></defs>' +
  '<rect width="1440" height="900" fill="url(#sky)"/>' +
  '<path d="M0 420L130 350L280 395L475 300L640 385L830 320L1020 400L1210 330L1440 410V900H0Z" fill="#748998"/>' +
  '<path d="M0 535L210 425L370 475L560 405L760 485L985 420L1170 495L1440 445V900H0Z" fill="#435e60"/>' +
  '<path d="M0 645L260 575L520 635L810 570L1120 640L1440 555V900H0Z" fill="#243a3d"/>' +
  '<g fill="#354954"><rect x="880" y="365" width="85" height="210"/>' +
  '<rect x="977" y="318" width="60" height="265"/><rect x="1050" y="382" width="100" height="190"/></g>' +
  '<g fill="#d7c8a5"><rect x="896" y="391" width="12" height="18"/>' +
  '<rect x="930" y="391" width="12" height="18"/><rect x="993" y="350" width="12" height="18"/></g></svg>';
const createdAt = 1_780_000_000_000;
const modes = [
  { name: 'light', mode: 'light', hour: 12 },
  { name: 'dark', mode: 'dark', hour: 12 },
  { name: 'AMOLED', mode: 'amoled', hour: 12 },
  { name: 'Celestial day', mode: 'celestial', hour: 12 },
  { name: 'Celestial night', mode: 'celestial', hour: 0 },
] as const;

async function seedWallpaper(
  page: Page,
  mode: string,
  hour: number,
  enabled = true,
  preferenceUpdateFailures = 0,
  imageUrl = wallpaper,
  opacity = 0.8
) {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.clock.setFixedTime(
    new Date(`2026-09-05T${String(hour).padStart(2, '0')}:00:00Z`)
  );
  return mockLibreWebUiApi(page, {
    preferenceUpdateFailures,
    preferences: {
      theme: {
        mode,
        accent: 'blue',
        adaptToAccent: false,
        customAccent: '#2563eb',
      },
      // Deliberately omit effect: older preferences must default to dithering.
      backgroundSettings: {
        enabled,
        imageUrl,
        blurAmount: 0,
        opacity,
      },
    },
    sessions: [
      {
        id: 'wallpaper-chat',
        title: 'Wallpaper chat',
        model: 'llama3.2:3b',
        createdAt,
        updatedAt: createdAt,
        messages: [
          {
            id: 'wallpaper-message',
            role: 'assistant',
            content: 'Readable content over a personal wallpaper.',
            timestamp: createdAt,
          },
        ],
      },
    ],
    workTasks: [
      {
        id: 'wallpaper-task',
        title: 'Wallpaper task',
        model: 'llama3.2:3b',
        providerType: 'ollama',
        status: 'completed',
        networkEnabled: false,
        createdAt,
        updatedAt: createdAt,
        messages: [],
        activeRun: null,
        previewStatus: 'stopped',
        workspacePath: '/workspace',
      },
    ],
  });
}

async function chromePaint(page: Page) {
  return page.evaluate(() =>
    ['[data-app-shell]', '[data-app-sidebar]', '[data-app-tabbar]'].map(
      selector => {
        const style = getComputedStyle(document.querySelector(selector)!);
        return {
          fill: style.backgroundColor,
          image: style.backgroundImage,
          opacity: style.opacity,
          filter: style.backdropFilter,
        };
      }
    )
  );
}

async function assertWallpaperContained(page: Page) {
  const main = page.locator('[data-app-main]');
  const background = page.getByTestId('app-background');
  await expect(main).toHaveAttribute('data-wallpaper', 'true');
  await expect(main.getByTestId('app-background')).toHaveCount(1);
  await expect(background).toHaveAttribute('data-effect', 'dither');
  await expect(background).toHaveAttribute('data-state', 'ready');
  await expect(background).toHaveCSS('pointer-events', 'none');
  const mainBox = (await main.boundingBox())!;
  const backgroundBox = (await background.boundingBox())!;
  expect(backgroundBox.x).toBeGreaterThanOrEqual(mainBox.x);
  expect(backgroundBox.y).toBeGreaterThanOrEqual(mainBox.y);
  expect(backgroundBox.x + backgroundBox.width).toBeLessThanOrEqual(
    mainBox.x + mainBox.width
  );
  expect(backgroundBox.y + backgroundBox.height).toBeLessThanOrEqual(
    mainBox.y + mainBox.height
  );
  for (const selector of ['[data-app-sidebar]', '[data-app-tabbar]']) {
    await expect(
      page.locator(selector).getByTestId('app-background')
    ).toHaveCount(0);
  }
  const canvas = background.getByTestId('wallpaper-canvas');
  await expect(canvas).toBeVisible();
  const pixels = await canvas.evaluate(element => {
    const image = element as HTMLCanvasElement;
    const data = image
      .getContext('2d')!
      .getImageData(0, 0, image.width, image.height).data;
    let painted = 0;
    for (let index = 3; index < data.length; index += 4) {
      if (data[index] > 0) painted++;
    }
    return { width: image.width, height: image.height, painted };
  });
  expect(pixels.width).toBeGreaterThan(0);
  expect(pixels.height).toBeGreaterThan(0);
  expect(pixels.painted).toBeGreaterThan(0);
}

async function toggleWallpaper(page: Page) {
  const checkbox = page.getByTestId('background-enabled');
  await checkbox.locator('..').click();
  await expect(page.getByTestId('background-save-status')).toHaveText('Saved');
}

async function savedWallpaperSource(page: Page) {
  return page.evaluate(async () => {
    const token = localStorage.getItem('auth-token');
    const response = await fetch('/api/preferences', {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    const result = await response.json();
    return result.data.backgroundSettings.imageUrl;
  });
}

for (const { name, mode, hour } of modes) {
  test(`${name} confines wallpaper to Chat and Work without repainting navigation`, async ({
    page,
  }) => {
    await seedWallpaper(page, mode, hour, false);
    await page.goto('/chat');
    await expect(page.locator('[data-composer-box] textarea')).toBeVisible();
    await expect(page.getByTestId('app-background')).toHaveCount(0);
    const before = await chromePaint(page);
    await openSettingsTab(page, 'appearance');
    await toggleWallpaper(page);
    await expect(page.getByTestId('background-enabled')).toBeChecked();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('settings-modal-panel')).toHaveCount(0);
    await assertWallpaperContained(page);
    expect(await chromePaint(page)).toEqual(before);

    for (const route of [
      '/c/wallpaper-chat',
      '/work',
      '/work/wallpaper-task',
    ]) {
      await page.goto(route);
      await assertWallpaperContained(page);
    }
    for (const route of [
      '/',
      '/notes',
      '/gallery',
      '/calendar',
      '/automations',
      '/channels',
    ]) {
      await page.goto(route);
      await expect(page.locator('[data-app-main]')).toBeVisible();
      await expect(page.getByTestId('app-background')).toHaveCount(0);
      await expect(page.locator('[data-app-main]')).not.toHaveAttribute(
        'data-wallpaper',
        'true'
      );
    }
  });
}

test('wallpaper stays inside mobile RTL Chat and Work while controls remain usable', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await seedWallpaper(page, 'celestial', 0);
  await page.addInitScript(() => localStorage.setItem('i18nextLng', 'ar'));
  await page.goto('/c/wallpaper-chat');
  await expect(page.getByTestId('app-background')).toBeHidden();
  await page.getByTestId('sidebar-toggle-size').click();
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await assertWallpaperContained(page);
  await page.getByTestId('sidebar-rail-expand').click();
  await expect(page.getByTestId('app-background')).toBeHidden();
  await page.getByTestId('sidebar-toggle-size').click();
  await assertWallpaperContained(page);
  const main = (await page.locator('[data-app-main]').boundingBox())!;
  const sidebar = (await page.getByTestId('sidebar').boundingBox())!;
  expect(main.x + main.width).toBeLessThanOrEqual(sidebar.x);
  await page.locator('[data-composer-box] textarea').fill('مرحبا بالعالم');
  await expect(page.locator('[data-composer-box] textarea')).toHaveValue(
    'مرحبا بالعالم'
  );
  await page.goto('/work/wallpaper-task');
  await assertWallpaperContained(page);
  await page.getByTestId('work-composer-input').fill('مهمة جديدة');
  await expect(page.getByTestId('work-submit-button')).toBeEnabled();
});

test('wallpaper effects preserve the source and persist changes, zero intensity, disabling and removal', async ({
  page,
}) => {
  const mock = await seedWallpaper(page, 'dark', 12);
  await page.goto('/chat');
  await assertWallpaperContained(page);
  await openSettingsTab(page, 'appearance');
  const effect = page.getByTestId('background-effect');
  await expect(effect).toHaveValue('dither');
  await expect(page.getByTestId('background-preview')).toBeVisible();
  expect(await savedWallpaperSource(page)).toBe(wallpaper);

  await effect.selectOption('original');
  await expect(page.getByTestId('app-background')).toHaveAttribute(
    'data-effect',
    'original'
  );
  await expect(page.getByTestId('app-background')).toHaveAttribute(
    'data-state',
    'ready'
  );
  const original = page
    .getByTestId('app-background')
    .getByTestId('wallpaper-canvas');
  await expect(original).toBeVisible();
  expect(
    await original.evaluate(element => {
      const canvas = element as HTMLCanvasElement;
      return canvas
        .getContext('2d')!
        .getImageData(0, 0, canvas.width, canvas.height)
        .data.some((value, index) => index % 4 === 3 && value > 0);
    })
  ).toBe(true);
  expect(await savedWallpaperSource(page)).toBe(wallpaper);
  await effect.selectOption('blur');
  await page.getByTestId('background-blur').fill('7');
  await expect(page.getByTestId('app-background')).toHaveAttribute(
    'data-effect',
    'blur'
  );
  await page.getByTestId('background-intensity').fill('0');
  await expect(page.getByTestId('background-save-status')).toHaveText('Saved');
  await expect
    .poll(() => {
      const update = mock.preferenceUpdateRequests.at(-1)?.backgroundSettings;
      return update?.opacity;
    })
    .toBe(0);
  const saved = mock.preferenceUpdateRequests.at(-1)?.backgroundSettings as {
    imageUrl?: string;
    effect?: string;
    blurAmount?: number;
  };
  expect(saved.imageUrl).toBe(wallpaper);
  expect(saved.effect).toBe('blur');
  expect(saved.blurAmount).toBe(7);
  await page.reload();
  await openSettingsTab(page, 'appearance');
  await expect(effect).toHaveValue('blur');
  await expect(page.getByTestId('background-blur')).toHaveValue('7');
  await expect(page.getByTestId('background-intensity')).toHaveValue('0');
  await expect(page.getByTestId('background-preview')).toBeVisible();
  expect(await savedWallpaperSource(page)).toBe(wallpaper);

  await page.getByTestId('background-intensity').fill('0.8');
  await effect.selectOption('dither');
  await toggleWallpaper(page);
  await expect(page.getByTestId('background-enabled')).not.toBeChecked();
  await expect(page.getByTestId('app-background')).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId('app-background')).toHaveCount(0);
  await openSettingsTab(page, 'appearance');
  await toggleWallpaper(page);
  await expect(page.getByTestId('background-enabled')).toBeChecked();
  await page.getByTestId('background-remove').click();
  await expect(page.getByTestId('background-save-status')).toHaveText('Saved');
  await expect(page.getByTestId('app-background')).toHaveCount(0);
  await expect(page.getByTestId('background-preview')).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId('app-background')).toHaveCount(0);
  await openSettingsTab(page, 'appearance');
  await expect(page.getByTestId('background-preview')).toHaveCount(0);
  await expect(page.getByTestId('background-enabled')).not.toBeChecked();
});

test('a failed wallpaper save restores confirmed settings and offers retry', async ({
  page,
}) => {
  const mock = await seedWallpaper(page, 'dark', 12, true, 1);
  await page.goto('/chat');
  await assertWallpaperContained(page);
  await openSettingsTab(page, 'appearance');
  const effect = page.getByTestId('background-effect');
  await effect.selectOption('original');
  const status = page.getByTestId('background-save-status');
  await expect(status).toHaveAttribute('role', 'alert');
  await expect(status).toContainText('Changes could not be saved. Try again.');
  await expect(effect).toHaveValue('dither');
  await expect(page.getByTestId('app-background')).toHaveAttribute(
    'data-effect',
    'dither'
  );
  expect(await savedWallpaperSource(page)).toBe(wallpaper);

  await status.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(status).toHaveText('Saved');
  await expect(effect).toHaveValue('original');
  await expect(page.getByTestId('app-background')).toHaveAttribute(
    'data-effect',
    'original'
  );
  expect(mock.preferenceUpdateRequests).toHaveLength(2);
  await page.reload();
  await expect(page.getByTestId('app-background')).toHaveAttribute(
    'data-effect',
    'original'
  );
  expect(await savedWallpaperSource(page)).toBe(wallpaper);
});

test('choosing a chat persona cannot replace the account wallpaper', async ({
  page,
}) => {
  const mock = await seedWallpaper(page, 'dark', 12);
  const persona = {
    id: 'wallpaper-persona',
    name: 'Paper guide',
    description: 'A persona with its own chat artwork.',
    model: 'llama3.2:3b',
    parameters: {},
    user_id: 'e2e-user',
    created_at: createdAt,
    updated_at: createdAt,
    background: `data:image/svg+xml,${encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="#d96748"/></svg>'
    )}`,
  };
  await page.route('**/api/personas', route =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: [persona] }),
    })
  );
  await page.route('**/api/personas/wallpaper-persona', route =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: persona }),
    })
  );
  await page.goto('/c/wallpaper-chat');
  await assertWallpaperContained(page);
  const preferenceWrites = mock.preferenceUpdateRequests.length;
  await page.getByRole('button', { name: /llama3\.2:3b/ }).click();
  await page
    .locator(
      '[data-testid="model-selector-option"][data-model-value="persona:wallpaper-persona"]'
    )
    .click();
  await expect.poll(() => mock.sessionUpdateRequests.length).toBeGreaterThan(0);
  await expect(
    page
      .locator('[data-composer-box]')
      .getByRole('button', { name: /Paper guide/ })
  ).toBeVisible();
  expect(mock.preferenceUpdateRequests).toHaveLength(preferenceWrites);
  expect(await savedWallpaperSource(page)).toBe(wallpaper);
  await page.goto('/work/wallpaper-task');
  await assertWallpaperContained(page);
  expect(await savedWallpaperSource(page)).toBe(wallpaper);
});

test('a delayed old image cannot overwrite a newly uploaded wallpaper', async ({
  page,
}) => {
  await seedWallpaper(page, 'light', 12, true, 0, '/wallpaper-old.svg');
  let releaseOldImage!: () => void;
  const oldImageGate = new Promise<void>(resolve => {
    releaseOldImage = resolve;
  });
  let oldRequests = 0;
  let finishedOldRequests = 0;
  await page.route('**/wallpaper-old.svg', async route => {
    oldRequests++;
    await oldImageGate;
    // Replacing the source may cancel the browser's original request.
    await route
      .fulfill({
        contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="100"><rect width="160" height="100" fill="#ff0000"/></svg>',
      })
      .catch(() => undefined);
    finishedOldRequests++;
  });
  await page.goto('/chat');
  await expect.poll(() => oldRequests).toBeGreaterThan(0);
  await expect(page.getByTestId('app-background')).toHaveAttribute(
    'data-state',
    'loading'
  );
  await openSettingsTab(page, 'appearance');
  const replacement =
    '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="100"><rect width="160" height="100" fill="#0055ff"/></svg>';
  await page.getByTestId('background-file-input').setInputFiles({
    name: 'replacement.svg',
    mimeType: 'image/svg+xml',
    buffer: Buffer.from(replacement),
  });
  await expect(page.getByTestId('background-save-status')).toHaveText('Saved');
  const background = page.getByTestId('app-background');
  await expect(background).toHaveAttribute('data-state', 'ready');
  const canvas = background.getByTestId('wallpaper-canvas');
  const bitmap = async () => {
    const snapshot = await canvas.evaluate(element => {
      const image = element as HTMLCanvasElement;
      const pixels = image
        .getContext('2d')!
        .getImageData(0, 0, image.width, image.height).data;
      let red = 0;
      let blue = 0;
      for (let offset = 0; offset < pixels.length; offset += 4) {
        const alpha = pixels[offset + 3] / 255;
        red += pixels[offset] * alpha;
        blue += pixels[offset + 2] * alpha;
      }
      return { red, blue, png: image.toDataURL() };
    });
    return {
      red: snapshot.red,
      blue: snapshot.blue,
      digest: createHash('sha256').update(snapshot.png).digest('hex'),
    };
  };
  // A dot pattern can leave the corner black. Verify painted color and the
  // complete bitmap so a late image cannot replace any portion of the result.
  const currentBitmap = await bitmap();
  expect(currentBitmap.blue).toBeGreaterThan(currentBitmap.red);
  releaseOldImage();
  await expect.poll(() => finishedOldRequests).toBe(oldRequests);
  await page.evaluate(
    () =>
      new Promise<void>(resolve => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      })
  );
  await expect(background).toHaveAttribute('data-state', 'ready');
  expect(await bitmap()).toEqual(currentBitmap);
  expect(await savedWallpaperSource(page)).toBe(
    `data:image/svg+xml;base64,${Buffer.from(replacement).toString('base64')}`
  );
});

async function primaryTextContrast(page: Page) {
  const text = page.getByText('Readable content over a personal wallpaper.', {
    exact: true,
  });
  await text.scrollIntoViewIfNeeded();
  const probe = await text.evaluate(element => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const bounds = range.getBoundingClientRect();
    return {
      color: getComputedStyle(element).color,
      className: element.className,
      visibility: (element as HTMLElement).style.visibility,
      bounds: {
        x: Math.floor(bounds.left),
        y: Math.floor(bounds.top),
        width: Math.ceil(bounds.right) - Math.floor(bounds.left),
        height: Math.ceil(bounds.bottom) - Math.floor(bounds.top),
      },
    };
  });
  // Sample the actual composited backdrop, including masks, theme veils, and
  // the rendered image, without counting antialiased glyph pixels as background.
  await text.evaluate(element => {
    (element as HTMLElement).style.visibility = 'hidden';
  });
  let screenshot: Buffer;
  try {
    screenshot = await page.screenshot({ animations: 'disabled' });
  } finally {
    await text.evaluate((element, visibility) => {
      (element as HTMLElement).style.visibility = visibility;
    }, probe.visibility);
  }
  const backgrounds = await page.evaluate(
    async ({ source, bounds }) => {
      const image = new Image();
      image.src = source;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d')!;
      context.drawImage(image, 0, 0);
      const pixels = context.getImageData(
        bounds.x,
        bounds.y,
        bounds.width,
        bounds.height
      ).data;
      const colors = new Map<string, number[]>();
      for (let offset = 0; offset < pixels.length; offset += 4) {
        const rgb = Array.from(pixels.slice(offset, offset + 3));
        colors.set(rgb.join(','), rgb);
      }
      return Array.from(colors.values());
    },
    {
      source: `data:image/png;base64,${screenshot!.toString('base64')}`,
      bounds: probe.bounds,
    }
  );
  const foreground = probe.color
    .match(/[\d.]+/g)!
    .slice(0, 3)
    .map(Number);
  const luminance = (rgb: number[]) => {
    const linear = rgb.map(value => {
      const channel = value / 255;
      return channel <= 0.04045
        ? channel / 12.92
        : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
  };
  const front = luminance(foreground);
  return {
    foreground,
    backgrounds,
    className: probe.className,
    ratio: Math.min(
      ...backgrounds.map(background => {
        const back = luminance(background);
        return (Math.max(front, back) + 0.05) / (Math.min(front, back) + 0.05);
      })
    ),
  };
}

for (const { name, mode, hour } of modes) {
  for (const color of ['white', 'black']) {
    test(`${name} keeps text readable over ${color} wallpaper at full intensity`, async ({
      page,
    }) => {
      const source = `data:image/svg+xml,${encodeURIComponent(
        `<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="${color}"/></svg>`
      )}`;
      await seedWallpaper(page, mode, hour, true, 0, source, 1);
      await page.goto('/c/wallpaper-chat');
      for (const effect of ['dither', 'original', 'blur']) {
        if (effect !== 'dither') {
          await openSettingsTab(page, 'appearance');
          await page.getByTestId('background-effect').selectOption(effect);
          await expect(page.getByTestId('background-save-status')).toHaveText(
            'Saved'
          );
          await page.keyboard.press('Escape');
          await expect(page.getByTestId('settings-modal-panel')).toHaveCount(0);
        }
        const background = page.getByTestId('app-background');
        await expect(background).toHaveAttribute('data-effect', effect);
        await expect(background).toHaveAttribute('data-state', 'ready');
        const contrast = await primaryTextContrast(page);
        expect(
          contrast.ratio,
          JSON.stringify({ name, color, effect, ...contrast })
        ).toBeGreaterThanOrEqual(4.5);
      }
      expect(await savedWallpaperSource(page)).toBe(source);
    });
  }
}

test('switching accounts clears a failed file-upload retry from open Appearance settings', async ({
  page,
}) => {
  const systemInfo = {
    requiresAuth: true,
    hasUsers: true,
    userCount: 2,
    version: '0.15.0-e2e',
    turnstile: { enabled: false },
  };
  const alice = {
    id: 'wallpaper-alice',
    username: 'alice',
    email: 'alice@example.test',
    role: 'admin' as const,
    token: 'alice-wallpaper-token',
  };
  const bobBackground = {
    enabled: true,
    imageUrl: wallpaper,
    blurAmount: 0,
    opacity: 0.4,
    effect: 'original' as const,
  };
  const bob = {
    id: 'wallpaper-bob',
    username: 'bob',
    email: 'bob@example.test',
    role: 'admin' as const,
    token: 'bob-wallpaper-token',
    preferences: { backgroundSettings: bobBackground },
  };
  const mock = await mockLibreWebUiApi(page, {
    systemInfo,
    authUsers: [alice, bob],
    preferenceUpdateFailures: 1,
  });
  await page.addInitScript(
    token => localStorage.setItem('auth-token', token),
    alice.token
  );
  await page.goto('/chat');
  const panel = await openSettingsTab(page, 'appearance');
  await panel.evaluate(element => {
    (element as HTMLElement).dataset.retryOwnerProbe = 'mounted';
  });
  await page.getByTestId('background-file-input').setInputFiles({
    name: 'alice-only.svg',
    mimeType: 'image/svg+xml',
    buffer: Buffer.from(sourceSvg),
  });
  const status = page.getByTestId('background-save-status');
  await expect(status).toHaveAttribute('role', 'alert');
  await expect(status.getByRole('button', { name: 'Retry' })).toBeVisible();
  expect(mock.preferenceUpdateUserIds).toEqual([alice.id]);

  // Exercise an owner replacement while the modal stays mounted. A logout UI
  // journey would close it first and could not detect a retained File closure.
  await page.evaluate(
    async ({ user, token, info }) => {
      const modulePath = '/src/store/authStore.ts';
      const { useAuthStore } = await import(modulePath);
      useAuthStore.getState().login(user, token, info);
    },
    {
      user: {
        id: bob.id,
        username: bob.username,
        email: bob.email,
        role: bob.role,
      },
      token: bob.token,
      info: systemInfo,
    }
  );
  await expect(panel).toHaveAttribute('data-retry-owner-probe', 'mounted');
  await expect(page.getByTestId('background-effect')).toHaveValue('original');
  await expect(status.getByRole('button', { name: 'Retry' })).toHaveCount(0);
  await expect(status).not.toHaveAttribute('role', 'alert');
  await expect(page.getByTestId('background-file-input')).toHaveValue('');
  expect(mock.preferenceUpdateUserIds).toEqual([alice.id]);
  expect(await savedWallpaperSource(page)).toBe(wallpaper);
});

test('wallpaper accepts exactly 10 MiB and rejects one extra byte with a French error', async ({
  page,
}) => {
  const maximumBytes = 10 * 1024 * 1024;
  // XML permits trailing whitespace: preserve a decodable image at the exact
  // upload boundary without committing a large fixture or stubbing FileReader.
  const source = Buffer.alloc(maximumBytes, ' ');
  source.write(sourceSvg, 0, 'utf8');
  const mock = await seedWallpaper(page, 'dark', 12);
  await page.addInitScript(() => localStorage.setItem('i18nextLng', 'fr'));
  await page.goto('/chat');
  await openSettingsTab(page, 'appearance');
  const input = page.getByTestId('background-file-input');

  await input.setInputFiles({
    name: 'one-byte-too-large.svg',
    mimeType: 'image/svg+xml',
    buffer: Buffer.concat([source, Buffer.from(' ')]),
  });
  await expect(
    page.getByRole('status').filter({
      hasText:
        "La taille de l'image d'arrière-plan ne doit pas dépasser 10 Mo.",
    })
  ).toBeVisible();
  expect(mock.preferenceUpdateRequests.length).toBe(0);
  expect(await savedWallpaperSource(page)).toBe(wallpaper);

  await input.setInputFiles({
    name: 'exactly-ten-mebibytes.svg',
    mimeType: 'image/svg+xml',
    buffer: source,
  });
  await expect(page.getByTestId('background-save-status')).toHaveText(
    'Enregistré'
  );
  expect(mock.preferenceUpdateRequests.length).toBe(1);
  const saved = mock.preferenceUpdateRequests[0].backgroundSettings?.imageUrl;
  expect(saved?.startsWith('data:image/svg+xml;base64,')).toBe(true);
  const savedBytes = Buffer.from(saved!.split(',')[1], 'base64');
  expect(savedBytes.length).toBe(maximumBytes);
  expect(createHash('sha256').update(savedBytes).digest('hex')).toBe(
    createHash('sha256').update(source).digest('hex')
  );
  // Ready canvas pixels prove the native Image path decoded the padded SVG.
  await assertWallpaperContained(page);
});

test('a bright landscape retains sky texture and tonal separation after dark rendering', async ({
  page,
}) => {
  const source = `data:image/svg+xml,${encodeURIComponent(landscapeSvg)}`;
  await seedWallpaper(page, 'dark', 12, true, 0, source, 1);
  await page.goto('/chat');
  await assertWallpaperContained(page);
  const metrics = await page
    .getByTestId('app-background')
    .getByTestId('wallpaper-canvas')
    .evaluate(element => {
      const canvas = element as HTMLCanvasElement;
      const context = canvas.getContext('2d')!;
      const linear = (value: number) => {
        const channel = value / 255;
        return channel <= 0.04045
          ? channel / 12.92
          : ((channel + 0.055) / 1.055) ** 2.4;
      };
      const sample = (x: number, y: number, width: number, height: number) => {
        const pixels = context.getImageData(x, y, width, height).data;
        const values: number[] = [];
        let transparentPixels = 0;
        for (let offset = 0; offset < pixels.length; offset += 4) {
          if (pixels[offset + 3] === 0) transparentPixels++;
          values.push(
            linear(pixels[offset]) * 0.2126 +
              linear(pixels[offset + 1]) * 0.7152 +
              linear(pixels[offset + 2]) * 0.0722
          );
        }
        return { values, transparentPixels };
      };
      // Equal, grid-aligned samples avoid mistaking partial dot cells for a
      // brightness gradient; the upper image contains only the pale sky.
      const left = Math.floor((canvas.width * 0.18) / 8) * 8;
      const top = Math.floor((canvas.height * 0.16) / 8) * 8;
      const bandWidth = Math.max(
        8,
        Math.floor((canvas.width * 0.64) / 4 / 8) * 8
      );
      const bands = Array.from({ length: 4 }, (_, index) =>
        sample(left + index * bandWidth, top, bandWidth, 32)
      );
      const sky = bands.flatMap(band => band.values);
      const terrain = sample(
        left,
        Math.floor(canvas.height * 0.9),
        bandWidth * 4,
        8
      );
      const average = (values: number[]) =>
        values.reduce((sum, value) => sum + value, 0) / values.length;
      return {
        gapRatio:
          bands.reduce((sum, band) => sum + band.transparentPixels, 0) /
          sky.length,
        skySpread: Math.max(...sky) - Math.min(...sky),
        bandMeans: bands.map(band => average(band.values)),
        skyMean: average(sky),
        terrainMean: average(terrain.values),
      };
    });
  const evidence = JSON.stringify(metrics);
  expect(metrics.gapRatio, evidence).toBeGreaterThan(0.5);
  expect(metrics.gapRatio, evidence).toBeLessThan(0.75);
  expect(metrics.skySpread, evidence).toBeGreaterThan(0.025);
  expect(
    Math.max(...metrics.bandMeans) - Math.min(...metrics.bandMeans),
    evidence
  ).toBeGreaterThan(0.003);
  expect(metrics.terrainMean, evidence).toBeLessThan(metrics.skyMean);
  expect(await savedWallpaperSource(page)).toBe(source);
});
