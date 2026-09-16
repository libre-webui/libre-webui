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

/*
 * Interactive OAuth for MCP tool servers: discovery from a 401 challenge,
 * dynamic client registration, the PKCE redirect flow behind the state
 * cookie, the encrypted per-user token envelope, refresh on expiry, and
 * disconnect. Every network peer here is a local mock: a gated MCP server
 * and an authorization server with the two well-known documents, a
 * registration endpoint and a token endpoint.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import express from 'express';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'libre-tool-oauth-'));
process.env.DATA_DIR = dataDir;
process.env.JWT_SECRET = 'tool-oauth-test-secret-that-is-long-enough';
process.env.ENCRYPTION_KEY ||= '4'.repeat(64);
process.env.TOOLS_PRIVATE_NETWORK_ALLOWLIST = '127.0.0.1,localhost';
process.env.CORS_ORIGIN = 'http://127.0.0.1:5173';

const distModule = relativePath =>
  import(
    pathToFileURL(path.join(repoRoot, 'backend', 'dist', relativePath)).href
  );

const { encryptionService } = await distModule('services/encryptionService.js');
const persistenceModule = await distModule('persistence/index.js');
const applicationPersistence = await persistenceModule.initializePersistence({
  dialect: 'sqlite',
  emailCodec: encryptionService,
  env: process.env,
});
const platformStorageModule = await distModule(
  'platform/storage/platformStorageRuntime.js'
);
await platformStorageModule.initializePlatformStorageRuntime({
  persistence: applicationPersistence,
  cipher: encryptionService,
  env: process.env,
});

const [toolServers, mcpOAuth, authModule, toolsRoute, database] =
  await Promise.all([
    distModule('services/toolServerService.js'),
    distModule('services/mcpOAuthService.js'),
    distModule('services/authService.js'),
    distModule('routes/tools.js'),
    distModule('db.js'),
  ]);

const db = database.getDatabase();
const now = Date.now();
const ADMIN = 'oauth-admin';
db.prepare(
  `INSERT INTO users
     (id, username, email, password_hash, role, account_status, avatar,
      created_at, updated_at)
   VALUES (?, ?, NULL, 'unused', 'admin', 'active', NULL, ?, ?)`
).run(ADMIN, ADMIN, now, now);
const adminToken = authModule.authService.generateToken({
  id: ADMIN,
  username: ADMIN,
  email: null,
  role: 'admin',
  status: 'active',
  avatar: null,
  createdAt: new Date(now).toISOString(),
  updatedAt: new Date(now).toISOString(),
});

// === Mock authorization server ===

const tokenRequests = [];
let issuedChallenge = null;
let registrationCount = 0;
const AUTH_CODE = 'mock-authorization-code';

const readBody = request =>
  new Promise(resolve => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
  });

const sendJson = (response, status, body) => {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
};

const authMock = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');

  if (url.pathname === '/.well-known/oauth-authorization-server') {
    sendJson(response, 200, {
      issuer: authBase,
      authorization_endpoint: `${authBase}/authorize`,
      token_endpoint: `${authBase}/token`,
      registration_endpoint: `${authBase}/register`,
      code_challenge_methods_supported: ['S256'],
    });
    return;
  }

  if (url.pathname === '/register' && request.method === 'POST') {
    const body = JSON.parse((await readBody(request)) || '{}');
    registrationCount += 1;
    sendJson(response, 201, {
      client_id: `dynamic-client-${registrationCount}`,
      redirect_uris: body.redirect_uris,
      token_endpoint_auth_method: 'none',
    });
    return;
  }

  if (url.pathname === '/token' && request.method === 'POST') {
    const form = new URLSearchParams(await readBody(request));
    tokenRequests.push(Object.fromEntries(form));
    if (form.get('grant_type') === 'authorization_code') {
      const verifier = form.get('code_verifier') ?? '';
      const derived = createHash('sha256').update(verifier).digest('base64url');
      if (form.get('code') !== AUTH_CODE || derived !== issuedChallenge) {
        sendJson(response, 400, { error: 'invalid_grant' });
        return;
      }
      sendJson(response, 200, {
        access_token: 'access-token-1',
        refresh_token: 'refresh-token-1',
        token_type: 'Bearer',
        expires_in: 3600,
        scope: 'notes.read',
      });
      return;
    }
    if (form.get('grant_type') === 'refresh_token') {
      if (form.get('refresh_token') !== 'refresh-token-1') {
        sendJson(response, 400, { error: 'invalid_grant' });
        return;
      }
      sendJson(response, 200, {
        access_token: 'access-token-2',
        refresh_token: 'refresh-token-2',
        token_type: 'Bearer',
        expires_in: 3600,
      });
      return;
    }
    sendJson(response, 400, { error: 'unsupported_grant_type' });
    return;
  }

  sendJson(response, 404, { error: 'not_found' });
});

// === Mock MCP server behind that authorization server ===

const acceptedTokens = new Set(['access-token-1', 'access-token-2']);
const mcpMock = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');

  if (url.pathname === '/.well-known/oauth-protected-resource/mcp') {
    sendJson(response, 200, {
      resource: `${mcpBase}/mcp`,
      authorization_servers: [authBase],
      scopes_supported: ['notes.read'],
    });
    return;
  }

  const authorization = request.headers.authorization ?? '';
  const bearer = authorization.replace(/^Bearer\s+/i, '');
  if (url.pathname === '/mcp' && !acceptedTokens.has(bearer)) {
    response.writeHead(401, {
      'Content-Type': 'application/json',
      'WWW-Authenticate': `Bearer realm="notes", resource_metadata="${mcpBase}/.well-known/oauth-protected-resource/mcp"`,
    });
    response.end(JSON.stringify({ error: 'unauthorized' }));
    return;
  }

  const payload = JSON.parse((await readBody(request)) || '{}');
  if (payload.id === undefined) {
    response.writeHead(202);
    response.end();
    return;
  }
  if (payload.method === 'initialize') {
    sendJson(response, 200, {
      jsonrpc: '2.0',
      id: payload.id,
      result: {
        protocolVersion: '2025-06-18',
        serverInfo: { name: 'gated-notes', version: '1.0' },
        capabilities: { tools: {} },
      },
    });
    return;
  }
  if (payload.method === 'tools/list') {
    sendJson(response, 200, {
      jsonrpc: '2.0',
      id: payload.id,
      result: {
        tools: [
          {
            name: 'read_note',
            description: 'Read one note',
            inputSchema: { type: 'object', properties: {} },
            annotations: { readOnlyHint: true },
          },
        ],
      },
    });
    return;
  }
  sendJson(response, 200, {
    jsonrpc: '2.0',
    id: payload.id,
    error: { code: -32601, message: 'Method not found' },
  });
});

const listen = server =>
  new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });

const authPort = await listen(authMock);
const mcpPort = await listen(mcpMock);
const authBase = `http://127.0.0.1:${authPort}`;
const mcpBase = `http://127.0.0.1:${mcpPort}`;
const mcpUrl = `${mcpBase}/mcp`;

// === The application's own tools router ===

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use('/api/tools', toolsRoute.default);
const apiServer = createServer(app);
const apiPort = await listen(apiServer);
const apiBase = `http://127.0.0.1:${apiPort}/api/tools`;
process.env.BASE_URL = `http://127.0.0.1:${apiPort}`;

after(async () => {
  await new Promise(resolve => authMock.close(resolve));
  await new Promise(resolve => mcpMock.close(resolve));
  await new Promise(resolve => apiServer.close(resolve));
  database.closeDatabase();
  await rm(dataDir, { recursive: true, force: true });
});

const adminHeaders = { Authorization: `Bearer ${adminToken}` };
const settingValue = key =>
  db.prepare('SELECT value FROM system_settings WHERE key = ?').get(key)?.value;
const credentialRow = serverId =>
  db
    .prepare(
      'SELECT secret FROM tool_server_credentials WHERE server_id = ? AND user_id = ?'
    )
    .get(serverId, ADMIN);

let server;
let stateCookie;
let authorizeUrl;

test('registration discovers the authorization server and registers a client', async () => {
  server = await toolServers.registerToolServer(ADMIN, {
    name: 'Gated notes',
    kind: 'mcp',
    baseUrl: mcpUrl,
    authMode: 'oauth',
    accessMode: 'all-users',
  });
  assert.equal(server.authMode, 'oauth');

  // The unauthenticated listing was refused, so the server stands with an
  // empty inventory instead of failing registration outright.
  const tools = await toolServers.listServerTools(server.id);
  assert.equal(tools.length, 0);

  const stored = settingValue(`tools.mcp-oauth.${server.id}`);
  assert.ok(stored, 'the discovered metadata is persisted');
  const config = JSON.parse(stored);
  assert.equal(config.authorizationEndpoint, `${authBase}/authorize`);
  assert.equal(config.tokenEndpoint, `${authBase}/token`);
  assert.equal(config.registrationEndpoint, `${authBase}/register`);
  assert.equal(config.resource, mcpUrl);
  assert.equal(config.scope, 'notes.read');
  assert.equal(config.clientId, 'dynamic-client-1');
  assert.equal(config.dynamicallyRegistered, true);
  assert.equal(registrationCount, 1);
});

test('starting the flow returns a PKCE authorization URL and a state cookie', async () => {
  const response = await fetch(`${apiBase}/servers/${server.id}/oauth/start`, {
    method: 'POST',
    headers: adminHeaders,
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.success, true);
  authorizeUrl = new URL(body.data.authorizeUrl);

  assert.equal(authorizeUrl.origin, authBase);
  assert.equal(authorizeUrl.pathname, '/authorize');
  assert.equal(authorizeUrl.searchParams.get('response_type'), 'code');
  assert.equal(authorizeUrl.searchParams.get('client_id'), 'dynamic-client-1');
  assert.equal(
    authorizeUrl.searchParams.get('redirect_uri'),
    `${process.env.BASE_URL}/api/tools/servers/${server.id}/oauth/callback`
  );
  assert.equal(authorizeUrl.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(authorizeUrl.searchParams.get('scope'), 'notes.read');
  assert.equal(authorizeUrl.searchParams.get('resource'), mcpUrl);
  issuedChallenge = authorizeUrl.searchParams.get('code_challenge');
  assert.match(issuedChallenge ?? '', /^[A-Za-z0-9_-]{43}$/);
  assert.ok((authorizeUrl.searchParams.get('state') ?? '').length >= 32);

  const setCookie = response.headers.getSetCookie?.() ?? [];
  const flowCookie = setCookie.find(entry =>
    entry.startsWith(`libre_oauth_state_mcp_${server.id}=`)
  );
  assert.ok(flowCookie, 'the flow state rides in an HttpOnly cookie');
  assert.match(flowCookie, /HttpOnly/);
  stateCookie = flowCookie.split(';')[0];
  // The PKCE verifier never reaches the browser in readable form.
  assert.equal(flowCookie.includes('verifier='), false);
});

test('a callback with the wrong state is refused', async () => {
  const response = await fetch(
    `${apiBase}/servers/${server.id}/oauth/callback?code=${AUTH_CODE}&state=not-the-state`,
    { headers: { Cookie: stateCookie }, redirect: 'manual' }
  );
  assert.equal(response.status, 302);
  assert.match(response.headers.get('location') ?? '', /mcpOAuth=error/);
  assert.equal(credentialRow(server.id), undefined);
  assert.equal(tokenRequests.length, 0, 'no code was exchanged');
});

test('the callback exchanges the code and stores an encrypted envelope', async () => {
  const state = authorizeUrl.searchParams.get('state');
  const response = await fetch(
    `${apiBase}/servers/${server.id}/oauth/callback?code=${AUTH_CODE}&state=${encodeURIComponent(state)}`,
    { headers: { Cookie: stateCookie }, redirect: 'manual' }
  );
  assert.equal(response.status, 302);
  const location = response.headers.get('location') ?? '';
  assert.match(location, /mcpOAuth=connected/);
  assert.match(location, new RegExp(`serverId=${server.id}`));
  // The token never travels back through the browser.
  assert.equal(location.includes('access-token-1'), false);

  const exchange = tokenRequests.at(-1);
  assert.equal(exchange.grant_type, 'authorization_code');
  assert.equal(exchange.client_id, 'dynamic-client-1');
  assert.equal(exchange.resource, mcpUrl);

  const row = credentialRow(server.id);
  assert.ok(row, 'the connection is stored for this user');
  assert.equal(row.secret.includes('access-token-1'), false);
  assert.equal(row.secret.includes('refresh-token-1'), false);
  assert.equal(row.secret.includes('accessToken'), false);

  const status = await toolServers.getToolServerOAuthStatus(ADMIN, server.id);
  assert.equal(status.connected, true);
  assert.equal(status.configured, true);
  assert.equal(status.scope, 'notes.read');
  assert.ok(status.expiresAt > Date.now());

  // The inventory refused before the sign-in is pinned on connection.
  const tools = await toolServers.listServerTools(server.id);
  assert.deepEqual(
    tools.map(tool => tool.name),
    ['read_note']
  );
});

test('calls carry the bearer and a spent token refreshes once', async () => {
  const headers = await toolServers.resolveAuthHeaders(ADMIN, server);
  assert.deepEqual(headers, { Authorization: 'Bearer access-token-1' });
  const exchanges = tokenRequests.length;

  // Age the stored token past the refresh margin.
  await toolServers.setToolServerOAuthTokens(ADMIN, server.id, {
    accessToken: 'access-token-1',
    refreshToken: 'refresh-token-1',
    expiresAt: Date.now() - 1_000,
    scope: 'notes.read',
  });

  const [first, second] = await Promise.all([
    toolServers.resolveAuthHeaders(ADMIN, server),
    toolServers.resolveAuthHeaders(ADMIN, server),
  ]);
  assert.deepEqual(first, { Authorization: 'Bearer access-token-2' });
  assert.deepEqual(second, { Authorization: 'Bearer access-token-2' });
  // Single flight: two concurrent calls spend the refresh token once.
  assert.equal(tokenRequests.length, exchanges + 1);
  assert.equal(tokenRequests.at(-1).grant_type, 'refresh_token');

  // The refreshed pair is what a later call reads back.
  const later = await toolServers.resolveAuthHeaders(ADMIN, server);
  assert.deepEqual(later, { Authorization: 'Bearer access-token-2' });
  assert.equal(tokenRequests.length, exchanges + 1);
});

test('disconnecting removes the tokens and calls ask to reconnect', async () => {
  const response = await fetch(`${apiBase}/servers/${server.id}/oauth`, {
    method: 'DELETE',
    headers: adminHeaders,
  });
  assert.equal(response.status, 200);
  assert.equal(credentialRow(server.id), undefined);

  const status = await toolServers.getToolServerOAuthStatus(ADMIN, server.id);
  assert.equal(status.connected, false);
  assert.equal(status.configured, true);

  await assert.rejects(
    () => toolServers.resolveAuthHeaders(ADMIN, server),
    error => error.name === 'ToolReauthRequiredError'
  );

  // A second disconnect has nothing to remove.
  const repeat = await fetch(`${apiBase}/servers/${server.id}/oauth`, {
    method: 'DELETE',
    headers: adminHeaders,
  });
  assert.equal(repeat.status, 404);
});

test('deleting the server forgets its OAuth configuration', async () => {
  assert.equal(await toolServers.deleteToolServer(ADMIN, server.id), true);
  assert.equal(settingValue(`tools.mcp-oauth.${server.id}`), '');
  assert.equal(await mcpOAuth.loadOAuthConfig(server.id), null);
});
