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
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('unset validation accepts only schema variable names', async () => {
  const { validatePluginVariablesToUnset } =
    await import('../backend/dist/utils/pluginVariableValidation.js');
  const schema = [
    { name: 'endpoint', type: 'string', label: 'API endpoint' },
    { name: 'temperature', type: 'number', label: 'Temperature' },
  ];

  assert.deepEqual(validatePluginVariablesToUnset(schema, undefined), {
    success: true,
    variables: [],
  });
  assert.deepEqual(
    validatePluginVariablesToUnset(schema, [
      'endpoint',
      'endpoint',
      'temperature',
    ]),
    {
      success: true,
      variables: ['endpoint', 'temperature'],
    }
  );
  assert.deepEqual(validatePluginVariablesToUnset(schema, 'endpoint'), {
    success: false,
    error: 'Variable names to unset must be an array',
  });
  assert.deepEqual(validatePluginVariablesToUnset(schema, ['unknown']), {
    success: false,
    error: 'Cannot unset unknown plugin variable "unknown"',
  });
});

test('unsetting an override restores defaults without affecting other users or variables', async () => {
  const dataDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'libre-webui-plugin-overrides-')
  );
  const previousDataDirectory = process.env.DATA_DIR;
  process.env.DATA_DIR = dataDirectory;

  const { closeDatabase, getDatabase } = await import('../backend/dist/db.js');
  const { default: pluginVariablesService } =
    await import('../backend/dist/services/pluginVariablesService.js');

  const schema = [
    {
      name: 'endpoint',
      type: 'string',
      label: 'API endpoint',
      default: 'https://provider.example/v1/chat/completions',
    },
    {
      name: 'temperature',
      type: 'number',
      label: 'Temperature',
      default: 0.7,
      min: 0,
      max: 2,
    },
    {
      name: 'secret_header',
      type: 'string',
      label: 'Secret header',
      sensitive: true,
    },
  ];
  const pluginId = 'provider-under-test';
  const firstUserId = 'provider-user-one';
  const secondUserId = 'provider-user-two';

  try {
    const database = getDatabase();
    const now = Date.now();
    const insertUser = database.prepare(`
      INSERT INTO users
        (id, username, email, password_hash, role, created_at, updated_at)
      VALUES (?, ?, NULL, ?, 'user', ?, ?)
    `);
    insertUser.run(firstUserId, firstUserId, 'test', now, now);
    insertUser.run(secondUserId, secondUserId, 'test', now, now);

    assert.deepEqual(
      await pluginVariablesService.getResolvedVariables(
        pluginId,
        schema,
        firstUserId
      ),
      {
        endpoint: 'https://provider.example/v1/chat/completions',
        temperature: 0.7,
        secret_header: '',
      }
    );

    assert.equal(
      await pluginVariablesService.setVariables(
        pluginId,
        {
          endpoint: 'https://first.example/v1/chat/completions',
          temperature: 0.2,
        },
        schema,
        firstUserId
      ),
      true
    );
    assert.equal(
      await pluginVariablesService.setVariables(
        pluginId,
        {
          endpoint: 'https://second.example/v1/chat/completions',
        },
        schema,
        secondUserId
      ),
      true
    );

    // Prime the resolved-value cache before clearing the first user's endpoint.
    assert.equal(
      (
        await pluginVariablesService.getResolvedVariables(
          pluginId,
          schema,
          firstUserId
        )
      ).endpoint,
      'https://first.example/v1/chat/completions'
    );

    assert.equal(
      await pluginVariablesService.setVariables(
        pluginId,
        {},
        schema,
        firstUserId,
        ['endpoint']
      ),
      true
    );

    const firstUserDisplay = await pluginVariablesService.getVariables(
      pluginId,
      schema,
      firstUserId,
      true
    );
    assert.deepEqual(firstUserDisplay.endpoint, {
      name: 'endpoint',
      value: 'https://provider.example/v1/chat/completions',
      is_sensitive: false,
      has_value: false,
    });
    assert.equal(firstUserDisplay.temperature.has_value, true);
    assert.equal(firstUserDisplay.temperature.value, 0.2);

    assert.deepEqual(
      await pluginVariablesService.getResolvedVariables(
        pluginId,
        schema,
        firstUserId
      ),
      {
        endpoint: 'https://provider.example/v1/chat/completions',
        temperature: 0.2,
        secret_header: '',
      }
    );
    assert.equal(
      (
        await pluginVariablesService.getResolvedVariables(
          pluginId,
          schema,
          secondUserId
        )
      ).endpoint,
      'https://second.example/v1/chat/completions'
    );

    assert.equal(
      await pluginVariablesService.setVariables(
        pluginId,
        { unknown: 'value' },
        schema,
        firstUserId
      ),
      false
    );
    assert.equal(
      await pluginVariablesService.setVariables(
        pluginId,
        { temperature: 0.9 },
        schema,
        firstUserId,
        ['temperature']
      ),
      false
    );
    assert.equal(
      (await pluginVariablesService.getVariables(pluginId, schema, firstUserId))
        .temperature.value,
      0.2
    );

    assert.equal(
      await pluginVariablesService.setVariables(
        pluginId,
        {
          endpoint: 'https://rollback.example/v1/chat/completions',
          secret_header: 'original-secret',
        },
        schema,
        firstUserId
      ),
      true
    );

    const { encryptionService } =
      await import('../backend/dist/services/encryptionService.js');
    const originalEncrypt = encryptionService.encrypt;
    try {
      encryptionService.encrypt = () => {
        throw new Error('forced encryption failure');
      };
      assert.equal(
        await pluginVariablesService.setVariables(
          pluginId,
          {
            temperature: 0.9,
            secret_header: 'replacement-secret',
          },
          schema,
          firstUserId,
          ['endpoint']
        ),
        false
      );
    } finally {
      encryptionService.encrypt = originalEncrypt;
    }

    const valuesAfterRollback = await pluginVariablesService.getVariables(
      pluginId,
      schema,
      firstUserId
    );
    assert.equal(
      valuesAfterRollback.endpoint.value,
      'https://rollback.example/v1/chat/completions'
    );
    assert.equal(valuesAfterRollback.temperature.value, 0.2);
    assert.equal(valuesAfterRollback.secret_header.value, 'original-secret');
  } finally {
    closeDatabase();
    if (previousDataDirectory === undefined) {
      delete process.env.DATA_DIR;
    } else {
      process.env.DATA_DIR = previousDataDirectory;
    }
    fs.rmSync(dataDirectory, { recursive: true, force: true });
  }
});

test('plugin variable invalidation reaches peer service caches before the write returns', async () => {
  const dataDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'libre-webui-plugin-cache-invalidation-')
  );
  const previousEnvironment = new Map(
    [
      'DATA_DIR',
      'LIBRE_PLATFORM_MODE',
      'DATABASE_BACKEND',
      'COORDINATION_BACKEND',
    ].map(name => [name, process.env[name]])
  );
  process.env.DATA_DIR = dataDirectory;
  process.env.LIBRE_PLATFORM_MODE = 'solo';
  process.env.DATABASE_BACKEND = 'sqlite';
  process.env.COORDINATION_BACKEND = 'local';

  const { closeDatabase, getDatabase } = await import('../backend/dist/db.js');
  const { PluginVariablesService } =
    await import('../backend/dist/services/pluginVariablesService.js');
  const {
    closePluginCacheInvalidation,
    getPluginCacheInvalidationHealth,
    probePluginCacheInvalidationHealth,
  } = await import('../backend/dist/services/pluginCacheInvalidation.js');
  const coordination =
    await import('../backend/dist/platform/coordination/service.js');
  const writer = new PluginVariablesService();
  const reader = new PluginVariablesService();
  const pluginId = 'replicated-provider';
  const userId = 'replicated-user';
  const schema = [
    {
      name: 'endpoint',
      type: 'string',
      label: 'API endpoint',
      default: 'https://default.example/v1',
    },
  ];

  try {
    await coordination.resetPlatformServicesForTests();
    await coordination.initializeCoordinator();
    const database = getDatabase();
    const now = Date.now();
    database
      .prepare(
        `INSERT INTO users
           (id, username, email, password_hash, role, created_at, updated_at)
         VALUES (?, ?, NULL, 'hash', 'user', ?, ?)`
      )
      .run(userId, userId, now, now);

    assert.equal(
      (await reader.getResolvedVariables(pluginId, schema, userId)).endpoint,
      'https://default.example/v1'
    );
    assert.equal(
      await writer.setVariables(
        pluginId,
        { endpoint: 'https://new.example/v1' },
        schema,
        userId
      ),
      true
    );
    assert.equal(
      (await reader.getResolvedVariables(pluginId, schema, userId)).endpoint,
      'https://new.example/v1'
    );

    const coordinator = coordination.getCoordinator();
    const originalPublish = coordinator.publish.bind(coordinator);
    coordinator.publish = async () => {
      throw new Error('forced invalidation publication failure');
    };
    try {
      assert.equal(
        await writer.setVariables(
          pluginId,
          { endpoint: 'https://committed.example/v1' },
          schema,
          userId
        ),
        true,
        'a post-commit publication failure must not report the SQL mutation as failed'
      );
      assert.equal(getPluginCacheInvalidationHealth().ready, false);
      assert.equal(
        (await reader.getResolvedVariables(pluginId, schema, userId)).endpoint,
        'https://committed.example/v1',
        'the writer process still invalidates its local peers before publication'
      );
    } finally {
      coordinator.publish = originalPublish;
    }

    assert.equal(
      (await probePluginCacheInvalidationHealth()).ready,
      true,
      'readiness must recover after the coordinator does, without another mutation'
    );
    assert.equal(
      (await reader.getResolvedVariables(pluginId, schema, userId)).endpoint,
      'https://committed.example/v1'
    );
  } finally {
    await Promise.all([
      writer.closeCacheInvalidation(),
      reader.closeCacheInvalidation(),
    ]);
    await closePluginCacheInvalidation();
    await coordination.closeCoordinator();
    closeDatabase();
    for (const [name, value] of previousEnvironment) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    fs.rmSync(dataDirectory, { recursive: true, force: true });
  }
});
