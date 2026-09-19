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
 * Administrator opt-in for the embedded Cordis engine.
 *
 * The engine ships disabled because its tools reach the filesystem outside
 * Libre WebUI's approval flow, so "off by default" and "an administrator can
 * turn it on without editing files or restarting" are both load-bearing. This
 * suite drives the access service, the gate on the engine runtime, and the
 * administrator routes.
 *
 * Unlike the other Cordis suites, this one deliberately does NOT override the
 * runtime configuration: the override is the test seam, and using it here would
 * bypass the very decision under test.
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
const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'libre-cordis-access-'));

process.env.DATA_DIR = path.join(tempRoot, 'data');
process.env.JWT_SECRET = 'cordis-access-test-secret-value';
process.env.ENCRYPTION_KEY = '9'.repeat(64);
process.env.ENABLE_SIGNUP = 'true';

const importBuilt = relativePath =>
  import(pathToFileURL(path.join(backendDir, 'dist', relativePath)).href);

const [
  { default: express },
  { default: cordisRoutes },
  runtime,
  access,
  { authService },
  { userModel },
] = await Promise.all([
  import('express'),
  importBuilt('routes/cordis.js'),
  importBuilt('cordis/runtime.js'),
  importBuilt('services/cordisAccessService.js'),
  importBuilt('services/authService.js'),
  importBuilt('models/userModel.js'),
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

const password = 'Cordis-Access-Password-1!';
let adminToken;

test.after(async () => {
  await runtime.stopCordisHost();
  await rm(tempRoot, { recursive: true, force: true });
});

/** Point the runtime at a scenario composition with no override in force. */
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

async function configureScenario(label) {
  const dir = await mkdtemp(path.join(tempRoot, `${label}-`));
  const workspacePath = path.join(dir, 'workspace');
  const sessionStorePath = path.join(dir, 'sessions');
  await mkdir(workspacePath, { recursive: true });
  await mkdir(sessionStorePath, { recursive: true });

  const example = await readFile(
    path.join(backendDir, 'cordis.patch.example.yml'),
    'utf8'
  );
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
  const settingsPath = path.join(dir, 'cordis.config.yml');
  await installStubProvider();
  await writeFile(configPath, composition, 'utf8');
  // No `features.enabled` key: the decision belongs to the administrator.
  await writeFile(
    settingsPath,
    'model:\n  provider: none\n  route: test-fake-route\n  model: test-model\n',
    'utf8'
  );

  // DATA_DIR is deliberately left alone. Persistence resolves it on every
  // call, so re-pointing it mid-suite would move the database out from under
  // the accounts this suite signs in with, turning every later request into a
  // 401. Only the engine's own paths vary per scenario.
  // `configureCordisRuntime` merges into whatever was set before, so a stale
  // override from an earlier scenario would silently win here.
  runtime.configureCordisRuntime(undefined);
  runtime.configureCordisRuntime({
    configPath,
    settingsPath,
    workspacePath,
    sessionStorePath,
    runtimePath: path.join(dir, 'runtime'),
  });
  await runtime.stopCordisHost();
  return { dir, workspacePath, configPath, settingsPath };
}

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

/** Issue a request with the suite's admin bearer token. */
function request(base, pathname, init = {}) {
  return fetch(`${base}${pathname}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      authorization: adminToken ? `Bearer ${adminToken}` : undefined,
    },
  });
}

test('a bootstrap administrator is issued for the suite', async () => {
  const result = await authService.signup(
    'cordis_access_admin',
    password,
    'cordis-access@example.test',
    { kind: 'signup', ip: '203.0.113.11', userAgent: 'node-test' }
  );
  assert.equal(result?.status, 'authenticated');
  adminToken = result.token;
  assert.ok(adminToken);
});

test('the engine is disabled and unlocked before any administrator decides', async () => {
  const scenario = await configureScenario('default');
  const state = await access.getCordisAccess(runtime.cordisRuntimeConfig());
  assert.equal(state.enabled, false, 'the engine must ship disabled');
  assert.equal(state.lockedByEnv, false, 'nothing should pin it yet');
  // The gate the engine runtime reads agrees with the access state.
  assert.equal(await runtime.isCordisBridgeEnabled(), false);
  assert.equal(await runtime.getCordisEngine().then(r => r.ok), false);
  assert.equal(scenario.configPath.endsWith('cordis.patch.yml'), true);
});

test('the shipped example leaves the decision to the administrator', async () => {
  // The example is what an operator copies. If it stated `features.enabled`, it
  // would pin the feature and grey out the toggle the documentation tells them
  // to use.
  const example = await readFile(
    path.join(backendDir, 'cordis.config.example.yml'),
    'utf8'
  );
  const declared = example
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.startsWith('enabled:'));
  assert.deepEqual(declared, [], 'the example must not pin features.enabled');
});

test('an administrator turns the engine on and it serves without a restart', async () => {
  await configureScenario('enable');
  const server = await startServer();
  try {
    const before = await fetch(`${server.base}/api/cordis/health`);
    assert.deepEqual(await before.json(), {
      success: true,
      enabled: false,
      ready: false,
    });

    const enabled = await request(server.base, '/api/cordis/access', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    assert.equal(enabled.status, 200);
    assert.deepEqual(await enabled.json(), {
      success: true,
      enabled: true,
      lockedByEnv: false,
    });

    // The same process, no restart: the engine mounts on the next request.
    const health = await fetch(`${server.base}/api/cordis/health`);
    const body = await health.json();
    assert.equal(body.enabled, true);
    assert.equal(body.ready, true, JSON.stringify(body));

    const sessions = await request(server.base, '/api/cordis/sessions');
    assert.deepEqual((await sessions.json()).sessions, []);
  } finally {
    await server.close();
  }
});

test('turning the engine off stops it instead of hiding a running host', async () => {
  await configureScenario('disable');
  const server = await startServer();
  try {
    await request(server.base, '/api/cordis/access', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    // Force the mount before disabling, so the assertion is about teardown
    // rather than about a host that never started.
    await fetch(`${server.base}/api/cordis/health`);
    assert.notEqual(
      runtime.cordisHost(),
      undefined,
      'the host should be mounted'
    );

    const disabled = await request(server.base, '/api/cordis/access', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(disabled.status, 200);
    assert.equal(
      runtime.cordisHost(),
      undefined,
      'disabling must dispose the running host'
    );

    const health = await fetch(`${server.base}/api/cordis/health`);
    assert.deepEqual(await health.json(), {
      success: true,
      enabled: false,
      ready: false,
    });
  } finally {
    await server.close();
  }
});

test('an environment pin locks the toggle and is reported', async () => {
  await configureScenario('pinned');
  process.env.LIBRE_CORDIS_ENABLED = 'true';
  const server = await startServer();
  try {
    const read = await request(server.base, '/api/cordis/access');
    assert.deepEqual(await read.json(), {
      success: true,
      enabled: true,
      lockedByEnv: true,
      lockedBy: 'env',
    });

    const write = await request(server.base, '/api/cordis/access', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(write.status, 409);
    assert.match((await write.json()).error, /LIBRE_CORDIS_ENABLED/);
    // The rejected write must not have taken effect.
    assert.equal(await runtime.isCordisBridgeEnabled(), true);
  } finally {
    delete process.env.LIBRE_CORDIS_ENABLED;
    await server.close();
  }
});

test('a composition file that states the flag locks the toggle', async () => {
  const scenario = await configureScenario('file-pinned');
  await writeFile(
    scenario.settingsPath,
    'features:\n  enabled: false\nmodel:\n  provider: none\n',
    'utf8'
  );
  const state = await access.getCordisAccess(runtime.cordisRuntimeConfig());
  assert.equal(state.enabled, false);
  assert.equal(state.lockedByEnv, true);
  assert.equal(state.lockedBy, 'config-file');

  const server = await startServer();
  try {
    const write = await request(server.base, '/api/cordis/access', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    assert.equal(write.status, 409);
    assert.match((await write.json()).error, /cordis\.config\.yml/);
  } finally {
    await server.close();
  }
});

test('access routes require authentication and administrator rights', async () => {
  await configureScenario('authorization');
  const server = await startServer();
  try {
    const anonymous = await fetch(`${server.base}/api/cordis/access`);
    assert.equal(anonymous.status, 401);

    const nonAdmin = await authService.signup(
      'cordis_access_user',
      password,
      'cordis-access-user@example.test',
      { kind: 'signup', ip: '203.0.113.12', userAgent: 'node-test' }
    );
    // A second account is pending until an administrator approves it, and
    // approval does not confer the administrator role — which is exactly the
    // actor this assertion needs.
    assert.equal(nonAdmin?.status, 'pending');
    await userModel.approveUser(nonAdmin.user.id, 'cordis_access_admin');
    const approved = await authService.login('cordis_access_user', password);
    const userToken = approved?.token;
    assert.ok(userToken, 'the approved member needs a session');

    const forbidden = await fetch(`${server.base}/api/cordis/access`, {
      headers: { authorization: `Bearer ${userToken}` },
    });
    assert.equal(
      forbidden.status,
      403,
      'the deployment-wide switch is not a user preference'
    );
    for (const [method, pathname] of [
      ['GET', '/models'],
      ['PATCH', '/sessions/admin-session/settings'],
      ['POST', '/sessions/admin-session/approvals/approval-fixture'],
      ['GET', '/sessions'],
      ['POST', '/sessions'],
      ['GET', '/sessions/admin-session'],
      ['DELETE', '/sessions/admin-session'],
      ['POST', '/sessions/admin-session/messages'],
      ['POST', '/sessions/admin-session/cancel'],
      ['GET', '/agents'],
      ['GET', '/tools'],
    ]) {
      const denied = await fetch(`${server.base}/api/cordis${pathname}`, {
        method,
        headers: {
          authorization: `Bearer ${userToken}`,
          'content-type': 'application/json',
        },
        ...(method === 'POST'
          ? { body: JSON.stringify({ cwd: '/', text: 'hello' }) }
          : {}),
      });
      assert.equal(
        denied.status,
        403,
        `${method} ${pathname} requires an administrator`
      );
    }
  } finally {
    await server.close();
  }
});
