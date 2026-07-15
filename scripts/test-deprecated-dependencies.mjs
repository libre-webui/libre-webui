import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const lockfilePath = path.resolve(__dirname, '..', 'package-lock.json');

test('package lock contains no deprecated dependencies', () => {
  const lockfile = JSON.parse(fs.readFileSync(lockfilePath, 'utf8'));
  const deprecatedPackages = Object.entries(lockfile.packages ?? {})
    .filter(([, metadata]) => Boolean(metadata.deprecated))
    .map(([packagePath, metadata]) => ({
      package: packagePath.replace(/^node_modules\//, ''),
      version: metadata.version,
      reason: metadata.deprecated,
    }));

  assert.deepEqual(
    deprecatedPackages,
    [],
    `Remove or upgrade deprecated dependencies:\n${JSON.stringify(
      deprecatedPackages,
      null,
      2
    )}`
  );
});
