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

import { expect, test, type Page } from '@playwright/test';
import { mockLibreWebUiApi } from './lib/mockApi';
import { openSettingsTab } from './lib/settingsTab';

const AUTHORIZE_URL =
  'https://auth.example.test/authorize?client_id=libre&state=e2e-state';

const oauthServer = {
  id: 'server-mcp-oauth',
  name: 'Notes MCP',
  description: 'Notes over MCP, behind a sign-in',
  kind: 'mcp' as const,
  authMode: 'oauth' as const,
  enabled: true,
  specRevision: 1,
  hasCredential: false,
  baseUrl: 'https://notes.example/mcp',
  accessMode: 'all-users' as const,
  createdAt: 1_770_000_000_000,
  updatedAt: 1_770_000_000_000,
};

async function mockOAuthToolsApi(page: Page, options: { connected: boolean }) {
  let connected = options.connected;
  const startRequests: string[] = [];
  const disconnectRequests: string[] = [];

  await page.route(/\/api\/tools(?:\/.*)?$/, async route => {
    const request = route.request();
    const method = request.method();
    const path = new URL(request.url()).pathname;
    const fulfill = async (data: unknown) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data }),
      });
    };

    if (path === '/api/tools/catalog' && method === 'GET') {
      await fulfill({ available: false, tools: [] });
      return;
    }
    if (path === '/api/tools/approvals' && method === 'GET') {
      await fulfill({ pending: [], standing: [] });
      return;
    }
    if (path === '/api/tools/servers' && method === 'GET') {
      await fulfill([{ ...oauthServer, hasCredential: connected }]);
      return;
    }

    const statusMatch = path.match(
      /^\/api\/tools\/servers\/([^/]+)\/oauth\/status$/
    );
    if (statusMatch && method === 'GET') {
      await fulfill({ connected, configured: true });
      return;
    }

    const startMatch = path.match(
      /^\/api\/tools\/servers\/([^/]+)\/oauth\/start$/
    );
    if (startMatch && method === 'POST') {
      startRequests.push(startMatch[1] as string);
      await fulfill({ authorizeUrl: AUTHORIZE_URL });
      return;
    }

    const disconnectMatch = path.match(
      /^\/api\/tools\/servers\/([^/]+)\/oauth$/
    );
    if (disconnectMatch && method === 'DELETE') {
      disconnectRequests.push(disconnectMatch[1] as string);
      connected = false;
      await fulfill({ deleted: true });
      return;
    }

    await route.fulfill({
      status: 405,
      contentType: 'application/json',
      body: JSON.stringify({ success: false, error: 'Method not allowed' }),
    });
  });

  // The connect button is a full-page redirect to the authorization server;
  // stand in for it so the navigation resolves without leaving the sandbox.
  await page.route('https://auth.example.test/**', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<html><body>authorization server</body></html>',
    });
  });

  return { startRequests, disconnectRequests };
}

async function signIn(page: Page) {
  await mockLibreWebUiApi(page, {
    authRole: 'admin',
    systemInfo: {
      requiresAuth: true,
      hasUsers: true,
      userCount: 2,
      version: '0.35.0-e2e',
      turnstile: { enabled: false },
    },
  });
  await page.addInitScript(() => {
    localStorage.setItem('i18nextLng', 'en');
    localStorage.setItem('auth-token', 'e2e-token');
  });
}

test('an OAuth MCP server is connected through a redirect and disconnected again', async ({
  page,
}) => {
  await signIn(page);
  const toolsApi = await mockOAuthToolsApi(page, { connected: false });

  await page.goto('/');
  await openSettingsTab(page, 'tools');
  const row = page.getByTestId('tool-server-row');
  await expect(row).toContainText('Notes MCP');
  // An OAuth server reports a connection, not a pasted secret.
  await expect(row).toContainText('Not connected');
  await expect(row.getByTestId('tool-credential-toggle')).toHaveCount(0);

  await row.getByTestId('tool-oauth-toggle').click();
  const panel = page.getByTestId('tool-oauth-panel');
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId('tool-oauth-disconnect')).toHaveCount(0);

  await panel.getByTestId('tool-oauth-connect').click();
  await page.waitForURL(url => url.origin === 'https://auth.example.test');
  expect(toolsApi.startRequests).toEqual([oauthServer.id]);
  expect(page.url()).toBe(AUTHORIZE_URL);
});

test('the callback flag reports the connection and the server can be disconnected', async ({
  page,
}) => {
  await signIn(page);
  const toolsApi = await mockOAuthToolsApi(page, { connected: true });

  // The backend callback redirects the browser back to the app this way.
  await page.goto(`/?mcpOAuth=connected&serverId=${oauthServer.id}`);
  await openSettingsTab(page, 'tools');
  await expect(page.getByText('Tool server connected')).toBeVisible();
  // The flag is consumed, so a reload cannot repeat the toast.
  await expect.poll(() => new URL(page.url()).search).toBe('');

  const row = page.getByTestId('tool-server-row');
  await expect(row).toContainText('Connected');
  await row.getByTestId('tool-oauth-toggle').click();
  const panel = page.getByTestId('tool-oauth-panel');
  await expect(panel.getByTestId('tool-oauth-connect')).toContainText(
    'Reconnect'
  );

  await panel.getByTestId('tool-oauth-disconnect').click();
  await expect.poll(() => toolsApi.disconnectRequests.length).toBe(1);
  expect(toolsApi.disconnectRequests).toEqual([oauthServer.id]);
  await expect(row).toContainText('Not connected');
});
