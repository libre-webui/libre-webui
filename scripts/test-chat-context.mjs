import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const distRoot = path.join(repoRoot, 'backend', 'dist');

const chatContext = await import(
  pathToFileURL(path.join(distRoot, 'utils', 'chatContext.js')).href
);

function withEnv(overrides, run) {
  const previous = {};

  for (const key of Object.keys(overrides)) {
    previous[key] = process.env[key];
    if (overrides[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = overrides[key];
    }
  }

  return Promise.resolve()
    .then(run)
    .finally(() => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    });
}

test('replaceLatestUserMessageContent updates the latest user message without appending', () => {
  const messages = [
    { role: 'system', content: 'system' },
    { role: 'user', content: 'first prompt' },
    { role: 'assistant', content: 'first answer' },
    { role: 'user', content: 'latest prompt' },
  ];

  const result = chatContext.replaceLatestUserMessageContent(
    messages,
    'context wrapped latest prompt'
  );

  assert.equal(result.length, messages.length);
  assert.equal(result[1].content, 'first prompt');
  assert.equal(result[3].content, 'context wrapped latest prompt');
  assert.equal(messages[3].content, 'latest prompt');
});

test('toOllamaMessages replaces latest user content and normalizes image payloads', () => {
  const result = chatContext.toOllamaMessages(
    [
      {
        role: 'user',
        content: 'see this',
        images: ['data:image/png;base64,abc123', 'raw456'],
      },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'now answer' },
    ],
    { latestUserContent: 'answer with document context' }
  );

  assert.deepEqual(result, [
    {
      role: 'user',
      content: 'see this',
      images: ['abc123', 'raw456'],
    },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: 'answer with document context' },
  ]);
});

test('withSystemPrompt replaces stale system messages with the persona prompt', () => {
  const result = chatContext.withSystemPrompt(
    [
      { role: 'system', content: 'old system' },
      { role: 'user', content: 'hello' },
    ],
    '  persona system  '
  );

  assert.deepEqual(result, [
    { role: 'system', content: 'persona system' },
    { role: 'user', content: 'hello' },
  ]);
});

test('plugin model routing requires an active plugin and the current user credentials', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'libre-plugin-route-'));
  const pluginsDir = path.join(tempDir, 'plugins');
  const dataDir = path.join(tempDir, 'data');
  const previousCwd = process.cwd();

  const writePlugin = plugin => {
    fs.writeFileSync(
      path.join(pluginsDir, `${plugin.id}.json`),
      JSON.stringify(plugin, null, 2)
    );
  };

  fs.mkdirSync(pluginsDir, { recursive: true });
  writePlugin({
    id: 'active-plugin',
    name: 'Active Plugin',
    type: 'completion',
    endpoint: 'https://example.invalid/v1/chat/completions',
    auth: {
      header: 'Authorization',
      prefix: 'Bearer ',
      key_env: 'ACTIVE_PLUGIN_TEST_KEY',
    },
    model_map: ['shared-model'],
  });
  writePlugin({
    id: 'inactive-plugin',
    name: 'Inactive Plugin',
    type: 'completion',
    endpoint: 'https://example.invalid/v1/chat/completions',
    auth: {
      header: 'Authorization',
      prefix: 'Bearer ',
      key_env: 'INACTIVE_PLUGIN_TEST_KEY',
    },
    model_map: ['shared-model', 'inactive-only-model'],
  });
  fs.writeFileSync(
    path.join(pluginsDir, '.status.json'),
    JSON.stringify({ activePlugins: ['active-plugin'] }, null, 2)
  );

  try {
    await withEnv(
      {
        ACTIVE_PLUGIN_TEST_KEY: undefined,
        INACTIVE_PLUGIN_TEST_KEY: undefined,
        DATA_DIR: dataDir,
        ENCRYPTION_KEY:
          '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      },
      async () => {
        process.chdir(tempDir);

        const { getDatabaseSafe } = await import(
          pathToFileURL(path.join(distRoot, 'db.js')).href
        );
        const db = getDatabaseSafe();

        try {
          assert.ok(db, 'test database should be available');

          const now = Date.now();
          db.prepare(
            `INSERT INTO users (id, username, password_hash, role, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)`
          ).run('alice', 'alice', 'test-hash', 'user', now, now);

          const credentialsService = (
            await import(
              pathToFileURL(
                path.join(distRoot, 'services', 'pluginCredentialsService.js')
              ).href
            )
          ).default;
          const chatGenerationService = (
            await import(
              `${pathToFileURL(path.join(distRoot, 'services', 'chatGenerationService.js')).href}?generationRouteTest=${Date.now()}`
            )
          ).default;

          assert.equal(
            credentialsService.setApiKey('active-plugin', 'alice-key', 'alice'),
            true
          );

          const aliceTarget =
            await chatGenerationService.prepareGenerationTarget(
              'shared-model',
              'alice',
              { temperature: 0.2 }
            );
          assert.equal(aliceTarget.actualModelName, 'shared-model');
          assert.equal(aliceTarget.mergedOptions.temperature, 0.2);
          assert.equal(aliceTarget.activePlugin?.id, 'active-plugin');

          assert.equal(
            (
              await chatGenerationService.prepareGenerationTarget(
                'shared-model',
                'bob'
              )
            ).activePlugin,
            null
          );
          assert.equal(
            (
              await chatGenerationService.prepareGenerationTarget(
                'inactive-only-model',
                'alice'
              )
            ).activePlugin,
            null
          );
        } finally {
          db?.close();
          process.chdir(previousCwd);
        }
      }
    );
  } finally {
    process.chdir(previousCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
