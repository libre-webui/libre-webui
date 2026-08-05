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
 * Runs a React artifact inside the sandbox frame.
 *
 * The artifact arrives as JSX or TSX source in an inert script tag. This
 * transpiles it, evaluates it as a module so its imports resolve through the
 * sandbox import map, and mounts whatever component it exports. Tailwind is
 * loaded alongside, because generated components assume utility classes are
 * available.
 */

import * as Babel from '@babel/standalone';
import * as React from 'react';
import * as ReactDOM from 'react-dom';
import * as ReactDOMClient from 'react-dom/client';
import * as JsxRuntime from 'react/jsx-runtime';

import '@tailwindcss/browser';

const { createRoot } = ReactDOMClient;

/**
 * Some vendored libraries reach React through a CommonJS `require`. Serving it
 * from here is what keeps the whole frame on a single React instance — two
 * copies would break every hook.
 */
const REQUIRE_REGISTRY: Record<string, unknown> = {
  react: React,
  'react-dom': ReactDOM,
  'react-dom/client': ReactDOMClient,
  'react/jsx-runtime': JsxRuntime,
  'react/jsx-dev-runtime': JsxRuntime,
};

(window as unknown as { require?: unknown }).require = (id: string) => {
  const module = REQUIRE_REGISTRY[id];
  if (!module) {
    throw new Error(`Artifacts cannot require "${id}".`);
  }
  return module;
};

const SOURCE_ELEMENT_ID = 'libre-artifact-source';
const ROOT_ELEMENT_ID = 'root';

const showFailure = (heading: string, detail: string) => {
  const root = document.getElementById(ROOT_ELEMENT_ID);
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

/**
 * Generated artifacts are not consistent about how they expose their entry
 * component: a default export is the norm, a single named component happens,
 * and some mount themselves.
 */
const pickComponent = (
  module: Record<string, unknown>
): React.ComponentType | null => {
  const candidate = module.default;
  if (typeof candidate === 'function') {
    return candidate as React.ComponentType;
  }

  for (const [name, value] of Object.entries(module)) {
    if (typeof value === 'function' && /^[A-Z]/.test(name)) {
      return value as React.ComponentType;
    }
  }

  return null;
};

class ArtifactBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (this.state.error) {
      showFailure(
        'This artifact crashed while rendering.',
        `${this.state.error.message}\n\n${this.state.error.stack ?? ''}`.trim()
      );
      return null;
    }
    return this.props.children;
  }
}

const transpile = (source: string): string => {
  const result = Babel.transform(source, {
    filename: 'artifact.tsx',
    sourceType: 'module',
    // The .tsx filename above is what tells the TypeScript preset to parse
    // JSX; Babel 8 removed the explicit isTSX option.
    presets: ['typescript', ['react', { runtime: 'automatic' }]],
  });

  if (!result?.code) {
    throw new Error('The artifact produced no runnable code.');
  }
  return result.code;
};

const run = async () => {
  const source =
    document.getElementById(SOURCE_ELEMENT_ID)?.textContent?.trim() ?? '';
  const root = document.getElementById(ROOT_ELEMENT_ID);

  if (!source || !root) {
    showFailure('Nothing to render.', 'The artifact carried no source.');
    return;
  }

  let moduleUrl = '';
  try {
    const compiled = transpile(source);
    moduleUrl = URL.createObjectURL(
      new Blob([compiled], { type: 'text/javascript' })
    );
  } catch (error) {
    showFailure(
      'This artifact could not be compiled.',
      error instanceof Error ? error.message : String(error)
    );
    return;
  }

  try {
    const module = (await import(/* @vite-ignore */ moduleUrl)) as Record<
      string,
      unknown
    >;
    const Component = pickComponent(module);

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
        React.createElement(
          ArtifactBoundary,
          null,
          React.createElement(Component)
        )
      )
    );
  } catch (error) {
    showFailure(
      'This artifact failed to run.',
      error instanceof Error
        ? `${error.message}\n\n${error.stack ?? ''}`.trim()
        : String(error)
    );
  } finally {
    URL.revokeObjectURL(moduleUrl);
  }
};

window.addEventListener('unhandledrejection', event => {
  showFailure('This artifact raised an unhandled error.', String(event.reason));
});

void run();
