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
 * The embedded DSH engine as an agent in Libre WebUI's own pipeline.
 *
 * Claude Code, Codex, OpenCode, and Pi are agents an administrator can pick in
 * Chat: the pipeline resolves the selection to `agentCliService`, and the
 * agent answers by streaming chunks back. The embedded engine joins that set,
 * with one structural difference — it is a library rather than an executable,
 * so there is no binary to find on PATH and no stdout to parse. Its
 * availability is decided by whether the engine is enabled, and its turns
 * arrive as Cordis streams.
 *
 * This suite covers that difference: the selector entry appears exactly when
 * the engine is enabled, and a turn reaches the caller through the same
 * function the CLI agents use.
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
const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'libre-cordis-agent-'));

process.env.DATA_DIR = path.join(tempRoot, 'data');
process.env.ENCRYPTION_KEY = '3'.repeat(64);
process.env.JWT_SECRET = 'cordis-agent-test-secret-value';
// Enable CLI models independently; each scenario controls the DSH opt-in.
process.env.AGENT_CLI_MODELS_ENABLED = 'true';

const importBuilt = relativePath =>
  import(pathToFileURL(path.join(backendDir, 'dist', relativePath)).href);

const { encryptionService } = await importBuilt(
  'services/encryptionService.js'
);
const persistence = await importBuilt('persistence/index.js');
await persistence.initializePersistence({
  dialect: 'sqlite',
  emailCodec: encryptionService,
  env: process.env,
});

const [
  { default: agentCliService, AGENT_CLI_DEFINITIONS },
  runtime,
  { userModel },
] = await Promise.all([
  importBuilt('services/agentCliService.js'),
  importBuilt('cordis/runtime.js'),
  importBuilt('models/userModel.js'),
]);

const ENGINE_PLUGIN = pathToFileURL(
  path.join(backendDir, 'dist', 'cordis', 'dsh', 'engine-plugin.js')
).href;
const ADAPTER_PLUGIN = pathToFileURL(
  path.join(backendDir, 'dist', 'cordis', 'dsh', 'librewebui-llm-adapter.js')
).href;
const FIXTURE_ADAPTER = pathToFileURL(
  path.join(repoRoot, 'scripts', 'fixtures', 'cordis', 'fake-adapter.mjs')
).href;
const FAKE_REPLY_TEXT = 'Hello from the fake model.';

/** An administrator account, because every agent requires one. */
let adminUserId;

test.after(async () => {
  await runtime.stopCordisHost();
  await rm(tempRoot, { recursive: true, force: true });
});

/** Build a scenario whose composition mounts the engine plus a fixture model. */
async function scenario(label) {
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
  await writeFile(configPath, composition, 'utf8');
  await writeFile(
    settingsPath,
    [
      'features:',
      '  enabled: true',
      'model:',
      "  provider: 'none'",
      "  route: 'test-fake-route'",
      "  model: 'test-model'",
    ].join('\n'),
    'utf8'
  );

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

/** Wait for a stream to report its terminal chunk. */
async function collect(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

test('an administrator account exists for the agent surface', async () => {
  const created = await userModel.createPublicUser({
    username: 'cordis_agent_admin',
    email: 'cordis-agent@example.test',
    password: 'Cordis-Agent-Password-1!',
    role: 'admin',
    accountStatus: 'active',
  });
  adminUserId = created?.id;
  assert.ok(adminUserId, 'an administrator is required by every agent');
  assert.equal((await userModel.getUserById(adminUserId))?.role, 'admin');
});

test('the engine joins the agent selector once it is enabled', async t => {
  const paths = await scenario('selector');
  const binaries = path.join(paths.dir, 'bin');
  await mkdir(binaries);
  const previousPath = process.env.PATH;
  // Discovery must depend on this fixture, not installed CLIs or their config.
  process.env.PATH = binaries;
  t.after(() => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  });
  // Disabled first: the entry must not be offered by a deployment that has not
  // opted into the engine, exactly as an uninstalled CLI is not offered.
  process.env.LIBRE_CORDIS_ENABLED = 'false';
  await runtime.stopCordisHost();
  const disabled = await agentCliService.listAgentModels();
  assert.equal(
    disabled.some(model => model.agentId === 'dsh'),
    false,
    'a disabled engine must not appear'
  );

  process.env.LIBRE_CORDIS_ENABLED = 'true';
  const handlerModule = await importBuilt('cordis/dsh/provider-handler.js');
  const { setEngineDefaultModelResolver, startCordisHost } = await importBuilt(
    'cordis/host/host.js'
  );
  runtime.setCordisProviderCapability(
    await handlerModule.installLibreWebUiProvider()
  );
  setEngineDefaultModelResolver(handlerModule.resolveEngineDefaultModel);
  const host = await startCordisHost(runtime.cordisRuntimeConfig());
  try {
    const standalone = await agentCliService.listAgentModels();
    assert.deepEqual(
      standalone.map(model => model.agentId),
      ['dsh'],
      'the embedded engine requires no installed CLI'
    );
    const claudeBinary = path.join(binaries, 'claude');
    await writeFile(claudeBinary, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const enabled = await agentCliService.listAgentModels();
    const entry = enabled.find(model => model.agentId === 'dsh');
    assert.notEqual(entry, undefined, 'the engine should be offered');
    assert.equal(entry?.name, 'DeepSeek Harness');
    // It sits among the CLIs rather than apart from them, which is the point of
    // the integration.
    assert.ok(enabled.some(model => model.agentId === 'claude-code'));
    assert.equal(
      enabled.find(model => model.agentId === 'claude-code')?.binaryPath,
      claudeBinary
    );
  } finally {
    await host.stop();
    delete process.env.LIBRE_CORDIS_ENABLED;
  }
});

test('the engine answers a turn through the shared agent entry point', async () => {
  const paths = await scenario('agent-turn');
  process.env.LIBRE_CORDIS_ENABLED = 'true';
  const handlerModule = await importBuilt('cordis/dsh/provider-handler.js');
  const { setEngineDefaultModelResolver, startCordisHost } = await importBuilt(
    'cordis/host/host.js'
  );
  runtime.setCordisProviderCapability(
    await handlerModule.installLibreWebUiProvider()
  );
  setEngineDefaultModelResolver(handlerModule.resolveEngineDefaultModel);
  const host = await startCordisHost(runtime.cordisRuntimeConfig());
  try {
    // Chat delegates one request to the embedded engine through this call.
    const chunks = await collect(
      agentCliService.executeAgentStreamRequest(
        'dsh',
        [
          {
            id: 'u1',
            role: 'user',
            content: 'Say hello',
            timestamp: Date.now(),
          },
        ],
        adminUserId,
        { cwd: paths.workspacePath }
      )
    );
    const types = chunks.map(chunk => chunk.type);
    assert.ok(
      types.includes('content'),
      `expected content, saw ${types.join(',')}`
    );
    assert.equal(types.at(-1), 'done', 'the turn must terminate');
    const text = chunks
      .filter(chunk => chunk.type === 'content')
      .map(chunk => chunk.content)
      .join('');
    assert.equal(text, FAKE_REPLY_TEXT);
  } finally {
    await host.stop();
    delete process.env.LIBRE_CORDIS_ENABLED;
  }
});

test('the engine reports itself unavailable instead of failing obscurely', async () => {
  // The pipeline reaches this when the engine is off or its composition did not
  // mount. A caller needs to know which, not a generic stream failure.
  const paths = await scenario('agent-unavailable');
  // Disable the engine in the document the runtime resolves, rather than only
  // clearing the environment: the scenario's own configuration enables it.
  await writeFile(
    paths.settingsPath,
    [
      'features:',
      '  enabled: false',
      'model:',
      "  provider: 'none'",
      "  route: 'test-fake-route'",
      "  model: 'test-model'",
    ].join('\n'),
    'utf8'
  );
  delete process.env.LIBRE_CORDIS_ENABLED;
  await runtime.stopCordisHost();
  await assert.rejects(
    collect(
      agentCliService.executeAgentStreamRequest(
        'dsh',
        [{ id: 'u1', role: 'user', content: 'hi', timestamp: Date.now() }],
        adminUserId,
        {}
      )
    ),
    /not available/
  );
});

test('the engine is declared as an in-process agent, not a CLI', () => {
  // The distinction is load-bearing: a CLI agent is discovered on PATH and
  // parsed from stdout, and the engine has neither.
  const definition = AGENT_CLI_DEFINITIONS.find(
    candidate => candidate.id === 'dsh'
  );
  assert.notEqual(definition, undefined);
  assert.equal(definition?.inProcess, true);
  assert.equal(definition?.name, 'DeepSeek Harness');
});

test('separate Chat requests use isolated transient sessions and leave no engine history', async () => {
  await scenario('isolated-chats');
  const result = await runtime.getCordisEngine();
  assert.equal(result.ok, true);
  const engine = result.engine;
  const originalSend = engine.sendMessage.bind(engine);
  const calls = [];
  engine.sendMessage = async (sessionId, text, options) => {
    calls.push({ sessionId, text, options });
    return originalSend(sessionId, text, options);
  };
  const first = [
    {
      id: 'first',
      role: 'user',
      content: 'Remember fixture-alpha.',
      timestamp: Date.now(),
    },
  ];
  const second = [
    {
      id: 'second',
      role: 'user',
      content: 'A separate conversation.',
      timestamp: Date.now(),
    },
  ];
  try {
    await Promise.all(
      [first, second].map(messages =>
        collect(
          agentCliService.executeAgentStreamRequest(
            'dsh',
            messages,
            adminUserId
          )
        )
      )
    );
    assert.equal(calls.length, 2);
    assert.notEqual(calls[0].sessionId, calls[1].sessionId);
    assert.ok(calls.every(call => call.options.userId === adminUserId));
    assert.equal(
      calls
        .find(call => call.text.includes('A separate conversation.'))
        .text.includes('fixture-alpha'),
      false
    );
    assert.deepEqual(await engine.listSessions(), []);
    for (const call of calls)
      assert.equal(await engine.getSession(call.sessionId), undefined);
  } finally {
    engine.sendMessage = originalSend;
    await runtime.stopCordisHost();
  }
});

test('aborting Chat cancels the engine and removes its transient session', async () => {
  await scenario('cancel-chat');
  const result = await runtime.getCordisEngine();
  assert.equal(result.ok, true);
  const engine = result.engine;
  const originalSend = engine.sendMessage.bind(engine);
  const originalCancel = engine.cancel.bind(engine);
  const cancelled = [];
  let sessionId;
  let listener;
  engine.sendMessage = async id => {
    sessionId = id;
    return {
      sessionId: id,
      subscribe(callback) {
        listener = callback;
        return {
          unsubscribe() {
            listener = undefined;
          },
        };
      },
      close() {},
    };
  };
  engine.cancel = async id => {
    cancelled.push(id);
    return originalCancel(id);
  };
  const controller = new AbortController();
  const pending = collect(
    agentCliService.executeAgentStreamRequest(
      'dsh',
      [
        {
          id: 'cancel-me',
          role: 'user',
          content: 'Wait for cancellation.',
          timestamp: Date.now(),
        },
      ],
      adminUserId,
      { signal: controller.signal }
    )
  );
  try {
    for (let attempt = 0; !listener && attempt < 100; attempt += 1)
      await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(listener, 'the engine stream is attached');
    controller.abort();
    await assert.rejects(pending, /cancelled/);
    assert.ok(cancelled.includes(sessionId));
    assert.equal(listener, undefined);
    assert.equal(await engine.getSession(sessionId), undefined);
  } finally {
    engine.sendMessage = originalSend;
    engine.cancel = originalCancel;
    await runtime.stopCordisHost();
  }
});

test('a broken optional DSH configuration cannot hide installed direct agents', async () => {
  const binaries = path.join(tempRoot, 'agent-binaries');
  await mkdir(binaries, { recursive: true });
  for (const command of ['claude', 'codex', 'pi', 'opencode']) {
    await writeFile(
      path.join(binaries, command),
      '#!/bin/sh\nprintf "fixture/model\\n"\n',
      { mode: 0o755 }
    );
  }
  const previousPath = process.env.PATH;
  const originalAvailability = agentCliService.inProcessAgentAvailable;
  process.env.PATH = binaries;
  agentCliService.inProcessAgentAvailable = async () => {
    throw new Error('Invalid Cordis configuration fixture');
  };
  try {
    const models = await agentCliService.listAgentModels();
    const ids = new Set(models.map(model => model.agentId));
    for (const id of ['claude-code', 'codex', 'pi', 'opencode'])
      assert.ok(ids.has(id), id);
    assert.equal(ids.has('dsh'), false);
  } finally {
    agentCliService.inProcessAgentAvailable = originalAvailability;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
});

const LOCAL_DSH_MODEL = {
  id: 'lwui:ollama:local-model%3Alatest',
  name: 'Local model',
  providerType: 'ollama',
  providerId: 'ollama',
  providerName: 'Ollama',
};
const PLUGIN_DSH_MODEL = {
  id: 'lwui:plugin:provider-a:vendor%2Fchat%3Afast',
  name: 'Remote chat',
  providerType: 'plugin',
  providerId: 'provider-a',
  providerName: 'Provider A',
};

/** Standard model adapter with account-scoped fixtures; no provider or CLI runs. */
async function providerChoiceScenario(
  t,
  label,
  {
    modelsFor = () => [LOCAL_DSH_MODEL, PLUGIN_DSH_MODEL],
    customRoute = false,
  } = {}
) {
  const paths = await scenario(label);
  const { libreWebUiProviderHandler: handler } = await importBuilt(
    'cordis/dsh/provider-handler.js'
  );
  const calls = [];
  const catalogs = [];
  t.mock.method(handler, 'listModels', async userId => {
    catalogs.push(userId);
    return modelsFor(userId);
  });
  t.mock.method(handler, 'resolveModel', async (model, userId) =>
    modelsFor(userId).find(candidate => candidate.id === model)
  );
  t.mock.method(
    handler,
    'defaultModel',
    async userId => modelsFor(userId)[0]?.id
  );
  t.mock.method(handler, 'stream', async function* (call) {
    calls.push(call);
    yield { type: 'text', text: `Model ${call.model}; actor ${call.userId}` };
    yield { type: 'done', reason: 'stop' };
  });
  runtime.setCordisProviderCapability(handler);
  if (!customRoute) {
    await writeFile(
      paths.settingsPath,
      "features:\n  enabled: true\nmodel:\n  provider: libre-webui\n  route: ''\n  model: ''\n"
    );
  }
  const binaries = path.join(paths.dir, 'empty-bin');
  await mkdir(binaries);
  const previousPath = process.env.PATH;
  const previousCordis = process.env.LIBRE_CORDIS_ENABLED;
  const previousCli = process.env.AGENT_CLI_MODELS_ENABLED;
  process.env.PATH = binaries;
  process.env.LIBRE_CORDIS_ENABLED = 'true';
  process.env.AGENT_CLI_MODELS_ENABLED = 'true';
  t.after(async () => {
    await runtime.stopCordisHost();
    for (const [key, previous] of [
      ['PATH', previousPath],
      ['LIBRE_CORDIS_ENABLED', previousCordis],
      ['AGENT_CLI_MODELS_ENABLED', previousCli],
    ]) {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
  });
  return { ...paths, calls, catalogs, handler };
}

function providerChoicePrompt(
  content = 'Use the explicitly selected provider.'
) {
  return [
    { id: 'provider-choice', role: 'user', content, timestamp: Date.now() },
  ];
}

test('DSH provider choices include plugin-only catalogs without Ollama or CLI binaries', async t => {
  const fixture = await providerChoiceScenario(t, 'plugin-only-choices', {
    modelsFor: () => [PLUGIN_DSH_MODEL],
  });
  const { default: ollamaService } = await importBuilt(
    'services/ollamaService.js'
  );
  t.mock.method(ollamaService, 'getModels', async () => {
    throw new Error('Ollama is disabled in this fixture.');
  });
  const models = await agentCliService.listAgentModels(adminUserId);
  assert.deepEqual(
    models.map(model => ({
      id: model.id,
      agentId: model.agentId,
      name: model.name,
    })),
    [
      { id: 'dsh', agentId: 'dsh', name: 'DeepSeek Harness' },
      {
        id: `dsh:${PLUGIN_DSH_MODEL.id}`,
        agentId: 'dsh',
        name: 'DeepSeek Harness · Remote chat (Provider A)',
      },
    ]
  );
  assert.ok(models.every(model => model.binaryPath === ''));
  assert.ok(fixture.catalogs.length > 0);
  assert.ok(fixture.catalogs.every(userId => userId === adminUserId));
  assert.equal(
    runtime.cordisHost(),
    undefined,
    'catalog discovery must not mount the engine'
  );
});

test('DSH provider choices are scoped to an active administrator identity', async t => {
  const secondAdmin = await userModel.createUser({
    username: 'cordis_choices_second_admin',
    email: 'cordis-choices-second@example.test',
    password: 'Cordis-Choices-Password-1!',
    role: 'admin',
    accountStatus: 'active',
  });
  const member = await userModel.createUser({
    username: 'cordis_choices_member',
    email: 'cordis-choices-member@example.test',
    password: 'Cordis-Choices-Password-1!',
    role: 'user',
    accountStatus: 'active',
  });
  const pendingAdmin = await userModel.createUser({
    username: 'cordis_choices_pending_admin',
    email: 'cordis-choices-pending@example.test',
    password: 'Cordis-Choices-Password-1!',
    role: 'admin',
    accountStatus: 'pending',
  });
  const secondModel = {
    ...PLUGIN_DSH_MODEL,
    id: 'lwui:plugin:provider-b:other-model',
    providerId: 'provider-b',
    providerName: 'Provider B',
  };
  const fixture = await providerChoiceScenario(t, 'identity-choices', {
    modelsFor: userId =>
      userId === adminUserId
        ? [PLUGIN_DSH_MODEL]
        : userId === secondAdmin.id
          ? [secondModel]
          : [],
  });
  for (const userId of [
    undefined,
    member.id,
    pendingAdmin.id,
    'missing-user',
  ]) {
    const models = await agentCliService.listAgentModels(userId);
    assert.deepEqual(
      models.map(model => model.id),
      ['dsh']
    );
    if (userId !== undefined) {
      await assert.rejects(
        collect(
          agentCliService.executeAgentStreamRequest(
            'dsh',
            providerChoicePrompt(),
            userId,
            { model: `dsh:${PLUGIN_DSH_MODEL.id}` }
          )
        ),
        /admin|account|available|allowed/i
      );
      assert.equal(runtime.cordisHost() === undefined, true);
    }
  }
  assert.deepEqual(
    fixture.catalogs,
    [],
    'unprivileged calls must not read another account’s catalog'
  );
  assert.deepEqual(
    (await agentCliService.listAgentModels(adminUserId)).map(model => model.id),
    ['dsh', `dsh:${PLUGIN_DSH_MODEL.id}`]
  );
  assert.deepEqual(
    (await agentCliService.listAgentModels(secondAdmin.id)).map(
      model => model.id
    ),
    ['dsh', `dsh:${secondModel.id}`]
  );
  await assert.rejects(
    collect(
      agentCliService.executeAgentStreamRequest(
        'dsh',
        providerChoicePrompt(),
        adminUserId,
        { model: `dsh:${secondModel.id}` }
      )
    ),
    /unavailable|available|model/i
  );
  assert.equal(runtime.cordisHost() === undefined, true);
  assert.deepEqual(fixture.calls, []);
});

test('explicit DSH choices reach the native model adapter and transient creation with exact caller identity', async t => {
  const secondAdmin = await userModel.createUser({
    username: 'cordis_target_second_admin',
    email: 'cordis-target-second@example.test',
    password: 'Cordis-Targets-Password-1!',
    role: 'admin',
    accountStatus: 'active',
  });
  const fixture = await providerChoiceScenario(t, 'exact-native-targets', {
    modelsFor: userId =>
      userId === secondAdmin.id ? [PLUGIN_DSH_MODEL] : [LOCAL_DSH_MODEL],
  });
  const result = await runtime.getCordisEngine();
  assert.equal(result.ok, true);
  const engine = result.engine;
  const originalCreate = engine.createSession.bind(engine);
  const creations = [];
  engine.createSession = async options => {
    creations.push(options);
    return originalCreate(options);
  };
  try {
    const targets = [
      { model: LOCAL_DSH_MODEL.id, userId: adminUserId },
      { model: PLUGIN_DSH_MODEL.id, userId: secondAdmin.id },
    ];
    const responses = await Promise.all(
      targets.map(target =>
        collect(
          agentCliService.executeAgentStreamRequest(
            'dsh',
            providerChoicePrompt(),
            target.userId,
            { model: `dsh:${target.model}` }
          )
        )
      )
    );
    for (const [index, target] of targets.entries()) {
      assert.equal(responses[index].at(-1).type, 'done');
      assert.equal(
        responses[index]
          .filter(chunk => chunk.type === 'content')
          .map(chunk => chunk.content)
          .join(''),
        `Model ${target.model}; actor ${target.userId}`
      );
      assert.ok(
        creations.some(
          options =>
            options.model === target.model &&
            options.userId === target.userId &&
            options.transient === true
        )
      );
      assert.ok(
        fixture.calls.some(
          call => call.model === target.model && call.userId === target.userId
        )
      );
    }
    assert.equal(fixture.calls.length, 2);
    assert.deepEqual(await engine.listSessions(), []);
    assert.deepEqual(
      await runtime.cordisHost().context.get('sessionPersistence').list(),
      []
    );
  } finally {
    engine.createSession = originalCreate;
  }
});

test('base DSH keeps the composition default rather than selecting a catalog override', async t => {
  const fixture = await providerChoiceScenario(t, 'base-composition-default');
  await writeFile(
    fixture.settingsPath,
    "features:\n  enabled: true\nmodel:\n  provider: libre-webui\n  route: ''\n  model: 'lwui:plugin:provider-a:vendor%2Fchat%3Afast'\n"
  );
  const chunks = await collect(
    agentCliService.executeAgentStreamRequest(
      'dsh',
      providerChoicePrompt(),
      adminUserId,
      { model: 'dsh' }
    )
  );
  assert.equal(chunks.at(-1).type, 'done');
  assert.equal(fixture.calls.length, 1);
  assert.equal(fixture.calls[0].model, PLUGIN_DSH_MODEL.id);
  assert.equal(fixture.calls[0].userId, adminUserId);
  assert.deepEqual(
    await runtime.cordisHost().context.get('sessionPersistence').list(),
    []
  );
});

test('mismatched, malformed and pseudo DSH choices are rejected before engine startup', async t => {
  const fixture = await providerChoiceScenario(t, 'invalid-target-choices');
  for (const model of [
    'claude-code:sonnet',
    'lwui:ollama:local-model%3Alatest',
    'dsh:not-a-qualified-model',
    'dsh:lwui:ollama:',
    'dsh:lwui:ollama:%',
    'dsh:lwui:ollama:one:two',
    'dsh:lwui:plugin:missing-model',
    'dsh:lwui:ollama:persona%3Aexample',
    'dsh:lwui:plugin:provider-a:agent%3Acodex',
  ]) {
    await assert.rejects(
      collect(
        agentCliService.executeAgentStreamRequest(
          'dsh',
          providerChoicePrompt(),
          adminUserId,
          { model }
        )
      ),
      /model|selection|route|provider|DSH|Harness|agent/i,
      model
    );
    assert.equal(runtime.cordisHost(), undefined, model);
  }
  assert.deepEqual(
    fixture.calls,
    [],
    'an invalid explicit choice must never silently use the default'
  );
});

test('unavailable explicit DSH models cannot fall back to the healthy default', async t => {
  const fixture = await providerChoiceScenario(t, 'unavailable-choice', {
    modelsFor: () => [LOCAL_DSH_MODEL],
  });
  await assert.rejects(
    collect(
      agentCliService.executeAgentStreamRequest(
        'dsh',
        providerChoicePrompt(),
        adminUserId,
        { model: `dsh:${PLUGIN_DSH_MODEL.id}` }
      )
    ),
    /unavailable|available|model|provider/i
  );
  assert.equal(runtime.cordisHost(), undefined);
  assert.deepEqual(fixture.calls, []);
});

test('custom DSH adapters expose only their base entry and refuse standard provider overrides', async t => {
  const fixture = await providerChoiceScenario(t, 'custom-adapter-choices', {
    customRoute: true,
  });
  assert.deepEqual(
    (await agentCliService.listAgentModels(adminUserId)).map(model => model.id),
    ['dsh']
  );
  assert.deepEqual(
    fixture.catalogs,
    [],
    'a custom composition must not advertise the standard adapter’s catalog'
  );
  await assert.rejects(
    collect(
      agentCliService.executeAgentStreamRequest(
        'dsh',
        providerChoicePrompt(),
        adminUserId,
        { model: `dsh:${PLUGIN_DSH_MODEL.id}` }
      )
    ),
    /adapter|composition|route|provider|model/i
  );
  assert.equal(runtime.cordisHost(), undefined);
  assert.deepEqual(fixture.calls, []);
});

test('CLI and Cordis gates suppress provider choices and deny explicit execution before startup', async t => {
  const fixture = await providerChoiceScenario(t, 'choice-gates');
  for (const disabledKey of [
    'AGENT_CLI_MODELS_ENABLED',
    'LIBRE_CORDIS_ENABLED',
  ]) {
    process.env[disabledKey] = 'false';
    assert.deepEqual(await agentCliService.listAgentModels(adminUserId), []);
    await assert.rejects(
      collect(
        agentCliService.executeAgentStreamRequest(
          'dsh',
          providerChoicePrompt(),
          adminUserId,
          { model: `dsh:${PLUGIN_DSH_MODEL.id}` }
        )
      ),
      /disabled|available|enabled|allowed/i
    );
    assert.equal(runtime.cordisHost(), undefined);
    process.env[disabledKey] = 'true';
  }
  assert.deepEqual(fixture.calls, []);
});

test('an unavailable DSH model catalog keeps its enabled base selector entry', async t => {
  const fixture = await providerChoiceScenario(t, 'unavailable-catalog');
  t.mock.method(fixture.handler, 'listModels', async () => {
    throw new Error('Provider catalog unavailable.');
  });
  const models = await agentCliService.listAgentModels(adminUserId);
  assert.deepEqual(
    models.map(model => model.id),
    ['dsh']
  );
  assert.equal(runtime.cordisHost(), undefined);
});

test('a standard adapter route permits DSH provider choices even with provider mode none', async t => {
  await providerChoiceScenario(t, 'standard-route-provider-choices');
  const settingsPath = runtime.cordisRuntimeConfig().settingsPath;
  await writeFile(
    settingsPath,
    "features:\n  enabled: true\nmodel:\n  provider: none\n  route: libre-webui\n  model: ''\n"
  );
  const ids = (await agentCliService.listAgentModels(adminUserId)).map(
    model => model.id
  );
  assert.deepEqual(ids, [
    'dsh',
    `dsh:${LOCAL_DSH_MODEL.id}`,
    `dsh:${PLUGIN_DSH_MODEL.id}`,
  ]);
  assert.equal(runtime.cordisHost() === undefined, true);
});

test('a running custom DSH adapter cannot accept provider choices after configuration changes', async t => {
  const fixture = await providerChoiceScenario(t, 'running-adapter-mismatch', {
    customRoute: true,
  });
  const running = await runtime.getCordisEngine();
  assert.equal(running.ok, true);
  await writeFile(
    fixture.settingsPath,
    "features:\n  enabled: true\nmodel:\n  provider: libre-webui\n  route: ''\n  model: ''\n"
  );
  const advertised = await agentCliService.listAgentModels(adminUserId);
  assert.ok(
    advertised.some(model => model.id === `dsh:${PLUGIN_DSH_MODEL.id}`)
  );
  await assert.rejects(
    collect(
      agentCliService.executeAgentStreamRequest(
        'dsh',
        providerChoicePrompt(),
        adminUserId,
        { model: `dsh:${PLUGIN_DSH_MODEL.id}` }
      )
    ),
    /composition|provider|adapter/i
  );
  assert.deepEqual(fixture.calls, []);
  assert.deepEqual(await running.engine.listSessions(), []);
});

/** Observe allocations while preserving the real native engine implementations. */
function observeAuxiliaryAllocations(t, engine, host) {
  const counts = { sessions: 0, agents: 0, tools: 0 };
  const originalCreate = engine.createSession.bind(engine);
  t.mock.method(engine, 'createSession', async options => {
    counts.sessions += 1;
    return originalCreate(options);
  });
  host.context.on('agent/created', () => {
    counts.agents += 1;
  });
  host.context.on('tools/execute', async (_exec, next) => {
    counts.tools += 1;
    return next();
  });
  return counts;
}

test('real DSH auxiliary resolution honors the running bridge default and exact provider identities', async t => {
  const rawModel = 'vendor/chat:fast';
  const sameNamedLocal = {
    ...LOCAL_DSH_MODEL,
    id: `lwui:ollama:${encodeURIComponent(rawModel)}`,
    name: 'Remote chat',
  };
  let ollamaEnabled = true;
  const fixture = await providerChoiceScenario(t, 'real-auxiliary-targets', {
    modelsFor: () =>
      ollamaEnabled ? [sameNamedLocal, PLUGIN_DSH_MODEL] : [PLUGIN_DSH_MODEL],
  });
  const { parseComposition, stringifyComposition } = await importBuilt(
    'cordis/host/composition.js'
  );
  const composition = parseComposition(
    await readFile(fixture.configPath, 'utf8')
  );
  const bridge = composition.find(row => row.id === 'libre-webui-bridge');
  bridge.config = { ...bridge.config, defaultModel: PLUGIN_DSH_MODEL.id };
  await writeFile(fixture.configPath, stringifyComposition(composition));
  const { default: pluginService } = await importBuilt(
    'services/pluginService.js'
  );
  const { default: ollamaService } = await importBuilt(
    'services/ollamaService.js'
  );
  const lookups = [];
  t.mock.method(
    pluginService,
    'getActivePluginForModel',
    async (model, userId, providerId) => {
      lookups.push({ model, userId, providerId });
      assert.equal(model, rawModel);
      assert.equal(userId, adminUserId);
      assert.equal(providerId, PLUGIN_DSH_MODEL.providerId);
      return {
        id: PLUGIN_DSH_MODEL.providerId,
        name: 'Provider A',
        type: 'completion',
        model_map: [rawModel],
      };
    }
  );
  let localProbes = 0;
  t.mock.method(ollamaService, 'getModels', async () => {
    localProbes += 1;
    if (!ollamaEnabled) throw new Error('Ollama is disabled.');
    return [{ name: rawModel }];
  });
  const running = await runtime.getCordisEngine();
  assert.equal(running.ok, true);
  assert.equal(running.engine.modelConfiguration().model, PLUGIN_DSH_MODEL.id);
  const host = runtime.cordisHost();
  const allocations = observeAuxiliaryAllocations(t, running.engine, host);
  // Editing the operator document does not replace the already-running row.
  bridge.config.defaultModel = sameNamedLocal.id;
  await writeFile(fixture.configPath, stringifyComposition(composition));
  const { resolveDshProviderTarget } = await importBuilt(
    'cordis/dsh/chat-model.js'
  );
  const expectedPlugin = {
    model: rawModel,
    providerType: 'plugin',
    providerId: PLUGIN_DSH_MODEL.providerId,
  };

  // The bridge row overrides both the host settings and the catalog's local-first default.
  assert.deepEqual(
    await resolveDshProviderTarget('dsh', adminUserId),
    expectedPlugin
  );
  assert.deepEqual(
    await resolveDshProviderTarget(`dsh:${PLUGIN_DSH_MODEL.id}`, adminUserId),
    expectedPlugin
  );
  const pluginLookups = lookups.length;
  assert.deepEqual(
    await resolveDshProviderTarget(`dsh:${sameNamedLocal.id}`, adminUserId),
    { model: rawModel, providerType: 'ollama', providerId: null }
  );
  assert.equal(
    lookups.length,
    pluginLookups,
    'a qualified local target must not resolve through the same-named plugin'
  );

  ollamaEnabled = false;
  assert.deepEqual(
    await resolveDshProviderTarget(`dsh:${PLUGIN_DSH_MODEL.id}`, adminUserId),
    expectedPlugin
  );
  await assert.rejects(
    resolveDshProviderTarget(`dsh:${sameNamedLocal.id}`, adminUserId),
    /unavailable/
  );
  assert.equal(
    localProbes,
    0,
    'qualified targets must not depend on an Ollama catalog probe'
  );
  assert.equal(lookups.length, 3);
  assert.deepEqual(allocations, { sessions: 0, agents: 0, tools: 0 });
  assert.deepEqual(
    fixture.calls,
    [],
    'auxiliary resolution must never run the agent'
  );
  assert.deepEqual(await running.engine.listSessions(), []);
  assert.deepEqual(await running.engine.listAgents(), []);
  assert.deepEqual(await host.context.get('sessionPersistence').list(), []);
});

test('real DSH auxiliary resolution refuses a running custom adapter without allocating an agent', async t => {
  const fixture = await providerChoiceScenario(t, 'custom-auxiliary-runtime', {
    customRoute: true,
  });
  const running = await runtime.getCordisEngine();
  assert.equal(running.ok, true);
  const host = runtime.cordisHost();
  const allocations = observeAuxiliaryAllocations(t, running.engine, host);
  const { resolveDshProviderTarget } = await importBuilt(
    'cordis/dsh/chat-model.js'
  );
  await assert.rejects(
    resolveDshProviderTarget('dsh', adminUserId),
    /composition.*provider/i
  );
  await writeFile(
    fixture.settingsPath,
    "features:\n  enabled: true\nmodel:\n  provider: libre-webui\n  route: ''\n  model: ''\n"
  );
  // Current configuration may advertise the choice before the existing runtime is restarted.
  await assert.rejects(
    resolveDshProviderTarget(`dsh:${PLUGIN_DSH_MODEL.id}`, adminUserId),
    /composition.*provider/i
  );
  assert.deepEqual(allocations, { sessions: 0, agents: 0, tools: 0 });
  assert.deepEqual(fixture.calls, []);
  assert.deepEqual(await running.engine.listSessions(), []);
  assert.deepEqual(await running.engine.listAgents(), []);
  assert.deepEqual(await host.context.get('sessionPersistence').list(), []);
});
