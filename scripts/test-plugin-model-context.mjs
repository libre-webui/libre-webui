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

test('a catalog without windows is still stored as a plain list', () => {
  const serialized = catalog.serializeDiscoveredCatalog({
    models: ['a', 'b', 'a'],
  });
  assert.deepEqual(
    JSON.parse(serialized),
    ['a', 'b', 'a'],
    'releases that never knew about context windows read this column'
  );
  assert.deepEqual(catalog.parseDiscoveredCatalog(serialized), {
    models: ['a', 'b'],
  });
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

test('a catalog written before windows existed still reads', () => {
  assert.deepEqual(catalog.parseDiscoveredCatalog('["old-model", "", 7]'), {
    models: ['old-model'],
  });
});

test('an unreadable catalog reports nothing rather than guessing', () => {
  assert.deepEqual(catalog.parseDiscoveredCatalog('null'), { models: [] });
  assert.deepEqual(catalog.parseDiscoveredCatalog('{"version":1}'), {
    models: [],
  });
  assert.deepEqual(
    catalog.parseDiscoveredCatalog(
      '{"version":1,"models":["a"],"context":{"a":"wide"}}'
    ),
    { models: ['a'] },
    'a window that is not a number is dropped, the models are kept'
  );
});
