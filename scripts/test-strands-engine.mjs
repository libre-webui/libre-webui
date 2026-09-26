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
 * End-to-end coverage for the embedded Strands engine: access control on
 * the HTTP surface, a real harness turn against a fake Ollama, the file-tool
 * workspace jail, and transcript persistence.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import express from 'express';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);
const directory = await mkdtemp(path.join(os.tmpdir(), 'libre-strands-'));
process.env.DATA_DIR = path.join(directory, 'data');
process.env.PLUGINS_DIR = path.join(directory, 'plugins');
process.env.ENCRYPTION_KEY = '7'.repeat(64);
process.env.JWT_SECRET = 'strands-engine-test-secret-value';
process.env.OLLAMA_ENABLED = 'true';
delete process.env.LIBRE_STRANDS_ACCESS;

/** Every /api/chat body the fake Ollama received. */
const chatRequests = [];

/**
 * A fake Ollama that plays a two-step agent: when the latest message is the
 * user's, it asks for the `write` tool with the path named in the prompt;
 * once a tool result is in the history, it answers in text.
 */
const ollama = http.createServer((request, response) => {
  const chunks = [];
  request.on('data', chunk => chunks.push(chunk));
  request.on('end', () => {
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : {};
    if (request.url === '/api/tags') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({
          models: [
            { name: 'fixture-agent', model: 'fixture-agent', size: 1 },
            { name: 'nomic-embed-text', model: 'nomic-embed-text', size: 1 },
          ],
        })
      );
      return;
    }
    if (request.url === '/api/show') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({
          parameters: '',
          model_info: {},
          capabilities: ['completion', 'tools'],
        })
      );
      return;
    }
    if (request.url !== '/api/chat') {
      response.writeHead(404).end();
      return;
    }
    chatRequests.push(body);
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const last = messages[messages.length - 1] ?? {};
    const lines = [];
    if (last.role === 'tool') {
      lines.push({
        message: { role: 'assistant', content: 'Saved the note.' },
        done: false,
      });
      lines.push({
        message: { role: 'assistant', content: '' },
        done: true,
        done_reason: 'stop',
        prompt_eval_count: 30,
        eval_count: 4,
      });
    } else {
      const target =
        /path=(\S+)/.exec(String(last.content ?? ''))?.[1] ??
        '/workspace/notes.txt';
      lines.push({
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'call_write_1',
              function: {
                name: 'write',
                arguments: { path: target, content: 'hello from strands' },
              },
            },
          ],
        },
        done: false,
      });
      lines.push({
        message: { role: 'assistant', content: '' },
        done: true,
        done_reason: 'stop',
        prompt_eval_count: 20,
        eval_count: 8,
      });
    }
    response.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    response.end(lines.map(line => `${JSON.stringify(line)}\n`).join(''));
  });
});
await new Promise(resolve => ollama.listen(0, '127.0.0.1', resolve));
process.env.OLLAMA_BASE_URL = `http://127.0.0.1:${ollama.address().port}`;

const importBuilt = file =>
  import(pathToFileURL(path.join(repoRoot, 'backend', 'dist', file)).href);
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
  { default: strandsRoutes },
  { authService },
  { userModel },
  runtime,
  access,
] = await Promise.all([
  importBuilt('routes/strands.js'),
  importBuilt('services/authService.js'),
  importBuilt('models/userModel.js'),
  importBuilt('strands/runtime.js'),
  importBuilt('services/strandsAccessService.js'),
]);

const admin = await userModel.createUser({
  username: 'strands_admin',
  email: 'strands-admin@example.test',
  password: 'Strands-Engine-Password-1!',
  role: 'admin',
  accountStatus: 'active',
});
const regular = await userModel.createUser({
  username: 'strands_user',
  email: 'strands-user@example.test',
  password: 'Strands-Engine-Password-1!',
  role: 'user',
  accountStatus: 'active',
});
const metadata = { kind: 'signup', ip: '203.0.113.7', userAgent: 'node-test' };
const adminToken = await authService.issueSession(admin, metadata);
const regularToken = await authService.issueSession(regular, metadata);

const app = express();
app.use(express.json());
app.use('/api/strands', strandsRoutes);
const server = await new Promise(resolve => {
  const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
});
const base = `http://127.0.0.1:${server.address().port}`;

const call = (endpoint, { token = adminToken, method = 'GET', body } = {}) =>
  fetch(`${base}/api/strands${endpoint}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      'content-type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

async function turn(sessionId, text, token = adminToken) {
  const response = await call(`/sessions/${sessionId}/messages`, {
    token,
    method: 'POST',
    body: { text },
  });
  assert.equal(response.status, 200);
  assert.match(
    response.headers.get('content-type') ?? '',
    /application\/x-ndjson/
  );
  const raw = await response.text();
  return raw
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

function findFile(root, name) {
  if (!fs.existsSync(root)) return undefined;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      const found = findFile(full, name);
      if (found) return found;
    } else if (entry.name === name) {
      return full;
    }
  }
  return undefined;
}

test.after(async () => {
  await runtime.stopStrandsEngine();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  ollama.closeAllConnections();
  await new Promise(resolve => ollama.close(resolve));
  await persistence.closePersistence();
  await rm(directory, { recursive: true, force: true });
});

test('Strands access fails closed and follows the admin setting and environment pin', async () => {
  assert.equal(await access.getStrandsAccessMode(), 'disabled');
  assert.equal(
    (await call('/sessions')).status,
    403,
    'a fresh install keeps the engine off, even for admins'
  );
  assert.equal((await call('/access')).status, 200);
  assert.equal(
    (await call('/access', { method: 'PUT', body: { mode: 'admins' } })).status,
    200
  );
  assert.equal((await call('/sessions')).status, 200);
  assert.equal((await call('/sessions', { token: null })).status, 401);
  assert.equal((await call('/sessions', { token: regularToken })).status, 403);
  assert.equal((await call('/models', { token: regularToken })).status, 403);
  assert.equal(
    (
      await call('/access', {
        token: regularToken,
        method: 'PUT',
        body: { mode: 'all-users' },
      })
    ).status,
    403,
    'only an admin may change who can use the engine'
  );
  assert.equal(
    (await call('/access', { method: 'PUT', body: { mode: 'everyone' } }))
      .status,
    400
  );

  const opened = await call('/access', {
    method: 'PUT',
    body: { mode: 'all-users' },
  });
  assert.equal(opened.status, 200);
  assert.equal((await call('/sessions', { token: regularToken })).status, 200);

  process.env.LIBRE_STRANDS_ACCESS = 'sometimes';
  try {
    assert.equal(await access.getStrandsAccessMode(), 'disabled');
    assert.equal(
      (await call('/sessions')).status,
      403,
      'a bad pin locks admins out too'
    );
    const pinned = await (await call('/access')).json();
    assert.equal(pinned.data.lockedByEnv, true);
    assert.equal(
      (await call('/access', { method: 'PUT', body: { mode: 'admins' } }))
        .status,
      409
    );
  } finally {
    delete process.env.LIBRE_STRANDS_ACCESS;
  }

  assert.equal(
    (await call('/access', { method: 'PUT', body: { mode: 'admins' } })).status,
    200
  );
  assert.equal((await call('/sessions', { token: regularToken })).status, 403);
});

test('a Strands turn streams NDJSON, runs a jailed file tool, and persists the transcript', async () => {
  const health = await (await call('/health')).json();
  assert.equal(health.data.available, true);
  assert.match(health.data.harnessVersion, /^\d+\.\d+\.\d+/);

  const models = (await (await call('/models')).json()).data;
  assert.deepEqual(
    models.map(model => model.id),
    ['ollama:fixture-agent'],
    'embedding models are not offered to the agent'
  );

  const created = await call('/sessions', {
    method: 'POST',
    body: { title: 'Fixture', model: 'ollama:fixture-agent' },
  });
  assert.equal(created.status, 201);
  const session = (await created.json()).data;

  const sigintBefore = process.listenerCount('SIGINT');
  const events = await turn(
    session.id,
    'Save a note at path=/workspace/notes.txt'
  );
  assert.equal(
    process.listenerCount('SIGINT'),
    sigintBefore,
    'loading the harness must not install process signal handlers'
  );
  const types = events.map(event => event.type);
  assert.equal(types[0], 'turn-start');
  assert.equal(types[types.length - 1], 'done');
  const toolStart = events.find(event => event.type === 'tool-start');
  assert.equal(toolStart?.name, 'write');
  const toolResult = events.find(event => event.type === 'tool-result');
  assert.equal(toolResult?.status, 'success');
  assert.equal(
    events
      .filter(event => event.type === 'text')
      .map(event => event.text)
      .join(''),
    'Saved the note.'
  );

  const written = findFile(
    path.join(process.env.DATA_DIR, 'strands'),
    'notes.txt'
  );
  assert.ok(written, 'the write tool lands inside the session workspace');
  assert.equal(fs.readFileSync(written, 'utf8'), 'hello from strands');
  assert.ok(
    written.startsWith(path.join(process.env.DATA_DIR, 'strands') + path.sep)
  );

  // The model only ever sees read, write and edit, and never a shell.
  const offered = new Set(
    chatRequests.flatMap(body =>
      (body.tools ?? []).map(tool => tool.function?.name)
    )
  );
  assert.ok(offered.has('write'));
  for (const name of ['shell', 'web_fetch', 'web_search', 'subagent']) {
    assert.equal(offered.has(name), false, `${name} must not be offered`);
  }

  const detail = (await (await call(`/sessions/${session.id}`)).json()).data;
  assert.equal(detail.running, false);
  assert.deepEqual(
    detail.messages.map(message => message.role),
    ['user', 'assistant']
  );
  assert.equal(detail.messages[1].content, 'Saved the note.');
});

test('the workspace jail rejects paths that leave the session root', async () => {
  const session = (
    await (
      await call('/sessions', {
        method: 'POST',
        body: { model: 'ollama:fixture-agent' },
      })
    ).json()
  ).data;
  const escape = path.join(directory, 'escaped.txt');
  const events = await turn(session.id, `Write it at path=${escape}`);
  const result = events.find(event => event.type === 'tool-result');
  assert.equal(result?.status, 'error');
  assert.equal(fs.existsSync(escape), false);
  assert.equal(events[events.length - 1].type, 'done');

  // Other accounts cannot see or drive this session.
  await call('/access', { method: 'PUT', body: { mode: 'all-users' } });
  try {
    assert.equal(
      (await call(`/sessions/${session.id}`, { token: regularToken })).status,
      404
    );
    assert.equal(
      (
        await call(`/sessions/${session.id}/messages`, {
          token: regularToken,
          method: 'POST',
          body: { text: 'hi' },
        })
      ).status,
      404
    );
  } finally {
    await call('/access', { method: 'PUT', body: { mode: 'admins' } });
  }
});
