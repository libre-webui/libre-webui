import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';

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

const importedModules = (filename, source) => {
  const modules = new Set();
  const sourceFile = ts.createSourceFile(
    filename,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const addLiteral = node => {
    if (node && ts.isStringLiteralLike(node)) modules.add(node.text);
  };
  const visit = node => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      addLiteral(node.moduleSpecifier);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      addLiteral(node.moduleReference.expression);
    } else if (ts.isCallExpression(node) && node.arguments.length === 1) {
      const isDynamicImport =
        node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire =
        ts.isIdentifier(node.expression) && node.expression.text === 'require';
      if (isDynamicImport || isRequire) addLiteral(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return modules;
};

test('new application code cannot import the SQLite database directly', () => {
  const violations = [];
  for (const filename of walk(sourceRoot)) {
    const relative = path
      .relative(sourceRoot, filename)
      .split(path.sep)
      .join('/');
    if (relative.startsWith('persistence/')) continue;
    const source = fs.readFileSync(filename, 'utf8');
    const importsDatabase = [...importedModules(filename, source)].some(
      specifier => specifier.endsWith('/db.js')
    );
    if (importsDatabase) violations.push(relative);
  }

  assert.deepEqual(
    violations,
    [],
    `Route new persistence through a repository instead of db.ts: ${violations.join(', ')}`
  );
});

test('SQLite driver imports stay inside audited adapter and recovery boundaries', () => {
  const allowedFiles = new Set([
    'db.ts',
    'persistence/index.ts',
    'persistence/sqliteExtensionRepositories.ts',
    'persistence/sqliteMigrations.ts',
    'persistence/sqlitePersistence.ts',
    'persistence/sqliteResourceRepositories.ts',
    'persistence/sqliteSecurityRepositories.ts',
    'persistence/sqliteSyncExecutor.ts',
    'persistence/sqliteToPostgresMigration.ts',
    'platform/jobs/sqliteDurableJobRepository.ts',
    'platform/storage/blobReferenceRepository.ts',
    'platform/storage/durableBlobQuotaPolicy.ts',
    'platform/storage/sqliteEncryptedVectorStore.ts',
    'platform/storage/sqlitePlatformDomainRepositories.ts',
    'platform/storage/sqliteToTeamStorageMigration.ts',
    'platform/storage/storageFactory.ts',
    'platform/workPersistence/sqliteWorkPersistence.ts',
    'services/healthService.ts',
    'services/legacyCiphertextIntegrity.ts',
    'services/recoveryInventoryService.ts',
  ]);
  const violations = [];
  for (const filename of walk(sourceRoot)) {
    const relative = path
      .relative(sourceRoot, filename)
      .split(path.sep)
      .join('/');
    const source = fs.readFileSync(filename, 'utf8');
    const importsDriver = importedModules(filename, source).has(
      'better-sqlite3'
    );
    if (!importsDriver) continue;
    if (allowedFiles.has(relative)) continue;
    violations.push(relative);
  }

  assert.deepEqual(
    violations,
    [],
    `Move SQLite driver access into an audited adapter boundary: ${violations.join(', ')}`
  );
});

test('common job and domain contracts do not expose SQLite driver handles', () => {
  const commonFiles = [
    'persistence/chatGenerationTypes.ts',
    'persistence/identityDeletionTypes.ts',
    'platform/jobs/chatGenerationEnqueuer.ts',
    'platform/jobs/documentIngestionEnqueuer.ts',
    'platform/jobs/durableJobRuntime.ts',
    'platform/jobs/identityDeletionEnqueuer.ts',
    'platform/jobs/resourceDeletionEnqueuer.ts',
    'platform/jobs/videoGenerationEnqueuer.ts',
    'platform/jobs/workExecutionEnqueuer.ts',
    'platform/storage/platformDomainRepositories.ts',
    'platform/workPersistence/workExecutionTypes.ts',
  ];
  for (const relative of commonFiles) {
    const source = fs.readFileSync(path.join(sourceRoot, relative), 'utf8');
    assert.doesNotMatch(
      source,
      /from\s+['"]better-sqlite3['"]|getSQLiteAdapterDatabase|Database\.Database/,
      `${relative} must use repository or opaque transaction contracts`
    );
  }

  const runtimeBackend = fs.readFileSync(
    path.join(sourceRoot, 'platform/jobs/durableJobRuntimeBackend.ts'),
    'utf8'
  );
  assert.doesNotMatch(runtimeBackend, /\.prepare\s*\(/);
  assert.match(runtimeBackend, /identity\.findAccountStatusById\(/);
  assert.doesNotMatch(runtimeBackend, /identity\.findPublicById\(/);
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
