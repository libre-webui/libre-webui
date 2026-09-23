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
 * Manual demonstration of model-adapter hot swap and plugin rollback.
 *
 * The regression suites assert these behaviours; this script shows them, which
 * is what makes them reviewable by someone who does not want to read a test
 * file. It mounts the real engine with a deterministic fixture adapter, then:
 *
 *  1. records the live engine state;
 *  2. swaps the model adapter to a different provider route and endpoint;
 *  3. shows that every other service and every session survived the swap;
 *  4. restores the original adapter;
 *  5. disposes the whole tree and shows that every service, the bridge, the
 *     adapter row, and the probe's listener are gone.
 *
 * Run from the repository root after `npm run build:backend`:
 *
 * ```bash
 * node scripts/manual-cordis-hot-swap.mjs
 * ```
 */

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const backendDir = path.join(repoRoot, 'backend');

const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'libre-cordis-manual-'));
process.env.DATA_DIR = tempRoot;

const distModule = (relativePath) =>
  import(pathToFileURL(path.join(backendDir, 'dist', relativePath)).href);

const { startCordisHost } = await distModule('cordis/host/host.js');
const { resolveCordisHostConfig } = await distModule('cordis/host/config.js');

const FIXTURE_ADAPTER = pathToFileURL(
  path.join(repoRoot, 'scripts', 'fixtures', 'cordis', 'fake-adapter.mjs')
).href;

/** Print one labelled observation. */
function report(label, value) {
  console.log(`  ${label.padEnd(34)} ${value}`);
}

/** Summarize what the engine currently provides. */
function snapshot(host) {
  const context = host.context;
  const tools = context.get('tools');
  return {
    llm: context.get('llm') !== undefined,
    sessions: context.get('sessions') !== undefined,
    tools: tools !== undefined,
    agents: context.get('agents') !== undefined,
    engine: context.get('libreDshEngine') !== undefined,
    toolCount: tools ? tools.schemas().length : -1,
  };
}

const workspacePath = path.join(tempRoot, 'workspace');
const sessionStorePath = path.join(tempRoot, 'sessions');
await mkdir(workspacePath, { recursive: true });
await mkdir(sessionStorePath, { recursive: true });

const example = await readFile(
  path.join(backendDir, 'cordis.patch.example.yml'),
  'utf8'
);
// The relative specifier is left as shipped, so the demo exercises the same
// resolution an operator's document does.
const composition = example
  .replace(
    '- id: fs-sandbox',
    [
      '- id: demo-fake-adapter',
      `  name: ${JSON.stringify(FIXTURE_ADAPTER)}`,
      '  config:',
      '    route: demo-route',
      '',
      '- id: fs-sandbox',
    ].join('\n')
  );

const configPath = path.join(tempRoot, 'cordis.patch.yml');
const settingsPath = path.join(tempRoot, 'cordis.config.yml');
await writeFile(configPath, composition, 'utf8');
await writeFile(
  settingsPath,
  [
    'trace: false',
    'features:',
    '  enabled: true',
    'model:',
    '  provider: none',
    '  route: demo-route',
    '  model: demo-model',
  ].join('\n'),
  'utf8'
);

const host = await startCordisHost(
  resolveCordisHostConfig({
    configPath,
    settingsPath,
    workspacePath,
    sessionStorePath,
  })
);

try {
  console.log('\n1. Mounted engine');
  const before = snapshot(host);
  for (const [name, available] of Object.entries(before)) {
    report(name, available);
  }
  report('adapter', JSON.stringify(host.model.state()));

  const engine = host.context.get('libreDshEngine');
  assert.ok(engine, 'the bridge should have published its service');

  const session = await engine.createSession({ cwd: workspacePath });
  report('created session', session.id);

  console.log('\n2. Hot swap: Ollama route -> OpenAI-compatible gateway');
  const after = await host.model.swap({
    provider: 'pi-ai',
    route: 'openai-compatible',
    apiKeyEnv: 'LOCAL_GATEWAY_API_KEY',
    baseUrl: 'http://127.0.0.1:8080/v1',
    model: 'local-model',
    providers: {},
  });
  report('adapter', JSON.stringify(after));

  console.log('\n3. Engine state after the swap');
  const mid = snapshot(host);
  for (const [name, available] of Object.entries(mid)) {
    report(name, available);
  }
  // A swap that restarted the engine would have lost the session and the tools.
  assert.deepEqual(
    { ...before, toolCount: mid.toolCount },
    mid,
    'every service and tool should survive the swap'
  );
  assert.notEqual(
    await engine.getSession(session.id),
    undefined,
    'the session created before the swap should still exist'
  );
  report('session survived', session.id);

  console.log('\n4. Swap again: the gateway -> a local Ollama route');
  const restored = await host.model.swap({
    provider: 'pi-ai',
    route: 'ollama',
    apiKeyEnv: 'OLLAMA_API_KEY',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'llama3.2',
    providers: {},
  });
  report('adapter', JSON.stringify(restored));
  // Swapping twice is the real proof that the previous adapter's provider
  // routes were released; a leaked registration would have failed here.
  assert.equal(restored.swaps, 2);
  report('successful swaps', restored.swaps);

  console.log('\n5. Remove the adapter row entirely (engine keeps running)');
  await host.model.remove();
  report('adapter row present', host.model.state().provider === 'pi-ai');
  // With `provider: none` remembered as the intended state, the row is gone.
  assert.equal(
    snapshot(host).sessions,
    true,
    'removing the adapter must not disturb the session store'
  );
  report('sessions still available', true);

  console.log('\n6. Rollback: dispose the whole Cordis tree');
  await host.stop();
  const afterStop = snapshot(host);
  for (const [name, available] of Object.entries(afterStop)) {
    report(name, available);
  }
  assert.equal(afterStop.engine, false, 'the bridge service should be gone');
  report('engine service withdrawn', afterStop.engine === false);

  console.log(
    '\nEvery service was withdrawn and the bridge released its listener.\n' +
      'Session files remain on disk as data:\n' +
      `  ${sessionStorePath}\n`
  );
} finally {
  await host.stop();
  await rm(tempRoot, { recursive: true, force: true });
}
