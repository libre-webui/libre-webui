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

/**
 * HTTP regression suite for the Cordis bridge routes.
 *
 * The engine-level suite proves the contract works; this one proves the routes
 * that expose it behave: the surface is closed while the feature is off, it
 * demands authentication once on, and a chat turn reaches the client as
 * newline-delimited JSON with the assistant text before the terminal chunk.
 *
 * The suite runs the real router over a real HTTP server so the streaming
 * behaviour is observed end to end rather than asserted on a mock response.
 */

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const backendDir = path.join(repoRoot, 'backend');
const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'libre-cordis-http-'));

process.env.DATA_DIR = path.join(tempRoot, 'data');
process.env.JWT_SECRET = 'cordis-bridge-http-test-secret-value';
process.env.ENCRYPTION_KEY = '7'.repeat(64);
process.env.ENABLE_SIGNUP = 'true';

const importBuilt = relativePath =>
  import(pathToFileURL(path.join(backendDir, 'dist', relativePath)).href);

const [
  { default: express },
  { default: cordisRoutes },
  runtime,
  { authService },
] = await Promise.all([
  import('express'),
  importBuilt('routes/cordis.js'),
  importBuilt('cordis/runtime.js'),
  importBuilt('services/authService.js'),
]);

const ADAPTER_PLUGIN = pathToFileURL(
  path.join(backendDir, 'dist', 'cordis', 'dsh', 'librewebui-llm-adapter.js')
).href;
const ENGINE_PLUGIN = pathToFileURL(
  path.join(backendDir, 'dist', 'cordis', 'dsh', 'engine-plugin.js')
).href;
const FIXTURE_ADAPTER = pathToFileURL(
  path.join(repoRoot, 'scripts', 'fixtures', 'cordis', 'fake-adapter.mjs')
).href;
const FAKE_REPLY_TEXT = 'Hello from the fake model.';

const password = 'Cordis-Bridge-Password-1!';
let token;

test.after(async () => {
  await runtime.stopCordisHost();
  await rm(tempRoot, { recursive: true, force: true });
});

/** Boot the router on an ephemeral port. */
/**
 * Install a provider handler for the shipped composition's adapter row.
 *
 * That row registers its route only when a handler is installed — the real one
 * delegates to Libre WebUI's provider services, which these scenarios do not
 * boot. A handler that reports no models keeps the row active without
 * pretending to serve calls, so the composition under test is the shipped one
 * rather than a doctored copy.
 */
async function installStubProvider() {
  const { registerLibreWebUiProvider } = await importBuilt(
    'cordis/dsh/librewebui-llm-adapter.js'
  );
  registerLibreWebUiProvider({
    listModels: async () => [],
    resolveModel: async () => undefined,
    defaultModel: async () => undefined,
    stream: async function* () {
      yield { type: 'done', reason: 'stop' };
    },
  });
}

async function startServer() {
  const app = express();
  app.use(express.json());
  app.use('/api/cordis', cordisRoutes);
  const server = await new Promise(resolve => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

/** Build a scenario composition that mounts the engine plus the fixture model. */
/**
 * Remove the Libre WebUI provider adapter row.
 *
 * That row delegates to the deployment's provider layer, which a test host does
 * not install; leaving it in place makes the row fail to register and the bridge
 * never activates. These scenarios supply their own fixture adapter instead.
 */
function withoutProviderAdapter(composition) {
  return composition.replace(
    /\n *# Serves the engine's model calls[\s\S]*?- id: libre-webui-llm-adapter\n *name: '[^']*'\n/,
    '\n'
  );
}

async function engineScenario(label) {
  const dir = await mkdtemp(path.join(tempRoot, `${label}-`));
  const workspacePath = path.join(dir, 'workspace');
  const sessionStorePath = path.join(dir, 'sessions');
  await mkdir(workspacePath, { recursive: true });
  await mkdir(sessionStorePath, { recursive: true });

  const example = await readFile(
    path.join(backendDir, 'cordis.patch.example.yml'),
    'utf8'
  );
  // This document is written into a temp directory, so the shipped relative
  // specifier is made absolute: it would otherwise resolve against the temp
  // directory and fail. Relative resolution itself is covered by
  // test-cordis-bridge.mjs, which mounts the shipped document from its real
  // location.
  const composition = example
    .replace(
      "'./dist/cordis/dsh/engine-plugin.js'",
      JSON.stringify(ENGINE_PLUGIN)
    )
    .replace(
      "'./dist/cordis/dsh/librewebui-llm-adapter.js'",
      JSON.stringify(ADAPTER_PLUGIN)
    )
    .replace(
      '- id: fs-sandbox',
      [
        '- id: test-fake-adapter',
        `  name: ${JSON.stringify(FIXTURE_ADAPTER)}`,
        '  config:',
        '    route: test-fake-route',
        '',
        '- id: fs-sandbox',
      ].join('\n')
    );
  const configPath = path.join(dir, 'cordis.patch.yml');
  await installStubProvider();
  await writeFile(configPath, composition, 'utf8');
  return { dir, workspacePath, sessionStorePath, configPath };
}

/** Point the runtime at a scenario and rebuild its configuration. */
async function configureRuntime(scenarioPaths, { enabled }) {
  process.env.DATA_DIR = scenarioPaths.dir;
  runtime.configureCordisRuntime({
    features: {
      enabled,
      streaming: true,
      tools: true,
      persistence: true,
    },
    model: {
      provider: 'none',
      apiKeyEnv: 'TEST_KEY',
      baseUrl: '',
      route: 'test-fake-route',
      model: 'test-model',
      providers: {},
    },
    configPath: scenarioPaths.configPath,
    settingsPath: path.join(scenarioPaths.dir, 'cordis.config.yml'),
    workspacePath: scenarioPaths.workspacePath,
    sessionStorePath: scenarioPaths.sessionStorePath,
    runtimePath: path.join(scenarioPaths.dir, 'runtime'),
    trace: false,
  });
  await runtime.stopCordisHost();
}

/** Issue a request with the suite's bearer token. */
function request(base, pathname, init = {}) {
  return fetch(`${base}${pathname}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      authorization: token ? `Bearer ${token}` : undefined,
    },
  });
}

test('a bootstrap account is issued for the suite', async () => {
  const result = await authService.signup(
    'cordis_admin',
    password,
    'cordis@example.test',
    { kind: 'signup', ip: '203.0.113.9', userAgent: 'node-test' }
  );
  assert.equal(result?.status, 'authenticated');
  token = result.token;
  assert.ok(token, 'the suite needs a token');
});

test('every route reports the bridge as disabled while the feature is off', async () => {
  const scenarioPaths = await engineScenario('disabled');
  await configureRuntime(scenarioPaths, { enabled: false });
  const server = await startServer();
  try {
    // Health is intentionally unauthenticated so an operator can distinguish
    // "off" from "broken" before they hold a session.
    const health = await fetch(`${server.base}/api/cordis/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), {
      success: true,
      enabled: false,
      ready: false,
    });

    for (const [method, pathname] of [
      ['GET', '/api/cordis/sessions'],
      ['POST', '/api/cordis/sessions'],
      ['GET', '/api/cordis/agents'],
      ['GET', '/api/cordis/tools'],
      ['POST', '/api/cordis/sessions/whatever/messages'],
    ]) {
      const response = await request(server.base, pathname, {
        method,
        ...(method === 'POST'
          ? {
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ text: 'hi' }),
            }
          : {}),
      });
      assert.equal(response.status, 503, `${method} ${pathname}`);
      const body = await response.json();
      assert.equal(body.code, 'CORDIS_DISABLED', `${method} ${pathname}`);
    }
  } finally {
    await server.close();
  }
});

test('routes reject an unauthenticated caller once the bridge is on', async () => {
  const scenarioPaths = await engineScenario('unauthenticated');
  await configureRuntime(scenarioPaths, { enabled: true });
  const server = await startServer();
  try {
    const response = await fetch(`${server.base}/api/cordis/sessions`);
    assert.equal(response.status, 401);
    // The engine can run tools with real filesystem access, so an open route
    // would be a remote code execution surface.
    const body = await response.json();
    assert.equal(body.success, false);
  } finally {
    await server.close();
  }
});

test('the bridge serves sessions, tools, and agents over HTTP', async () => {
  const scenarioPaths = await engineScenario('http-contract');
  await configureRuntime(scenarioPaths, { enabled: true });
  const server = await startServer();
  try {
    const health = await fetch(`${server.base}/api/cordis/health`);
    const healthBody = await health.json();
    assert.equal(healthBody.ready, true, JSON.stringify(healthBody));

    const empty = await request(server.base, '/api/cordis/sessions');
    assert.deepEqual((await empty.json()).sessions, []);

    const created = await request(server.base, '/api/cordis/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: scenarioPaths.workspacePath }),
    });
    assert.equal(created.status, 201);
    const session = (await created.json()).session;
    assert.match(session.id, /^session-[0-9a-f]{8}-\d+$/);

    const tools = await (
      await request(server.base, '/api/cordis/tools')
    ).json();
    assert.deepEqual(tools.tools.map(tool => tool.name).sort(), [
      'edit',
      'read',
      'write',
    ]);

    const detail = await request(
      server.base,
      `/api/cordis/sessions/${session.id}`
    );
    assert.equal(detail.status, 200);
    assert.equal((await detail.json()).session.id, session.id);

    const agents = await (
      await request(server.base, '/api/cordis/agents')
    ).json();
    assert.deepEqual(agents.agents, []);

    const removed = await request(
      server.base,
      `/api/cordis/sessions/${session.id}`,
      { method: 'DELETE' }
    );
    assert.equal(removed.status, 200);
    assert.equal((await removed.json()).success, true);

    const missing = await request(
      server.base,
      `/api/cordis/sessions/${session.id}`
    );
    assert.equal(missing.status, 404);
  } finally {
    await server.close();
  }
});

test('a chat turn streams assistant text before the terminal chunk', async () => {
  const scenarioPaths = await engineScenario('http-stream');
  await configureRuntime(scenarioPaths, { enabled: true });
  const server = await startServer();
  try {
    const created = await request(server.base, '/api/cordis/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: scenarioPaths.workspacePath }),
    });
    const session = (await created.json()).session;

    const response = await request(
      server.base,
      `/api/cordis/sessions/${session.id}/messages`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'Say hello' }),
      }
    );
    assert.equal(response.status, 200);
    assert.match(
      response.headers.get('content-type') ?? '',
      /application\/x-ndjson/
    );

    const chunks = (await response.text())
      .split('\n')
      .filter(line => line.trim() !== '')
      .map(line => JSON.parse(line));

    const text = chunks
      .filter(chunk => chunk.type === 'text')
      .map(chunk => chunk.text)
      .join('');
    assert.equal(text, FAKE_REPLY_TEXT);
    assert.equal(chunks.at(-1).type, 'done');

    // The turn is durable, so a client that reconnects reads history.
    const detail = await (
      await request(server.base, `/api/cordis/sessions/${session.id}`)
    ).json();
    const assistant = detail.session.messages.filter(
      message => message.role === 'assistant'
    );
    assert.equal(assistant.length, 1);
    assert.equal(assistant[0].text, FAKE_REPLY_TEXT);
  } finally {
    await server.close();
  }
});

test('a message for an unknown session is a request error, not an outage', async () => {
  const scenarioPaths = await engineScenario('http-unknown');
  await configureRuntime(scenarioPaths, { enabled: true });
  const server = await startServer();
  try {
    const response = await request(
      server.base,
      '/api/cordis/sessions/session-missing/messages',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'hello' }),
      }
    );
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.match(body.error, /does not exist/);
    assert.equal(body.code, undefined, 'not reported as a bridge outage');
  } finally {
    await server.close();
  }
});

test('an empty message is rejected before the engine is asked', async () => {
  const scenarioPaths = await engineScenario('http-empty');
  await configureRuntime(scenarioPaths, { enabled: true });
  const server = await startServer();
  try {
    const response = await request(
      server.base,
      '/api/cordis/sessions/whatever/messages',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: '   ' }),
      }
    );
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /message text is required/);
  } finally {
    await server.close();
  }
});

async function withModelCatalog(callback) {
  const { libreWebUiProviderHandler } = await importBuilt(
    'cordis/dsh/provider-handler.js'
  );
  const originalList = libreWebUiProviderHandler.listModels;
  const originalDefault = libreWebUiProviderHandler.defaultModel;
  const model = {
    id: 'lwui:ollama:test-model',
    name: 'test-model',
    providerType: 'ollama',
    providerName: 'Ollama',
  };
  libreWebUiProviderHandler.listModels = async () => [model];
  libreWebUiProviderHandler.defaultModel = async () => model.id;
  try {
    await callback(model);
  } finally {
    libreWebUiProviderHandler.listModels = originalList;
    libreWebUiProviderHandler.defaultModel = originalDefault;
  }
}

test('the engine model catalog and session settings preserve exact model and permission choices', async () => {
  const paths = await engineScenario('http-settings');
  await configureRuntime(paths, { enabled: true });
  const server = await startServer();
  try {
    await withModelCatalog(async model => {
      const catalog = await request(server.base, '/api/cordis/models');
      assert.equal(catalog.status, 200);
      assert.deepEqual(await catalog.json(), {
        success: true,
        models: [model],
        defaultModel: model.id,
      });
      const created = await request(server.base, '/api/cordis/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: model.id, permissionMode: 'read-only' }),
      });
      assert.equal(created.status, 201);
      const { session } = await created.json();
      assert.equal(session.settings.model, model.id);
      assert.equal(session.settings.permissionMode, 'read-only');
      const updated = await request(
        server.base,
        `/api/cordis/sessions/${session.id}/settings`,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ permissionMode: 'workspace-write' }),
        }
      );
      assert.equal(updated.status, 200);
      assert.equal(
        (await updated.json()).session.settings.permissionMode,
        'workspace-write'
      );
      await runtime.stopCordisHost();
      const restored = await request(
        server.base,
        `/api/cordis/sessions/${session.id}`
      );
      assert.equal(restored.status, 200);
      assert.deepEqual((await restored.json()).session.settings, {
        model: model.id,
        permissionMode: 'workspace-write',
      });
    });
  } finally {
    await runtime.stopCordisHost();
    await server.close();
  }
});

test('session settings reject pseudo-models, unavailable routes, unsupported permissions and empty updates', async () => {
  const paths = await engineScenario('http-settings-validation');
  await configureRuntime(paths, { enabled: true });
  const server = await startServer();
  try {
    await withModelCatalog(async () => {
      const created = await request(server.base, '/api/cordis/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      const { session } = await created.json();
      for (const body of [
        { model: 'persona:fixture' },
        { model: 'codex' },
        { model: 'lwui:plugin:other:private-model' },
        { permissionMode: 'danger-full-access' },
        {},
        null,
        [],
      ]) {
        const rejected = await request(
          server.base,
          `/api/cordis/sessions/${session.id}/settings`,
          {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          }
        );
        assert.equal(rejected.status, 400, JSON.stringify(body));
      }
      const untouched = await request(
        server.base,
        `/api/cordis/sessions/${session.id}`
      );
      assert.equal(
        (await untouched.json()).session.settings.permissionMode,
        'read-only'
      );
      const absent = await request(
        server.base,
        '/api/cordis/sessions/missing/settings',
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ permissionMode: 'read-only' }),
        }
      );
      assert.equal(absent.status, 404);
      const stale = await request(
        server.base,
        `/api/cordis/sessions/${session.id}/approvals/stale`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ decision: 'allowed-once' }),
        }
      );
      assert.equal(stale.status, 409);
      const invalid = await request(
        server.base,
        `/api/cordis/sessions/${session.id}/approvals/stale`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ decision: 'always' }),
        }
      );
      assert.equal(invalid.status, 400);
    });
  } finally {
    await runtime.stopCordisHost();
    await server.close();
  }
});
