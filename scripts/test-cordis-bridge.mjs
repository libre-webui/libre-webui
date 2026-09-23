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
 * Cordis bridge regression suite.
 *
 * Covers the four claims the Cordis bridge makes:
 *
 *  1. The host mounts a composition document and reports each engine service's
 *     DONE/PENDING state.
 *  2. The `libreDshEngine` contract is satisfied by the DSH composition, so
 *     session creation, chat streaming, and tool listing work end to end.
 *  3. Retargeting the model adapter through a plugin reload changes the
 *     provider without restarting the host or disturbing the other services.
 *  4. Stopping the host rolls the engine back: services withdrawn, listeners
 *     released, fixtures torn down.
 *
 * The suite is offline. A deterministic fixture adapter stands in for a real
 * provider so assertions are exact and no credential or network is required.
 */

import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
  symlink,
  readdir,
  realpath,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { EntryTree } from '@deepseek-ai/cordis-plugin-loader';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const backendDir = path.join(repoRoot, 'backend');
const { resolveCliRuntimePaths } = await import('../bin/runtime-paths.js');

/** Root for every temp directory this suite creates. */
const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'libre-cordis-'));

// DATA_DIR must be redirected before anything resolves a data path, or the
// host would write its runtime state into the developer's checkout.
process.env.DATA_DIR = path.join(tempRoot, 'data');

const distModule = relativePath =>
  import(pathToFileURL(path.join(backendDir, 'dist', relativePath)).href);

const {
  applyHostDefaults,
  parseComposition,
  parseSettings,
  stringifyComposition,
} = await distModule('cordis/host/composition.js');
const { resolveCordisHostConfig, readConfigDocument } = await distModule(
  'cordis/host/config.js'
);
const { BRIDGE_ENTRY_ID, startCordisHost } = await distModule(
  'cordis/host/host.js'
);
const { isServedByProviderLayer, requiredProviderPackage } = await distModule(
  'cordis/host/model.js'
);
const { extractText, projectStreamEvent, projectTurnFailure } =
  await distModule('cordis/dsh/engine-plugin.js');

/**
 * Install a provider handler for the shipped composition's adapter row.
 *
 * The shipped composition mounts `libre-webui-llm-adapter`, which registers its
 * route only when a handler is installed — the real one delegates to Libre
 * WebUI's provider services, which these scenarios do not boot. A handler that
 * reports no models keeps the row active without pretending to serve calls, so
 * the composition under test is the shipped one rather than a doctored copy.
 */
async function installStubProvider() {
  const { registerLibreWebUiProvider } = await distModule(
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

const FIXTURE_ADAPTER = pathToFileURL(
  path.join(repoRoot, 'scripts', 'fixtures', 'cordis', 'fake-adapter.mjs')
).href;
const FIXTURE_PROBE = pathToFileURL(
  path.join(repoRoot, 'scripts', 'fixtures', 'cordis', 'lifecycle-probe.mjs')
).href;
const ADAPTER_PLUGIN = pathToFileURL(
  path.join(backendDir, 'dist', 'cordis', 'dsh', 'librewebui-llm-adapter.js')
).href;
const ENGINE_PLUGIN = pathToFileURL(
  path.join(backendDir, 'dist', 'cordis', 'dsh', 'engine-plugin.js')
).href;

const FAKE_REPLY_TEXT = 'Hello from the fake model.';
const UPLOAD_PACKAGES = [
  '@deepseek-ai/dsh-session-telemetry-otel',
  '@deepseek-ai/dsh-session-log-deepseek',
  '@deepseek-ai/dsh-plugin-package-inventory-deepseek',
];
const PROBE_SERVICE = 'testLifecycleProbe';
const PROBE_EVENT = 'test/probe-ping';

/**
 * Create a scenario directory with its own workspace and session store.
 *
 * Each scenario also gets its own `DATA_DIR`. `resolveDataDirectory()` reads
 * `process.env.DATA_DIR` on every call, so re-pointing it per scenario is what
 * keeps one scenario's persisted sessions from colliding with another's — the
 * JSONL backend refuses to create a session whose file already exists, and
 * `node --test` runs these tests concurrently.
 */
async function scenario(label) {
  const dir = await mkdtemp(path.join(tempRoot, `${label}-`));
  const workspacePath = path.join(dir, 'workspace');
  const sessionStorePath = path.join(dir, 'sessions');
  const dataDir = path.join(dir, 'data');
  await mkdir(workspacePath, { recursive: true });
  await mkdir(sessionStorePath, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  process.env.DATA_DIR = dataDir;
  return {
    dir,
    dataDir,
    workspacePath,
    sessionStorePath,
    configPath: path.join(dir, 'cordis.patch.yml'),
    settingsPath: path.join(dir, 'cordis.config.yml'),
  };
}

/**
 * Read the shipped example composition, making its plugin path absolute.
 *
 * Scenarios write this document into a temp directory, where the shipped
 * relative specifier cannot resolve. The resolution of that specifier against
 * the operator's document is covered separately, by the test that mounts the
 * shipped file where it actually lives.
 */
async function exampleComposition() {
  const source = await readFile(
    path.join(backendDir, 'cordis.patch.example.yml'),
    'utf8'
  );
  return source
    .replace(
      "'./dist/cordis/dsh/engine-plugin.js'",
      JSON.stringify(ENGINE_PLUGIN)
    )
    .replace(
      "'./dist/cordis/dsh/librewebui-llm-adapter.js'",
      JSON.stringify(ADAPTER_PLUGIN)
    );
}

/** Read the shipped example composition verbatim, relative specifier intact. */
async function shippedComposition() {
  return readFile(path.join(backendDir, 'cordis.patch.example.yml'), 'utf8');
}

test('the shipped composition resolves its relative plugin specifier', async () => {
  // This is the one scenario that must use the documented location: a relative
  // specifier only means what the example claims when the document sits beside
  // the backend package. A developer's own composition there is preserved.
  const livePath = path.join(backendDir, 'cordis.patch.yml');
  const previous = await readFile(livePath, 'utf8').catch(() => undefined);
  const paths = await scenario('relative-specifier');
  // The check under test is path resolution, not routing, and no provider
  // handler is installed here, so the composition serves no route.
  await writeSettings(paths, { route: '' });
  await writeFile(livePath, await shippedComposition(), 'utf8');
  let host;
  try {
    const config = resolveCordisHostConfig({
      configPath: livePath,
      settingsPath: paths.settingsPath,
      workspacePath: paths.workspacePath,
      sessionStorePath: paths.sessionStorePath,
      runtimePath: path.join(paths.dir, 'runtime'),
    });
    host = await startCordisHost(config);
    // Before the fix the bridge row failed to import, so the services it
    // publishes were reported missing while every other row started fine.
    assert.deepEqual(host.status().missing, []);
    assert.notEqual(host.context.get('libreDshEngine'), undefined);
  } finally {
    await host?.stop();
    if (previous === undefined) await rm(livePath, { force: true });
    else await writeFile(livePath, previous, 'utf8');
  }
});

/**
 * Build a composition that mounts the real engine plus a deterministic model
 * adapter, so chat streaming can be asserted without a provider.
 */
async function engineComposition({ route = 'test-fake-route' } = {}) {
  const base = await exampleComposition();
  return base.replace(
    '- id: fs-sandbox',
    [
      '- id: test-fake-adapter',
      `  name: ${JSON.stringify(FIXTURE_ADAPTER)}`,
      '  config:',
      `    route: ${route}`,
      '',
      '- id: fs-sandbox',
    ].join('\n')
  );
}

/** Write a settings document for a scenario. */
async function writeSettings(
  scenarioPaths,
  { provider = 'none', route = 'test-fake-route', model = 'test-model' } = {}
) {
  await writeFile(
    scenarioPaths.settingsPath,
    [
      'features:',
      '  enabled: true',
      'model:',
      `  provider: ${provider}`,
      `  route: '${route}'`,
      `  model: '${model}'`,
    ].join('\n'),
    'utf8'
  );
}

/** Start a host for one scenario, writing the composition first. */
async function startHost(scenarioPaths, composition) {
  await installStubProvider();
  await writeFile(scenarioPaths.configPath, composition, 'utf8');
  const config = resolveCordisHostConfig({
    configPath: scenarioPaths.configPath,
    settingsPath: scenarioPaths.settingsPath,
    workspacePath: scenarioPaths.workspacePath,
    sessionStorePath: scenarioPaths.sessionStorePath,
  });
  return startCordisHost(config);
}

/** Create a loader entry, carrying the id the Loader's types omit. */
async function createLoaderEntryForTest(loader, entry) {
  const create = loader.create.bind(loader);
  await create(entry);
}

/** Wait until a response reports its terminal chunk. */
async function waitForTerminal(chunks, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (chunks.some(chunk => chunk.type === 'done')) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`no terminal chunk within ${timeoutMs}ms`);
}

/** Collect chunks until the stream reports completion. */
function collectStream(handle, { timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const timer = setTimeout(() => {
      reject(
        new Error(
          `stream did not finish within ${timeoutMs}ms; saw ${JSON.stringify(chunks)}`
        )
      );
    }, timeoutMs);
    handle.subscribe(chunk => {
      chunks.push(chunk);
      if (chunk.type === 'done') {
        clearTimeout(timer);
        resolve(chunks);
      }
    });
  });
}

test.after(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

// ── Composition parsing ──────────────────────────────────────────────────────

test('composition parses a top-level entry array and preserves !!js markers', () => {
  const entries = parseComposition(
    [
      '- id: alpha',
      "  name: '@example/alpha'",
      '  config:',
      "    root: !!js process.env.SOME_ROOT ?? 'fallback'",
    ].join('\n')
  );
  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, 'alpha');
  assert.equal(entries[0].name, '@example/alpha');
  // The marker must survive parsing intact: the loader evaluates it later, in
  // the owning entry's fiber, and cannot do that once it is an expanded string.
  assert.deepEqual(entries[0].config, {
    root: { __jsExpr: "process.env.SOME_ROOT ?? 'fallback'" },
  });
});

test('composition rejects a document that is not a top-level array', () => {
  assert.throws(
    () => parseComposition('settings:\n  enabled: true\n'),
    /top-level YAML array/
  );
});

test('composition rejects an entry without a literal name', () => {
  assert.throws(
    () => parseComposition('- id: alpha\n  config: {}\n'),
    /literal string `name`/
  );
});

test('composition accepts an empty document', () => {
  assert.deepEqual(parseComposition(''), []);
});

test('composition assigns a stable id to an unlabelled entry', () => {
  const entries = parseComposition("- name: '@example/alpha'\n");
  assert.equal(entries[0].id, '@example/alpha#0');
});

test('composition round-trips !!js tags through serialize and parse', () => {
  const original = parseComposition(
    "- id: alpha\n  name: '@example/alpha'\n  config:\n    root: !!js process.env.X ?? 'y'\n"
  );
  const reparsed = parseComposition(stringifyComposition(original));
  assert.deepEqual(reparsed, original);
});

test('host defaults merge into the bridge row only', () => {
  const entries = [
    { id: 'llm', name: '@deepseek-ai/dsh-llm' },
    {
      id: BRIDGE_ENTRY_ID,
      name: './engine.js',
      config: { streaming: false },
    },
  ];
  const merged = applyHostDefaults(entries, BRIDGE_ENTRY_ID, {
    defaultProvider: 'ollama',
    streaming: true,
  });
  // The composition wins over the host default: an operator who pinned a value
  // on the row meant it.
  assert.deepEqual(merged[1].config, {
    defaultProvider: 'ollama',
    streaming: false,
  });
  assert.deepEqual(merged[0], entries[0]);
});

test('settings parsing rejects a non-mapping document', () => {
  assert.throws(() => parseSettings('- one\n'), /must be a YAML mapping/);
});

// ── Configuration resolution ─────────────────────────────────────────────────

test('missing settings fall back to defaults with the host disabled', async () => {
  const paths = await scenario('config-defaults');
  const config = resolveCordisHostConfig({
    configPath: paths.configPath,
    settingsPath: paths.settingsPath,
    workspacePath: paths.workspacePath,
    sessionStorePath: paths.sessionStorePath,
  });
  assert.equal(config.features.enabled, false, 'opt-in by default');
  assert.equal(config.features.streaming, true);
  assert.equal(config.model.provider, 'libre-webui');
  assert.equal(config.settingsPath, paths.settingsPath);
});

test('default and blank engine paths follow the packaged home or configured data directory', async () => {
  const paths = await scenario('engine-data-home');
  const names = [
    'DATA_DIR',
    'LIBRE_CORDIS_WORKSPACE',
    'LIBRE_CORDIS_SESSION_STORE',
  ];
  const previous = names.map(name => process.env[name]);
  const fakeHome = path.join(paths.dir, 'home');
  const packaged = resolveCliRuntimePaths({}, { homeDirectory: fakeHome });
  assert.equal(packaged.dataDirectory, path.join(fakeHome, '.libre-webui'));
  try {
    delete process.env.LIBRE_CORDIS_WORKSPACE;
    delete process.env.LIBRE_CORDIS_SESSION_STORE;
    for (const dataDirectory of [
      packaged.dataDirectory,
      path.join(paths.dir, 'custom-data-mount'),
    ]) {
      process.env.DATA_DIR = dataDirectory;
      for (const document of [
        '',
        "workspacePath: ''\nsessionStorePath: '   '\n",
        'workspacePath: null\nsessionStorePath: null\n',
      ]) {
        await writeFile(paths.settingsPath, document);
        const config = resolveCordisHostConfig({
          configPath: paths.configPath,
          settingsPath: paths.settingsPath,
          workspacePath: '',
          sessionStorePath: ' ',
        });
        assert.equal(
          config.workspacePath,
          path.join(dataDirectory, 'cordis-workspace')
        );
        assert.equal(
          config.sessionStorePath,
          path.join(dataDirectory, 'cordis-sessions')
        );
        assert.equal(
          config.runtimePath,
          path.join(dataDirectory, 'cordis-runtime')
        );
      }
    }
  } finally {
    names.forEach((name, index) => restoreEnv(name, previous[index]));
  }
});

test('explicit engine paths keep their precedence and invalid paths fail', async () => {
  const paths = await scenario('engine-path-overrides');
  const names = ['LIBRE_CORDIS_WORKSPACE', 'LIBRE_CORDIS_SESSION_STORE'];
  const previous = names.map(name => process.env[name]);
  const resolve = (options = {}) =>
    resolveCordisHostConfig({
      configPath: paths.configPath,
      settingsPath: paths.settingsPath,
      ...options,
    });
  try {
    delete process.env.LIBRE_CORDIS_WORKSPACE;
    delete process.env.LIBRE_CORDIS_SESSION_STORE;
    await writeFile(
      paths.settingsPath,
      JSON.stringify({
        workspacePath: paths.workspacePath,
        sessionStorePath: paths.sessionStorePath,
      })
    );
    assert.equal(resolve().workspacePath, paths.workspacePath);
    assert.equal(resolve().sessionStorePath, paths.sessionStorePath);
    process.env.LIBRE_CORDIS_WORKSPACE = path.join(paths.dir, 'env-workspace');
    process.env.LIBRE_CORDIS_SESSION_STORE = path.join(
      paths.dir,
      'env-sessions'
    );
    assert.equal(resolve().workspacePath, process.env.LIBRE_CORDIS_WORKSPACE);
    assert.equal(
      resolve().sessionStorePath,
      process.env.LIBRE_CORDIS_SESSION_STORE
    );
    const explicit = resolve({
      workspacePath: paths.workspacePath,
      sessionStorePath: paths.sessionStorePath,
    });
    assert.equal(explicit.workspacePath, paths.workspacePath);
    assert.equal(explicit.sessionStorePath, paths.sessionStorePath);
    process.env.LIBRE_CORDIS_WORKSPACE = '  ';
    process.env.LIBRE_CORDIS_SESSION_STORE = '';
    assert.equal(resolve().workspacePath, paths.workspacePath);
    assert.equal(resolve().sessionStorePath, paths.sessionStorePath);
    await writeFile(paths.settingsPath, JSON.stringify({ workspacePath: 42 }));
    assert.throws(() => resolve(), /directory setting must be strings/);
  } finally {
    names.forEach((name, index) => restoreEnv(name, previous[index]));
  }
});

test('a directly configured bridge defaults its workspace to LWUI data instead of cwd', async () => {
  for (const workspacePath of [undefined, '', '   ']) {
    const paths = await scenario('direct-bridge-workspace');
    await writeSettings(paths);
    const rows = parseComposition(await engineComposition());
    const bridge = rows.find(row => row.id === BRIDGE_ENTRY_ID);
    // A custom row does not receive the host's named-bridge defaults.
    bridge.id = 'custom-bridge';
    bridge.config = {
      workspacePath,
      defaultProvider: 'test-fake-route',
      defaultModel: 'test-model',
    };
    const host = await startHost(paths, stringifyComposition(rows));
    try {
      const engine = host.context.get('libreDshEngine');
      const session = await engine.createSession({ cwd: '' });
      assert.equal(
        session.workspacePath,
        await realpath(path.join(paths.dataDir, 'cordis-workspace'))
      );
      await assert.rejects(
        engine.createSession({ cwd: process.cwd() }),
        /inside the configured Cordis workspace/
      );
    } finally {
      await host.stop();
    }
  }
});

test('settings document supplies provider, route, and feature flags', async () => {
  const paths = await scenario('config-document');
  await writeFile(
    paths.settingsPath,
    [
      // `enabled` is a top-level flag; `features` holds only the capability
      // switches. This mirrors cordis.config.example.yml.
      'features:',
      '  enabled: true',
      '  tools: false',
      'model:',
      '  provider: pi-ai',
      '  route: ollama',
      '  apiKeyEnv: OLLAMA_API_KEY',
      '  baseUrl: http://127.0.0.1:11434/v1',
      '  providers:',
      '    ollama:',
      '      api: openai-completions',
    ].join('\n'),
    'utf8'
  );
  const config = resolveCordisHostConfig({
    configPath: paths.configPath,
    settingsPath: paths.settingsPath,
    workspacePath: paths.workspacePath,
    sessionStorePath: paths.sessionStorePath,
  });
  assert.equal(config.features.enabled, true);
  assert.equal(config.features.tools, false);
  assert.equal(config.model.provider, 'pi-ai');
  assert.equal(config.model.route, 'ollama');
  assert.equal(config.model.apiKeyEnv, 'OLLAMA_API_KEY');
  assert.equal(config.model.baseUrl, 'http://127.0.0.1:11434/v1');
  assert.deepEqual(config.model.providers, {
    ollama: { api: 'openai-completions' },
  });
});

test('environment variables override the settings document', async () => {
  const paths = await scenario('config-env');
  await writeFile(
    paths.settingsPath,
    'features:\n  enabled: false\nmodel:\n  provider: deepseek\n  route: from-file\n',
    'utf8'
  );
  const previousProvider = process.env.LIBRE_CORDIS_MODEL_PROVIDER;
  const previousRoute = process.env.LIBRE_CORDIS_MODEL_ROUTE;
  process.env.LIBRE_CORDIS_MODEL_PROVIDER = 'pi-ai';
  process.env.LIBRE_CORDIS_MODEL_ROUTE = 'from-env';
  try {
    const config = resolveCordisHostConfig({
      configPath: paths.configPath,
      settingsPath: paths.settingsPath,
      workspacePath: paths.workspacePath,
      sessionStorePath: paths.sessionStorePath,
    });
    assert.equal(config.model.provider, 'pi-ai');
    assert.equal(config.model.route, 'from-env');
  } finally {
    restoreEnv('LIBRE_CORDIS_MODEL_PROVIDER', previousProvider);
    restoreEnv('LIBRE_CORDIS_MODEL_ROUTE', previousRoute);
  }
});

test('an unknown provider mode is rejected rather than defaulted', async () => {
  const paths = await scenario('config-bad-provider');
  await writeFile(
    paths.settingsPath,
    'model:\n  provider: not-a-provider\n',
    'utf8'
  );
  assert.throws(
    () =>
      resolveCordisHostConfig({
        configPath: paths.configPath,
        settingsPath: paths.settingsPath,
        workspacePath: paths.workspacePath,
        sessionStorePath: paths.sessionStorePath,
      }),
    /unknown model provider/
  );
});

test('a malformed settings document fails loudly', async () => {
  const paths = await scenario('config-malformed');
  await writeFile(paths.settingsPath, '- not\n- a\n- mapping\n', 'utf8');
  assert.throws(
    () => readConfigDocument(paths.settingsPath),
    /must be a YAML mapping/
  );
});

test('a provider mode needing an uninstalled package is named', async () => {
  // The provider packages are deliberately not dependencies: carrying every
  // provider SDK pulled in a large transitive tree. A deployment that wants one
  // installs it, so the failure has to say which package that is.
  const paths = await scenario('provider-package');
  await writeSettings(paths, { provider: 'pi-ai', route: 'test-fake-route' });
  await writeFile(paths.configPath, await engineComposition(), 'utf8');
  const config = {
    ...resolveCordisHostConfig({
      configPath: paths.configPath,
      settingsPath: paths.settingsPath,
      workspacePath: paths.workspacePath,
      sessionStorePath: paths.sessionStorePath,
      runtimePath: path.join(paths.dir, 'runtime'),
    }),
    providerHandler: {
      listModels: async () => [],
      resolveModel: async () => undefined,
      defaultModel: async () => undefined,
      stream: async function* () {
        yield { type: 'done', reason: 'stop' };
      },
    },
  };
  assert.equal(
    requiredProviderPackage(config.model),
    '@deepseek-ai/dsh-llm-pi-ai'
  );
  await assert.rejects(startCordisHost(config), error => {
    assert.match(error.message, /dsh-llm-pi-ai/);
    assert.match(error.message, /not a dependency of this backend/);
    return true;
  });
});

test('the provider-layer mode needs no extra package', async () => {
  const paths = await scenario('provider-layer-mode');
  await writeSettings(paths, {
    provider: 'libre-webui',
    route: 'test-fake-route',
  });
  const config = resolveCordisHostConfig({
    configPath: paths.configPath,
    settingsPath: paths.settingsPath,
    workspacePath: paths.workspacePath,
    sessionStorePath: paths.sessionStorePath,
    runtimePath: path.join(paths.dir, 'runtime'),
  });
  assert.equal(requiredProviderPackage(config.model), undefined);
  assert.equal(isServedByProviderLayer(config), true);
});

/** Restore an environment variable, clearing it when it was unset. */
function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

// ── Host lifecycle ───────────────────────────────────────────────────────────

test('shipped composition explicitly disables every DSH data uploader', async () => {
  const rows = parseComposition(await shippedComposition());
  for (const name of UPLOAD_PACKAGES) {
    const matches = rows.filter(row => row.name === name);
    assert.equal(matches.length, 1, name);
    assert.equal(matches[0].disabled, true, name);
  }
});

test('host blocks uploader imports, nested includes, and live reconfiguration', async t => {
  const paths = await scenario('private-engine');
  await writeSettings(paths);
  const host = await startHost(paths, await engineComposition());
  const loader = host.context.get('loader');
  const importedUploaders = [];
  const originalImport = EntryTree.prototype.import;
  // Substitute harmless modules at the real import boundary. A regression
  // records the attempted upload-module import without loading any uploader.
  t.mock.method(EntryTree.prototype, 'import', function (name, ...args) {
    if (UPLOAD_PACKAGES.some(pkg => name.includes(pkg))) {
      importedUploaders.push(name);
      return { apply() {} };
    }
    return originalImport.call(this, name, ...args);
  });
  try {
    await loader.create({
      id: 'disabled-invalid-module',
      name: 'file://other-host/plugin.js',
      disabled: true,
    });
    for (const name of UPLOAD_PACKAGES) {
      const entry = [...loader.entries()].find(
        row => row.options.name === name
      );
      assert.ok(entry, name);
      assert.equal(entry.disabled, true);
      assert.equal(entry.fiber, undefined);
    }
    for (const [index, name] of UPLOAD_PACKAGES.entries()) {
      const id = `privacy-${index}`;
      for (const specifier of [
        name,
        `${name}/lib/index.js`,
        pathToFileURL(path.join(repoRoot, 'node_modules', name, 'lib/index.js'))
          .href,
      ]) {
        await assert.rejects(
          loader.create({ id, name: specifier }),
          /Libre WebUI disables DSH data-upload plugin/
        );
      }
      await loader.create({ id, name, disabled: true });
      const entry = loader.resolve(id);
      assert.equal(entry.fiber, undefined);
      for (const disabled of [false, null, undefined]) {
        await assert.rejects(
          loader.update(id, { disabled }),
          /Libre WebUI disables DSH data-upload plugin/
        );
        assert.equal(entry.options.disabled, true);
      }
      await assert.rejects(
        loader.update(id, { group: true }),
        /Libre WebUI disables DSH data-upload plugin/
      );
      // refresh() calls init() without going through update().
      entry.options.disabled = false;
      try {
        await assert.rejects(
          entry.refresh(),
          /Libre WebUI disables DSH data-upload plugin/
        );
      } finally {
        entry.options.disabled = true;
      }
    }

    await loader.create({ id: 'safe-probe', name: FIXTURE_PROBE });
    const probe = host.context.get(PROBE_SERVICE);
    assert.ok(probe);
    const probeUid = loader.resolve('safe-probe').fiber.uid;
    for (const name of UPLOAD_PACKAGES) {
      for (const options of [{ name }, { name, disabled: true, group: true }]) {
        await assert.rejects(
          loader.update('safe-probe', options),
          /Libre WebUI disables DSH data-upload plugin/
        );
        assert.equal(loader.resolve('safe-probe').options.name, FIXTURE_PROBE);
        assert.equal(loader.resolve('safe-probe').fiber.uid, probeUid);
      }
    }

    const nestedPath = path.join(paths.dir, 'nested.yml');
    await writeFile(
      nestedPath,
      stringifyComposition([
        { id: 'nested-uploader', name: UPLOAD_PACKAGES[0] },
      ])
    );
    await assert.rejects(
      loader.create({
        id: 'nested-privacy',
        name: 'cordis:include',
        config: { path: pathToFileURL(nestedPath).href },
      }),
      /Libre WebUI disables DSH data-upload plugin/
    );
    assert.deepEqual(importedUploaders, []);

    const engine = host.context.get('libreDshEngine');
    const session = await engine.createSession({ cwd: '' });
    const chunks = await collectStream(
      await engine.sendMessage(session.id, 'A private test message')
    );
    assert.ok(chunks.some(chunk => chunk.type === 'text'));
    assert.equal(chunks.at(-1).type, 'done');
    assert.deepEqual(importedUploaders, []);
  } finally {
    await host.stop();
  }
});

test('provider capability initialization cannot import a data uploader', async () => {
  const paths = await scenario('private-adapter-import');
  await writeSettings(paths);
  const rows = parseComposition(await engineComposition());
  const adapter = rows.find(row => row.id === 'libre-webui-llm-adapter');
  const config = resolveCordisHostConfig({
    configPath: paths.configPath,
    settingsPath: paths.settingsPath,
    workspacePath: paths.workspacePath,
    sessionStorePath: paths.sessionStorePath,
    runtimePath: path.join(paths.dir, 'runtime'),
  });
  for (const name of UPLOAD_PACKAGES) {
    adapter.name = name;
    await writeFile(paths.configPath, stringifyComposition(rows));
    await assert.rejects(
      startCordisHost({ ...config, providerHandler: {} }),
      /Libre WebUI disables DSH data-upload plugin/
    );
  }
  // A disabled adapter must never be imported even to install its capability.
  adapter.name = 'file://other-host/plugin.js';
  adapter.disabled = true;
  await writeFile(paths.configPath, stringifyComposition(rows));
  const host = await startCordisHost({ ...config, providerHandler: {} });
  try {
    assert.deepEqual(host.status().missing, []);
  } finally {
    await host.stop();
  }
});

test('host reports every engine service as ready once DONE', async () => {
  const paths = await scenario('lifecycle-ready');
  await writeSettings(paths);
  const composition = (await exampleComposition()).replace(
    '- id: fs-sandbox',
    `- id: test-fake-adapter\n  name: ${JSON.stringify(FIXTURE_ADAPTER)}\n  config:\n    route: test-fake-route\n\n- id: fs-sandbox`
  );
  const host = await startHost(paths, composition);
  try {
    const status = host.status();
    assert.equal(status.started, true);
    assert.deepEqual(status.missing, []);
    const byName = new Map(status.services.map(s => [s.name, s]));
    for (const required of [
      'llm',
      'systemPrompt',
      'sessions',
      'tools',
      'agents',
      'sessionProjections',
      'sessionPersistence',
    ]) {
      assert.equal(
        byName.get(required)?.available,
        true,
        `${required} should be available`
      );
    }
    const engine = host.context.get('libreDshEngine');
    assert.notEqual(engine, undefined);
    // The contract's own view of the same services must agree.
    for (const entry of engine.status()) {
      assert.equal(entry.state, 'ready', `${entry.name} should be ready`);
    }
  } finally {
    await host.stop();
  }
});

test('host refuses to start when the composition omits a required service', async () => {
  const paths = await scenario('lifecycle-missing');
  // No route is named: this composition mounts no adapter on purpose, and the
  // assertion is about the missing tool layer rather than about routing.
  await writeSettings(paths, { route: '' });
  // Deliberately omit the tool layer: `agents` alone cannot satisfy the bridge,
  // and a bridge that published itself anyway would report empty tools.
  const composition = [
    '- id: llm',
    "  name: '@deepseek-ai/dsh-llm'",
    '- id: session',
    "  name: '@deepseek-ai/dsh-session'",
    '- id: session-projection',
    "  name: '@deepseek-ai/dsh-session-projection'",
    '- id: system-prompt',
    "  name: '@deepseek-ai/dsh-system-prompt'",
    '- id: agent',
    "  name: '@deepseek-ai/dsh-agent'",
    '- id: libre-webui-bridge',
    `  name: ${JSON.stringify(ENGINE_PLUGIN)}`,
    '  config:',
    `    workspacePath: ${JSON.stringify(paths.workspacePath)}`,
  ].join('\n');
  await assert.rejects(
    startHost(paths, composition),
    /did not provide required service/
  );
});

test('stopping the host withdraws services and releases listeners', async () => {
  const paths = await scenario('lifecycle-rollback');
  // This composition mounts no persistence row, so persistence is turned off
  // rather than left to demand a service the test deliberately omitted.
  // No route is named: this composition mounts no adapter on purpose.
  await writeFile(
    paths.settingsPath,
    "features:\n  enabled: true\n  persistence: false\nmodel:\n  provider: none\n  route: ''\n",
    'utf8'
  );
  // A probe row proves rollback of a real plugin, not just of the host's own
  // bookkeeping: its service and its event listener must both stop existing.
  const composition = [
    '- id: test-probe',
    `  name: ${JSON.stringify(FIXTURE_PROBE)}`,
    '- id: llm',
    "  name: '@deepseek-ai/dsh-llm'",
    '- id: session',
    "  name: '@deepseek-ai/dsh-session'",
    '- id: session-projection',
    "  name: '@deepseek-ai/dsh-session-projection'",
    '- id: system-prompt',
    "  name: '@deepseek-ai/dsh-system-prompt'",
    '- id: tools',
    "  name: '@deepseek-ai/dsh-tools'",
    '- id: agent',
    "  name: '@deepseek-ai/dsh-agent'",
    '- id: agent-loop',
    "  name: '@deepseek-ai/dsh-agent-loop'",
    '  config:',
    '    agents: []',
    '- id: libre-webui-bridge',
    `  name: ${JSON.stringify(ENGINE_PLUGIN)}`,
    '  config:',
    `    workspacePath: ${JSON.stringify(paths.workspacePath)}`,
  ].join('\n');

  const log = [];
  globalThis.__cordisProbeLog = log;
  try {
    const host = await startHost(paths, composition);
    const probe = host.context.get(PROBE_SERVICE);
    assert.notEqual(probe, undefined, 'probe service should be mounted');
    assert.deepEqual(log, ['apply']);

    host.context.emit(PROBE_EVENT);
    assert.equal(probe.pings, 1, 'probe listener should observe the event');
    assert.notEqual(host.context.get('libreDshEngine'), undefined);

    await host.stop();

    assert.equal(
      host.context.get(PROBE_SERVICE),
      undefined,
      'probe service should be withdrawn'
    );
    assert.equal(
      host.context.get('libreDshEngine'),
      undefined,
      'engine service should be withdrawn'
    );
    assert.ok(
      log.includes('dispose'),
      `probe teardown should have run, log was ${JSON.stringify(log)}`
    );
    // A listener that survived disposal would still fire on a later emit.
    assert.doesNotThrow(() => host.context.emit(PROBE_EVENT));

    // Teardown is idempotent: a second stop must not throw or re-run cleanup.
    const disposeCount = log.filter(entry => entry === 'dispose').length;
    await host.stop();
    assert.equal(
      log.filter(entry => entry === 'dispose').length,
      disposeCount,
      'a repeated stop should be a no-op'
    );
  } finally {
    delete globalThis.__cordisProbeLog;
  }
});

test('a required service that is missing names the row that never activated', async () => {
  // A row whose dependency is absent stays pending forever rather than failing,
  // so the only clue used to be a list of missing services. Naming the inactive
  // row is what turns "the engine is broken" into a fixable pointer.
  const livePath = path.join(backendDir, 'cordis.patch.yml');
  const previous = await readFile(livePath, 'utf8').catch(() => undefined);
  const paths = await scenario('inactive-row');
  const shipped = await shippedComposition();
  // Tools cannot start without systemPrompt, so disabling it leaves both
  // permanently pending.
  await writeFile(
    livePath,
    shipped.replace(
      "  name: '@deepseek-ai/dsh-system-prompt'",
      "  name: '@deepseek-ai/dsh-system-prompt'\n  disabled: true"
    ),
    'utf8'
  );
  let host;
  try {
    const config = resolveCordisHostConfig({
      configPath: livePath,
      settingsPath: paths.settingsPath,
      workspacePath: paths.workspacePath,
      sessionStorePath: paths.sessionStorePath,
      runtimePath: path.join(paths.dir, 'runtime'),
    });
    await assert.rejects(startCordisHost(config), error => {
      assert.match(error.message, /did not provide required service/);
      assert.match(
        error.message,
        /Row\(s\) that did not activate: system-prompt/
      );
      return true;
    });
  } finally {
    await host?.stop();
    if (previous === undefined) await rm(livePath, { force: true });
    else await writeFile(livePath, previous, 'utf8');
  }
});

test('the host hands the provider capability to the module the row names', async () => {
  // A plugin row is imported by URL while an application imports its own modules
  // by path, and those are separate module instances. A module-level
  // registration therefore reaches only the application's copy, leaving the
  // row's copy without a handler — the row then registers no route and every
  // turn fails with "no adapter". The capability must travel through the host
  // configuration to the module the composition actually names.
  const paths = await scenario('provider-capability');
  await writeSettings(paths, { route: 'test-fake-route' });
  const calls = [];
  const capability = {
    listModels: async () => [],
    resolveModel: async () => undefined,
    defaultModel: async () => 'capability-model',
    stream: async function* () {
      calls.push('streamed');
      yield { type: 'done', reason: 'stop' };
    },
  };
  await writeFile(paths.configPath, await engineComposition(), 'utf8');
  const config = {
    ...resolveCordisHostConfig({
      configPath: paths.configPath,
      settingsPath: paths.settingsPath,
      workspacePath: paths.workspacePath,
      sessionStorePath: paths.sessionStorePath,
      runtimePath: path.join(paths.dir, 'runtime'),
    }),
    providerHandler: capability,
  };
  // No module-level registration: the capability arrives only through config.
  const { registerLibreWebUiProvider } = await distModule(
    'cordis/dsh/librewebui-llm-adapter.js'
  );
  registerLibreWebUiProvider(undefined);
  const host = await startCordisHost(config);
  try {
    const routes = host.context
      .get('llm')
      .listProviders()
      .map(provider => provider.id);
    assert.ok(
      routes.includes('libre-webui'),
      `the adapter row should have registered its route, saw ${routes.join(', ')}`
    );
  } finally {
    await host.stop();
    registerLibreWebUiProvider(undefined);
  }
});

// ── Engine contract integration ──────────────────────────────────────────────

test('engine lists tools the composition registered', async () => {
  const paths = await scenario('integration-tools');
  await writeSettings(paths);
  const host = await startHost(paths, await engineComposition());
  try {
    const engine = host.context.get('libreDshEngine');
    const tools = await engine.listTools();
    const names = tools.map(tool => tool.name);
    // The filesystem tool row is what makes this assertion meaningful: an
    // empty registry would satisfy "returns an array" but not "lists tools".
    for (const expected of ['read', 'write', 'edit']) {
      assert.ok(
        names.includes(expected),
        `expected tool ${expected} in ${names}`
      );
    }
    assert.ok(
      tools.every(tool => typeof tool.description === 'string'),
      'every tool should carry a description string'
    );
  } finally {
    await host.stop();
  }
});

test('engine creates and lists a session before any message', async () => {
  const paths = await scenario('integration-session');
  await writeSettings(paths);
  const host = await startHost(paths, await engineComposition());
  try {
    const engine = host.context.get('libreDshEngine');
    assert.deepEqual(await engine.listSessions(), []);

    const created = await engine.createSession({ cwd: paths.workspacePath });
    // Ids carry a per-engine prefix so two hosts in one process cannot mint the
    // same id; the persistence backend refuses duplicates process-wide.
    assert.match(created.id, /^session-[0-9a-f]{8}-\d+$/);
    assert.equal(created.eventCount, 1);
    assert.equal(created.settings.permissionMode, 'read-only');
    assert.deepEqual(created.messages, []);

    const listed = await engine.listSessions();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, created.id);

    const fetched = await engine.getSession(created.id);
    assert.equal(fetched.id, created.id);
    assert.deepEqual(fetched.messages, []);

    assert.equal(await engine.deleteSession(created.id), true);
    assert.equal(await engine.getSession(created.id), undefined);
    assert.equal(await engine.deleteSession(created.id), false);
  } finally {
    await host.stop();
  }
});

test('engine streams an assistant response for a chat message', async () => {
  const paths = await scenario('integration-chat');
  await writeSettings(paths);
  const host = await startHost(paths, await engineComposition());
  try {
    const engine = host.context.get('libreDshEngine');
    const session = await engine.createSession({ cwd: paths.workspacePath });

    const handle = await engine.sendMessage(session.id, 'Say hello');
    const chunks = await collectStream(handle);

    const text = chunks
      .filter(chunk => chunk.type === 'text')
      .map(chunk => chunk.text)
      .join('');
    assert.equal(text, FAKE_REPLY_TEXT);
    assert.equal(chunks.at(-1).type, 'done', 'the response must terminate');

    // The turn must also be durable, not merely streamed: a client that
    // reconnects reads history rather than replaying a live stream.
    const stored = await engine.getSession(session.id);
    const assistant = stored.messages.filter(m => m.role === 'assistant');
    assert.equal(assistant.length, 1);
    assert.equal(assistant[0].text, FAKE_REPLY_TEXT);
    assert.ok(stored.eventCount > 0);

    const agents = await engine.listAgents();
    assert.deepEqual(
      agents.map(agent => agent.id),
      [session.id]
    );
    assert.equal(agents[0].root, true);
  } finally {
    await host.stop();
  }
});

test('a session keeps the working directory it was created with', async () => {
  const paths = await scenario('integration-session-cwd');
  await writeSettings(paths);
  const host = await startHost(paths, await engineComposition());
  try {
    const engine = host.context.get('libreDshEngine');
    // A cwd chosen at creation must survive until the agent is built on the
    // first message; the agent is what actually records it.
    const custom = path.join(paths.workspacePath, 'custom-workspace');
    await mkdir(custom, { recursive: true });
    const session = await engine.createSession({ cwd: custom });

    const handle = await engine.sendMessage(session.id, 'Say hello');
    await collectStream(handle);

    const stored = await engine.getSession(session.id);
    assert.ok(
      stored.messages.length > 0,
      'the turn should have recorded messages'
    );
    // The agent ran against the requested directory, which is visible in the
    // session's own header through the workspace the engine reports.
    const listed = (await engine.listSessions()).find(s => s.id === session.id);
    assert.notEqual(listed, undefined);
    assert.ok(listed.eventCount > 0);
  } finally {
    await host.stop();
  }
});

test('a session accepts its next turn after a finished reply', async () => {
  // The reply completes while the reader is attached, so the terminal chunk is
  // delivered straight to the listener and never enters the buffer. Inferring
  // "in flight" from the buffer therefore left the session looking busy forever
  // and refused every later message — the user saw one good answer followed by
  // "the engine could not complete the turn".
  const paths = await scenario('second-turn');
  await writeSettings(paths);
  const host = await startHost(paths, await engineComposition());
  try {
    const engine = host.context.get('libreDshEngine');
    const session = await engine.createSession({ cwd: paths.workspacePath });

    const first = [];
    const firstHandle = await engine.sendMessage(session.id, 'first');
    firstHandle.subscribe(chunk => first.push(chunk));
    await waitForTerminal(first);

    const second = [];
    const secondHandle = await engine.sendMessage(session.id, 'second');
    secondHandle.subscribe(chunk => second.push(chunk));
    await waitForTerminal(second);

    const text = second
      .filter(chunk => chunk.type === 'text')
      .map(chunk => chunk.text)
      .join('');
    assert.equal(
      text,
      FAKE_REPLY_TEXT,
      'the second turn must produce its reply'
    );
  } finally {
    await host.stop();
  }
});

test('a turn whose handle is dropped without being read still frees the session', async () => {
  // A reader that goes away leaves a stream nobody reads. Holding the session
  // for it would refuse every later message.
  const paths = await scenario('abandoned-turn');
  await writeSettings(paths);
  const host = await startHost(paths, await engineComposition());
  try {
    const engine = host.context.get('libreDshEngine');
    const session = await engine.createSession({ cwd: paths.workspacePath });
    await engine.sendMessage(session.id, 'abandoned');
    await new Promise(resolve => setTimeout(resolve, 1500));

    const next = [];
    const handle = await engine.sendMessage(session.id, 'next');
    handle.subscribe(chunk => next.push(chunk));
    await waitForTerminal(next);
    assert.equal(next.at(-1)?.type, 'done');
  } finally {
    await host.stop();
  }
});

test('a response that terminated before any reader attached is delivered whole', async () => {
  // A fast model can produce its whole reply, and the engine can mark the
  // response finished, before the HTTP handler subscribes. Draining the buffer
  // when a subscriber arrives therefore delivered the tail of a successful
  // turn and nothing else. Driving the stream directly is what makes that
  // observable: through the bridge the chunks are usually handed to a live
  // listener and never buffered at all.
  const { ResponseStream } = await distModule('cordis/dsh/engine-plugin.js');
  const stream = new ResponseStream('session-buffered');
  stream.push({ type: 'text', text: FAKE_REPLY_TEXT });
  stream.push({ type: 'done', reason: 'completed' });
  stream.close();

  const received = [];
  stream.subscribe(chunk => received.push(chunk));
  const text = received
    .filter(chunk => chunk.type === 'text')
    .map(chunk => chunk.text)
    .join('');
  assert.equal(
    text,
    FAKE_REPLY_TEXT,
    'the whole reply must survive to a late reader'
  );
  assert.equal(received.at(-1)?.type, 'done');
});

test('a second subscriber receives the same response', async () => {
  // Retaining the buffer is what makes a retry or a second reader coherent
  // rather than empty.
  const { ResponseStream } = await distModule('cordis/dsh/engine-plugin.js');
  const stream = new ResponseStream('session-replay');
  stream.push({ type: 'text', text: 'once' });
  stream.push({ type: 'done', reason: 'completed' });
  stream.close();
  const first = [];
  const second = [];
  stream.subscribe(chunk => first.push(chunk));
  stream.subscribe(chunk => second.push(chunk));
  assert.deepEqual(first, second);
  assert.equal(first.length, 2);
});

test('engine rejects a message for an unknown session', async () => {
  const paths = await scenario('integration-unknown-session');
  await writeSettings(paths);
  const host = await startHost(paths, await engineComposition());
  try {
    const engine = host.context.get('libreDshEngine');
    await assert.rejects(
      engine.sendMessage('session-does-not-exist', 'hello'),
      /does not exist/
    );
  } finally {
    await host.stop();
  }
});

// ── Provider reload ──────────────────────────────────────────────────────────

test('the engine keeps serving while its provider row is replaced', async () => {
  // Providers used to be swapped by reloading a package the host mounted. The
  // host mounts none now: the route comes from the composition, so a provider
  // change is a row change, and the engine must survive one. A second row is
  // mounted on its own route to stand in for the replacement, because removing
  // a row inside the composition's Include does not propagate in this Loader
  // version — a limitation of nested removal, noted rather than papered over.
  const paths = await scenario('provider-reload');
  await writeSettings(paths);
  const host = await startHost(paths, await engineComposition());
  try {
    const loader = host.context.get('loader');
    const engine = host.context.get('libreDshEngine');
    const session = await engine.createSession({ cwd: paths.workspacePath });
    const before = host.context
      .get('llm')
      .listProviders()
      .map(provider => provider.id)
      .sort();

    await createLoaderEntryForTest(loader, {
      id: 'replacement-adapter',
      name: FIXTURE_ADAPTER,
      config: { route: 'replacement-route' },
    });
    await loader.await();
    const after = host.context
      .get('llm')
      .listProviders()
      .map(provider => provider.id)
      .sort();
    assert.deepEqual(
      after,
      [...before, 'replacement-route'].sort(),
      'the replacement route registers without disturbing the others'
    );

    // The engine never restarted: the session from before still answers.
    assert.notEqual(await engine.getSession(session.id), undefined);
    const chunks = [];
    const handle = await engine.sendMessage(session.id, 'after reload');
    handle.subscribe(chunk => chunks.push(chunk));
    await waitForTerminal(chunks);
    assert.equal(
      chunks
        .filter(chunk => chunk.type === 'text')
        .map(chunk => chunk.text)
        .join(''),
      FAKE_REPLY_TEXT
    );
  } finally {
    await host.stop();
  }
});

test('a composition with no row for its route fails naming what to add', async () => {
  // The other half of a reload: a routes-less composition must say so at
  // startup rather than fail every turn with "no adapter".
  const paths = await scenario('route-without-row');
  await writeSettings(paths, { route: 'test-fake-route' });
  await writeFile(
    paths.configPath,
    [
      '- id: llm',
      "  name: '@deepseek-ai/dsh-llm'",
      '- id: session',
      "  name: '@deepseek-ai/dsh-session'",
    ].join('\n'),
    'utf8'
  );
  const config = resolveCordisHostConfig({
    configPath: paths.configPath,
    settingsPath: paths.settingsPath,
    workspacePath: paths.workspacePath,
    sessionStorePath: paths.sessionStorePath,
    runtimePath: path.join(paths.dir, 'runtime'),
  });
  await assert.rejects(startCordisHost(config), error => {
    assert.match(error.message, /no adapter for model route "test-fake-route"/);
    return true;
  });
});

// ── Projection helpers ───────────────────────────────────────────────────────

test('session events project onto the contract stream vocabulary', () => {
  assert.deepEqual(
    projectStreamEvent({
      type: 'assistant/message',
      data: {
        message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
      },
    }),
    { type: 'text', text: 'hi' }
  );
  assert.deepEqual(
    projectStreamEvent({
      type: 'tool/call',
      data: { callId: 'c1', name: 'read' },
    }),
    { type: 'tool-call', callId: 'c1', name: 'read' }
  );
  // Identity lives on the result message, and the failure identity is the only
  // place a tool name appears on a result event.
  assert.deepEqual(
    projectStreamEvent({
      type: 'tool/result',
      data: {
        message: {
          toolCallId: 'c1',
          content: [{ type: 'text', text: 'ok' }],
          isError: true,
        },
        error: { name: 'read', code: 'X' },
      },
    }),
    { type: 'tool-result', callId: 'c1', name: 'read', isError: true }
  );
  assert.deepEqual(
    projectStreamEvent({
      type: 'turn/end',
      data: { reason: { kind: 'stop' } },
    }),
    { type: 'done', reason: 'stop' }
  );
  // A failed turn carries its reason, which the projector must lift out rather
  // than collapse into an unknown status.
  assert.deepEqual(
    projectTurnFailure({
      type: 'turn/end',
      data: {
        reason: {
          kind: 'error',
          error: { message: 'provider unreachable', code: 'ECONNREFUSED' },
        },
      },
    }),
    { type: 'error', message: 'provider unreachable', code: 'ECONNREFUSED' }
  );
  // Events with nothing to show a chat client contribute no chunk.
  assert.equal(projectStreamEvent({ type: 'step/start', data: {} }), undefined);
  assert.equal(
    projectStreamEvent({
      type: 'assistant/message',
      data: { message: { role: 'assistant', content: [] } },
    }),
    undefined
  );
});

test('message text extraction reads text blocks and ignores the rest', () => {
  assert.equal(
    extractText([
      { type: 'text', text: 'a' },
      { type: 'image', source: 'x' },
      { type: 'text', text: 'b' },
    ]),
    'ab'
  );
  assert.equal(extractText('plain'), 'plain');
  assert.equal(extractText(undefined), '');
});

test('persistent sessions survive restart, resume, and are physically deleted', async () => {
  const paths = await scenario('durable-restart');
  await writeSettings(paths);
  let host = await startHost(paths, await engineComposition());
  try {
    let engine = host.context.get('libreDshEngine');
    const session = await engine.createSession({ cwd: paths.workspacePath });
    await collectStream(
      await engine.sendMessage(session.id, 'first durable turn')
    );
    await host.stop();
    host = await startHost(paths, await engineComposition());
    engine = host.context.get('libreDshEngine');
    assert.ok(
      (await engine.listSessions()).some(item => item.id === session.id)
    );
    assert.ok(
      (await engine.getSession(session.id)).messages.some(
        message => message.text === 'first durable turn'
      )
    );
    await collectStream(
      await engine.sendMessage(session.id, 'second durable turn')
    );
    assert.equal(
      (await engine.getSession(session.id)).messages.filter(
        message => message.role === 'assistant'
      ).length,
      2
    );
    assert.equal(await engine.deleteSession(session.id), true);
    assert.equal(
      await host.context.get('sessionPersistence').stat(session.id),
      undefined
    );
    assert.equal(await engine.getSession(session.id), undefined);
    await host.stop();
    host = await startHost(paths, await engineComposition());
    assert.deepEqual(
      await host.context.get('libreDshEngine').listSessions(),
      []
    );
  } finally {
    await host.stop();
  }
});

test('an empty persistent session survives restart and accepts its first turn', async () => {
  const paths = await scenario('empty-restart');
  await writeSettings(paths);
  let host = await startHost(paths, await engineComposition());
  try {
    const session = await host.context
      .get('libreDshEngine')
      .createSession({ cwd: paths.workspacePath });
    await host.stop();
    host = await startHost(paths, await engineComposition());
    const engine = host.context.get('libreDshEngine');
    assert.deepEqual((await engine.getSession(session.id)).messages, []);
    await collectStream(await engine.sendMessage(session.id, 'first'));
  } finally {
    await host.stop();
  }
});

test('workspace containment rejects traversal and symlinks, including resumed sessions', async () => {
  const paths = await scenario('containment');
  await writeSettings(paths);
  const host = await startHost(paths, await engineComposition());
  try {
    const engine = host.context.get('libreDshEngine');
    const outside = path.join(paths.dir, 'outside');
    await mkdir(outside);
    await symlink(outside, path.join(paths.workspacePath, 'escape'));
    await assert.rejects(
      engine.createSession({ cwd: outside }),
      /inside the configured/
    );
    await assert.rejects(
      engine.createSession({ cwd: path.join(paths.workspacePath, 'escape') }),
      /inside the configured/
    );
    const child = path.join(paths.workspacePath, 'child');
    await mkdir(child);
    const session = await engine.createSession({ cwd: child });
    await rm(child, { recursive: true });
    await assert.rejects(
      engine.sendMessage(session.id, 'failed start'),
      /ENOENT/
    );
    await mkdir(child);
    await collectStream(
      await engine.sendMessage(session.id, 'retry after failed start')
    );
    assert.ok(
      (await engine.getSession(session.id)).messages.some(
        message => message.text === 'retry after failed start'
      )
    );
  } finally {
    await host.stop();
  }
});

test('settings paths and feature flags control the mounted composition', async () => {
  const paths = await scenario('settings-authority');
  await writeSettings(paths);
  const config = resolveCordisHostConfig({
    configPath: paths.configPath,
    settingsPath: paths.settingsPath,
    workspacePath: paths.workspacePath,
    sessionStorePath: paths.sessionStorePath,
  });
  await writeFile(paths.configPath, await engineComposition());
  await installStubProvider();
  const host = await startCordisHost({
    ...config,
    features: {
      ...config.features,
      persistence: false,
      tools: false,
      streaming: false,
    },
  });
  try {
    const engine = host.context.get('libreDshEngine');
    assert.equal(host.context.get('sessionPersistence'), undefined);
    assert.deepEqual(await engine.listTools(), []);
    const session = await engine.createSession({ cwd: '' });
    await assert.rejects(
      engine.sendMessage(session.id, 'blocked'),
      /streaming is disabled/
    );
    assert.deepEqual(await readdir(paths.sessionStorePath), []);
  } finally {
    await host.stop();
  }
});

test('transient sessions stay out of console listings and are deleted from disk', async () => {
  const paths = await scenario('transient');
  await writeSettings(paths);
  const host = await startHost(paths, await engineComposition());
  try {
    const engine = host.context.get('libreDshEngine');
    const session = await engine.createSession({ cwd: '', transient: true });
    await collectStream(
      await engine.sendMessage(session.id, 'chat context', { userId: 'caller' })
    );
    assert.deepEqual(await engine.listSessions(), []);
    assert.equal(await engine.deleteSession(session.id), true);
    assert.equal(
      await host.context.get('sessionPersistence').stat(session.id),
      undefined
    );
  } finally {
    await host.stop();
  }
});

/** A gated model proves live frames arrive before the durable assistant message. */
async function gatedComposition(paths) {
  const file = path.join(paths.dir, 'gated-adapter.mjs');
  const llm = pathToFileURL(
    path.join(repoRoot, 'node_modules/@deepseek-ai/dsh-llm/lib/index.js')
  ).href;
  await writeFile(
    file,
    `
    import { LlmAdapter } from ${JSON.stringify(llm)};
    export const inject = ['llm'];
    class Adapter extends LlmAdapter {
      async *stream(options) {
        const control = globalThis.__cordisGated;
        const name = options.sessionId;
        yield { type: 'block-start', index: 0, blockType: 'reasoning' };
        yield { type: 'reasoning-delta', index: 0, text: 'thinking-' + name };
        yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'thinking-' + name } };
        yield { type: 'block-start', index: 1, blockType: 'text' };
        yield { type: 'text-delta', index: 1, text: name + '-first' };
        await new Promise((resolve, reject) => {
          control.set(name, resolve);
          options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
        });
        yield { type: 'text-delta', index: 1, text: '-second' };
        yield { type: 'block-end', index: 1, block: { type: 'text', text: name + '-first-second' } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      }
    }
    export function apply(ctx) {
      ctx.effect(() => ctx.llm.registerAdapter(['test-fake-route'], new Adapter()));
    }
  `
  );
  return (await engineComposition()).replace(
    JSON.stringify(FIXTURE_ADAPTER),
    JSON.stringify(pathToFileURL(file).href)
  );
}

async function waitUntil(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw new Error('Timed out waiting for the gated model.');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test('concurrent sessions receive their own live text and reasoning without final duplication', async () => {
  const paths = await scenario('live-concurrent');
  await writeSettings(paths);
  globalThis.__cordisGated = new Map();
  const host = await startHost(paths, await gatedComposition(paths));
  try {
    const engine = host.context.get('libreDshEngine');
    const sessions = await Promise.all([
      engine.createSession({ cwd: '' }),
      engine.createSession({ cwd: '' }),
    ]);
    const chunks = [[], []];
    const handles = await Promise.all(
      sessions.map((session, index) =>
        engine.sendMessage(session.id, 'run', { userId: 'user-' + index })
      )
    );
    handles.forEach((handle, index) =>
      handle.subscribe(chunk => chunks[index].push(chunk))
    );
    await waitUntil(
      () =>
        globalThis.__cordisGated.size === 2 &&
        chunks.every(list => list.some(chunk => chunk.type === 'text'))
    );
    sessions.forEach((session, index) => {
      assert.equal(engine.requestUserId(session.id), 'user-' + index);
      assert.deepEqual(
        chunks[index]
          .filter(chunk => chunk.type === 'text')
          .map(chunk => chunk.text),
        [session.id + '-first']
      );
      assert.equal(
        chunks[index].some(chunk => chunk.type === 'done'),
        false
      );
      globalThis.__cordisGated.get(session.id)();
    });
    await Promise.all(chunks.map(list => waitForTerminal(list)));
    for (const [index, session] of sessions.entries()) {
      assert.equal(
        chunks[index]
          .filter(chunk => chunk.type === 'text')
          .map(chunk => chunk.text)
          .join(''),
        session.id + '-first-second'
      );
      assert.equal(
        chunks[index]
          .filter(chunk => chunk.type === 'reasoning')
          .map(chunk => chunk.text)
          .join(''),
        'thinking-' + session.id
      );
      assert.equal(
        (await engine.getSession(session.id)).messages.find(
          message => message.role === 'assistant'
        ).reasoning,
        'thinking-' + session.id
      );
      assert.equal(engine.requestUserId(session.id), undefined);
    }
  } finally {
    await host.stop();
    delete globalThis.__cordisGated;
  }
});

test('cancel aborts the provider and frees a session for a resumed turn', async () => {
  const paths = await scenario('cancel-live');
  await writeSettings(paths);
  globalThis.__cordisGated = new Map();
  const host = await startHost(paths, await gatedComposition(paths));
  try {
    const engine = host.context.get('libreDshEngine');
    const session = await engine.createSession({ cwd: '' });
    const chunks = [];
    (await engine.sendMessage(session.id, 'cancel me')).subscribe(chunk =>
      chunks.push(chunk)
    );
    await waitUntil(() => globalThis.__cordisGated.has(session.id));
    assert.equal(await engine.cancel(session.id), true);
    assert.equal(chunks.at(-1).type, 'done');
    assert.equal(chunks.at(-1).interrupted, true);
    globalThis.__cordisGated.delete(session.id);
    const next = collectStream(await engine.sendMessage(session.id, 'resume'));
    await waitUntil(() => globalThis.__cordisGated.has(session.id));
    globalThis.__cordisGated.get(session.id)();
    assert.equal((await next).at(-1).type, 'done');
  } finally {
    await host.stop();
    delete globalThis.__cordisGated;
  }
});

test('disabled tools are absent from agent prompts and denied at dispatch', async () => {
  const paths = await scenario('tools-disabled');
  await writeSettings(paths);
  await installStubProvider();
  await writeFile(paths.configPath, await engineComposition());
  const config = resolveCordisHostConfig({
    configPath: paths.configPath,
    settingsPath: paths.settingsPath,
    workspacePath: paths.workspacePath,
    sessionStorePath: paths.sessionStorePath,
  });
  const host = await startCordisHost({
    ...config,
    features: { ...config.features, tools: false },
  });
  try {
    const engine = host.context.get('libreDshEngine');
    const session = await engine.createSession({ cwd: '' });
    let modelCalled = false;
    let advertised;
    host.context.on('llm/stream', (request, next) => {
      modelCalled = true;
      advertised = request.tools;
      return next();
    });
    await collectStream(await engine.sendMessage(session.id, 'no tools'));
    const agent = host.context.get('agents').get(session.id);
    assert.deepEqual(agent.ctx.tools.schemas(agent), []);
    assert.equal(modelCalled, true);
    assert.deepEqual(advertised ?? [], []);
    const result = await agent.ctx.tools.execute({
      callId: 'blocked-call',
      name: 'read',
      arguments: { path: 'private' },
      agent,
      signal: new AbortController().signal,
    });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result), /disabled|UNKNOWN_TOOL|unknown tool/i);
  } finally {
    await host.stop();
  }
});

test('response buffer overflow terminates explicitly and cancels its producer', async () => {
  const { ResponseStream } = await distModule('cordis/dsh/engine-plugin.js');
  let cancelled = 0;
  const stream = new ResponseStream('bounded', () => {
    cancelled += 1;
  });
  stream.push({ type: 'text', text: 'x'.repeat(2 * 1024 * 1024 + 1) });
  const chunks = [];
  stream.subscribe(chunk => chunks.push(chunk));
  assert.equal(cancelled, 1);
  assert.deepEqual(
    chunks.map(chunk => chunk.type),
    ['error', 'done']
  );
  assert.equal(chunks[0].code, 'CORDIS_STREAM_LIMIT');
  assert.equal(stream.isTerminated, true);
  assert.ok(stream.pending <= 2);
});

test('stop during startup disposes the candidate instead of resurrecting the host', async () => {
  const paths = await scenario('startup-stop');
  await writeSettings(paths, { model: '' });
  await installStubProvider();
  await writeFile(paths.configPath, await engineComposition());
  const runtime = await distModule('cordis/runtime.js');
  const { setEngineDefaultModelResolver } = await distModule(
    'cordis/host/host.js'
  );
  let entered;
  const ready = new Promise(resolve => {
    entered = resolve;
  });
  let release;
  const gate = new Promise(resolve => {
    release = resolve;
  });
  setEngineDefaultModelResolver(() => {
    entered();
    return gate;
  });
  runtime.configureCordisRuntime({
    configPath: paths.configPath,
    settingsPath: paths.settingsPath,
    workspacePath: paths.workspacePath,
    sessionStorePath: paths.sessionStorePath,
    features: {
      enabled: true,
      streaming: true,
      tools: true,
      persistence: true,
    },
  });
  try {
    const starting = runtime.ensureCordisHost();
    await ready;
    const stopping = runtime.stopCordisHost();
    release('test-model');
    await Promise.all([starting, stopping]);
    assert.equal(runtime.cordisHost(), undefined);
  } finally {
    release('test-model');
    await runtime.stopCordisHost();
    runtime.configureCordisRuntime(undefined);
    setEngineDefaultModelResolver(undefined);
  }
});

test('runtime overrides retain resolved workspace paths instead of restoring blank inputs', async () => {
  const paths = await scenario('runtime-path-normalization');
  const runtime = await distModule('cordis/runtime.js');
  const names = ['LIBRE_CORDIS_WORKSPACE', 'LIBRE_CORDIS_SESSION_STORE'];
  const previous = names.map(name => process.env[name]);
  try {
    names.forEach(name => delete process.env[name]);
    runtime.configureCordisRuntime({
      configPath: paths.configPath,
      settingsPath: paths.settingsPath,
      workspacePath: '',
      sessionStorePath: ' ',
      trace: true,
    });
    const defaults = runtime.cordisRuntimeConfig();
    assert.equal(
      defaults.workspacePath,
      path.join(paths.dataDir, 'cordis-workspace')
    );
    assert.equal(
      defaults.sessionStorePath,
      path.join(paths.dataDir, 'cordis-sessions')
    );
    assert.equal(defaults.trace, true);
    runtime.configureCordisRuntime({
      configPath: path.relative(process.cwd(), paths.configPath),
      settingsPath: path.relative(process.cwd(), paths.settingsPath),
      workspacePath: './explicit-workspace',
      sessionStorePath: './explicit-sessions',
    });
    const explicit = runtime.cordisRuntimeConfig();
    assert.equal(explicit.configPath, paths.configPath);
    assert.equal(explicit.settingsPath, paths.settingsPath);
    assert.equal(explicit.workspacePath, path.resolve('explicit-workspace'));
    assert.equal(explicit.sessionStorePath, path.resolve('explicit-sessions'));
  } finally {
    runtime.configureCordisRuntime(undefined);
    names.forEach((name, index) => restoreEnv(name, previous[index]));
  }
});

test('team profile refuses the local-only host before mounting any plugin', async () => {
  const paths = await scenario('team-rejected');
  await writeSettings(paths);
  const previous = process.env.LIBRE_PLATFORM_MODE;
  process.env.LIBRE_PLATFORM_MODE = ' TEAM ';
  try {
    const config = resolveCordisHostConfig({
      configPath: paths.configPath,
      settingsPath: paths.settingsPath,
    });
    await assert.rejects(
      startCordisHost(config),
      /single-replica solo profile/
    );
  } finally {
    restoreEnv('LIBRE_PLATFORM_MODE', previous);
  }
});

test('native DSH tool result blocks retain correlation, error state, and readable transcript text', async () => {
  const { projectMessage } = await distModule('cordis/dsh/engine-plugin.js');
  const message = {
    id: 'tool-message',
    role: 'user',
    source: { kind: 'tool', callId: 'call-123' },
    content: [
      {
        type: 'tool-result',
        toolCallId: 'call-123',
        isError: true,
        content: [{ type: 'text', text: 'permission denied' }],
      },
    ],
  };
  assert.deepEqual(
    projectStreamEvent({ type: 'tool/result', data: { message } }),
    {
      type: 'tool-result',
      callId: 'call-123',
      name: '',
      isError: true,
      output: 'permission denied',
    }
  );
  assert.deepEqual(projectMessage(message, 0), {
    id: 'tool-message',
    role: 'tool',
    text: 'permission denied',
    source: 'tool',
    toolResults: [
      { callId: 'call-123', output: 'permission denied', isError: true },
    ],
  });
});

test('a corrupt legacy message body can be deleted without weakening transcript validation', async () => {
  const paths = await scenario('delete-corrupt-body');
  await writeSettings(paths);
  const entries = parseComposition(await engineComposition());
  entries.find(entry => entry.id === 'session-persistence').config = {
    compression: 'none',
  };
  const composition = stringifyComposition(entries);
  let host = await startHost(paths, composition);
  try {
    let engine = host.context.get('libreDshEngine');
    const session = await engine.createSession({ cwd: '' });
    await collectStream(
      await engine.sendMessage(session.id, 'valid first turn')
    );
    await host.stop();
    const files = await readdir(paths.sessionStorePath, { recursive: true });
    const artifact = path.join(
      paths.sessionStorePath,
      files.find(file => file.endsWith('.jsonl'))
    );
    const rows = (await readFile(artifact, 'utf8'))
      .trimEnd()
      .split('\n')
      .map(line => JSON.parse(line));
    const userMessage = rows.find(row => row.type === 'user/message');
    assert.ok(
      userMessage,
      'the fixture must contain a real persisted user message'
    );
    // Reproduce only the released bridge's malformed message body; its valid
    // session header and artifact location remain untouched.
    delete userMessage.data.id;
    delete userMessage.data.source;
    await writeFile(
      artifact,
      rows.map(row => JSON.stringify(row)).join('\n') + '\n'
    );
    host = await startHost(paths, composition);
    engine = host.context.get('libreDshEngine');
    assert.ok(
      (await engine.listSessions()).some(value => value.id === session.id)
    );
    await assert.rejects(
      engine.getSession(session.id),
      error => error.name === 'SessionPersistenceCorruptionError'
    );
    assert.equal(await engine.deleteSession(session.id), true);
    assert.equal(
      await host.context.get('sessionPersistence').stat(session.id),
      undefined
    );
    await assert.rejects(readFile(artifact), error => error.code === 'ENOENT');
    assert.equal(await engine.getSession(session.id), undefined);
    assert.equal(await engine.deleteSession(session.id), false);
  } finally {
    await host.stop();
  }
});

async function controlsComposition(
  paths,
  { target, escalation, configuredMode } = {}
) {
  const file = path.join(paths.dir, 'controls-adapter.mjs');
  const llm = pathToFileURL(
    path.join(repoRoot, 'node_modules/@deepseek-ai/dsh-llm/lib/index.js')
  ).href;
  await writeFile(
    file,
    `
    import { LlmAdapter } from ${JSON.stringify(llm)};
    export const inject = ['llm'];
    class Adapter extends LlmAdapter {
      async *stream(options) {
        globalThis.__cordisControlModels?.push(options.model);
        if (globalThis.__cordisUnavailableModel === options.model) throw new Error('selected provider unavailable');
        const target = ${JSON.stringify(target ?? null)};
        const escalation = ${JSON.stringify(escalation ?? null)};
        const hasResult = options.messages.some(message => message.source?.kind === 'tool');
        if (target && !hasResult) {
          const args = JSON.stringify({ file_path: target, content: 'native tool output', ...(escalation ? { sandbox_permissions: escalation, justification: 'Write the exact requested workspace file.' } : {}) });
          yield { type: 'block-start', index: 0, blockType: 'tool-call' };
          yield { type: 'tool-call-delta', index: 0, id: 'controls-write', name: 'write', argumentsDelta: args };
          yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'controls-write', name: 'write', arguments: args } };
          yield { type: 'finish', reason: { kind: 'tool-calls' } };
        } else {
          yield { type: 'block-start', index: 0, blockType: 'text' };
          yield { type: 'text-delta', index: 0, text: 'finished' };
          yield { type: 'block-end', index: 0, block: { type: 'text', text: 'finished' } };
          yield { type: 'finish', reason: { kind: 'stop' } };
        }
      }
    }
    export function apply(ctx) { ctx.effect(() => ctx.llm.registerAdapter(['test-fake-route'], new Adapter())); }
  `
  );
  const entries = parseComposition(
    (await engineComposition()).replace(
      JSON.stringify(FIXTURE_ADAPTER),
      JSON.stringify(pathToFileURL(file).href)
    )
  );
  if (configuredMode)
    entries.find(entry => entry.id === 'sandbox-policy').config = {
      mode: configuredMode,
    };
  return stringifyComposition(entries);
}

test('session model and permission selections persist before a first prompt and change the resumed native agent', async () => {
  const paths = await scenario('controls-persistence');
  await writeSettings(paths);
  const composition = await controlsComposition(paths);
  globalThis.__cordisControlModels = [];
  let host = await startHost(paths, composition);
  try {
    let engine = host.context.get('libreDshEngine');
    const created = await engine.createSession({
      cwd: '',
      model: 'initial-model',
      permissionMode: 'read-only',
    });
    await engine.updateSessionSettings(created.id, {
      model: 'selected-model',
      permissionMode: 'workspace-write',
    });
    await host.stop();
    host = await startHost(paths, composition);
    engine = host.context.get('libreDshEngine');
    assert.deepEqual((await engine.getSession(created.id)).settings, {
      model: 'selected-model',
      permissionMode: 'workspace-write',
    });
    await collectStream(
      await engine.sendMessage(created.id, 'use the selected model')
    );
    assert.equal(globalThis.__cordisControlModels.at(-1), 'selected-model');
    assert.equal(
      host.context
        .get('sandboxPolicy')
        .resolve({ session: host.context.get('sessions').get(created.id) })
        .mode,
      'workspace-write'
    );
    await engine.updateSessionSettings(created.id, {
      model: 'changed-model',
      permissionMode: 'read-only',
    });
    await collectStream(
      await engine.sendMessage(
        created.id,
        'continue under the changed selection'
      )
    );
    assert.equal(globalThis.__cordisControlModels.at(-1), 'changed-model');
    const detail = await engine.getSession(created.id);
    assert.equal(detail.settings.permissionMode, 'read-only');
    assert.ok(detail.messages.some(message => message.source === 'context'));
    assert.equal(detail.title, 'use the selected model');
    await assert.rejects(
      engine.updateSessionSettings(created.id, {
        model: 'persona:not-a-provider',
      }),
      /provider model/
    );
    await assert.rejects(
      engine.updateSessionSettings(created.id, {
        permissionMode: 'danger-full-access',
      }),
      /read-only or workspace-write/
    );
  } finally {
    await host.stop();
    delete globalThis.__cordisControlModels;
  }
});

test('native one-shot approval performs only the reviewed workspace operation and preserves read-only mode', async () => {
  const paths = await scenario('controls-approval-allow');
  await writeSettings(paths);
  const target = path.join(paths.workspacePath, 'approved.txt');
  const host = await startHost(
    paths,
    await controlsComposition(paths, { target, escalation: 'workspace-write' })
  );
  try {
    const engine = host.context.get('libreDshEngine');
    const session = await engine.createSession({ cwd: '' });
    assert.equal(session.capabilities.approvals, true);
    const chunks = [];
    (await engine.sendMessage(session.id, 'write the reviewed file')).subscribe(
      chunk => chunks.push(chunk)
    );
    await waitUntil(() =>
      chunks.some(chunk => chunk.type === 'approval-request')
    );
    const approval = chunks.find(
      chunk => chunk.type === 'approval-request'
    ).approval;
    assert.equal(approval.callId, 'controls-write');
    assert.equal(
      (await engine.getSession(session.id)).approvals[0].id,
      approval.id
    );
    await assert.rejects(
      engine.updateSessionSettings(session.id, {
        permissionMode: 'workspace-write',
      }),
      /active/
    );
    assert.equal(
      await engine.decideApproval(
        'another-session',
        approval.id,
        'allowed-once'
      ),
      false
    );
    assert.equal(
      await engine.decideApproval(session.id, approval.id, 'allowed-once'),
      true
    );
    assert.equal(
      await engine.decideApproval(session.id, approval.id, 'allowed-once'),
      false
    );
    await waitForTerminal(chunks);
    assert.equal(await readFile(target, 'utf8'), 'native tool output');
    assert.ok(
      chunks.some(
        chunk =>
          chunk.type === 'approval-decision' && chunk.outcome === 'allowed-once'
      )
    );
    const detail = await engine.getSession(session.id);
    assert.equal(detail.settings.permissionMode, 'read-only');
    assert.deepEqual(detail.approvals, []);
    assert.ok(
      detail.messages.some(message =>
        message.toolCalls?.some(
          call =>
            call.callId === 'controls-write' &&
            call.arguments.includes('approved.txt')
        )
      )
    );
    assert.ok(
      detail.messages.some(message =>
        message.toolResults?.some(
          result => result.callId === 'controls-write' && !result.isError
        )
      )
    );
  } finally {
    await host.stop();
  }
});

test('native approval rejection and cancellation never write files and drain their pending questions', async () => {
  for (const action of ['rejected', 'cancelled']) {
    const paths = await scenario('controls-approval-' + action);
    await writeSettings(paths);
    const target = path.join(paths.workspacePath, 'blocked.txt');
    const host = await startHost(
      paths,
      await controlsComposition(paths, {
        target,
        escalation: 'workspace-write',
      })
    );
    try {
      const engine = host.context.get('libreDshEngine');
      const session = await engine.createSession({ cwd: '' });
      const chunks = [];
      (await engine.sendMessage(session.id, 'request a write')).subscribe(
        chunk => chunks.push(chunk)
      );
      await waitUntil(() =>
        chunks.some(chunk => chunk.type === 'approval-request')
      );
      const approval = chunks.find(
        chunk => chunk.type === 'approval-request'
      ).approval;
      if (action === 'rejected')
        await engine.decideApproval(session.id, approval.id, 'rejected');
      else await engine.cancel(session.id);
      await waitForTerminal(chunks);
      await assert.rejects(readFile(target), error => error.code === 'ENOENT');
      assert.deepEqual((await engine.getSession(session.id)).approvals, []);
      assert.ok(
        chunks.some(
          chunk =>
            chunk.type === 'approval-decision' && chunk.outcome === action
        )
      );
    } finally {
      await host.stop();
    }
  }
});

test('workspace-write is functional while unrestricted defaults and headless approvals fail closed', async () => {
  for (const mode of ['workspace-write', 'danger-default', 'headless']) {
    const paths = await scenario('controls-mode-' + mode);
    await writeSettings(paths);
    const target = path.join(paths.workspacePath, 'mode.txt');
    const composition = await controlsComposition(paths, {
      target,
      ...(mode === 'headless' ? { escalation: 'workspace-write' } : {}),
      ...(mode === 'danger-default'
        ? { configuredMode: 'danger-full-access' }
        : {}),
    });
    const host = await startHost(paths, composition);
    try {
      const engine = host.context.get('libreDshEngine');
      const session = await engine.createSession({
        cwd: '',
        ...(mode === 'workspace-write' ? { permissionMode: mode } : {}),
        transient: mode === 'headless',
      });
      const chunks = await collectStream(
        await engine.sendMessage(session.id, 'write if permitted')
      );
      assert.equal(
        chunks.some(chunk => chunk.type === 'approval-request'),
        false
      );
      if (mode === 'workspace-write')
        assert.equal(await readFile(target, 'utf8'), 'native tool output');
      else
        await assert.rejects(
          readFile(target),
          error => error.code === 'ENOENT'
        );
      assert.equal(
        host.context
          .get('sandboxPolicy')
          .resolve({ session: host.context.get('sessions').get(session.id) })
          .mode,
        mode === 'workspace-write' ? mode : 'read-only'
      );
    } finally {
      await host.stop();
    }
  }
});

test('legacy raw and qualified persona headers recover on restart and follow-up without changing history', async () => {
  for (const legacyModel of [
    'persona:old-persona',
    'lwui:ollama:persona%3Aold-persona',
    'lwui:plugin:malformed',
  ]) {
    const paths = await scenario('legacy-model-fallback');
    await writeSettings(paths);
    const rows = parseComposition(await controlsComposition(paths));
    rows.find(row => row.id === 'session-persistence').config = {
      compression: 'none',
    };
    const composition = stringifyComposition(rows);
    globalThis.__cordisControlModels = [];
    let host = await startHost(paths, composition);
    try {
      let engine = host.context.get('libreDshEngine');
      const created = await engine.createSession({ cwd: '' });
      await collectStream(
        await engine.sendMessage(created.id, 'preserve this conversation')
      );
      await host.stop();
      const files = await readdir(paths.sessionStorePath, { recursive: true });
      const artifact = path.join(
        paths.sessionStorePath,
        files.find(file => file.endsWith('.jsonl'))
      );
      const log = (await readFile(artifact, 'utf8'))
        .trimEnd()
        .split('\n')
        .map(line => JSON.parse(line));
      const header = log.find(row => row.type === 'request/header');
      assert.ok(header);
      header.data.header.config.model = legacyModel;
      await writeFile(
        artifact,
        log.map(row => JSON.stringify(row)).join('\n') + '\n'
      );
      await writeSettings(paths, { model: 'current-real-model' });
      host = await startHost(paths, composition);
      engine = host.context.get('libreDshEngine');
      assert.equal(
        (await engine.getSession(created.id)).settings.model,
        undefined
      );
      assert.ok(
        (await engine.getSession(created.id)).messages.some(
          message => message.text === 'preserve this conversation'
        )
      );
      await collectStream(
        await engine.sendMessage(created.id, 'continue the same session')
      );
      assert.equal(
        globalThis.__cordisControlModels.at(-1),
        'current-real-model'
      );
      assert.ok(
        host.context
          .get('sessions')
          .get(created.id)
          .snapshotEvents()
          .some(
            event =>
              event.type === 'request/header' &&
              event.data.header.config.model === legacyModel
          ),
        'historical request metadata must remain unchanged'
      );
    } finally {
      await host.stop();
      delete globalThis.__cordisControlModels;
    }
  }
});

test('explicit unavailable real routes stay pinned while new pseudo or malformed selections are rejected', async () => {
  const paths = await scenario('model-identity-validation');
  await writeSettings(paths);
  const composition = await controlsComposition(paths);
  let host = await startHost(paths, composition);
  const selected = 'lwui:plugin:offline-provider:real-model';
  globalThis.__cordisControlModels = [];
  globalThis.__cordisUnavailableModel = selected;
  try {
    let engine = host.context.get('libreDshEngine');
    const session = await engine.createSession({ cwd: '', model: selected });
    for (const model of [
      'persona:old',
      'lwui:ollama:persona%3Aold',
      'lwui:plugin:provider:agent%3Adsh',
      'lwui:ollama:%',
      'lwui:plugin::real-model',
    ]) {
      await assert.rejects(
        engine.updateSessionSettings(session.id, { model }),
        /available provider model/
      );
    }
    await host.stop();
    host = await startHost(paths, composition);
    engine = host.context.get('libreDshEngine');
    assert.equal(
      (await engine.getSession(session.id)).settings.model,
      selected
    );
    const chunks = await collectStream(
      await engine.sendMessage(session.id, 'keep the selected provider')
    );
    assert.ok(chunks.some(chunk => chunk.type === 'error'));
    assert.deepEqual(globalThis.__cordisControlModels, [selected]);
    assert.equal(
      (await engine.getSession(session.id)).settings.model,
      selected
    );
  } finally {
    await host.stop();
    delete globalThis.__cordisControlModels;
    delete globalThis.__cordisUnavailableModel;
  }
});

test('cancelling an in-memory turn retains its transcript for follow-up and explicit deletion', async () => {
  const paths = await scenario('ephemeral-cancel-history');
  await writeSettings(paths);
  await writeFile(
    paths.settingsPath,
    (await readFile(paths.settingsPath, 'utf8')).replace(
      '  enabled: true',
      '  enabled: true\n  persistence: false'
    )
  );
  globalThis.__cordisGated = new Map();
  const host = await startHost(paths, await gatedComposition(paths));
  try {
    const engine = host.context.get('libreDshEngine');
    const session = await engine.createSession({ cwd: '' });
    const chunks = [];
    (
      await engine.sendMessage(session.id, 'retain this cancelled turn')
    ).subscribe(chunk => chunks.push(chunk));
    await waitUntil(() => globalThis.__cordisGated.has(session.id));
    assert.equal(await engine.cancel(session.id), true);
    assert.equal(chunks.at(-1).type, 'done');
    assert.equal(chunks.at(-1).interrupted, true);
    const cancelled = await engine.getSession(session.id);
    assert.ok(
      cancelled.messages.some(
        message => message.text === 'retain this cancelled turn'
      )
    );
    assert.equal(cancelled.active, false);
    globalThis.__cordisGated.delete(session.id);
    const next = collectStream(
      await engine.sendMessage(
        session.id,
        'continue the same in-memory session'
      )
    );
    await waitUntil(() => globalThis.__cordisGated.has(session.id));
    globalThis.__cordisGated.get(session.id)();
    await next;
    assert.equal(
      (await engine.getSession(session.id)).messages.filter(
        message => message.source === 'user'
      ).length,
      2
    );
    // An idle cancel is also harmless; deletion remains the explicit operation
    // that disposes the in-memory session after its agent has drained.
    await engine.cancel(session.id);
    assert.ok(await engine.getSession(session.id));
    assert.equal(await engine.deleteSession(session.id), true);
    assert.equal(await engine.getSession(session.id), undefined);
  } finally {
    await host.stop();
    delete globalThis.__cordisGated;
  }
});
