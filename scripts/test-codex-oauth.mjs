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

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-oauth-test-'));
process.env.CODEX_HOME = codexHome;

const jwt = (claims, expiresInSeconds) =>
  [
    Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url'),
    Buffer.from(
      JSON.stringify({
        exp: Math.floor(Date.now() / 1000) + expiresInSeconds,
        ...claims,
      })
    ).toString('base64url'),
    'sig',
  ].join('.');

const authFile = path.join(codexHome, 'auth.json');
const writeAuthFile = (accessToken, refreshToken = 'refresh-1') =>
  fs.writeFileSync(
    authFile,
    JSON.stringify({
      OPENAI_API_KEY: null,
      tokens: {
        id_token: 'unused',
        access_token: accessToken,
        refresh_token: refreshToken,
      },
      last_refresh: new Date(0).toISOString(),
    })
  );

// Mock the OAuth token endpoint.
const refreshCalls = [];
let slowRefreshStarted;
let slowRefreshClosed;
const resetSlowRefreshSignals = () => {
  slowRefreshStarted = Promise.withResolvers();
  slowRefreshClosed = Promise.withResolvers();
};
resetSlowRefreshSignals();
const mockServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', chunk => (body += chunk));
  req.on('end', () => {
    refreshCalls.push(Object.fromEntries(new URLSearchParams(body)));
    if (req.url === '/slow-token') {
      slowRefreshStarted.resolve();
      res.once('close', () => {
        if (!res.writableEnded) slowRefreshClosed.resolve();
      });
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        id_token: 'id-2',
        access_token: jwt({ chatgpt_account_id: 'acct-2' }, 3600),
        refresh_token: 'refresh-2',
        expires_in: 3600,
      })
    );
  });
});
await new Promise(resolve => mockServer.listen(0, resolve));
process.env.CODEX_OAUTH_TOKEN_URL = `http://127.0.0.1:${mockServer.address().port}/oauth/token`;

const serviceUrl = pathToFileURL(
  path.join(repoRoot, 'backend', 'dist', 'services', 'codexOAuthService.js')
).href;
const { CodexOAuthService, CODEX_OAUTH_PLUGIN_ID } = await import(serviceUrl);

after(() => {
  mockServer.close();
  fs.rmSync(codexHome, { recursive: true, force: true });
});

test('availability tracks the codex auth file', () => {
  const service = new CodexOAuthService();
  fs.rmSync(authFile, { force: true });
  assert.equal(service.isAvailable(), false);
  writeAuthFile(jwt({ chatgpt_account_id: 'acct-1' }, 3600));
  assert.equal(service.isAvailable(), true);
});

test('reads token and account id from disk without refreshing when fresh', async () => {
  writeAuthFile(jwt({ chatgpt_account_id: 'acct-1' }, 3600));
  const service = new CodexOAuthService();
  const before = refreshCalls.length;
  await service.ensureFreshToken();
  assert.equal(refreshCalls.length, before);
  assert.equal(service.getCachedAccountId(), 'acct-1');
  assert.ok(service.getCachedAccessToken());
});

test('refreshes an expired token through the OAuth client and persists it', async () => {
  writeAuthFile(jwt({ chatgpt_account_id: 'acct-1' }, -60), 'refresh-old');
  const service = new CodexOAuthService();
  await service.ensureFreshToken();

  const call = refreshCalls.at(-1);
  assert.equal(call.grant_type, 'refresh_token');
  assert.equal(call.refresh_token, 'refresh-old');
  assert.equal(call.client_id, 'app_EMoamEEZ73f0CkXaXp7hrann');
  assert.equal(service.getCachedAccountId(), 'acct-2');

  const persisted = JSON.parse(fs.readFileSync(authFile, 'utf8'));
  assert.equal(persisted.tokens.refresh_token, 'refresh-2');
  assert.equal(persisted.tokens.account_id, 'acct-2');
  assert.notEqual(persisted.last_refresh, new Date(0).toISOString());
});

test('cancelling the final refresh waiter blocks an overlapping retry until transport settlement', async () => {
  resetSlowRefreshSignals();
  writeAuthFile(jwt({ chatgpt_account_id: 'acct-1' }, -60), 'refresh-slow');
  const service = new CodexOAuthService();
  const normalTokenUrl = process.env.CODEX_OAUTH_TOKEN_URL;
  process.env.CODEX_OAUTH_TOKEN_URL = `http://127.0.0.1:${mockServer.address().port}/slow-token`;
  const controller = new AbortController();
  const refreshing = service.ensureFreshToken(controller.signal);

  try {
    await slowRefreshStarted.promise;
    controller.abort(new Error('Chat generation was cancelled'));
    await assert.rejects(refreshing, /Chat generation was cancelled/);

    // Changing the endpoint makes an incorrectly detached single-flight launch
    // a second request immediately. The correct retry remains joined to the
    // aborting flight and observes its cancellation after transport teardown.
    process.env.CODEX_OAUTH_TOKEN_URL = normalTokenUrl;
    const retryDuringTeardown = service.ensureFreshToken();
    const retryDuringTeardownRejected = assert.rejects(
      retryDuringTeardown,
      error => error?.code === 'ERR_CANCELED' || /cancel/i.test(error?.message)
    );
    await slowRefreshClosed.promise;
    await retryDuringTeardownRejected;

    // Only after the cancelled transport settles may a new refresh exchange
    // start with the same rotating refresh token.
    await service.ensureFreshToken();
    assert.equal(service.getCachedAccountId(), 'acct-2');
  } finally {
    process.env.CODEX_OAUTH_TOKEN_URL = normalTokenUrl;
  }
});

test('the bundled codex plugin omits sampling parameters and adds ChatGPT headers', async () => {
  const plugin = JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'plugins', 'codex-oauth.json'), 'utf8')
  );
  assert.equal(plugin.id, CODEX_OAUTH_PLUGIN_ID);
  assert.equal(plugin.api_mode, 'responses');

  const trust = await import(
    pathToFileURL(
      path.join(
        repoRoot,
        'backend',
        'dist',
        'utils',
        'pluginDefinitionTrust.js'
      )
    ).href
  );
  assert.ok(
    trust.matchesBundledPluginTrustAnchor(plugin),
    'bundled codex manifest must match its shipped trust anchor'
  );

  const adapter = await import(
    pathToFileURL(
      path.join(repoRoot, 'backend', 'dist', 'utils', 'pluginChatAdapter.js')
    ).href
  );
  const { payload } = adapter.buildPluginChatPayload(
    plugin,
    'gpt-5.6-luna',
    [{ role: 'user', content: 'hi' }],
    { temperature: 0.7, top_p: 0.9, num_predict: 2048 },
    {},
    true,
    'responses'
  );
  assert.equal(payload.temperature, undefined);
  assert.equal(payload.top_p, undefined);
  assert.equal(payload.max_output_tokens, undefined);
  assert.equal(payload.store, false);

  // Fresh cache from the refreshed token above feeds the attribution headers.
  const validation = await import(
    pathToFileURL(
      path.join(repoRoot, 'backend', 'dist', 'utils', 'pluginValidation.js')
    ).href
  );
  const headers = validation.buildPluginAuthHeaders(
    plugin,
    'token-value',
    plugin.endpoint
  );
  assert.equal(headers['ChatGPT-Account-Id'], 'acct-2');
  assert.equal(headers['OpenAI-Beta'], 'responses=experimental');
  assert.equal(headers['Authorization'], 'Bearer token-value');
});
