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
import { once } from 'node:events';
import {
  chmod,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { prepareDshProviderBundle } from './prepare-dsh-provider.mjs';

const { NativeDshProviderService, verifyNativeProviderSocket } =
  await import('../backend/dist/cordis/dsh/native-provider-client.js');
const { nativeDshModelId, parseNativeDshModelId, isProviderModelIdentity } =
  await import('../backend/dist/cordis/dsh/model-identity.js');
const { resolveCordisHostConfig } =
  await import('../backend/dist/cordis/host/config.js');

const model = {
  providerId: 'deepseek-official',
  model: 'deepseek-flash',
  name: 'Flash',
  providerName: 'DeepSeek',
};
const request = {
  model: model.model,
  messages: [{ role: 'user', content: 'Hello' }],
};
const textChunks = [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: 'Hello' },
  { type: 'block-end', index: 0, block: { type: 'text', text: 'Hello' } },
];
const finish = { type: 'finish', reason: { kind: 'stop' } };

async function fixture(t) {
  const directory = await realpath(
    await mkdtemp(path.join(os.tmpdir(), 'dsh-client-'))
  );
  await chmod(directory, 0o700);
  const socketPath = path.join(directory, 'llm.sock');
  const calls = [];
  const usage = [];
  const state = {
    catalog: { instanceId: 'first', models: [model] },
    chunks: [...textChunks, finish],
  };
  const sockets = new Set();
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    calls.push({
      path: req.url,
      body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
    });
    if (req.url === '/catalog') res.end(JSON.stringify(state.catalog));
    else if (req.url === '/generate') {
      if (state.generateStatus !== undefined) {
        res.writeHead(state.generateStatus);
        res.end('{}');
        return;
      }
      if (state.raw !== undefined) {
        res.end(state.raw);
        return;
      }
      for (const chunk of state.chunks) res.write(`${JSON.stringify(chunk)}\n`);
      res.end();
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.listen(socketPath);
  await once(server, 'listening');
  await chmod(socketPath, 0o600);
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  return {
    directory,
    socketPath,
    calls,
    usage,
    state,
    service: new NativeDshProviderService({
      socketPath: () => socketPath,
      authorize: async userId => userId === 'admin',
      assertUsageAllowed: async () => {},
      recordUsage: event => {
        usage.push(event);
      },
    }),
  };
}

test('native DSH identifiers preserve exact provider and model without Ollama aliases', () => {
  const id = nativeDshModelId('provider:one', 'model/name:variant');
  assert.equal(id, 'native:provider%3Aone:model%2Fname%3Avariant');
  assert.equal(isProviderModelIdentity(id), true);
  assert.deepEqual(parseNativeDshModelId(id), {
    providerId: 'provider:one',
    model: 'model/name:variant',
  });
  assert.equal(parseNativeDshModelId('lwui:ollama:deepseek-flash'), undefined);
  for (const value of [
    'native::flash',
    'native:p:%00',
    'native:p:%XX',
    'native:p:m:extra',
  ]) {
    assert.throws(() => parseNativeDshModelId(value), /Invalid/);
    assert.equal(isProviderModelIdentity(value), false);
  }
});

test('native provider access is checked before any socket or catalog request', async t => {
  const item = await fixture(t);
  assert.deepEqual(await item.service.catalog('member'), {
    status: 'disabled',
    models: [],
  });
  await assert.rejects(
    item.service.generate(request, model.providerId, 'member'),
    /administrator/
  );
  assert.equal(item.calls.length, 0);
});

test('a malformed optional native connection leaves ordinary model discovery usable', async () => {
  const service = new NativeDshProviderService({
    authorize: async () => {
      throw new Error('Invalid native socket configuration');
    },
    socketPath: () => {
      throw new Error('Must not connect');
    },
  });
  assert.deepEqual(await service.catalog('admin'), {
    status: 'unavailable',
    models: [],
  });
  await assert.rejects(
    service.generate(request, model.providerId, 'admin'),
    /Invalid native socket configuration/
  );
});

test('native DSH transport rejects public or symlinked sockets without provider fallback', async t => {
  const item = await fixture(t);
  await chmod(item.socketPath, 0o666);
  assert.deepEqual(await item.service.catalog('admin'), {
    status: 'unavailable',
    models: [],
  });
  await assert.rejects(
    item.service.assertModel(model.providerId, model.model, 'admin'),
    /private/
  );
  await chmod(item.socketPath, 0o600);
  const link = path.join(item.directory, 'link.sock');
  await symlink(item.socketPath, link);
  await assert.rejects(verifyNativeProviderSocket(link), /private/);
  assert.equal(item.calls.length, 0);
});

test('native DSH calls pin the exact catalog route and configuration generation', async t => {
  const item = await fixture(t);
  const first = await item.service.routingFingerprint(
    model.providerId,
    model.model,
    'admin'
  );
  item.state.catalog.instanceId = 'rotated';
  assert.notEqual(
    await item.service.routingFingerprint(
      model.providerId,
      model.model,
      'admin'
    ),
    first
  );
  const response = await item.service.generate(
    request,
    model.providerId,
    'admin'
  );
  assert.equal(response.message.content, 'Hello');
  const sent = item.calls.find(call => call.path === '/generate').body;
  assert.equal(sent.provider, model.providerId);
  assert.equal(sent.model, model.model);
  assert.equal(sent.instanceId, 'rotated');
  assert.equal('sessionId' in sent, false);
  await assert.rejects(
    item.service.generate(request, 'other-provider', 'admin'),
    /unavailable/
  );
  assert.equal(item.calls.filter(call => call.path === '/generate').length, 1);
});

test('native DSH rejects incomplete, malformed and trailing stream data', async t => {
  const item = await fixture(t);
  for (const chunks of [
    textChunks,
    [...textChunks, finish, finish],
    [
      {
        type: 'block-end',
        index: 0,
        block: { type: 'image', attachment: { path: '/private/file' } },
      },
      finish,
    ],
    [
      {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: {
            code: 'PROVIDER_UNAVAILABLE',
            message: 'private upstream diagnostic',
          },
        },
      },
    ],
  ]) {
    item.state.chunks = chunks;
    await assert.rejects(
      item.service.generate(request, model.providerId, 'admin'),
      error => {
        assert.doesNotMatch(error.message, /private upstream diagnostic/);
        return /native dsh|native provider/i.test(error.message);
      }
    );
  }
});

test('malformed native JSON never exposes upstream diagnostic fragments', async t => {
  const item = await fixture(t);
  item.state.raw = 'private-upstream-diagnostic-not-json\n';
  await assert.rejects(
    item.service.generate(request, model.providerId, 'admin'),
    error => {
      assert.equal(error.message, 'Invalid native DSH stream frame.');
      assert.doesNotMatch(error.message, /private-upstream-diagnostic/);
      return true;
    }
  );
});

test('native DSH cancellation and unsupported attachments never start an unscoped request', async t => {
  const item = await fixture(t);
  const controller = new AbortController();
  controller.abort(new Error('cancel native call'));
  await assert.rejects(
    item.service.generate(
      request,
      model.providerId,
      'admin',
      {},
      controller.signal
    ),
    /cancel native call/
  );
  await assert.rejects(
    item.service.generate(
      {
        ...request,
        messages: [{ role: 'user', content: 'image', images: ['pixels'] }],
      },
      model.providerId,
      'admin'
    ),
    /text and tool/
  );
  assert.equal(item.calls.length, 0);
});

test('native provider bundle is self-contained and never overwrites an existing directory', async t => {
  const item = await fixture(t);
  const outputDirectory = path.join(item.directory, 'bundle');
  await prepareDshProviderBundle({
    outputDirectory,
    socketPath: item.socketPath,
  });
  const manifest = JSON.parse(
    await readFile(path.join(outputDirectory, 'package.json'), 'utf8')
  );
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml');
  assert.equal(manifest.dependencies, undefined);
  const plugin = await import(
    pathToFileURL(path.join(outputDirectory, manifest.main)).href
  );
  assert.deepEqual(plugin.inject, ['llm']);
  assert.equal(typeof plugin.apply, 'function');
  const patch = await readFile(
    path.join(outputDirectory, 'cordis.patch.yml'),
    'utf8'
  );
  assert.ok(patch.includes(JSON.stringify(item.socketPath)));
  await assert.rejects(
    prepareDshProviderBundle({ outputDirectory, socketPath: item.socketPath }),
    { code: 'EEXIST' }
  );
});

test('native socket configuration is explicit and an empty environment override disables it', async t => {
  const item = await fixture(t);
  const saved = process.env.LIBRE_DSH_PROVIDER_SOCKET;
  t.after(() => {
    if (saved === undefined) delete process.env.LIBRE_DSH_PROVIDER_SOCKET;
    else process.env.LIBRE_DSH_PROVIDER_SOCKET = saved;
  });
  const options = {
    configPath: path.join(item.directory, 'missing.patch.yml'),
    settingsPath: path.join(item.directory, 'missing.settings.yml'),
  };
  delete process.env.LIBRE_DSH_PROVIDER_SOCKET;
  assert.equal(resolveCordisHostConfig(options).nativeProvider, undefined);
  process.env.LIBRE_DSH_PROVIDER_SOCKET = item.socketPath;
  assert.deepEqual(resolveCordisHostConfig(options).nativeProvider, {
    socketPath: item.socketPath,
  });
  process.env.LIBRE_DSH_PROVIDER_SOCKET = 'relative.sock';
  assert.throws(() => resolveCordisHostConfig(options), /absolute/);
  process.env.LIBRE_DSH_PROVIDER_SOCKET = '';
  assert.equal(resolveCordisHostConfig(options).nativeProvider, undefined);
});

test('a dispatched native HTTP failure is recorded once while catalog-only work stays unmetered', async t => {
  const item = await fixture(t);
  await item.service.catalog('admin');
  assert.deepEqual(item.usage, []);
  item.state.generateStatus = 503;
  await assert.rejects(
    item.service.generate(request, model.providerId, 'admin'),
    /503/
  );
  assert.equal(item.calls.filter(call => call.path === '/generate').length, 1);
  assert.equal(item.usage.length, 1);
  assert.equal(item.usage[0].status, 'error');
  assert.equal(item.usage[0].userId, 'admin');
  assert.equal(item.usage[0].providerId, model.providerId);
  assert.equal(item.usage[0].model, model.model);
  assert.equal(item.usage[0].usage, undefined);
});
