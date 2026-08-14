import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const sourceRoot = path.resolve('backend/src');
const walk = directory =>
  fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const candidate = path.join(directory, entry.name);
    return entry.isDirectory()
      ? walk(candidate)
      : entry.isFile() && entry.name.endsWith('.ts')
        ? [candidate]
        : [];
  });

test('new application code cannot import the SQLite database directly', () => {
  const violations = [];
  for (const filename of walk(sourceRoot)) {
    const relative = path
      .relative(sourceRoot, filename)
      .split(path.sep)
      .join('/');
    if (relative.startsWith('persistence/')) continue;
    const source = fs.readFileSync(filename, 'utf8');
    const importsDatabase =
      /(?:from\s+|import\s*\()\s*['"][^'"]*\/db\.js['"]/.test(source);
    if (importsDatabase) violations.push(relative);
  }

  assert.deepEqual(
    violations,
    [],
    `Route new persistence through a repository instead of db.ts: ${violations.join(', ')}`
  );
});

test('authenticated storage fails closed instead of selecting JSON at runtime', () => {
  const source = fs.readFileSync(path.join(sourceRoot, 'storage.ts'), 'utf8');
  assert.match(source, /getPersistence/);
  assert.match(source, /getPlatformStorageRuntime/);
  assert.doesNotMatch(source, /getDatabase(?:Safe)?/);
  assert.doesNotMatch(source, /useSQLite/);
  assert.doesNotMatch(source, /readFileSync|writeFileSync|existsSync/);
  assert.doesNotMatch(source, /Storage mode:.*JSON/);
});

test('stateful entrypoints keep the preflight import graph side-effect free', () => {
  for (const entrypoint of ['main.ts', 'worker.ts']) {
    const source = fs.readFileSync(path.join(sourceRoot, entrypoint), 'utf8');
    assert.match(source, /platform\/storage\/storageFactory\.js/);
    assert.doesNotMatch(
      source,
      /from ['"]\.\/platform\/storage\/index\.js['"]/
    );
    assert.ok(
      source.indexOf('provisionLegacyEncryptionKey') <
        source.indexOf("import('./services/encryptionService.js')"),
      `${entrypoint} must provision and validate keys before loading stateful services`
    );
  }
});
