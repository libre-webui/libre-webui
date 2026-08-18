import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

const catalog = await import(
  pathToFileURL(
    path.join(repoRoot, 'backend', 'dist', 'utils', 'pluginModelCatalog.js')
  ).href
);

test('a context window is read from whichever field the provider uses', () => {
  assert.equal(
    catalog.readModelContextLength({ id: 'a', context_length: 131072 }),
    131072
  );
  assert.equal(
    catalog.readModelContextLength({ id: 'a', context_window: 200000 }),
    200000
  );
  assert.equal(
    catalog.readModelContextLength({ id: 'a', inputTokenLimit: 1048576 }),
    1048576
  );
  assert.equal(
    catalog.readModelContextLength({ id: 'a', max_input_tokens: '8192' }),
    8192
  );

  // The provider actually serving the model wins over the catalog-wide value.
  assert.equal(
    catalog.readModelContextLength({
      id: 'a',
      context_length: 131072,
      top_provider: { context_length: 32768 },
    }),
    32768
  );
});

test('a window that is not a token count is left out', () => {
  for (const entry of [
    { id: 'a' },
    { id: 'a', context_length: 0 },
    { id: 'a', context_length: -1 },
    { id: 'a', context_length: 1.5 },
    { id: 'a', context_length: 'unlimited' },
    { id: 'a', context_length: null },
  ]) {
    assert.equal(
      catalog.readModelContextLength(entry),
      undefined,
      `${JSON.stringify(entry)} should report no window`
    );
  }
  assert.equal(catalog.readModelContextLength(undefined), undefined);
});

test('a listing yields the windows of the models that publish one', () => {
  assert.deepEqual(
    catalog.readModelContextMap([
      { id: 'big', context_length: 200000 },
      { id: 'quiet' },
      { id: 'small', context_length: 8192 },
      { context_length: 4096 },
      'not-an-entry',
      null,
    ]),
    { big: 200000, small: 8192 }
  );
});

test('a catalog without windows is still a catalog, not a legacy one', () => {
  const serialized = catalog.serializeDiscoveredCatalog({
    models: ['a', 'b', 'a'],
  });
  assert.deepEqual(catalog.parseDiscoveredCatalog(serialized), {
    models: ['a', 'b'],
  });
  assert.equal(
    catalog.parseDiscoveredCatalog(serialized).legacy,
    undefined,
    'a provider that publishes no windows should not be re-discovered forever'
  );
});

test('a catalog with windows round-trips both halves', () => {
  const serialized = catalog.serializeDiscoveredCatalog({
    models: ['a', 'b'],
    modelContext: { a: 128000 },
  });
  assert.deepEqual(catalog.parseDiscoveredCatalog(serialized), {
    models: ['a', 'b'],
    modelContext: { a: 128000 },
  });
});

test('a catalog written before windows existed reads, and is refreshed', () => {
  assert.deepEqual(catalog.parseDiscoveredCatalog('["old-model", "", 7]'), {
    models: ['old-model'],
    legacy: true,
  });
});

test('an unreadable catalog reports nothing rather than guessing', () => {
  assert.deepEqual(catalog.parseDiscoveredCatalog('null'), { models: [] });
  // A version-1 object without the reasoning key predates reasoning capture
  // and earns one refresh, exactly like the plain-array form did for windows.
  assert.deepEqual(catalog.parseDiscoveredCatalog('{"version":1}'), {
    models: [],
    legacy: true,
  });
  assert.deepEqual(
    catalog.parseDiscoveredCatalog(
      '{"version":1,"models":["a"],"context":{"a":"wide"},"reasoning":{}}'
    ),
    { models: ['a'] },
    'a window that is not a number is dropped, the models are kept'
  );
});

test('reasoning support is read from the listing or inferred from the name', () => {
  // OpenRouter-style: supported_parameters answers definitively both ways.
  assert.equal(
    catalog.readModelReasoningSupport({
      supported_parameters: ['temperature', 'reasoning'],
    }),
    true
  );
  assert.equal(
    catalog.readModelReasoningSupport({
      supported_parameters: ['temperature'],
    }),
    false
  );
  // A listing that says nothing stays unknown at this layer.
  assert.equal(catalog.readModelReasoningSupport({ id: 'gpt-4o' }), undefined);

  // Name heuristics for the listings that say nothing.
  assert.equal(catalog.inferReasoningFromModelId('gpt-4o'), false);
  assert.equal(catalog.inferReasoningFromModelId('gpt-5-mini'), true);
  assert.equal(catalog.inferReasoningFromModelId('o3-mini'), true);
  assert.equal(catalog.inferReasoningFromModelId('openai/gpt-oss-120b'), true);
  assert.equal(
    catalog.inferReasoningFromModelId('claude-3-5-sonnet-20241022'),
    false
  );
  assert.equal(catalog.inferReasoningFromModelId('claude-sonnet-4-5'), true);
  assert.equal(catalog.inferReasoningFromModelId('claude-3-7-sonnet'), true);
  assert.equal(catalog.inferReasoningFromModelId('gemini-2.0-flash'), false);
  assert.equal(
    catalog.inferReasoningFromModelId('gemini-2.5-flash'),
    true
  );
  assert.equal(catalog.inferReasoningFromModelId('deepseek/deepseek-r1'), true);
  assert.equal(
    catalog.inferReasoningFromModelId('totally-unknown-model'),
    undefined
  );
});

test('reasoning support round-trips through the stored catalog', () => {
  const entries = [
    { id: 'thinker', supported_parameters: ['reasoning'] },
    { id: 'plain', supported_parameters: ['temperature'] },
    { id: 'mystery' },
  ];
  const reasoning = catalog.readModelReasoningMap(entries);
  assert.deepEqual(reasoning, { thinker: true, plain: false });

  const parsed = catalog.parseDiscoveredCatalog(
    catalog.serializeDiscoveredCatalog({
      models: ['thinker', 'plain', 'mystery'],
      modelReasoning: reasoning,
    })
  );
  assert.deepEqual(parsed.modelReasoning, { thinker: true, plain: false });
  assert.notEqual(parsed.legacy, true, 'a fresh catalog is not legacy');
});
