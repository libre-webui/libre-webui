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

import { expect, test, type Locator, type Page } from '@playwright/test';
import en from '../src/i18n/locales/en.json' with { type: 'json' };
import ar from '../src/i18n/locales/ar.json' with { type: 'json' };
import { mockLibreWebUiApi, type MockEmailSettings } from './lib/mockApi';
import { openSettingsTab } from './lib/settingsTab';

const admin = {
  id: 'admin-user',
  username: 'admin',
  email: 'admin@example.test',
  role: 'admin' as const,
  status: 'active' as const,
  token: 'admin-token',
};
const member = {
  id: 'member-user',
  username: 'member',
  email: 'member@example.test',
  role: 'user' as const,
  status: 'active' as const,
  token: 'member-token',
};
const addressless = {
  id: 'addressless-user',
  username: 'nobody',
  email: null,
  role: 'user' as const,
  status: 'active' as const,
  token: 'nobody-token',
};

const configuredServer: Partial<MockEmailSettings> = {
  enabled: true,
  host: 'smtp.example.test',
  from: 'Libre WebUI <notify@example.test>',
};

async function prepare(
  page: Page,
  options: {
    as: typeof admin | typeof member | typeof addressless;
    emailSettings?: Partial<MockEmailSettings>;
    emailTestFailure?: string;
    language?: 'en' | 'ar';
  }
) {
  await mockLibreWebUiApi(page, {
    systemInfo: {
      requiresAuth: true,
      hasUsers: true,
      userCount: 3,
      signupEnabled: false,
      version: '0.36.0-e2e',
      turnstile: { enabled: false },
    },
    authUsers: [admin, member, addressless],
    ...(options.emailSettings ? { emailSettings: options.emailSettings } : {}),
    ...(options.emailTestFailure
      ? { emailTestFailure: options.emailTestFailure }
      : {}),
  });
  await page.addInitScript(
    ({ token, language }) => {
      localStorage.setItem('i18nextLng', language);
      localStorage.setItem('auth-token', token);
    },
    { token: options.as.token, language: options.language ?? 'en' }
  );
}

for (const language of ['en', 'ar'] as const) {
  test(`an administrator previews and saves a dark email template in ${language}`, async ({
    page,
  }) => {
    await prepare(page, { as: admin, language });
    const strings = language === 'ar' ? ar : en;
    let testMessages = 0;
    page.on('request', request => {
      if (request.url().endsWith('/api/email/test')) testMessages += 1;
    });
    await page.goto('/users');
    await page
      .getByRole('tab', { name: strings.userManager.sections.access })
      .click();
    const card = page.getByTestId('email-notification-settings');
    const theme = card.getByTestId('email-template-theme');
    await expect(theme).toHaveValue('light');
    const previewRequest = page.waitForRequest(
      request =>
        request.url().endsWith('/api/email/preview') &&
        request.postDataJSON().emailTheme === 'dark'
    );
    await theme.selectOption('dark');
    expect((await previewRequest).postDataJSON()).toMatchObject({
      emailTheme: 'dark',
      heading: strings.userManager.emailNotifications.previewHeading,
    });
    const frame = card.getByTestId('email-template-preview');
    await expect(frame).toHaveAttribute('sandbox', '');
    await expect(frame).toHaveAttribute('referrerpolicy', 'no-referrer');
    await expect(
      page
        .frameLocator('[data-testid="email-template-preview"]')
        .locator('body')
    ).toHaveAttribute('data-email-theme', 'dark');
    await expect(
      page
        .frameLocator('[data-testid="email-template-preview"]')
        .getByRole('heading', {
          name: strings.userManager.emailNotifications.previewHeading,
        })
    ).toBeVisible();
    const save = page.waitForRequest(
      request =>
        request.method() === 'PUT' &&
        request.url().endsWith('/api/email/settings')
    );
    await card.getByTestId('email-save-button').click();
    expect((await save).postDataJSON().emailTheme).toBe('dark');
    await expect(card.getByTestId('email-save-button')).toBeDisabled();
    await page.reload();
    await page.goto('/users');
    await page
      .getByRole('tab', { name: strings.userManager.sections.access })
      .click();
    await expect(page.getByTestId('email-template-theme')).toHaveValue('dark');
    expect(testMessages).toBe(0);
  });
}

test('a delayed email preview cannot replace a newer theme or load remote assets', async ({
  page,
}) => {
  await prepare(page, { as: admin });
  let releaseLight!: () => void;
  const lightGate = new Promise<void>(resolve => {
    releaseLight = resolve;
  });
  let lightStarted!: () => void;
  const lightPending = new Promise<void>(resolve => {
    lightStarted = resolve;
  });
  let remoteRequests = 0;
  // CSP-blocked resource attempts emit request events, but never reach the
  // network interceptor. Count actual outgoing requests instead.
  await page.route('https://email-assets.example.test/**', async route => {
    remoteRequests += 1;
    await route.abort();
  });
  await page.route('**/api/email/preview', async route => {
    const body = route.request().postDataJSON();
    if (body.emailTheme === 'light') {
      lightStarted();
      await lightGate;
    }
    await route.fulfill({
      json: {
        success: true,
        data: {
          html: `<html><head><link rel="stylesheet" href="https://email-assets.example.test/fonts.css"></head><body data-email-theme="${body.emailTheme}"><img src="https://email-assets.example.test/logo.png" alt=""><h1>Preview</h1></body></html>`,
          text: 'Preview',
        },
      },
    });
  });
  try {
    await page.goto('/users');
    await page
      .getByRole('tab', { name: en.userManager.sections.access })
      .click();
    await lightPending;
    await page.getByTestId('email-template-theme').selectOption('dark');
    const body = page
      .frameLocator('[data-testid="email-template-preview"]')
      .locator('body');
    await expect(body).toHaveAttribute('data-email-theme', 'dark');
    const oldResponse = page.waitForResponse(
      response =>
        response.url().endsWith('/api/email/preview') &&
        response.request().postDataJSON().emailTheme === 'light'
    );
    releaseLight();
    await (await oldResponse).finished();
    await page.evaluate(
      () =>
        new Promise(resolve =>
          requestAnimationFrame(() => requestAnimationFrame(resolve))
        )
    );
    await expect(body).toHaveAttribute('data-email-theme', 'dark');
    expect(remoteRequests).toBe(0);
  } finally {
    releaseLight();
  }
});

/** SettingsToggle keeps its checkbox screen-reader-only; the label is the target. */
const flip = (row: Locator) => row.locator('label').first().click();

const preferenceUpdate = (page: Page) =>
  page.waitForRequest(
    request =>
      request.method() === 'PUT' && /\/api\/preferences\/?$/.test(request.url())
  );

test('a user opts into mention and automation emails from Settings > Notifications', async ({
  page,
}) => {
  await prepare(page, { as: member, emailSettings: configuredServer });
  await page.goto('/');
  const panel = await openSettingsTab(page, 'notifications');
  const section = panel.getByTestId('settings-email-notifications');
  await expect(section).toContainText(
    en.settings.notifications.emailHint.replace(
      '{{address}}',
      'member@example.test'
    )
  );

  const mentions = section
    .getByTestId('settings-email-channelMentions')
    .getByRole('checkbox');
  const automations = section
    .getByTestId('settings-email-automationRuns')
    .getByRole('checkbox');
  await expect(mentions).toBeEnabled();
  await expect(mentions).not.toBeChecked();
  await expect(automations).not.toBeChecked();

  const firstUpdate = preferenceUpdate(page);
  await flip(section.getByTestId('settings-email-channelMentions'));
  expect((await firstUpdate).postDataJSON().emailNotifications).toEqual({
    channelMentions: true,
    automationRuns: false,
  });
  await expect(mentions).toBeChecked();

  const secondUpdate = preferenceUpdate(page);
  await flip(section.getByTestId('settings-email-automationRuns'));
  expect((await secondUpdate).postDataJSON().emailNotifications).toEqual({
    channelMentions: true,
    automationRuns: true,
  });
  await expect(automations).toBeChecked();

  // The choice survives a reload because it lives in the account preferences.
  await page.reload();
  const reopened = await openSettingsTab(page, 'notifications');
  await expect(
    reopened.getByTestId('settings-email-automationRuns').getByRole('checkbox')
  ).toBeChecked();
});

test('the email switches explain themselves without a mail server or an address', async ({
  page,
}) => {
  await prepare(page, { as: member });
  await page.goto('/');
  const panel = await openSettingsTab(page, 'notifications');
  const section = panel.getByTestId('settings-email-notifications');
  await expect(section).toContainText(
    en.settings.notifications.emailUnavailable
  );
  await expect(
    section.getByTestId('settings-email-channelMentions').getByRole('checkbox')
  ).toBeDisabled();
  await expect(
    section.getByTestId('settings-email-automationRuns').getByRole('checkbox')
  ).toBeDisabled();
});

test('the email switches stay off for an account without an address', async ({
  page,
}) => {
  await prepare(page, { as: addressless, emailSettings: configuredServer });
  await page.goto('/');
  const reopened = await openSettingsTab(page, 'notifications');
  const withoutAddress = reopened.getByTestId('settings-email-notifications');
  await expect(withoutAddress).toContainText(
    en.settings.notifications.emailNoAddress
  );
  await expect(
    withoutAddress
      .getByTestId('settings-email-channelMentions')
      .getByRole('checkbox')
  ).toBeDisabled();
});

test('an administrator configures the mail server and proves it with a test message', async ({
  page,
}) => {
  await prepare(page, { as: admin });
  await page.goto('/users');
  await page.getByRole('tab', { name: en.userManager.sections.access }).click();
  const card = page.getByTestId('email-notification-settings');
  await expect(card).toBeVisible();

  const enabledSwitch = card
    .getByTestId('email-notifications-enabled')
    .getByRole('checkbox');
  await expect(enabledSwitch).toBeDisabled();
  await expect(card.getByTestId('email-test-button')).toBeDisabled();

  await card.getByTestId('email-smtp-host').fill('smtp.example.test');
  await card.getByTestId('email-smtp-port').fill('2525');
  await card.getByTestId('email-smtp-username').fill('relay');
  await card.getByTestId('email-smtp-password').fill('hunter2');
  await card
    .getByTestId('email-smtp-from')
    .fill('Libre WebUI <notify@example.test>');
  await card.getByTestId('email-app-url').fill('https://chat.example.test');

  const save = page.waitForRequest(
    request =>
      request.method() === 'PUT' &&
      request.url().endsWith('/api/email/settings')
  );
  await card.getByTestId('email-save-button').click();
  const saved = (await save).postDataJSON();
  expect(saved).toMatchObject({
    host: 'smtp.example.test',
    port: '2525',
    security: 'starttls',
    username: 'relay',
    password: 'hunter2',
    from: 'Libre WebUI <notify@example.test>',
    appUrl: 'https://chat.example.test',
    rejectUnauthorized: true,
  });
  await expect(
    page.getByText(en.userManager.emailNotifications.saved)
  ).toBeVisible();
  // The password never comes back; the field clears and reports it is stored.
  await expect(card.getByTestId('email-smtp-password')).toHaveValue('');
  await expect(card).toContainText(
    en.userManager.emailNotifications.passwordStored
  );

  const enable = page.waitForRequest(
    request =>
      request.method() === 'PUT' &&
      request.url().endsWith('/api/email/settings')
  );
  await expect(enabledSwitch).toBeEnabled();
  await flip(card.getByTestId('email-notifications-enabled'));
  expect((await enable).postDataJSON()).toEqual({ enabled: true });
  await expect(
    page.getByText(en.userManager.emailNotifications.enabledToast)
  ).toBeVisible();

  await expect(card.getByTestId('email-test-recipient')).toHaveValue(
    'admin@example.test'
  );
  const probe = page.waitForRequest(
    request =>
      request.method() === 'POST' && request.url().endsWith('/api/email/test')
  );
  await card.getByTestId('email-test-button').click();
  expect((await probe).postDataJSON()).toEqual({ to: 'admin@example.test' });
  await expect(
    page.getByText(
      en.userManager.emailNotifications.testSent.replace(
        '{{address}}',
        'admin@example.test'
      )
    )
  ).toBeVisible();
});

test('a failed test message shows the server error to the administrator', async ({
  page,
}) => {
  await prepare(page, {
    as: admin,
    emailSettings: configuredServer,
    emailTestFailure:
      'Could not connect to smtp.example.test:587 (ECONNREFUSED).',
  });
  await page.goto('/users');
  await page.getByRole('tab', { name: en.userManager.sections.access }).click();
  const card = page.getByTestId('email-notification-settings');
  await card.getByTestId('email-test-button').click();
  await expect(
    page.getByText('Could not connect to smtp.example.test:587 (ECONNREFUSED).')
  ).toBeVisible();
});
