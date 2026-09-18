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
process.env.LIBRE_CORDIS_ENABLED = 'false';
delete process.env.AGENT_CLI_MODELS_ENABLED;
delete process.env.LIBRE_CLAW_ENABLED;
const importBuilt = file =>
  import(pathToFileURL(path.join(repoRoot, 'backend', 'dist', file)).href);
const { encryptionService } = await importBuilt(
  'services/encryptionService.js'
);
const persistence = await importBuilt('persistence/index.js');
const applicationPersistence = await persistence.initializePersistence({
  dialect: 'sqlite',
  emailCodec: encryptionService,
  env: process.env,
});
const [
  access,
  settings,
  { default: agentCliService },
  { default: cliRoutes },
  { default: clawRoutes },
  { authService },
  { userModel },
] = await Promise.all([
  importBuilt('services/agentAccessService.js'),
  importBuilt('services/systemSettingsService.js'),
  importBuilt('services/agentCliService.js'),
  importBuilt('routes/agentCli.js'),
  importBuilt('routes/libreClaw.js'),
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
app.use('/api/libre-claw', clawRoutes);
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

test('fresh features stay disabled and initial legacy environment behavior is preserved', async () => {
  assert.equal(await access.getAgentsEnabled(), false);
  assert.equal(await access.getAgentCliModelsEnabled(), false);
  process.env.AGENT_CLI_MODELS_ENABLED = 'true';
  try {
    assert.equal(await access.getAgentCliModelsEnabled(), true);
    assert.equal(
      await access.getAgentsEnabled(),
      true,
      'an untouched old environment still supplies the former shared default'
    );
    assert.equal(access.agentCliModelsEnabledLockedByEnv(), true);
    assert.equal(
      access.agentsEnabledLockedByEnv(),
      false,
      'only the new Claw variable locks its independent toggle'
    );
    process.env.LIBRE_CLAW_ENABLED = 'false';
    assert.equal(await access.getAgentsEnabled(), false);
    assert.equal(await access.getAgentCliModelsEnabled(), true);
  } finally {
    delete process.env.AGENT_CLI_MODELS_ENABLED;
    delete process.env.LIBRE_CLAW_ENABLED;
  }
  process.env.LIBRE_CLAW_ENABLED = 'true';
  try {
    assert.equal(await access.getAgentsEnabled(), true);
    assert.equal(
      await access.getAgentCliModelsEnabled(),
      false,
      'the new Claw pin never opts into host CLIs'
    );
  } finally {
    delete process.env.LIBRE_CLAW_ENABLED;
  }
});

test('legacy persisted choice carries forward and the first Claw edit preserves CLI access', async () => {
  await settings.setSystemSetting(access.AGENTS_ENABLED_KEY, 'true');
  assert.equal(await access.getAgentCliModelsEnabled(), true);
  assert.equal(
    await settings.getSystemSetting(access.AGENT_CLI_MODELS_ENABLED_KEY),
    null
  );
  await access.setAgentsEnabled(false);
  assert.equal(await access.getAgentsEnabled(), false);
  assert.equal(await access.getAgentCliModelsEnabled(), true);
  assert.equal(
    await settings.getSystemSetting(access.AGENT_CLI_MODELS_ENABLED_KEY),
    'true'
  );
  const info = await authService.getSystemInfo();
  assert.equal(info.agentsEnabled, false);
  assert.equal(info.agentCliModelsEnabled, true);

  const bin = path.join(directory, 'bin');
  await mkdir(bin);
  await writeFile(path.join(bin, 'codex'), '#!/bin/sh\nexit 0\n', {
    mode: 0o755,
  });
  const previousPath = process.env.PATH;
  process.env.PATH = bin;
  try {
    assert.ok(
      (await agentCliService.listAgentModels()).some(
        model => model.agentId === 'codex'
      )
    );
    await agentCliService.assertAgentAccess(admin.id);
  } finally {
    process.env.PATH = previousPath;
  }
});

test('CLI changes never alter Claw and Claw changes preserve explicit CLI choices', async () => {
  await access.setAgentsEnabled(true);
  await access.setAgentCliModelsEnabled(false);
  assert.equal(await access.getAgentsEnabled(), true);
  assert.equal(await access.getAgentCliModelsEnabled(), false);
  assert.deepEqual(await agentCliService.listAgentModels(), []);
  await assert.rejects(agentCliService.assertAgentAccess(admin.id), /disabled/);
  const info = await authService.getSystemInfo();
  assert.equal(info.agentsEnabled, true);
  assert.equal(info.agentCliModelsEnabled, false);
  await access.setAgentsEnabled(false);
  await access.setAgentsEnabled(true);
  assert.equal(await access.getAgentCliModelsEnabled(), false);
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
  assert.equal(await access.getAgentsEnabled(), true);
  assert.equal(
    (await request('/api/libre-claw/access', { method: 'PUT', enabled: false }))
      .status,
    200
  );
  assert.equal(await access.getAgentsEnabled(), false);
  assert.equal(await access.getAgentCliModelsEnabled(), true);
});

test('each environment pin locks only its own setting and remains visible in system info', async () => {
  process.env.AGENT_CLI_MODELS_ENABLED = 'false';
  process.env.LIBRE_CLAW_ENABLED = 'true';
  try {
    assert.deepEqual(
      (await (await request('/api/agent-clis/access')).json()).data,
      { enabled: false, lockedByEnv: true }
    );
    assert.deepEqual(
      (await (await request('/api/libre-claw/access')).json()).data,
      { enabled: true, lockedByEnv: true }
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
    assert.equal(
      (
        await request('/api/libre-claw/access', {
          method: 'PUT',
          enabled: false,
        })
      ).status,
      409
    );
    const info = await authService.getSystemInfo();
    assert.equal(info.agentsEnabled, true);
    assert.equal(info.agentCliModelsEnabled, false);
    delete process.env.LIBRE_CLAW_ENABLED;
    assert.equal(
      (
        await request('/api/libre-claw/access', {
          method: 'PUT',
          enabled: true,
        })
      ).status,
      200,
      'the CLI environment pin does not lock Claw'
    );
    assert.equal(await access.getAgentCliModelsEnabled(), false);
  } finally {
    delete process.env.AGENT_CLI_MODELS_ENABLED;
    delete process.env.LIBRE_CLAW_ENABLED;
  }
  assert.equal(
    await access.getAgentCliModelsEnabled(),
    true,
    'the saved CLI choice survives its temporary environment pin'
  );
});

test('a concurrent CLI revocation wins over first-edit Claw compatibility defaults', async t => {
  // Reset only the dedicated fixture setting to model an untouched upgraded DB.
  const { getDatabase } = await importBuilt('db.js');
  getDatabase()
    .prepare('DELETE FROM system_settings WHERE key = ?')
    .run(access.AGENT_CLI_MODELS_ENABLED_KEY);
  await settings.setSystemSetting(access.AGENTS_ENABLED_KEY, 'true');
  assert.equal(await access.getAgentCliModelsEnabled(), true);
  const repository =
    applicationPersistence.repositories.resources.systemSettings;
  const save = repository.upsertMany.bind(repository);
  t.mock.method(
    repository,
    'upsertMany',
    async (values, updatedAt, defaults) => {
      assert.equal(defaults[access.AGENT_CLI_MODELS_ENABLED_KEY], 'true');
      // This is the other administrator's explicit edit between the initial
      // legacy snapshot and the atomic migration/save transaction.
      await access.setAgentCliModelsEnabled(false);
      await save(values, updatedAt, defaults);
    }
  );
  await access.setAgentsEnabled(false);
  assert.equal(await access.getAgentsEnabled(), false);
  assert.equal(await access.getAgentCliModelsEnabled(), false);
  assert.equal(
    await settings.getSystemSetting(access.AGENT_CLI_MODELS_ENABLED_KEY),
    'false'
  );
});
