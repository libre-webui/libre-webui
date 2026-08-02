import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const repoRoot = path.resolve(import.meta.dirname, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'libre-plugin-usage-'));
process.env.DATA_DIR = tempDir;

const usageModule = await import(
  pathToFileURL(
    path.join(repoRoot, 'backend', 'dist', 'services', 'pluginUsageService.js')
  ).href
);
const dbModule = await import(
  pathToFileURL(path.join(repoRoot, 'backend', 'dist', 'db.js')).href
);

test.after(() => {
  dbModule.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('normalizes provider token usage without estimating missing counters', () => {
  assert.deepEqual(
    usageModule.normalizeProviderTokenUsage({
      usage: {
        prompt_tokens: 120,
        completion_tokens: 30,
        total_tokens: 150,
      },
    }),
    { promptTokens: 120, completionTokens: 30, totalTokens: 150 }
  );
  assert.deepEqual(
    usageModule.normalizeProviderTokenUsage({
      usage: { input_tokens: 80, output_tokens: 20 },
    }),
    { promptTokens: 80, completionTokens: 20, totalTokens: 100 }
  );
  assert.equal(
    usageModule.normalizeProviderTokenUsage({ usage: {} }),
    undefined
  );
});

test('aggregates calls, provider-reported tokens, failures, and capability units', () => {
  const service = new usageModule.PluginUsageService();
  const now = Date.now();
  service.record({
    userId: 'user-one',
    pluginId: 'openai',
    pluginName: 'OpenAI',
    capability: 'chat',
    model: 'gpt-test',
    status: 'success',
    durationMs: 800,
    tokens: { promptTokens: 100, completionTokens: 40, totalTokens: 140 },
    createdAt: now - 60_000,
  });
  service.record({
    userId: 'user-two',
    pluginId: 'openai',
    pluginName: 'OpenAI',
    capability: 'chat',
    model: 'gpt-test',
    status: 'error',
    durationMs: 1200,
    createdAt: now - 30_000,
  });
  service.record({
    userId: 'user-one',
    pluginId: 'image-provider',
    pluginName: 'Image Provider',
    capability: 'image',
    model: 'image-test',
    status: 'success',
    durationMs: 4000,
    outputUnits: 2,
    unitKind: 'images',
    createdAt: now - 10_000,
  });

  const analytics = service.getAnalytics(7);
  assert.equal(analytics.totals.calls, 3);
  assert.equal(analytics.totals.successfulCalls, 2);
  assert.equal(analytics.totals.failedCalls, 1);
  assert.equal(analytics.totals.meteredCalls, 1);
  assert.equal(analytics.totals.reportedTokens, 140);
  assert.equal(analytics.totals.uniqueUsers, 2);
  assert.equal(
    analytics.series.reduce((sum, point) => sum + point.calls, 0),
    3
  );
  assert.deepEqual(
    analytics.models.map(model => [model.model, model.calls, model.tokens]),
    [
      ['gpt-test', 2, 140],
      ['image-test', 1, 0],
    ]
  );
  assert.equal(
    analytics.capabilities.find(item => item.capability === 'image')
      ?.outputUnits,
    2
  );

  const columns = dbModule
    .getDatabase()
    .prepare('PRAGMA table_info(plugin_usage_events)')
    .all()
    .map(column => column.name);
  assert.ok(!columns.includes('prompt'));
  assert.ok(!columns.includes('response'));
  assert.ok(!columns.includes('endpoint'));
  assert.ok(!columns.includes('error_body'));
});

test('rejects analytics windows larger than the public API permits by clamping service input', () => {
  const service = new usageModule.PluginUsageService();
  assert.equal(service.getAnalytics(0).range.days, 1);
  assert.equal(service.getAnalytics(999).range.days, 365);
});

test('the usage endpoint is explicitly protected by administrator middleware', () => {
  const routeSource = fs.readFileSync(
    path.join(repoRoot, 'backend', 'src', 'routes', 'plugins.ts'),
    'utf8'
  );
  assert.match(routeSource, /router\.get\(\s*['"]\/usage['"],\s*requireAdmin,/);
});
