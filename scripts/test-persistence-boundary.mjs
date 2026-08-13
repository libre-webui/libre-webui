import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const sourceRoot = path.resolve('backend/src');
const legacyDatabaseConsumers = new Set([
  'index.ts',
  'models/personaModel.ts',
  'services/agentAccessService.ts',
  'services/dataArchiveService.ts',
  'services/galleryService.ts',
  'services/mediaGenerationJobService.ts',
  'services/memoryService.ts',
  'services/modelAccessService.ts',
  'services/mutationEngineService.ts',
  'services/personaService.ts',
  'services/pluginActivationService.ts',
  'services/pluginCredentialsService.ts',
  'services/pluginService.ts',
  'services/pluginUsageService.ts',
  'services/pluginVariablesService.ts',
  'services/voiceProfileService.ts',
  'services/webSearchService.ts',
  'services/workAccessService.ts',
  'services/workPolicyService.ts',
  'services/workPreviewProxyService.ts',
  'services/workRuntimeService.ts',
  'services/workTaskService.ts',
  'storage.ts',
]);

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
    if (importsDatabase && !legacyDatabaseConsumers.has(relative)) {
      violations.push(relative);
    }
  }

  assert.deepEqual(
    violations,
    [],
    `Route new persistence through a repository instead of db.ts: ${violations.join(', ')}`
  );
});

test('authenticated storage fails closed instead of selecting JSON at runtime', () => {
  const source = fs.readFileSync(path.join(sourceRoot, 'storage.ts'), 'utf8');
  assert.match(source, /private readonly useSQLite: true/);
  assert.match(source, /throw new Error\('SQLite application storage is unavailable'\)/);
  assert.doesNotMatch(source, /Storage mode:.*JSON/);
});
