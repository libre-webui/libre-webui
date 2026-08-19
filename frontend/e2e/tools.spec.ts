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

type MockToolServer = {
  id: string;
  name: string;
  description?: string;
  kind: 'openapi' | 'mcp';
  authMode: 'none' | 'bearer' | 'header';
  enabled: boolean;
  specRevision: number;
  hasCredential: boolean;
  baseUrl: string;
  specDigest?: string;
  authHeader?: string;
  accessMode: 'admins-only' | 'all-users' | 'granted';
  createdAt: number;
  updatedAt: number;
};

type MockServerTool = {
  name: string;
  description?: string;
  sideEffect: boolean;
  enabled: boolean;
};

type MockApproval = {
  id: string;
  serverId?: string;
  toolName: string;
  scope: 'once' | 'session' | 'always';
  status: 'approved';
  createdAt: number;
};

const weatherServer: MockToolServer = {
  id: 'server-weather',
  name: 'Weather API',
  description: 'Forecasts and current conditions',
  kind: 'openapi',
  authMode: 'bearer',
  enabled: true,
  specRevision: 3,
  hasCredential: false,
  baseUrl: 'https://api.weather.example',
  specDigest: 'sha256deadbeefcafe',
  accessMode: 'all-users',
  createdAt: 1_770_000_000_000,
  updatedAt: 1_770_000_000_000,
};

const weatherTools: MockServerTool[] = [
  {
    name: 'get_forecast',
    description: 'Reads the forecast for a city',
    sideEffect: false,
    enabled: true,
  },
  {
    name: 'set_alert',
    description: 'Creates a weather alert subscription',
    sideEffect: true,
    enabled: true,
  },
];

/**
 * The backend hides the operational fields of a tool server from anyone who
 * is not an administrator; the mock does the same so the non-admin test is
 * asserting against the payload the page would really receive.
 */
const publicServerView = (server: MockToolServer) => ({
  id: server.id,
  name: server.name,
  description: server.description,
  kind: server.kind,
  authMode: server.authMode,
  enabled: server.enabled,
  specRevision: server.specRevision,
  hasCredential: server.hasCredential,
});

async function mockToolsApi(
  page: Page,
  options: {
    role: 'admin' | 'user';
    servers?: MockToolServer[];
    tools?: Record<string, MockServerTool[]>;
    approvals?: MockApproval[];
  }
) {
  const isAdmin = options.role === 'admin';
  const servers = structuredClone(options.servers ?? []);
  const tools = structuredClone(options.tools ?? {});
  let approvals = structuredClone(options.approvals ?? []);
  const registerRequests: Array<Record<string, unknown>> = [];
  const overrideRequests: Array<{
    serverId: string;
    toolName: string;
    body: Record<string, unknown>;
  }> = [];
  const credentialRequests: Array<{
    serverId: string;
    body: Record<string, unknown>;
  }> = [];
  const revokeRequests: string[] = [];
  let nextId = servers.length + 1;

  const serverView = (server: MockToolServer) =>
    isAdmin ? server : publicServerView(server);

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
      await fulfill({ pending: [], standing: approvals });
      return;
    }

    const approvalMatch = path.match(/^\/api\/tools\/approvals\/([^/]+)$/);
    if (approvalMatch && method === 'DELETE') {
      const id = approvalMatch[1];
      revokeRequests.push(id);
      approvals = approvals.filter(approval => approval.id !== id);
      await fulfill({ id, revoked: true });
      return;
    }

    if (path === '/api/tools/servers' && method === 'GET') {
      await fulfill(servers.map(serverView));
      return;
    }

    if (path === '/api/tools/servers' && method === 'POST') {
      const body = request.postDataJSON() as Partial<MockToolServer> & {
        specUrl?: string;
      };
      registerRequests.push(body as Record<string, unknown>);
      const created: MockToolServer = {
        id: `server-${nextId++}`,
        name: body.name ?? '',
        description: body.description,
        kind: body.kind ?? 'openapi',
        authMode: body.authMode ?? 'none',
        enabled: body.enabled !== false,
        specRevision: 1,
        hasCredential: false,
        baseUrl: body.baseUrl ?? '',
        specDigest: 'sha256e2eregistered',
        accessMode: body.accessMode ?? 'admins-only',
        createdAt: 1_770_000_100_000,
        updatedAt: 1_770_000_100_000,
      };
      servers.push(created);
      tools[created.id] = [];
      await fulfill(serverView(created));
      return;
    }

    const credentialMatch = path.match(
      /^\/api\/tools\/servers\/([^/]+)\/credential$/
    );
    if (credentialMatch && method === 'PUT') {
      const serverId = credentialMatch[1];
      const body = request.postDataJSON() as Record<string, unknown>;
      credentialRequests.push({ serverId, body });
      const server = servers.find(item => item.id === serverId);
      if (server) server.hasCredential = true;
      await fulfill({ serverId, stored: true });
      return;
    }

    const overrideMatch = path.match(
      /^\/api\/tools\/servers\/([^/]+)\/tools\/([^/]+)$/
    );
    if (overrideMatch && method === 'PUT') {
      const [, serverId, toolName] = overrideMatch;
      const body = request.postDataJSON() as Record<string, unknown>;
      overrideRequests.push({ serverId, toolName, body });
      const tool = (tools[serverId] ?? []).find(item => item.name === toolName);
      if (tool) Object.assign(tool, body);
      await fulfill(tool ?? null);
      return;
    }

    const serverMatch = path.match(/^\/api\/tools\/servers\/([^/]+)$/);
    if (serverMatch && method === 'GET') {
      const server = servers.find(item => item.id === serverMatch[1]);
      if (!server) {
        await route.fulfill({
          status: 404,
          contentType: 'application/json',
          body: JSON.stringify({ success: false, error: 'Not found' }),
        });
        return;
      }
      await fulfill({
        server: serverView(server),
        tools: tools[server.id] ?? [],
      });
      return;
    }

    await route.fulfill({
      status: 405,
      contentType: 'application/json',
      body: JSON.stringify({ success: false, error: 'Method not allowed' }),
    });
  });

  return {
    registerRequests,
    overrideRequests,
    credentialRequests,
    revokeRequests,
  };
}

/** Tools gate on the signed-in role, so every test needs a real session. */
async function signIn(page: Page, role: 'admin' | 'user') {
  await mockLibreWebUiApi(page, {
    authRole: role,
    systemInfo: {
      requiresAuth: true,
      hasUsers: true,
      userCount: 2,
      version: '0.25.0-e2e',
      turnstile: { enabled: false },
    },
  });
  await page.addInitScript(() => {
    localStorage.setItem('auth-token', 'e2e-token');
  });
}

test('tool servers register, scope, and collect credentials through the UI', async ({
  page,
}) => {
  await signIn(page, 'admin');
  const toolsApi = await mockToolsApi(page, { role: 'admin' });

  await page.goto('/tools');
  await expect(page.getByTestId('tools-page')).toBeVisible();
  await expect(page.getByText('No tool servers')).toBeVisible();

  await page.getByTestId('tool-server-new').click();
  await expect(page.getByTestId('tool-server-modal')).toBeVisible();
  await page.getByTestId('tool-server-name').fill('Ticketing API');
  await page
    .getByTestId('tool-server-base-url')
    .fill('https://tickets.example');
  await page
    .getByLabel('Spec URL')
    .fill('https://tickets.example/openapi.json');
  await page.getByLabel('Authentication').selectOption('bearer');
  // Scope: who the server is offered to.
  await page.getByLabel('Who can use it').selectOption('all-users');
  await page.getByTestId('tool-server-save').click();
  await expect(page.getByTestId('tool-server-modal')).toHaveCount(0);

  expect(toolsApi.registerRequests).toHaveLength(1);
  expect(toolsApi.registerRequests[0]).toEqual({
    name: 'Ticketing API',
    kind: 'openapi',
    baseUrl: 'https://tickets.example',
    specUrl: 'https://tickets.example/openapi.json',
    authMode: 'bearer',
    accessMode: 'all-users',
    enabled: true,
  });

  const row = page.getByTestId('tool-server-row');
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('Ticketing API');
  await expect(row).toContainText('OpenAPI');
  await expect(row).toContainText('Enabled');
  await expect(row).toContainText('Credential needed');
  await expect(row).toContainText('https://tickets.example');

  // An authenticated server collects a per-person credential.
  await row.getByTestId('tool-credential-toggle').click();
  await expect(page.getByTestId('tool-credential-panel')).toBeVisible();
  await page.getByTestId('tool-credential-secret').fill('tok_live_e2e');
  await page.getByTestId('tool-credential-save').click();

  await expect.poll(() => toolsApi.credentialRequests.length).toBe(1);
  expect(toolsApi.credentialRequests[0]).toEqual({
    serverId: 'server-1',
    body: { secret: 'tok_live_e2e' },
  });
  await expect(row).toContainText('Credential set');
});

test('an administrator expands a server to override the tools it pinned', async ({
  page,
}) => {
  await signIn(page, 'admin');
  const toolsApi = await mockToolsApi(page, {
    role: 'admin',
    servers: [weatherServer],
    tools: { [weatherServer.id]: weatherTools },
  });

  await page.goto('/tools');
  const row = page.getByTestId('tool-server-row');
  await expect(row).toContainText('Weather API');
  await expect(row).toContainText('Revision 3');

  await row.getByTestId('tool-server-expand').click();
  const pinned = page.getByTestId('tool-server-tool');
  await expect(pinned).toHaveCount(2);
  await expect(pinned.first()).toContainText('get_forecast');
  await expect(pinned.last()).toContainText('set_alert');
  // Anything that changes the world outside the chat is flagged as such.
  await expect(pinned.last()).toContainText('Side effect');

  // The second switch on the row is the enabled override.
  await pinned.last().getByRole('switch').last().click();
  await expect(pinned.last().getByRole('switch').last()).toHaveAttribute(
    'aria-checked',
    'false'
  );

  await expect.poll(() => toolsApi.overrideRequests.length).toBe(1);
  expect(toolsApi.overrideRequests[0]).toEqual({
    serverId: weatherServer.id,
    toolName: 'set_alert',
    body: { enabled: false },
  });
});

test('a non-admin sees only the public server fields and saves a personal credential', async ({
  page,
}) => {
  await signIn(page, 'user');
  const toolsApi = await mockToolsApi(page, {
    role: 'user',
    servers: [weatherServer],
    tools: { [weatherServer.id]: weatherTools },
  });

  await page.goto('/tools');
  const row = page.getByTestId('tool-server-row');
  await expect(row).toContainText('Weather API');
  await expect(row).toContainText('OpenAPI');

  // Registration and the operational fields belong to administrators.
  await expect(page.getByTestId('tool-server-new')).toHaveCount(0);
  await expect(page.getByTestId('tool-server-edit')).toHaveCount(0);
  await expect(page.getByTestId('tool-server-delete')).toHaveCount(0);
  await expect(page.getByTestId('tool-server-refresh')).toHaveCount(0);
  await expect(page.getByTestId('tool-server-expand')).toHaveCount(0);
  await expect(row).not.toContainText('https://api.weather.example');
  await expect(row).not.toContainText('Revision');

  // A personal credential is still theirs to set.
  await row.getByTestId('tool-credential-toggle').click();
  await page.getByTestId('tool-credential-secret').fill('user-owned-token');
  await page.getByTestId('tool-credential-save').click();

  await expect.poll(() => toolsApi.credentialRequests.length).toBe(1);
  expect(toolsApi.credentialRequests[0]).toEqual({
    serverId: weatherServer.id,
    body: { secret: 'user-owned-token' },
  });
});

test('a standing approval is revoked from the tools page', async ({ page }) => {
  await signIn(page, 'admin');
  const toolsApi = await mockToolsApi(page, {
    role: 'admin',
    servers: [weatherServer],
    approvals: [
      {
        id: 'approval-1',
        serverId: weatherServer.id,
        toolName: 'set_alert',
        scope: 'always',
        status: 'approved',
        createdAt: 1_770_000_050_000,
      },
    ],
  });

  await page.goto('/tools');
  const approval = page.getByTestId('tool-approval-row');
  await expect(approval).toHaveCount(1);
  await expect(approval).toContainText('set_alert');
  await expect(approval).toContainText('Weather API');

  await approval.getByTestId('tool-approval-revoke').click();
  await expect(page.getByTestId('tool-approval-row')).toHaveCount(0);
  await expect.poll(() => toolsApi.revokeRequests).toEqual(['approval-1']);
});
