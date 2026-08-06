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
 * Runs artifacts inside the sandbox frame.
 *
 * Everything here executes from inline script: the frame makes no network
 * request of any kind, so a deployment behind an authenticating proxy cannot
 * turn an artifact's dependency into a login redirect. The libraries an
 * artifact imports are registered on this same object by the bundles the
 * application page injects alongside it.
 *
 * Artifact source is compiled to CommonJS rather than left as a module, so
 * `import` resolves through the registry below instead of the network.
 */

import { artifactModuleKey } from './manifest';

interface BabelTransformResult {
  code?: string | null;
}

interface BabelStandalone {
  transform(
    source: string,
    options: Record<string, unknown>
  ): BabelTransformResult | null;
  transformScriptTags?: () => void;
}

interface ArtifactRuntime {
  modules: Record<string, unknown>;
  register(specifiers: string[], value: unknown): void;
  require(specifier: string): unknown;
  runReact(): void;
  runMermaid(): void;
  runInline(source: string): void;
}

const ROOT_ELEMENT_ID = 'root';

const runtime: ArtifactRuntime = {
  modules: {},

  register(specifiers, value) {
    for (const specifier of specifiers) {
      this.modules[specifier] = value;
    }
  },

  require(specifier) {
    const direct = this.modules[specifier];
    if (direct !== undefined) return direct;

    // Generated code imports the same library by many names: a bare
    // specifier, a CDN URL, or a subpath such as three/addons/... They all
    // resolve to the one registered instance.
    const key = artifactModuleKey(specifier);
    const resolved = key === null ? undefined : this.modules[key];
    if (resolved !== undefined) return resolved;

    throw new Error(
      `"${specifier}" is not one of the libraries available to artifacts.`
    );
  },

  runReact() {
    void mountReact();
  },

  runMermaid() {
    void drawMermaid();
  },

  runInline(source) {
    // A module or text/babel script lifted out of generated HTML. Compiling it
    // here rather than letting the browser resolve its imports is what keeps
    // the frame off the network.
    try {
      evaluate(compile(source));
    } catch (error) {
      showFailure('This script could not run.', describe(error));
    }
  },
};

/**
 * The artifact's own source, handed over as a string literal by the page that
 * composed this document rather than as the text of an element.
 */
const artifactSource = (): string => {
  const source = (window as unknown as { __libreArtifactSource?: unknown })
    .__libreArtifactSource;
  return typeof source === 'string' ? source.trim() : '';
};

const artifactRoot = (): HTMLElement | null =>
  document.getElementById(ROOT_ELEMENT_ID);

const showFailure = (heading: string, detail: string) => {
  const root = artifactRoot();
  if (!root) return;

  const panel = document.createElement('div');
  panel.setAttribute('data-testid', 'artifact-runtime-error');
  panel.style.cssText =
    'margin:16px;padding:16px;border:1px solid #f0a5a5;border-radius:12px;' +
    'background:#fff5f5;color:#7f1d1d;font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;' +
    'white-space:pre-wrap;word-break:break-word;';

  const title = document.createElement('strong');
  title.textContent = heading;
  title.style.cssText =
    'display:block;margin-bottom:8px;font:600 13px/1.4 system-ui,sans-serif;';

  panel.append(title, document.createTextNode(detail));
  root.replaceChildren(panel);
};

const describe = (error: unknown): string =>
  error instanceof Error
    ? `${error.message}\n\n${error.stack ?? ''}`.trim()
    : String(error);

/**
 * Generated artifacts are not consistent about how they expose their entry
 * component: a default export is the norm, a single named component happens,
 * and some mount themselves.
 */
const pickComponent = (exported: Record<string, unknown>): unknown => {
  if (typeof exported.default === 'function') {
    return exported.default;
  }

  for (const [name, value] of Object.entries(exported)) {
    if (typeof value === 'function' && /^[A-Z]/.test(name)) {
      return value;
    }
  }

  return null;
};

const compile = (source: string): string => {
  const Babel = runtime.modules.__babel as BabelStandalone | undefined;
  if (!Babel) {
    throw new Error('The artifact compiler was not loaded.');
  }

  const result = Babel.transform(source, {
    filename: 'artifact.tsx',
    sourceType: 'module',
    // The .tsx filename is what tells the TypeScript preset to parse JSX.
    presets: ['typescript', ['react', { runtime: 'automatic' }]],
    // Compiling to CommonJS turns every `import` into a registry lookup, so
    // the frame never has to resolve a module over the network.
    plugins: ['transform-modules-commonjs'],
  });

  if (!result?.code) {
    throw new Error('The artifact produced no runnable code.');
  }
  return result.code;
};

const evaluate = (compiled: string): Record<string, unknown> => {
  const module = { exports: {} as Record<string, unknown> };
  const require = (specifier: string) => runtime.require(specifier);
  const run = new Function('require', 'module', 'exports', compiled) as (
    require: (specifier: string) => unknown,
    module: { exports: Record<string, unknown> },
    exports: Record<string, unknown>
  ) => void;

  run(require, module, module.exports);
  return module.exports;
};

interface ReactLike {
  createElement: (
    type: unknown,
    props?: unknown,
    ...children: unknown[]
  ) => unknown;
  StrictMode: unknown;
  Component: new (props: unknown) => unknown;
}

const mountReact = async () => {
  const source = artifactSource();
  const root = artifactRoot();
  if (!source || !root) {
    showFailure('Nothing to render.', 'The artifact carried no source.');
    return;
  }

  let exported: Record<string, unknown>;
  try {
    exported = evaluate(compile(source));
  } catch (error) {
    showFailure('This artifact could not be compiled.', describe(error));
    return;
  }

  try {
    const React = runtime.require('react') as ReactLike;
    const { createRoot } = runtime.require('react-dom/client') as {
      createRoot: (container: Element) => { render: (node: unknown) => void };
    };
    const Component = pickComponent(exported);

    if (!Component) {
      // Code that mounts itself has already put something on the page.
      if (root.childElementCount === 0) {
        showFailure(
          'This artifact exported no component.',
          'Export the component as the module default, for example: export default function App() { ... }'
        );
      }
      return;
    }

    createRoot(root).render(
      React.createElement(
        React.StrictMode,
        null,
        React.createElement(Component)
      )
    );
  } catch (error) {
    showFailure('This artifact failed to run.', describe(error));
  }
};

const drawMermaid = async () => {
  const source = artifactSource();
  const root = artifactRoot();
  if (!source || !root) return;

  try {
    const mermaid = runtime.require('mermaid') as {
      initialize: (options: Record<string, unknown>) => void;
      render: (id: string, source: string) => Promise<{ svg: string }>;
    };

    mermaid.initialize({
      startOnLoad: false,
      theme:
        document.documentElement.dataset.colorScheme === 'dark'
          ? 'dark'
          : 'default',
      securityLevel: 'strict',
      fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
    });

    const { svg } = await mermaid.render('libre-artifact-diagram', source);

    // Parsed as a document and adopted, rather than assigned as HTML: the
    // diagram is built from artifact text, and nothing here should be able to
    // reinterpret that text as markup for this document.
    const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml');
    const diagram = parsed.documentElement;
    if (!diagram || diagram.nodeName === 'parsererror') {
      throw new Error('The diagram could not be parsed.');
    }
    root.replaceChildren(document.importNode(diagram, true));
  } catch (error) {
    showFailure('This diagram could not be drawn.', describe(error));
  }
};

window.addEventListener('unhandledrejection', event => {
  showFailure('This artifact raised an unhandled error.', String(event.reason));
});

(window as unknown as Record<string, unknown>).__libreArtifactRuntime = runtime;
