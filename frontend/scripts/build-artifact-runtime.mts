/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at:
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Builds the artifact runtime: the vendored libraries a generated artifact
 * expects to find. Output lands in `public/artifact-runtime`, so the dev
 * server, the end-to-end suite, and the production build all serve it from the
 * same path without a special case.
 *
 * Three passes, because they have different linking rules:
 *
 *  - core     React and its entry points, built together so every library in
 *             the sandbox shares one React instance.
 *  - library  Modules artifacts import by name. React stays external and is
 *             resolved through the sandbox import map back to the core pass.
 *  - globals  Classic scripts that stand in for CDN bundles in HTML
 *             artifacts. Each is self-contained and assigns its own global.
 */

import { createHash } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, type InlineConfig, type Plugin } from 'vite';

import {
  ARTIFACT_CORE_ENTRIES,
  ARTIFACT_GLOBAL_ENTRIES,
  ARTIFACT_LIBRARY_ENTRIES,
} from '../src/artifact-runtime/manifest.js';

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);
const outDir = path.join(projectRoot, 'public', 'artifact-runtime');
const runtimeSource = path.join(projectRoot, 'src', 'artifact-runtime');

const REACT_EXTERNALS = [
  'react',
  'react-dom',
  'react-dom/client',
  'react/jsx-runtime',
  'react/jsx-dev-runtime',
];

/** The package behind each module an artifact may import. */
const MODULE_PACKAGES: Record<string, string> = {
  react: 'react',
  'react-dom': 'react-dom',
  'react-dom-client': 'react-dom/client',
  'jsx-runtime': 'react/jsx-runtime',
  recharts: 'recharts',
  'lucide-react': 'lucide-react',
  d3: 'd3',
  three: 'three',
  papaparse: 'papaparse',
  lodash: 'lodash',
  mermaid: 'mermaid',
  chart: 'chart.js/auto',
};

const RESERVED_WORDS = new Set([
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'debugger',
  'default',
  'delete',
  'do',
  'else',
  'enum',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'function',
  'if',
  'import',
  'in',
  'instanceof',
  'new',
  'null',
  'return',
  'super',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'typeof',
  'var',
  'void',
  'while',
  'with',
  'yield',
  'let',
  'static',
  'implements',
  'interface',
  'package',
  'private',
  'protected',
  'public',
]);

const exportableNames = (value: object): string[] =>
  Object.keys(value).filter(
    name => /^[A-Za-z_$][\w$]*$/.test(name) && !RESERVED_WORDS.has(name)
  );

/**
 * Re-exports a package by name.
 *
 * `export *` is not enough: several of these packages are CommonJS, and a star
 * re-export of one carries no named bindings, so `import { useState } from
 * 'react'` inside an artifact would fail to link. The names are read from the
 * package itself here and written out explicitly.
 */
const moduleSource = async (specifier: string): Promise<string> => {
  const namespace = (await import(specifier)) as Record<string, unknown>;
  const hasDefault = namespace.default !== undefined;
  // A CommonJS package arrives as a lone default; a native ESM one exposes its
  // API on the namespace. Referring to a default that does not exist is what
  // makes the bundler warn, so each case gets the binding that actually fits.
  const viaDefault = Object.keys(namespace).length <= 2 && hasDefault;
  const target = (viaDefault ? namespace.default : namespace) as object;
  const names = exportableNames(target);

  const binding = viaDefault
    ? `import __module from '${specifier}';`
    : `import * as __namespace from '${specifier}';\nconst __module = __namespace;`;
  const fallbackDefault = hasDefault ? '__namespace.default' : '__namespace';

  return [
    binding,
    `export default ${viaDefault ? '__module' : fallbackDefault};`,
    names.length ? `export const { ${names.join(', ')} } = __module;` : '',
  ]
    .filter(Boolean)
    .join('\n');
};

/**
 * Globals reproduce what the CDN builds put on `window`, so an artifact's own
 * inline scripts keep working after the CDN tag is redirected here.
 */
const GLOBAL_SOURCES: Record<string, string> = {
  tailwind: `import '@tailwindcss/browser';`,
  chart: `import Chart from 'chart.js/auto';
window.Chart = Chart;`,
  d3: `import * as d3 from 'd3';
window.d3 = d3;`,
  three: `import * as THREE from 'three';
window.THREE = THREE;`,
  papaparse: `import Papa from 'papaparse';
window.Papa = Papa;`,
  lodash: `import _ from 'lodash';
window._ = _;
window.lodash = _;`,
  mermaid: `import mermaid from 'mermaid';
window.mermaid = mermaid;
mermaid.initialize({ startOnLoad: true });`,
  // React 19 dropped ReactDOM.render, which is what CDN-era generated code
  // calls. The shim keeps those artifacts mounting.
  react: `import * as React from 'react';
import * as ReactDOM from 'react-dom';
import * as client from 'react-dom/client';
const roots = new WeakMap();
const render = (element, container) => {
  let root = roots.get(container);
  if (!root) {
    root = client.createRoot(container);
    roots.set(container, root);
  }
  root.render(element);
  return root;
};
window.React = React;
window.ReactDOM = { ...ReactDOM, ...client, render };`,
  // Babel's standalone build transforms <script type="text/babel"> tags on
  // load; run it again in case the document was already parsed.
  babel: `import * as Babel from '@babel/standalone';
window.Babel = Babel;
const transform = () => {
  try {
    Babel.transformScriptTags();
  } catch (error) {
    console.error('Artifact script transform failed:', error);
  }
};
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', transform);
} else {
  transform();
}`,
};

const VIRTUAL_PREFIX = 'libre-artifact-entry:';

/** Serves the generated entry sources above as if they were files. */
const virtualEntries = (sources: Record<string, string>): Plugin => ({
  name: 'libre-artifact-entries',
  resolveId(id) {
    return id.startsWith(VIRTUAL_PREFIX) ? `\0${id}` : null;
  },
  load(id) {
    if (!id.startsWith(`\0${VIRTUAL_PREFIX}`)) return null;
    const name = id.slice(`\0${VIRTUAL_PREFIX}`.length);
    const source = sources[name];
    if (!source) {
      throw new Error(`No artifact runtime entry named "${name}".`);
    }
    return source;
  },
});

const entryId = (name: string) => `${VIRTUAL_PREFIX}${name}`;

const resolveEntry = (name: string) => {
  if (name.endsWith('-bootstrap')) {
    return path.join(runtimeSource, `${name}.ts`);
  }
  return entryId(name);
};

/**
 * These bundles are vendored libraries, so the advice the bundler would give
 * about them does not apply: they are meant to be large, and the IIFE globals
 * inherit an `import.meta` reference from a helper they never reach. Real
 * errors still surface.
 */
const SILENCED_LOG_CODES = new Set([
  'EMPTY_IMPORT_META',
  'IMPORT_IS_UNDEFINED',
  'CIRCULAR_DEPENDENCY',
]);

const quietLog = (
  level: string,
  log: { code?: string },
  handler: (level: string, log: { code?: string }) => void
) => {
  if (log.code && SILENCED_LOG_CODES.has(log.code)) return;
  handler(level, log);
};

const baseConfig: InlineConfig = {
  root: projectRoot,
  configFile: false,
  // The output lives inside public/, so Vite must not also treat public/ as a
  // directory to copy.
  publicDir: false,
  logLevel: 'error',
  define: { 'process.env.NODE_ENV': '"production"' },
};

const buildModules = async (names: string[], external: string[]) => {
  const sources: Record<string, string> = {};
  for (const name of names) {
    const specifier = MODULE_PACKAGES[name];
    if (specifier) {
      sources[name] = await moduleSource(specifier);
    }
  }

  await build({
    ...baseConfig,
    plugins: [virtualEntries(sources)],
    build: {
      outDir,
      emptyOutDir: false,
      target: 'es2022',
      sourcemap: false,
      chunkSizeWarningLimit: Infinity,
      rollupOptions: {
        onLog: quietLog,
        input: Object.fromEntries(
          names.map(name => [name, resolveEntry(name)])
        ),
        external,
        // These entries exist to be imported by artifact code, not to run on
        // their own: their exports are the whole product.
        preserveEntrySignatures: 'exports-only',
        output: {
          format: 'es',
          entryFileNames: '[name].js',
          chunkFileNames: 'chunks/[name]-[hash].js',
          assetFileNames: 'assets/[name]-[hash][extname]',
          // A few of these libraries reach React through a CommonJS
          // `require`. Left alone, the call resolves against the registry the
          // bootstrap installs, which hands back the one shared instance;
          // polyfilled, it would throw instead.
          polyfillRequire: false,
        },
      },
    },
  });
};

const buildGlobal = async (name: string) => {
  await build({
    ...baseConfig,
    plugins: [virtualEntries(GLOBAL_SOURCES)],
    build: {
      outDir: path.join(outDir, 'globals'),
      emptyOutDir: false,
      target: 'es2022',
      sourcemap: false,
      chunkSizeWarningLimit: Infinity,
      rollupOptions: {
        onLog: quietLog,
        input: { [name]: entryId(name) },
        output: {
          format: 'iife',
          name: `libreArtifactGlobal_${name.replace(/\W/g, '_')}`,
          entryFileNames: '[name].js',
          assetFileNames: '[name][extname]',
        },
      },
    },
  });
};

/**
 * What the output depends on: the runtime sources, this script, and the
 * versions of the packages being vendored. Unchanged inputs mean the bundles
 * on disk are still current, so a plain `npm run dev` does not rebuild them.
 */
const inputFingerprint = async (): Promise<string> => {
  const hash = createHash('sha256');
  const files = [
    fileURLToPath(import.meta.url),
    path.join(runtimeSource, 'manifest.ts'),
    path.join(runtimeSource, 'react-bootstrap.ts'),
    path.join(runtimeSource, 'mermaid-bootstrap.ts'),
    path.join(projectRoot, 'package.json'),
  ];
  for (const file of files) {
    hash.update(await readFile(file));
  }
  return hash.digest('hex');
};

const stampPath = path.join(outDir, '.build-fingerprint');
const fingerprint = await inputFingerprint();
const force = process.argv.includes('--force');

if (!force) {
  const previous = await readFile(stampPath, 'utf8').catch(() => null);
  if (previous?.trim() === fingerprint) {
    console.log('artifact runtime is up to date');
    process.exit(0);
  }
}

await rm(outDir, { recursive: true, force: true });

console.log('artifact runtime: building React, Tailwind and the library set');
await buildModules(ARTIFACT_CORE_ENTRIES, []);
await buildModules(ARTIFACT_LIBRARY_ENTRIES, REACT_EXTERNALS);

for (const name of ARTIFACT_GLOBAL_ENTRIES) {
  await buildGlobal(name);
}

await writeFile(stampPath, `${fingerprint}\n`);
console.log(`artifact runtime built into ${path.relative(projectRoot, outDir)}`);
