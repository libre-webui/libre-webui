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
 * Composes the documents that run inside the artifact sandbox.
 *
 * Every dependency an artifact has travels inside the document as inline
 * script: React, the compiler, Tailwind, whatever libraries it imports, and —
 * for generated HTML that reaches for a CDN — the local stand-in for that CDN
 * bundle, spliced in where the tag was. The frame therefore issues no request
 * of its own, which is what keeps artifacts working behind an authenticating
 * proxy.
 */

import {
  ARTIFACT_BABEL_BUNDLE,
  ARTIFACT_MERMAID_PRELUDE,
  ARTIFACT_REACT_BUNDLE,
  ARTIFACT_REACT_PRELUDE,
  ARTIFACT_RUNTIME_BUNDLE,
  ARTIFACT_RUNTIME_GLOBAL,
  ARTIFACT_TAILWIND_BUNDLE,
  artifactBundlesFor,
  artifactCdnBundle,
  artifactBundlesForImports,
  artifactCdnBundlesFor,
  artifactUsesTailwind,
} from '@/artifact-runtime/manifest';
import {
  buildHtmlArtifactDocument,
  escapeArtifactHtml,
} from '@/utils/artifactHtml';
import { loadArtifactBundles } from '@/utils/artifactRuntimeLoader';

export type ArtifactSandboxKind = 'html' | 'react' | 'mermaid';

/** The sandbox kind for an artifact type, or null when it has no live preview. */
export function artifactSandboxKind(type: string): ArtifactSandboxKind | null {
  return type === 'html' || type === 'react' || type === 'mermaid'
    ? type
    : null;
}

export interface ArtifactDocumentOptions {
  colorScheme?: 'light' | 'dark';
}

const PAGE_STYLE = `
  html, body { margin: 0; min-height: 100%; }
  body {
    background: #ffffff;
    color: #111827;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  }
  #root { min-height: 100vh; }
  * { box-sizing: border-box; }
`;

/**
 * Artifact code as a JavaScript string literal.
 *
 * Escaping `<` outright is what makes this safe: no `</script`, no `<!--`, and
 * no double-escaped script state can be spelled at all, so artifact text can
 * never end the element it travels in. Escaping those sequences individually
 * is the fragile version of this.
 */
const jsStringLiteral = (value: string): string =>
  JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');

/**
 * Wraps a runtime bundle for inlining. These are this application's own build
 * output, not artifact content; the build refuses to emit a bundle containing
 * a script end tag, so nothing here needs escaping.
 */
const scriptTag = (source: string): string => `<script>${source}</script>`;

/**
 * Artifacts run on an opaque origin, where merely reading `localStorage`,
 * `sessionStorage` or `document.cookie` throws a SecurityError and takes the
 * whole script down with it. Generated code reaches for them constantly — to
 * remember a score, a theme, a draft — so the frame gets in-memory stand-ins.
 * State lives as long as the preview does, which is the honest behaviour for
 * something with no origin to persist against.
 */
const ARTIFACT_STORAGE_SHIM = `(function () {
  function createStorage() {
    var data = Object.create(null);
    var api = {
      getItem: function (key) {
        key = String(key);
        return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null;
      },
      setItem: function (key, value) { data[String(key)] = String(value); },
      removeItem: function (key) { delete data[String(key)]; },
      clear: function () { data = Object.create(null); },
      key: function (index) {
        var keys = Object.keys(data);
        return index < keys.length ? keys[index] : null;
      },
    };
    Object.defineProperty(api, 'length', { get: function () { return Object.keys(data).length; } });
    return api;
  }

  for (const name of ['localStorage', 'sessionStorage']) {
    try {
      void window[name];
    } catch (error) {
      Object.defineProperty(window, name, { value: createStorage(), configurable: true });
    }
  }

  // Generated code sometimes appends a font stylesheet itself. It cannot load
  // — artifacts have no network — and the vendored face is already injected,
  // so the tag is dropped instead of failing against the policy.
  var appendChild = Node.prototype.appendChild;
  var blocked = /fonts\\.(?:googleapis|gstatic)\\.com|^https?:\\/\\//i;
  Node.prototype.appendChild = function (node) {
    if (
      node &&
      node.tagName === 'LINK' &&
      String(node.rel || '').toLowerCase().indexOf('stylesheet') !== -1 &&
      blocked.test(String(node.href || ''))
    ) {
      return node;
    }
    return appendChild.call(this, node);
  };

  try {
    void document.cookie;
  } catch (error) {
    var jar = '';
    Object.defineProperty(document, 'cookie', {
      configurable: true,
      get: function () { return jar; },
      set: function (value) {
        var pair = String(value).split(';')[0];
        jar = jar ? jar + '; ' + pair : pair;
      },
    });
  }
})();`;

/** Script types whose body this runtime compiles instead of the browser. */
const COMPILED_SCRIPT_TYPES = new Set([
  'module',
  'text/babel',
  'application/babel',
]);

const isExternalUrl = (url: string): boolean => /^(?:https?:)?\/\//i.test(url);

/** Source of every inline module or Babel script, for dependency detection. */
function inlineScriptSources(html: string): string {
  const parsed = new DOMParser().parseFromString(html, 'text/html');

  return [...parsed.querySelectorAll('script')]
    .filter(
      script =>
        !script.getAttribute('src') &&
        COMPILED_SCRIPT_TYPES.has(
          (script.getAttribute('type') ?? '').trim().toLowerCase()
        )
    )
    .map(script => script.textContent ?? '')
    .join('\n');
}

/** Bundles this artifact needs, in load order. */
export function artifactBundleNames(
  kind: ArtifactSandboxKind,
  content: string
): string[] {
  if (kind === 'react') {
    return [
      ...new Set([...ARTIFACT_REACT_PRELUDE, ...artifactBundlesFor(content)]),
    ];
  }
  if (kind === 'mermaid') {
    return [...ARTIFACT_MERMAID_PRELUDE];
  }

  const inline = inlineScriptSources(content);
  const needed = new Set<string>(artifactCdnBundlesFor(content));
  for (const bundle of artifactBundlesForImports(inline)) {
    needed.add(bundle);
  }

  if (artifactUsesTailwind(content)) {
    // Written against Tailwind but loading nothing, which is how generated
    // markup usually arrives: the environment it was written for supplied the
    // utilities. Without this the artifact renders unstyled.
    needed.add(ARTIFACT_TAILWIND_BUNDLE);
  }

  if (inline.trim()) {
    // Those scripts are compiled in the frame, which needs the compiler and
    // the runtime that drives it.
    needed.add(ARTIFACT_BABEL_BUNDLE);
    if (/\bReact\b|jsx|<[A-Z]/.test(inline)) {
      needed.add(ARTIFACT_REACT_BUNDLE);
    }
  }

  // The runtime always ships. It is three kilobytes, and deciding case by case
  // whether a document needs it has been wrong often enough — a script the
  // rewrite compiles is worthless if the thing that compiles it was judged
  // unnecessary.
  return [
    ARTIFACT_RUNTIME_BUNDLE,
    ...[...needed].filter(name => name !== ARTIFACT_RUNTIME_BUNDLE),
  ];
}

/**
 * Rewrites a generated document for the sandbox.
 *
 * Parsed rather than pattern-matched. Every regex written against generated
 * markup here has eventually met a shape it mishandled — `<header>` read as
 * `<head>`, an end tag carrying attributes, a document with no head at all —
 * and the browser's own parser has none of those blind spots. It also
 * guarantees a head element to put the runtime in.
 *
 * Nothing executes while a document is parsed this way; it stays inert until
 * the sandbox frame loads the serialised result.
 */
function rewriteGeneratedHtml(
  html: string,
  sources: Record<string, string>,
  prelude: string[],
  missing: string[]
): string {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  const note = (text: string) => parsed.createComment(` ${text} `);

  const localBundleFor = (url: string): string | null => {
    const bundle = artifactCdnBundle(url);
    return bundle && sources[bundle] ? bundle : null;
  };

  for (const script of [...parsed.querySelectorAll('script')]) {
    const type = (script.getAttribute('type') ?? '').trim().toLowerCase();
    const src = script.getAttribute('src');

    if (type === 'importmap') {
      script.replaceWith(
        note('import map removed: modules resolve from the local runtime')
      );
      continue;
    }

    if (src) {
      const bundle = localBundleFor(src);
      if (bundle) {
        // Already in the head; loading it again would give Three.js, in
        // particular, a second copy of itself.
        script.replaceWith(note(`${bundle} is provided by the local runtime`));
      } else if (isExternalUrl(src)) {
        missing.push(src);
        script.replaceWith(note(`unavailable offline: ${src}`));
      }
      continue;
    }

    if (COMPILED_SCRIPT_TYPES.has(type)) {
      // Compiled by the runtime, so its imports resolve from the registry
      // rather than the network.
      const compiled = parsed.createElement('script');
      // Guarded, and loud when the guard fires: if the runtime is not there,
      // say what is, rather than leaving a bare TypeError in the console.
      compiled.textContent = `(function () {
  var runtime = window.${ARTIFACT_RUNTIME_GLOBAL};
  if (runtime && typeof runtime.runInline === 'function') {
    runtime.runInline(${jsStringLiteral(script.textContent ?? '')});
    return;
  }
  var report = document.createElement('pre');
  report.setAttribute('data-testid', 'artifact-runtime-missing');
  report.style.cssText = 'margin:16px;padding:12px;border:1px solid #f0a5a5;border-radius:8px;background:#fff5f5;color:#7f1d1d;font:12px/1.5 ui-monospace,Menlo,monospace;white-space:pre-wrap;';
  report.textContent = 'The artifact runtime did not load.\\n\\nregistry: ' +
    (runtime ? 'present, keys: ' + Object.keys(runtime).join(', ') : 'absent') +
    '\\nscripts in document: ' + document.querySelectorAll('script').length;
  (document.body || document.documentElement).appendChild(report);
})();`;
      script.replaceWith(compiled);
    }
  }

  for (const link of [...parsed.querySelectorAll('link')]) {
    const rel = (link.getAttribute('rel') ?? '').toLowerCase();
    if (/preconnect|dns-prefetch|icon|manifest/.test(rel)) continue;

    const href = link.getAttribute('href');
    if (!href) continue;
    if (!rel.includes('stylesheet') && !/\.css|fonts\.googleapis/i.test(href)) {
      continue;
    }

    const bundle = localBundleFor(href);
    if (bundle) {
      link.replaceWith(note(`${bundle} is provided by the local runtime`));
    } else if (isExternalUrl(href)) {
      missing.push(href);
      link.replaceWith(note(`unavailable offline: ${href}`));
    }
  }

  // The runtime goes first, ahead of the artifact's own scripts, so a library
  // is ready whichever order the generated tags happened to be in.
  const head = parsed.head;
  const preludeSources = [
    ...prelude,
    missing.length ? missingLibraryNotice(missing) : '',
  ].filter(Boolean);

  for (const source of [...preludeSources].reverse()) {
    const element = parsed.createElement('script');
    element.textContent = source;
    head.insertBefore(element, head.firstChild);
  }

  return `<!DOCTYPE html>${parsed.documentElement.outerHTML}`;
}

const missingLibraryNotice = (urls: string[]): string => {
  const names = urls
    .map(url => url.split('/').pop() || url)
    .filter((name, index, all) => all.indexOf(name) === index);

  return `(function () {
  var notice = document.createElement('div');
  notice.setAttribute('data-testid', 'artifact-missing-library');
  notice.style.cssText = 'position:sticky;top:0;z-index:2147483647;margin:0;padding:10px 14px;' +
    'background:#fff7ed;border-bottom:1px solid #fdba74;color:#7c2d12;' +
    'font:13px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;';
  notice.textContent = ${JSON.stringify(
    `This artifact asked for ${names.join(', ')}, which is not available offline. Artifacts run without network access; ask for a version that uses the built-in libraries.`
  )};
  var place = function () {
    if (document.body) document.body.insertBefore(notice, document.body.firstChild);
  };
  if (document.body) place();
  else document.addEventListener('DOMContentLoaded', place);
})();`;
};

const runtimeDocument = (
  title: string,
  source: string,
  bundleSources: string[],
  start: string,
  options: ArtifactDocumentOptions
): string => `<!DOCTYPE html>
<html lang="en" data-color-scheme="${options.colorScheme ?? 'light'}">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <base target="_blank" />
    <title>${escapeArtifactHtml(title)}</title>
    <style>${PAGE_STYLE}</style>
  </head>
  <body>
    <div id="root"></div>
    ${scriptTag(ARTIFACT_STORAGE_SHIM)}
    <script>window.__libreArtifactSource = ${jsStringLiteral(source)};</script>
${bundleSources.map(scriptTag).join('\n')}
    <script>window.${ARTIFACT_RUNTIME_GLOBAL}.${start}();</script>
  </body>
</html>`;

/** The document for an artifact of the given kind, with its runtime inlined. */
export function composeArtifactSandboxDocument(
  kind: ArtifactSandboxKind,
  content: string,
  title: string,
  sources: Record<string, string>,
  options: ArtifactDocumentOptions = {}
): string {
  const ordered = artifactBundleNames(kind, content)
    .map(name => sources[name])
    .filter((source): source is string => Boolean(source));

  if (kind === 'react') {
    return runtimeDocument(title, content, ordered, 'runReact', options);
  }
  if (kind === 'mermaid') {
    return runtimeDocument(title, content, ordered, 'runMermaid', options);
  }
  const missing: string[] = [];
  return rewriteGeneratedHtml(
    buildHtmlArtifactDocument(content, title),
    sources,
    [ARTIFACT_STORAGE_SHIM, ...ordered],
    missing
  );
}

/** Loads whatever the artifact needs, then composes its document. */
export async function buildArtifactSandboxDocument(
  kind: ArtifactSandboxKind,
  content: string,
  title: string,
  options: ArtifactDocumentOptions = {}
): Promise<string> {
  const sources = await loadArtifactBundles(artifactBundleNames(kind, content));
  return composeArtifactSandboxDocument(kind, content, title, sources, options);
}
