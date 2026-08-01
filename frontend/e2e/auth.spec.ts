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

type TurnstileTestWindow = Window & {
  completeTurnstile: (token: string) => void;
  turnstile: {
    render: (
      element: HTMLElement,
      options: { callback: (token: string) => void }
    ) => string;
    reset: () => void;
    remove: () => void;
  };
};

test('demo mode login is click-only with disabled demo credentials', async ({
  page,
}) => {
  const port = process.env.PLAYWRIGHT_PORT || '4173';

  await mockLibreWebUiApi(page, {
    systemInfo: {
      requiresAuth: true,
      hasUsers: true,
      userCount: 1,
      allowUserModelPull: true,
      version: '0.10.0-e2e',
      turnstile: { enabled: false },
    },
  });

  await page.goto(`http://demo.localhost:${port}/login`);

  await expect(page.getByLabel('Username')).toHaveValue('demo');
  await expect(page.getByLabel('Username')).toBeDisabled();
  await expect(page.getByLabel('Password')).toHaveValue('demo');
  await expect(page.getByLabel('Password')).toBeDisabled();
  await expect(page.getByRole('button', { name: /sign in/i })).toBeEnabled();

  await page.getByRole('button', { name: /sign in/i }).click();

  await expect(page.getByText('Demo Mode')).toBeVisible();
  // Signing in lands on the Home launcher tab, not straight into a chat.
  await expect(page.getByTestId('home-page')).toBeVisible();
  await expect(page.getByTestId('home-new-chat')).toBeVisible();
  await expect(page).not.toHaveURL(/\/login$/);
});

test('one-user mode bypasses login and renders the app shell', async ({
  page,
}) => {
  await mockLibreWebUiApi(page, {
    systemInfo: {
      requiresAuth: false,
      hasUsers: true,
      userCount: 1,
      allowUserModelPull: true,
      version: '0.10.0-e2e',
      turnstile: { enabled: false },
    },
  });

  await page.goto('/login');

  await expect(page.getByTestId('app-shell-content')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Sign In' })).toHaveCount(0);
  await expect(page.getByTestId('home-page')).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
});

test('password login requires and submits a Turnstile token', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const testWindow = window as unknown as TurnstileTestWindow;
    let completeVerification = (_token: string) => {};

    testWindow.completeTurnstile = token => completeVerification(token);
    testWindow.turnstile = {
      render: (_element, options) => {
        completeVerification = options.callback;
        return 'login-turnstile-widget';
      },
      reset: () => {},
      remove: () => {},
    };
  });

  await mockLibreWebUiApi(page, {
    systemInfo: {
      requiresAuth: true,
      hasUsers: true,
      userCount: 1,
      allowUserModelPull: true,
      version: '0.17.0-e2e',
      turnstile: {
        enabled: true,
        siteKey: '1x00000000000000000000AA',
      },
    },
  });

  await page.goto('/login');

  const signInButton = page.getByRole('button', { name: /sign in/i });
  await expect(page.getByLabel('Security verification')).toBeVisible();
  await expect(signInButton).toBeDisabled();

  await page.getByLabel('Username').fill('e2e');
  await page.getByLabel('Password').fill('password');
  await page.evaluate(() => {
    (window as unknown as TurnstileTestWindow).completeTurnstile(
      'verified-login-token'
    );
  });

  await expect(signInButton).toBeEnabled();
  const loginRequest = page.waitForRequest(request =>
    request.url().endsWith('/api/auth/login')
  );
  await signInButton.click();

  expect((await loginRequest).postDataJSON()).toEqual({
    username: 'e2e',
    password: 'password',
    turnstileToken: 'verified-login-token',
  });
});
