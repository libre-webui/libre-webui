import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import semver from 'semver';

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

test('frontend and React consumers share one checkout-local runtime and type graph', () => {
  const physicalRoot = fs.realpathSync(repoRoot);
  const frontendRequire = createRequire(
    path.join(repoRoot, 'frontend/src/main.tsx')
  );
  const reactPackages = [
    'react',
    'react-dom',
    '@types/react',
    '@types/react-dom',
  ];

  const localPath = (resolved, description) => {
    const physical = fs.realpathSync(resolved);
    const relative = path.relative(physicalRoot, physical);
    assert.ok(
      relative !== '..' &&
        !relative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relative),
      `${description} resolved outside the checkout: ${physical}`
    );
    return physical;
  };
  const resolvePackage = (resolver, name, consumer) => {
    const filename = localPath(
      resolver.resolve(`${name}/package.json`),
      `${consumer} -> ${name}`
    );
    const manifest = JSON.parse(fs.readFileSync(filename, 'utf8'));
    const lockPath = path
      .relative(physicalRoot, path.dirname(filename))
      .split(path.sep)
      .join('/');
    assert.equal(
      lockfile.packages[lockPath]?.version,
      manifest.version,
      `${consumer} -> ${name} must match the authoritative lockfile`
    );
    return { filename, manifest };
  };

  const frontendGraph = new Map();
  for (const name of reactPackages) {
    const declared =
      frontendPackage.dependencies[name] ??
      frontendPackage.devDependencies[name];
    const override = rootPackage.overrides[name];
    const installed = resolvePackage(frontendRequire, name, 'frontend');
    assert.ok(
      semver.satisfies(installed.manifest.version, declared),
      `${name}@${installed.manifest.version} must satisfy frontend ${declared}`
    );
    assert.ok(
      semver.satisfies(installed.manifest.version, override),
      `${name}@${installed.manifest.version} must satisfy root override ${override}`
    );
    if (frontendPackage.overrides?.[name]) {
      assert.equal(
        frontendPackage.overrides[name],
        override,
        `${name} workspace override must agree with the effective root override`
      );
    }
    frontendGraph.set(name, installed);
  }
  assert.equal(
    frontendGraph.get('react').manifest.version,
    frontendGraph.get('react-dom').manifest.version,
    'React and its renderer must use matching versions'
  );

  // Resolve from the libraries themselves: a frontend import can work while a
  // hoisted library silently borrows React or its types from a developer's home.
  for (const consumer of [
    'react-dom',
    'react-markdown',
    'framer-motion',
    'react-hot-toast',
    'react-router',
    'zustand',
  ]) {
    const entry = localPath(frontendRequire.resolve(consumer), consumer);
    const resolver = createRequire(entry);
    for (const name of reactPackages) {
      assert.equal(
        resolvePackage(resolver, name, consumer).filename,
        frontendGraph.get(name).filename,
        `${consumer} and frontend must resolve the same physical ${name} package`
      );
    }
  }
});

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
