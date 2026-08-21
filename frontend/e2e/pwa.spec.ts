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

import { test, expect } from '@playwright/test';
import { mockLibreWebUiApi } from './lib/mockApi';

/**
 * The installable-app surface: the manifest is linked and complete, the
 * service worker script is served from the root scope, and registration is
 * deliberately absent in dev (production-only enhancement).
 */

test('the app page links a complete web app manifest', async ({ page }) => {
  await mockLibreWebUiApi(page);
  await page.goto('/');

  const manifestHref = await page
    .locator('link[rel="manifest"]')
    .getAttribute('href');
  expect(manifestHref).toBe('/manifest.webmanifest');

  const themeColor = await page
    .locator('meta[name="theme-color"]')
    .getAttribute('content');
  expect(themeColor).toBeTruthy();

  const manifest = await page.evaluate(async () => {
    const response = await fetch('/manifest.webmanifest');
    return { status: response.status, body: await response.json() };
  });
  expect(manifest.status).toBe(200);
  expect(manifest.body.name).toBe('Libre WebUI');
  expect(manifest.body.display).toBe('standalone');
  expect(manifest.body.start_url).toBe('/');
  const sizes = manifest.body.icons.map(
    (icon: { sizes: string }) => icon.sizes
  );
  expect(sizes).toContain('192x192');
  expect(sizes).toContain('512x512');
  const purposes = manifest.body.icons.map(
    (icon: { purpose?: string }) => icon.purpose
  );
  expect(purposes).toContain('maskable');
});

test('the service worker script is served at the root scope', async ({
  page,
}) => {
  await mockLibreWebUiApi(page);
  await page.goto('/');

  const worker = await page.evaluate(async () => {
    const response = await fetch('/sw.js');
    return {
      status: response.status,
      body: await response.text(),
      registrations: (await navigator.serviceWorker.getRegistrations()).length,
    };
  });
  expect(worker.status).toBe(200);
  // The worker handles push display and the offline shell.
  expect(worker.body).toContain("addEventListener('push'");
  expect(worker.body).toContain("addEventListener('notificationclick'");
  expect(worker.body).toContain('libre-webui-shell');
  // Dev never registers the worker; production registration is guarded in
  // main.tsx and cannot be exercised against the dev server.
  expect(worker.registrations).toBe(0);
});
