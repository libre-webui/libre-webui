import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const repoRoot = path.resolve(import.meta.dirname, '..');
const pluginValidation = await import(
  pathToFileURL(
    path.join(repoRoot, 'backend', 'dist', 'utils', 'pluginValidation.js')
  ).href
);
const openRouterPlugin = JSON.parse(
  fs.readFileSync(path.join(repoRoot, 'plugins', 'openrouter.json'), 'utf8')
);
const expectedAttribution = {
  'HTTP-Referer': 'https://librewebui.org',
  'X-OpenRouter-Title': 'Libre WebUI',
  'X-OpenRouter-Categories': 'general-chat,personal-agent',
};

test('official OpenRouter requests identify Libre WebUI for app attribution', () => {
  assert.deepEqual(
    pluginValidation.buildPluginAttributionHeaders(
      openRouterPlugin,
      'https://openrouter.ai/api/v1/chat/completions'
    ),
    expectedAttribution
  );
  assert.deepEqual(
    pluginValidation.buildPluginAuthHeaders(
      openRouterPlugin,
      'test-openrouter-key',
      'https://openrouter.ai/api/v1/responses'
    ),
    {
      'Content-Type': 'application/json',
      Authorization: 'Bearer test-openrouter-key',
      ...expectedAttribution,
    }
  );
  assert.deepEqual(
    pluginValidation.buildPluginModelDiscoveryHeaders(
      openRouterPlugin,
      'test-openrouter-key',
      'https://openrouter.ai/api/v1/models'
    ),
    {
      Accept: 'application/json',
      Authorization: 'Bearer test-openrouter-key',
      ...expectedAttribution,
    }
  );
});

test('attribution is never sent to custom or lookalike endpoints', () => {
  for (const endpoint of [
    'http://openrouter.ai/api/v1/chat/completions',
    'https://openrouter.ai.example.test/api/v1/chat/completions',
    'https://gateway.example.test/v1/chat/completions',
    'not-a-url',
  ]) {
    assert.deepEqual(
      pluginValidation.buildPluginAttributionHeaders(
        openRouterPlugin,
        endpoint
      ),
      {}
    );
  }

  assert.deepEqual(
    pluginValidation.buildPluginAttributionHeaders(
      { id: 'openai' },
      'https://openrouter.ai/api/v1/chat/completions'
    ),
    {}
  );
});

test('every plugin request path opts into endpoint-scoped attribution', () => {
  const sources = [
    'backend/src/services/pluginService.ts',
    'backend/src/services/workModelProviderService.ts',
    'backend/src/services/pluginEmbeddingService.ts',
    'backend/src/services/pluginImageGenerationService.ts',
    'backend/src/services/pluginTTSService.ts',
  ].map(relativePath =>
    fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')
  );
  const combined = sources.join('\n');

  assert.match(
    combined,
    /buildPluginModelDiscoveryHeaders\([\s\S]*?modelsEndpoint/
  );
  assert.ok(
    combined.match(/buildPluginAuthHeaders\([^;]+?processedEndpoint,?\s*\)/g)
      ?.length >= 3,
    'chat, embedding, and TTS-compatible calls should bind attribution to their processed endpoint'
  );
  assert.ok(
    combined.match(/buildPluginAuthHeaders\(plugin, apiKey, endpoint\)/g)
      ?.length >= 3,
    'Work and capability calls should bind attribution to their resolved endpoint'
  );
  assert.match(
    combined,
    /buildPluginAttributionHeaders\(plugin, processedEndpoint\)/
  );
});
