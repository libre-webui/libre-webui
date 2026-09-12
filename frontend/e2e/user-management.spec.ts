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
import type { UserCreateRequest, UserUpdateRequest } from '../src/types';
import en from '../src/i18n/locales/en.json' with { type: 'json' };
import ar from '../src/i18n/locales/ar.json' with { type: 'json' };
import { mockLibreWebUiApi } from './lib/mockApi';

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
  email: null,
  role: 'user' as const,
  status: 'active' as const,
  token: 'member-token',
};
const pending = {
  id: 'pending-user',
  username: 'waiting',
  email: 'waiting@example.test',
  role: 'user' as const,
  status: 'pending' as const,
  token: 'pending-token',
};
const validPassword = 'SecurePassword123';

async function prepareUsers(
  page: Page,
  options: {
    language?: 'en' | 'ar';
    theme?: 'light' | 'dark';
    long?: boolean;
  } = {}
) {
  const { language = 'en', theme = 'light', long = false } = options;
  const users = [
    {
      ...admin,
      preferences: {
        theme: {
          mode: theme,
          adaptToAccent: false,
          accent: 'blue' as const,
          customAccent: '#2563eb',
        },
      },
    },
    {
      ...member,
      username: long
        ? 'member-with-an-unbroken-identity'.repeat(4)
        : member.username,
      email: long ? `${'long-email'.repeat(10)}@example.test` : member.email,
    },
    pending,
  ];
  await mockLibreWebUiApi(page, {
    systemInfo: {
      requiresAuth: true,
      hasUsers: true,
      userCount: users.length,
      signupEnabled: true,
      version: '0.17.0-e2e',
      turnstile: { enabled: false },
    },
    authUsers: users,
  });
  await page.addInitScript(language => {
    localStorage.setItem('i18nextLng', language);
    localStorage.setItem('auth-token', 'admin-token');
  }, language);
  return users.map(user => ({
    ...user,
    createdAt: '2026-06-21T00:00:00.000Z',
    updatedAt: '2026-06-21T00:00:00.000Z',
  }));
}

test('account search and role filters include pending registrations', async ({
  page,
}, testInfo) => {
  await prepareUsers(page);
  await page.goto('/users');

  const activeRows = page.getByTestId('user-row');
  const pendingRows = page.getByTestId('pending-user-row');
  const search = page.getByRole('searchbox', { name: 'Search users...' });
  const role = page.getByRole('combobox', { name: 'Role', exact: true });
  await expect(activeRows).toHaveCount(2);
  await expect(pendingRows).toHaveCount(1);
  await page.screenshot({ path: testInfo.outputPath('users-desktop.png') });

  await search.fill('ADMIN@EXAMPLE');
  await expect(activeRows).toHaveCount(1);
  await expect(activeRows).toContainText('admin@example.test');
  await expect(pendingRows).toHaveCount(0);

  await search.fill('waiting');
  await expect(activeRows).toHaveCount(0);
  await expect(pendingRows).toHaveCount(1);
  await role.selectOption('admin');
  await expect(pendingRows).toHaveCount(0);
  await expect(page.getByText('No users matching your search')).toHaveCount(2);
  await page
    .getByRole('button', { name: 'Clear filters', exact: true })
    .click();
  await expect(search).toHaveValue('');
  await expect(activeRows).toHaveCount(2);
  await expect(pendingRows).toHaveCount(1);

  await role.selectOption('user');
  await expect(activeRows).toHaveCount(1);
  await expect(activeRows).toContainText('member');
  await expect(pendingRows).toHaveCount(1);
});

test('a failed account load can be retried without losing the search', async ({
  page,
}) => {
  await prepareUsers(page);
  let failRequests = true;
  let loadRequests = 0;
  await page.route('**/api/users', async route => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    loadRequests += 1;
    if (failRequests) {
      await route.fulfill({
        status: 503,
        json: { success: false, message: 'Account storage is unavailable.' },
      });
      return;
    }
    await route.fallback();
  });
  await page.goto('/users');
  const directory = page.getByTestId('user-directory');
  const failure = directory.getByRole('alert');
  await expect(failure).toContainText(en.userManager.directory.loadFailed);
  await expect(directory.getByTestId('user-row')).toHaveCount(0);
  await expect(directory.getByText(en.userManager.directory.empty)).toHaveCount(
    0
  );
  const search = directory.getByRole('searchbox', { name: 'Search users...' });
  await search.fill('member');
  const requestsBeforeRetry = loadRequests;
  failRequests = false;
  await failure.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(failure).toHaveCount(0);
  await expect(directory.getByTestId('user-row')).toHaveCount(1);
  await expect(directory.getByTestId('user-row')).toContainText('member');
  await expect(search).toHaveValue('member');
  expect(loadRequests).toBeGreaterThan(requestsBeforeRetry);
});

test('create and edit dialogs keep account drafts separate', async ({
  page,
}) => {
  await prepareUsers(page);
  await page.goto('/users');
  const openCreate = page.getByRole('button', {
    name: 'Create User',
    exact: true,
  });
  await openCreate.click();
  const create = page.getByRole('dialog', { name: 'Create User', exact: true });
  await expect(create.getByLabel('Email', { exact: true })).toHaveAttribute(
    'required',
    ''
  );
  await expect(create.getByLabel('Password', { exact: true })).toHaveAttribute(
    'required',
    ''
  );
  await create.getByLabel('Username', { exact: true }).fill('unsaved-account');
  await create.getByLabel('Email', { exact: true }).fill('draft@example.test');
  await create.getByLabel('Password', { exact: true }).fill(validPassword);
  await create.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(create).toHaveCount(0);
  await expect(openCreate).toBeFocused();

  await page.getByRole('button', { name: 'Edit: member', exact: true }).click();
  const edit = page.getByRole('dialog', { name: 'Edit User', exact: true });
  await expect(create).toHaveCount(0);
  await expect(edit.getByLabel('Username', { exact: true })).toHaveValue(
    'member'
  );
  await expect(edit.getByLabel(/^Email/)).toHaveValue('');
  await expect(edit.getByLabel(/^Email/)).not.toHaveAttribute('required');
  await expect(edit.getByLabel(/^Password/)).toHaveValue('');
  await expect(edit.getByLabel(/^Password/)).not.toHaveAttribute('required');
  await edit.getByLabel('Username', { exact: true }).fill('unsaved-member');
  await page.keyboard.press('Escape');
  await expect(edit).toHaveCount(0);
  await expect(
    page.getByRole('heading', { name: 'Settings', exact: true })
  ).toBeVisible();

  await openCreate.click();
  await expect(create.getByLabel('Username', { exact: true })).toHaveValue('');
  await expect(create.getByLabel('Email', { exact: true })).toHaveValue('');
  await expect(create.getByLabel('Password', { exact: true })).toHaveValue('');
});

test('failed creation preserves the draft and pending saves cannot be duplicated', async ({
  page,
}) => {
  const users = await prepareUsers(page);
  const requests: UserCreateRequest[] = [];
  let releaseFirst!: () => void;
  const firstResponse = new Promise<void>(resolve => {
    releaseFirst = resolve;
  });
  let savedUser: (typeof users)[number] | undefined;
  await page.route('**/api/users', async route => {
    if (route.request().method() === 'GET') {
      await route.fulfill({
        json: {
          success: true,
          data: savedUser ? [...users, savedUser] : users,
        },
      });
      return;
    }
    if (route.request().method() !== 'POST') {
      await route.fallback();
      return;
    }
    const request = route.request().postDataJSON() as UserCreateRequest;
    requests.push(request);
    if (requests.length === 1) {
      await firstResponse;
      await route.fulfill({
        status: 409,
        json: { success: false, message: 'This username is already in use.' },
      });
      return;
    }
    savedUser = { ...users[1], id: 'created-user', ...request };
    await route.fulfill({ json: { success: true, data: savedUser } });
  });
  await page.goto('/users');
  await page.getByRole('button', { name: 'Create User', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Create User', exact: true });
  await dialog.getByLabel('Username', { exact: true }).fill('new-member');
  await dialog.getByLabel('Email', { exact: true }).fill('new@example.test');
  await dialog.getByLabel('Password', { exact: true }).fill(validPassword);
  await dialog
    .getByRole('button', { name: 'Create User', exact: true })
    .click();

  try {
    await expect.poll(() => requests.length).toBe(1);
    await expect(
      dialog.getByRole('button', { name: 'Creating...' })
    ).toBeDisabled();
    await expect(
      dialog.getByRole('button', { name: 'Cancel', exact: true })
    ).toBeDisabled();
    await dialog
      .locator('form')
      .evaluate(form => (form as HTMLFormElement).requestSubmit());
    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();
    expect(requests).toHaveLength(1);
  } finally {
    releaseFirst();
  }

  await expect(dialog.getByRole('alert')).toContainText(
    'This username is already in use.'
  );
  await expect(dialog.getByLabel('Username', { exact: true })).toHaveValue(
    'new-member'
  );
  await expect(dialog.getByLabel('Password', { exact: true })).toHaveValue(
    validPassword
  );
  await dialog
    .getByRole('button', { name: 'Create User', exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByTestId('user-row').filter({ hasText: 'new-member' })
  ).toBeVisible();
  expect(requests).toHaveLength(2);
});

test('editing an account without email keeps its password unchanged', async ({
  page,
}) => {
  let users = await prepareUsers(page);
  const updates: UserUpdateRequest[] = [];
  await page.route('**/api/users', async route => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    await route.fulfill({ json: { success: true, data: users } });
  });
  await page.route('**/api/users/member-user', async route => {
    if (route.request().method() !== 'PATCH') {
      await route.fallback();
      return;
    }
    const update = route.request().postDataJSON() as UserUpdateRequest;
    updates.push(update);
    users = users.map(user =>
      user.id === member.id ? { ...user, ...update } : user
    );
    await route.fulfill({
      json: { success: true, data: users.find(user => user.id === member.id) },
    });
  });
  await page.goto('/users');
  await page.getByRole('button', { name: 'Edit: member', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit User', exact: true });
  await dialog.getByLabel('Username', { exact: true }).fill('renamed-member');
  await dialog
    .getByRole('button', { name: 'Update User', exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByTestId('user-row').filter({ hasText: 'renamed-member' })
  ).toBeVisible();
  expect(updates).toHaveLength(1);
  expect(updates[0]).not.toHaveProperty('password');
  expect(updates[0].email).toBeNull();
});

test('account removal and MFA reset require cancellable in-app confirmation', async ({
  page,
}) => {
  await prepareUsers(page);
  const mutations: string[] = [];
  const browserDialogs: string[] = [];
  page.on('dialog', async dialog => {
    browserDialogs.push(dialog.type());
    await dialog.dismiss();
  });
  await page.route('**/api/users/**', async route => {
    if (route.request().method() !== 'GET') {
      mutations.push(
        `${route.request().method()} ${new URL(route.request().url()).pathname}`
      );
    }
    await route.fallback();
  });
  await page.goto('/users');
  const ownRow = page
    .getByTestId('user-row')
    .filter({ hasText: 'admin@example.test' });
  await expect(
    ownRow.getByRole('button', { name: 'Delete: admin', exact: true })
  ).toBeDisabled();
  await ownRow
    .getByRole('button', { name: 'Edit: admin', exact: true })
    .click();
  const edit = page.getByRole('dialog', { name: 'Edit User', exact: true });
  await expect(
    edit.getByRole('combobox', { name: 'Role', exact: true })
  ).toBeDisabled();
  await expect(
    edit.getByText('You cannot change your own administrator role.')
  ).toBeVisible();
  await edit.getByRole('button', { name: 'Cancel', exact: true }).click();

  await page
    .getByRole('button', { name: 'Delete: member', exact: true })
    .click();
  const removal = page.getByRole('dialog', {
    name: 'Delete user',
    exact: true,
  });
  await expect(removal).toContainText('member');
  await expect(
    removal.getByRole('button', { name: 'Close', exact: true })
  ).toBeFocused();
  await removal.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(removal).toHaveCount(0);
  await page
    .getByTestId('user-row')
    .filter({ hasText: 'member' })
    .getByTestId('reset-mfa-button')
    .click();
  const reset = page.getByRole('dialog', {
    name: 'Reset two-factor',
    exact: true,
  });
  await expect(reset).toContainText('member');
  await reset.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(reset).toHaveCount(0);
  expect(mutations).toEqual([]);
  expect(browserDialogs).toEqual([]);
});

test('confirmed deletion prevents duplicate requests and supports retry after failure', async ({
  page,
}) => {
  let users = await prepareUsers(page);
  let deletions = 0;
  let releaseFirst!: () => void;
  const firstResponse = new Promise<void>(resolve => {
    releaseFirst = resolve;
  });
  await page.route('**/api/users', async route => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    await route.fulfill({ json: { success: true, data: users } });
  });
  await page.route('**/api/users/member-user', async route => {
    if (route.request().method() !== 'DELETE') {
      await route.fallback();
      return;
    }
    deletions += 1;
    if (deletions === 1) {
      await firstResponse;
      await route.fulfill({
        status: 503,
        json: { success: false, message: 'The account could not be removed.' },
      });
      return;
    }
    users = users.filter(user => user.id !== member.id);
    await route.fulfill({ json: { success: true } });
  });
  await page.goto('/users');
  await page
    .getByRole('button', { name: 'Delete: member', exact: true })
    .click();
  const dialog = page.getByRole('dialog', { name: 'Delete user', exact: true });
  const confirm = dialog.getByRole('button', { name: 'Delete', exact: true });
  await confirm.click();
  try {
    await expect.poll(() => deletions).toBe(1);
    await expect(confirm).toBeDisabled();
    await expect(
      dialog.getByRole('button', { name: 'Cancel', exact: true })
    ).toBeDisabled();
    await confirm.evaluate(button => (button as HTMLButtonElement).click());
    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();
    expect(deletions).toBe(1);
  } finally {
    releaseFirst();
  }
  await expect(dialog.getByRole('alert')).toHaveText(
    'The account could not be removed.'
  );
  await expect(
    page.getByTestId('user-row').filter({ hasText: 'member' })
  ).toHaveCount(1);
  await confirm.click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByTestId('user-row').filter({ hasText: 'member' })
  ).toHaveCount(0);
  await expect(page.getByText('User deleted successfully')).toBeVisible();
  expect(deletions).toBe(2);
});

test('confirming a two-factor reset reports the selected account', async ({
  page,
}) => {
  await prepareUsers(page);
  const resets: string[] = [];
  await page.route('**/api/users/*/mfa/reset', async route => {
    resets.push(
      `${route.request().method()} ${new URL(route.request().url()).pathname}`
    );
    await route.fulfill({ json: { success: true, data: { removed: true } } });
  });
  await page.goto('/users');
  await page
    .getByTestId('user-row')
    .filter({ hasText: 'member' })
    .getByTestId('reset-mfa-button')
    .click();
  const dialog = page.getByRole('dialog', {
    name: 'Reset two-factor',
    exact: true,
  });
  await expect(dialog).toContainText('member');
  await dialog
    .getByRole('button', { name: 'Reset two-factor', exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByText('Two-factor removed for member.', { exact: true })
  ).toBeVisible();
  expect(resets).toEqual(['POST /api/users/member-user/mfa/reset']);
});

for (const { language, theme, translations } of [
  { language: 'en', theme: 'light', translations: en },
  { language: 'ar', theme: 'dark', translations: ar },
] as const) {
  test(`long account identities fit mobile ${language} ${theme} layouts`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await prepareUsers(page, { language, theme, long: true });
    await page.goto('/users');
    await expect(page.locator('html')).toHaveAttribute(
      'dir',
      language === 'ar' ? 'rtl' : 'ltr'
    );
    await expect(page.getByTestId('user-row')).toHaveCount(2);
    const content = page.getByTestId('settings-scroll-region');
    await expect
      .poll(() =>
        content.evaluate(element => element.scrollWidth - element.clientWidth)
      )
      .toBeLessThanOrEqual(1);
    const row = page
      .getByTestId('user-row')
      .filter({ hasText: 'member-with-an-unbroken-identity' });
    const edit = row.getByRole('button', {
      name: new RegExp(`^${translations.common.edit}:`),
    });
    await edit.scrollIntoViewIfNeeded();
    const bounds = await edit.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
    await page.screenshot({
      path: testInfo.outputPath(`users-mobile-${language}.png`),
    });

    await edit.click();
    const dialog = page.getByRole('dialog', {
      name: translations.userManager.form.title.edit,
      exact: true,
    });
    await expect(dialog).toBeVisible();
    await expect
      .poll(() =>
        dialog
          .getByTestId('modal-scroll-region')
          .evaluate(element => element.scrollWidth - element.clientWidth)
      )
      .toBeLessThanOrEqual(1);
    const dialogBounds = await dialog.boundingBox();
    expect(dialogBounds).not.toBeNull();
    expect(dialogBounds!.x).toBeGreaterThanOrEqual(0);
    expect(dialogBounds!.x + dialogBounds!.width).toBeLessThanOrEqual(390);
    await page.screenshot({
      path: testInfo.outputPath(`user-editor-mobile-${language}.png`),
    });
  });
}
