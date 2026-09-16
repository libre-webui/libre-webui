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
  await page.addInitScript(token => {
    localStorage.setItem('i18nextLng', 'en');
    localStorage.setItem('auth-token', token);
  }, options.as.token);
}

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
