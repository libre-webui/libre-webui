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
 * Every bundle is a self-contained classic script. The sandbox frame runs them
 * inline, never fetching anything, because a frame with an opaque origin sends
 * no session cookie: behind an authenticating proxy its requests come back as
 * a login redirect. Only the application page — which is properly
 * authenticated — ever loads these files.
 *
 * Each bundle registers what it provides on a small runtime object, and
 * libraries resolve React from that same object so the whole frame shares one
 * React instance.
 */

import { createHash } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, type InlineConfig, type Plugin } from 'vite';

import {
  ARTIFACT_BABEL_BUNDLE,
  ARTIFACT_BUNDLES,
  ARTIFACT_FONTS_BUNDLE,
  ARTIFACT_LIBRARY_BUNDLES,
  ARTIFACT_MODULES,
  ARTIFACT_REACT_BUNDLE,
  ARTIFACT_RUNTIME_BUNDLE,
  ARTIFACT_RUNTIME_GLOBAL,
  ARTIFACT_TAILWIND_BUNDLE,
} from '../src/artifact-runtime/manifest.js';

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);
const outDir = path.join(projectRoot, 'public', 'artifact-runtime');
const runtimeSource = path.join(projectRoot, 'src', 'artifact-runtime');

/** Specifiers a library bundle resolves from the registry instead of bundling. */
const SHARED_REACT_SPECIFIERS = [
  'react',
  'react-dom',
  'react-dom/client',
  'react/jsx-runtime',
  'react/jsx-dev-runtime',
];

/** The package behind each library bundle, and the global it also assigns. */
const LIBRARY_BUNDLES: Record<
  string,
  { specifier: string; global: string; useDefault?: boolean }
> = {
  recharts: { specifier: 'recharts', global: 'Recharts' },
  'lucide-react': { specifier: 'lucide-react', global: 'lucide' },
  d3: { specifier: 'd3', global: 'd3' },
  three: { specifier: 'three', global: 'THREE' },
  papaparse: { specifier: 'papaparse', global: 'Papa', useDefault: true },
  lodash: { specifier: 'lodash', global: '_', useDefault: true },
  mermaid: { specifier: 'mermaid', global: 'mermaid', useDefault: true },
  chart: { specifier: 'chart.js/auto', global: 'Chart', useDefault: true },
  tone: { specifier: 'tone', global: 'Tone' },
  mathjs: { specifier: 'mathjs', global: 'math' },
  xlsx: { specifier: 'xlsx', global: 'XLSX' },
  plotly: {
    specifier: 'plotly.js-dist-min',
    global: 'Plotly',
    useDefault: true,
  },
  'framer-motion': { specifier: 'framer-motion', global: 'Motion' },
};

/**
 * Creates the registry if this bundle happens to run first. An HTML artifact
 * that only needed Chart.js gets that bundle and nothing else.
 */
const REGISTRY_PRELUDE = `const __registry = (window.${ARTIFACT_RUNTIME_GLOBAL} = window.${ARTIFACT_RUNTIME_GLOBAL} || {
  modules: {},
  register(specifiers, value) {
    for (const specifier of specifiers) this.modules[specifier] = value;
  },
  require(specifier) {
    const found = this.modules[specifier];
    if (found === undefined) {
      throw new Error('"' + specifier + '" is not one of the libraries available to artifacts.');
    }
    return found;
  },
});`;

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

/** The names a package really exports, read from the package itself. */
const namesOf = async (specifier: string): Promise<string[]> => {
  const namespace = (await import(specifier)) as Record<string, unknown>;
  const viaDefault =
    Object.keys(namespace).length <= 2 && namespace.default !== undefined;
  return exportableNames(
    (viaDefault ? namespace.default : namespace) as object
  );
};

/**
 * Stands in for React inside a library bundle: the binding comes from the
 * registry at run time, so every library and the artifact itself share the one
 * instance the react bundle registered.
 */
const sharedReactSource = async (specifier: string): Promise<string> => {
  const names = await namesOf(specifier);
  return [
    `const __shared = window.${ARTIFACT_RUNTIME_GLOBAL}.modules[${JSON.stringify(specifier)}];`,
    'export default __shared.default ?? __shared;',
    names.length ? `export const { ${names.join(', ')} } = __shared;` : '',
  ]
    .filter(Boolean)
    .join('\n');
};

const reactBundleSource = () => `import * as React from 'react';
import * as ReactDOM from 'react-dom';
import * as ReactDOMClient from 'react-dom/client';
import * as JsxRuntime from 'react/jsx-runtime';
${REGISTRY_PRELUDE}
__registry.register(['react'], React);
__registry.register(['react-dom'], ReactDOM);
__registry.register(['react-dom/client'], ReactDOMClient);
__registry.register(['react/jsx-runtime', 'react/jsx-dev-runtime'], JsxRuntime);
// React 19 dropped ReactDOM.render, which is what CDN-era generated code
// calls. The shim keeps those artifacts mounting.
const __roots = new WeakMap();
const render = (element, container) => {
  let root = __roots.get(container);
  if (!root) {
    root = ReactDOMClient.createRoot(container);
    __roots.set(container, root);
  }
  root.render(element);
  return root;
};
window.React = React;
window.ReactDOM = { ...ReactDOM, ...ReactDOMClient, render };`;

const babelBundleSource = () => `import * as Babel from '@babel/standalone';
${REGISTRY_PRELUDE}
__registry.register(['__babel'], Babel);
window.Babel = Babel;
// Babel's standalone build transforms <script type="text/babel"> tags on load.
const __transform = () => {
  try {
    Babel.transformScriptTags();
  } catch (error) {
    console.error('Artifact script transform failed:', error);
  }
};
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', __transform);
} else {
  __transform();
}`;

/**
 * Generated artifacts link Google Fonts constantly. The frame cannot fetch a
 * stylesheet, let alone the font files behind it, so the vendored Inter the
 * application already ships is turned into a stylesheet of data URIs and
 * injected in the link's place. Families we do not have fall back to the
 * system stack, which is what the artifact's own font-family list asks for
 * next.
 */
const fontsBundleSource = async (): Promise<string> => {
  const fontsDir = path.join(projectRoot, 'public', 'fonts');
  const css = await readFile(path.join(fontsDir, 'inter.css'), 'utf8');

  const files = [...css.matchAll(/url\((\/fonts\/[^)]+)\)/g)].map(
    match => match[1]
  );
  let inlined = css;
  for (const file of [...new Set(files)]) {
    const data = await readFile(path.join(fontsDir, path.basename(file)));
    inlined = inlined.replaceAll(
      `url(${file})`,
      `url(data:font/woff2;base64,${data.toString('base64')})`
    );
  }

  return `${REGISTRY_PRELUDE}
const __css = ${JSON.stringify(inlined)};
const __style = document.createElement('style');
__style.setAttribute('data-artifact-fonts', 'inter');
__style.textContent = __css;
(document.head || document.documentElement).appendChild(__style);
__registry.register(['__fonts'], __css);`;
};

const librarySource = (name: string) => {
  const { specifier, global, useDefault } = LIBRARY_BUNDLES[name];
  const specifiers = Object.entries(ARTIFACT_MODULES)
    .filter(([, bundle]) => bundle === name)
    .map(([key]) => key);

  // A CommonJS library keeps its API on the default export; registering the
  // namespace instead would hand artifacts an object with nothing on it.
  const value = useDefault ? '__module.default ?? __module' : '__module';

  return `import * as __module from '${specifier}';
${REGISTRY_PRELUDE}
const __value = ${value};
__registry.register(${JSON.stringify(specifiers)}, __value);
window.${global} = __value;`;
};

/**
 * Three.js keeps its controls, loaders and post-processing outside the core
 * package, and generated code reaches for them constantly — `OrbitControls`
 * above all. The legacy CDN builds hung them off the `THREE` global, so they
 * are merged into it here as well as registered under their own specifiers.
 */
const THREE_ADDONS: Record<string, string> = {
  OrbitControls: 'controls/OrbitControls.js',
  MapControls: 'controls/MapControls.js',
  TrackballControls: 'controls/TrackballControls.js',
  FlyControls: 'controls/FlyControls.js',
  FirstPersonControls: 'controls/FirstPersonControls.js',
  PointerLockControls: 'controls/PointerLockControls.js',
  DragControls: 'controls/DragControls.js',
  ArcballControls: 'controls/ArcballControls.js',
  GLTFLoader: 'loaders/GLTFLoader.js',
  OBJLoader: 'loaders/OBJLoader.js',
  MTLLoader: 'loaders/MTLLoader.js',
  FBXLoader: 'loaders/FBXLoader.js',
  STLLoader: 'loaders/STLLoader.js',
  SVGLoader: 'loaders/SVGLoader.js',
  FontLoader: 'loaders/FontLoader.js',
  RGBELoader: 'loaders/RGBELoader.js',
  TextGeometry: 'geometries/TextGeometry.js',
  RoundedBoxGeometry: 'geometries/RoundedBoxGeometry.js',
  ConvexGeometry: 'geometries/ConvexGeometry.js',
  DecalGeometry: 'geometries/DecalGeometry.js',
  EffectComposer: 'postprocessing/EffectComposer.js',
  RenderPass: 'postprocessing/RenderPass.js',
  ShaderPass: 'postprocessing/ShaderPass.js',
  UnrealBloomPass: 'postprocessing/UnrealBloomPass.js',
  OutputPass: 'postprocessing/OutputPass.js',
  GlitchPass: 'postprocessing/GlitchPass.js',
  BufferGeometryUtils: 'utils/BufferGeometryUtils.js',
  SceneUtils: 'utils/SceneUtils.js',
  Sky: 'objects/Sky.js',
  Lensflare: 'objects/Lensflare.js',
  Line2: 'lines/Line2.js',
  LineGeometry: 'lines/LineGeometry.js',
  LineMaterial: 'lines/LineMaterial.js',
};

const threeBundleSource = () => {
  const imports = Object.entries(THREE_ADDONS)
    .map(
      ([name, file], index) =>
        `import * as __addon${index} from 'three/examples/jsm/${file}';`
    )
    .join('\n');
  const merged = Object.keys(THREE_ADDONS)
    .map((_, index) => `...__addon${index}`)
    .join(', ');
  const registrations = Object.entries(THREE_ADDONS)
    .map(
      ([, file], index) =>
        `__registry.register(['three/addons/${file}', 'three/examples/jsm/${file}'], __addon${index});`
    )
    .join('\n');

  return `import * as __module from 'three';
${imports}
${REGISTRY_PRELUDE}
const __value = { ...__module, ${merged} };
__registry.register(['three'], __value);
${registrations}
window.THREE = __value;`;
};

const VIRTUAL_PREFIX = 'libre-artifact-entry:';

const bundleSource = async (name: string): Promise<string> => {
  if (name === ARTIFACT_REACT_BUNDLE) return reactBundleSource();
  if (name === 'three') return threeBundleSource();
  if (name === ARTIFACT_BABEL_BUNDLE) return babelBundleSource();
  if (name === ARTIFACT_TAILWIND_BUNDLE)
    return `import '@tailwindcss/browser';`;
  if (name === ARTIFACT_FONTS_BUNDLE) return fontsBundleSource();
  return librarySource(name);
};

/** Serves the generated entry sources, and React's registry stand-in. */
const virtualModules = (
  entry: Record<string, string>,
  shared: Record<string, string>
): Plugin => ({
  name: 'libre-artifact-entries',
  // Ahead of Vite's own resolver, which would otherwise resolve React from
  // node_modules and bundle a second copy of it into every library.
  enforce: 'pre',
  resolveId(id) {
    if (id.startsWith(VIRTUAL_PREFIX)) return `\0${id}`;
    if (shared[id]) return `\0shared:${id}`;
    return null;
  },
  load(id) {
    if (id.startsWith(`\0${VIRTUAL_PREFIX}`)) {
      const name = id.slice(`\0${VIRTUAL_PREFIX}`.length);
      const source = entry[name];
      if (!source)
        throw new Error(`No artifact runtime bundle named "${name}".`);
      return source;
    }
    if (id.startsWith('\0shared:')) {
      return shared[id.slice('\0shared:'.length)];
    }
    return null;
  },
});

/**
 * These bundles are vendored libraries, so the advice the bundler would give
 * about them does not apply: they are meant to be large, and an IIFE inherits
 * an `import.meta` reference from a helper it never reaches.
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

const buildBundle = async (name: string, shareReact: boolean) => {
  const entry =
    name === ARTIFACT_RUNTIME_BUNDLE
      ? path.join(runtimeSource, 'runtime.ts')
      : `${VIRTUAL_PREFIX}${name}`;

  const shared: Record<string, string> = {};
  if (shareReact) {
    for (const specifier of SHARED_REACT_SPECIFIERS) {
      shared[specifier] = await sharedReactSource(
        specifier === 'react/jsx-dev-runtime' ? 'react/jsx-runtime' : specifier
      );
    }
  }

  await build({
    ...baseConfig,
    plugins: [
      virtualModules(
        name === ARTIFACT_RUNTIME_BUNDLE
          ? {}
          : { [name]: await bundleSource(name) },
        shared
      ),
    ],
    build: {
      outDir,
      emptyOutDir: false,
      target: 'es2022',
      sourcemap: false,
      chunkSizeWarningLimit: Infinity,
      rollupOptions: {
        onLog: quietLog,
        input: { [name]: entry },
        output: {
          format: 'iife',
          name: `libreArtifact_${name.replace(/\W/g, '_')}`,
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
    path.join(runtimeSource, 'runtime.ts'),
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

for (const name of [
  ARTIFACT_RUNTIME_BUNDLE,
  ARTIFACT_REACT_BUNDLE,
  ARTIFACT_BABEL_BUNDLE,
  ARTIFACT_TAILWIND_BUNDLE,
]) {
  await buildBundle(name, false);
}

for (const name of ARTIFACT_LIBRARY_BUNDLES) {
  await buildBundle(name, true);
}

// These bundles are inlined into artifact documents as script text. Nothing
// in this application's own output should be able to close that element, and
// checking is cheaper than escaping code correctly.
for (const name of ARTIFACT_BUNDLES) {
  const built = await readFile(path.join(outDir, `${name}.js`), 'utf8');
  if (/<\/script/i.test(built)) {
    throw new Error(
      `The ${name} bundle contains a script end tag and cannot be inlined safely.`
    );
  }
}

await writeFile(stampPath, `${fingerprint}\n`);

// The loader puts this in the request URL. Without it a cached bundle from an
// earlier release is indistinguishable from the current one — the application
// version does not change between development builds — and an artifact ends up
// running against a runtime the application no longer matches.
await writeFile(
  path.join(runtimeSource, 'fingerprint.ts'),
  `/*
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

/** Generated by scripts/build-artifact-runtime.mts — do not edit. */
export const ARTIFACT_RUNTIME_FINGERPRINT = '${fingerprint.slice(0, 16)}';
`
);
console.log(
  `artifact runtime built into ${path.relative(projectRoot, outDir)}`
);
