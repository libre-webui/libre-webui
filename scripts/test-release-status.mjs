import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { npm } = require('./lib/command');
const { parsePorcelainStatus } = require('./lib/releaseStatus');

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
