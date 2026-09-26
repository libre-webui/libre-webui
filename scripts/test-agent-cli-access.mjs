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
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import express from 'express';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);
const directory = await mkdtemp(path.join(os.tmpdir(), 'libre-cli-access-'));
process.env.DATA_DIR = path.join(directory, 'data');
process.env.PLUGINS_DIR = path.join(directory, 'plugins');
process.env.ENCRYPTION_KEY = '6'.repeat(64);
process.env.JWT_SECRET = 'agent-cli-access-test-secret-value';
delete process.env.AGENT_CLI_MODELS_ENABLED;
delete process.env.LIBRE_STRANDS_ACCESS;
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
  access,
  settings,
  { default: agentCliService },
  { default: cliRoutes },
  { authService },
  { userModel },
] = await Promise.all([
  importBuilt('services/agentAccessService.js'),
  importBuilt('services/systemSettingsService.js'),
  importBuilt('services/agentCliService.js'),
  importBuilt('routes/agentCli.js'),
  importBuilt('services/authService.js'),
  importBuilt('models/userModel.js'),
]);
const admin = await userModel.createUser({
  username: 'cli_access_admin',
  email: 'cli-access-admin@example.test',
  password: 'Agent-Access-Password-1!',
  role: 'admin',
  accountStatus: 'active',
});
const regular = await userModel.createUser({
  username: 'cli_access_user',
  email: 'cli-access-user@example.test',
  password: 'Agent-Access-Password-1!',
  role: 'user',
  accountStatus: 'active',
});
const metadata = { kind: 'signup', ip: '203.0.113.1', userAgent: 'node-test' };
const adminToken = await authService.issueSession(admin, metadata);
const regularToken = await authService.issueSession(regular, metadata);
const app = express();
app.use(express.json());
app.use('/api/agent-clis', cliRoutes);
const server = await new Promise(resolve => {
  const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
});
const base = `http://127.0.0.1:${server.address().port}`;
const request = (
  endpoint,
  { token = adminToken, enabled, body, method = 'GET' } = {}
) =>
  fetch(`${base}${endpoint}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      'content-type': 'application/json',
    },
    ...(method === 'PUT' ? { body: JSON.stringify(body ?? { enabled }) } : {}),
  });
test.after(async () => {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await persistence.closePersistence();
  await rm(directory, { recursive: true, force: true });
});

test('CLI models stay disabled on a fresh install and follow the environment pin', async () => {
  assert.equal(await access.getAgentCliModelsEnabled(), false);
  assert.equal(access.agentCliModelsEnabledLockedByEnv(), false);
  process.env.AGENT_CLI_MODELS_ENABLED = 'true';
  try {
    assert.equal(await access.getAgentCliModelsEnabled(), true);
    assert.equal(access.agentCliModelsEnabledLockedByEnv(), true);
  } finally {
    delete process.env.AGENT_CLI_MODELS_ENABLED;
  }
  process.env.AGENT_CLI_MODELS_ENABLED = 'maybe';
  try {
    assert.equal(
      await access.getAgentCliModelsEnabled(),
      false,
      'a malformed pin is ignored and the saved choice applies'
    );
    assert.equal(access.agentCliModelsEnabledLockedByEnv(), false);
  } finally {
    delete process.env.AGENT_CLI_MODELS_ENABLED;
  }
});

test('the legacy shared agents decision remains the CLI fallback until an admin edits it', async () => {
  await settings.setSystemSetting('agents_enabled', 'true');
  assert.equal(await access.getAgentCliModelsEnabled(), true);
  assert.equal(
    await settings.getSystemSetting(access.AGENT_CLI_MODELS_ENABLED_KEY),
    null
  );
  await access.setAgentCliModelsEnabled(false);
  assert.equal(
    await access.getAgentCliModelsEnabled(),
    false,
    'the dedicated setting wins over the legacy key once saved'
  );
  const info = await authService.getSystemInfo();
  assert.equal(info.agentCliModelsEnabled, false);
  assert.equal('agentsEnabled' in info, false);
  assert.equal('cordisEnabled' in info, false);
});

test('enabled CLI models are listed for administrators and never for regular users', async () => {
  await access.setAgentCliModelsEnabled(true);
  const bin = path.join(directory, 'bin');
  await mkdir(bin, { recursive: true });
  await writeFile(path.join(bin, 'codex'), '#!/bin/sh\nexit 0\n', {
    mode: 0o755,
  });
  const previousPath = process.env.PATH;
  process.env.PATH = bin;
  try {
    assert.ok(
      (await agentCliService.listAgentModels(admin.id)).some(
        model => model.agentId === 'codex'
      )
    );
    assert.equal(
      (await agentCliService.listAgentModels(regular.id)).some(
        model => model.agentId === 'codex'
      ),
      false
    );
    await agentCliService.assertAgentAccess(admin.id);
    await assert.rejects(
      agentCliService.assertAgentAccess(regular.id),
      /admin account/
    );
  } finally {
    process.env.PATH = previousPath;
  }
  await access.setAgentCliModelsEnabled(false);
  assert.deepEqual(await agentCliService.listAgentModels(admin.id), []);
  await assert.rejects(agentCliService.assertAgentAccess(admin.id), /disabled/);
});

test('CLI access endpoints enforce administrator authentication and boolean input', async () => {
  const regularModels = await request('/api/agent-clis/models', {
    token: regularToken,
  });
  assert.equal(regularModels.status, 200);
  assert.deepEqual((await regularModels.json()).data, []);
  for (const method of ['GET', 'PUT']) {
    assert.equal(
      (
        await request('/api/agent-clis/access', {
          method,
          token: null,
          enabled: true,
        })
      ).status,
      401
    );
    assert.equal(
      (
        await request('/api/agent-clis/access', {
          method,
          token: regularToken,
          enabled: true,
        })
      ).status,
      403
    );
  }
  assert.equal(
    (
      await request('/api/agent-clis/access', {
        method: 'PUT',
        body: { enabled: 'true' },
      })
    ).status,
    400
  );
  assert.deepEqual(
    (await (await request('/api/agent-clis/access')).json()).data,
    { enabled: false, lockedByEnv: false }
  );
  assert.deepEqual(
    (
      await (
        await request('/api/agent-clis/access', {
          method: 'PUT',
          enabled: true,
        })
      ).json()
    ).data,
    { enabled: true, lockedByEnv: false }
  );
  assert.equal(await access.getAgentCliModelsEnabled(), true);
});

test('the environment pin locks the CLI setting and the saved choice survives it', async () => {
  process.env.AGENT_CLI_MODELS_ENABLED = 'false';
  try {
    assert.deepEqual(
      (await (await request('/api/agent-clis/access')).json()).data,
      { enabled: false, lockedByEnv: true }
    );
    assert.equal(
      (
        await request('/api/agent-clis/access', {
          method: 'PUT',
          enabled: true,
        })
      ).status,
      409
    );
    const info = await authService.getSystemInfo();
    assert.equal(info.agentCliModelsEnabled, false);
  } finally {
    delete process.env.AGENT_CLI_MODELS_ENABLED;
  }
  assert.equal(
    await access.getAgentCliModelsEnabled(),
    true,
    'the saved CLI choice survives its temporary environment pin'
  );
});
