import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, relativePath), 'utf8'));
}

function readJsonWithComments(relativePath) {
  const source = fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
  return JSON.parse(source.replace(/\/\*[\s\S]*?\*\//g, ''));
}

const rootPackage = readJson('package.json');
const frontendPackage = readJson('frontend/package.json');
const backendPackage = readJson('backend/package.json');
const frontendConfig = readJsonWithComments('frontend/tsconfig.json');
const backendConfig = readJsonWithComments('backend/tsconfig.json');
const lockfile = readJson('package-lock.json');

test('all application compilers use TypeScript 7', () => {
  assert.equal(
    rootPackage.devDependencies['@typescript/native'],
    'npm:typescript@^7.0.2'
  );
  assert.match(frontendPackage.devDependencies.typescript, /^\^?7\./);
  assert.match(backendPackage.devDependencies.typescript, /^\^?7\./);
  assert.match(
    lockfile.packages['node_modules/@typescript/native'].version,
    /^7\./
  );
  assert.equal(
    lockfile.packages['node_modules/@typescript/native'].name,
    'typescript'
  );
  assert.equal(
    lockfile.packages['node_modules/@typescript/native'].bin.tsc,
    'bin/tsc'
  );
  assert.match(
    lockfile.packages['frontend/node_modules/typescript'].version,
    /^7\./
  );
  assert.match(
    lockfile.packages['backend/node_modules/typescript'].version,
    /^7\./
  );
});

test('TypeScript 7 compiler options use supported module resolution', () => {
  assert.equal(frontendConfig.compilerOptions.baseUrl, undefined);
  assert.deepEqual(frontendConfig.compilerOptions.paths['@/*'], ['./src/*']);
  assert.equal(backendConfig.compilerOptions.module, 'NodeNext');
  assert.equal(backendConfig.compilerOptions.moduleResolution, 'NodeNext');
});

test('ESLint uses the TypeScript 6 compatibility API', () => {
  // TypeScript 7.0 has no programmatic API. Microsoft recommends this alias
  // so API consumers can load TypeScript 6 while tsc resolves to TS 7.
  assert.equal(
    rootPackage.devDependencies.typescript,
    'npm:@typescript/typescript6@^6.0.2'
  );
  assert.equal(
    lockfile.packages['node_modules/typescript'].name,
    '@typescript/typescript6'
  );
  assert.match(lockfile.packages['node_modules/typescript'].version, /^6\.0\./);
  assert.equal(
    lockfile.packages['node_modules/typescript'].bin.tsc6,
    'bin/tsc6'
  );

  for (const workspacePackage of [frontendPackage, backendPackage]) {
    assert.equal(
      workspacePackage.devDependencies['@typescript-eslint/parser'],
      undefined
    );
    assert.equal(
      workspacePackage.devDependencies['@typescript-eslint/eslint-plugin'],
      undefined
    );
  }
});
