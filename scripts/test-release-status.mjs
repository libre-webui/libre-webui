import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { npm } = require('./lib/command');
const { parsePorcelainStatus } = require('./lib/releaseStatus');

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);
const releaseScript = fs.readFileSync(
  path.join(repoRoot, 'scripts', 'release.js'),
  'utf8'
);

const expectedPaths = [
  'CHANGELOG.md',
  'backend/package.json',
  'frontend/package.json',
  'package-lock.json',
  'package.json',
  'file with spaces.md',
];

const porcelainStatus = [
  ' M CHANGELOG.md',
  'M  backend/package.json',
  'MM frontend/package.json',
  ' M package-lock.json',
  'M  package.json',
  '?? "file with spaces.md"',
].join('\n');

test('release status parser preserves paths from porcelain output', () => {
  assert.deepEqual(parsePorcelainStatus(porcelainStatus), expectedPaths);
});

test('release status parser tolerates globally trimmed command output', () => {
  assert.deepEqual(parsePorcelainStatus(porcelainStatus.trim()), expectedPaths);
});

test('release command helper can execute npm on this platform', () => {
  assert.match(npm(['--version'], { silent: true }), /^\d+\.\d+\.\d+/);
});

test('release script completes the full gate before committing or tagging', () => {
  const tagPreflightIndex = releaseScript.indexOf(
    'this.ensureTagAvailable(nextVersion)'
  );
  const versionMutationIndex = releaseScript.indexOf(
    'this.updateHelmChartVersions(currentVersion, nextVersion)'
  );
  const releaseCheckIndex = releaseScript.indexOf(
    "npm(['run', 'release:check'])"
  );
  const finalScopeCheckIndex = releaseScript.lastIndexOf(
    'this.ensureOnlyReleaseFilesChanged()'
  );
  const commitIndex = releaseScript.indexOf(
    "git(['commit', '-m', `chore(release): ${nextVersion}`])"
  );
  const tagIndex = releaseScript.indexOf("git(['tag', '-a', `v${nextVersion}`");

  assert.ok(tagPreflightIndex > 0);
  assert.ok(tagPreflightIndex < versionMutationIndex);
  assert.ok(versionMutationIndex < releaseCheckIndex);
  assert.ok(releaseCheckIndex < finalScopeCheckIndex);
  assert.ok(finalScopeCheckIndex < commitIndex);
  assert.ok(commitIndex < tagIndex);
});
