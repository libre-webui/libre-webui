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

/**
 * Puts the runtime at the very start of the document, whatever shape the
 * generated markup takes.
 *
 * Matching `<head...>` loosely is a trap: it also matches `<header>`, which
 * sits in the body, so the runtime would load after the scripts that need it.
 * Generated documents also skip `<head>` altogether often enough to matter.
 */
const HEAD_OPEN_TAG = /<head(\s[^>]*)?>/i;
const HTML_OPEN_TAG = /<html(\s[^>]*)?>/i;
const DOCTYPE_TAG = /<!doctype[^>]*>/i;

function injectDocumentPrelude(html: string, prelude: string): string {
  if (HEAD_OPEN_TAG.test(html)) {
    return html.replace(HEAD_OPEN_TAG, match => `${match}${prelude}`);
  }
  if (HTML_OPEN_TAG.test(html)) {
    return html.replace(
      HTML_OPEN_TAG,
      match => `${match}<head>${prelude}</head>`
    );
  }
  if (DOCTYPE_TAG.test(html)) {
    return html.replace(
      DOCTYPE_TAG,
      match => `${match}<head>${prelude}</head>`
    );
  }
  return `${prelude}${html}`;
}

/**
 * Script and link tags, matched in one pass with the attributes captured
 * separately.
 *
 * Deliberately not one regex per tag shape: nesting quantifiers inside a
 * `<script ...>` match backtracks badly on generated markup, and the attribute
 * string is short enough to inspect on its own.
 */
// The end tag may carry whitespace and even stray attributes — browsers
// accept `</script foo>` — and missing one would swallow the rest of the
// document into a single match.
const SCRIPT_TAG_PATTERN = /<script\b([^>]*)>([\s\S]*?)<\/script\b[^>]*>/gi;
const LINK_TAG_PATTERN = /<link\b([^>]*)>/gi;

/** The value of one attribute, read from a tag's attribute string. */
const attributeValue = (attributes: string, name: string): string | null => {
  const match = new RegExp(`\\b${name}\\s*=\\s*("|')([^"']*)\\1`, 'i').exec(
    attributes
  );
  return match ? match[2] : null;
};

const scriptType = (attributes: string): string =>
  (attributeValue(attributes, 'type') ?? '').trim().toLowerCase();

const COMPILED_SCRIPT_TYPES = new Set([
  'module',
  'text/babel',
  'application/babel',
]);

/**
 * Hands inline module and Babel scripts to the runtime instead of the browser.
 *
 * The modern Three.js boilerplate is an import map plus
 * `import * as THREE from 'three'`, and TypeScript artifacts arrive as
 * `<script type="text/babel">` with interfaces in them. Left alone the first
 * resolves over the network — which the sandbox forbids — and the second is
 * parsed without the TypeScript preset. Compiling both here fixes each.
 */
function compileInlineScripts(html: string): string {
  return html.replace(
    SCRIPT_TAG_PATTERN,
    (tag, attributes: string, body: string) => {
      const type = scriptType(attributes);

      if (type === 'importmap') {
        return '<!-- import map removed: modules resolve from the local runtime -->';
      }
      if (!COMPILED_SCRIPT_TYPES.has(type)) return tag;
      if (attributeValue(attributes, 'src')) return tag;
      if (!body.trim()) return '';

      return `<script>window.${ARTIFACT_RUNTIME_GLOBAL}.runInline(${jsStringLiteral(body)});</script>`;
    }
  );
}

/** Source of every inline module or Babel script, for dependency detection. */
function inlineScriptSources(html: string): string {
  const sources: string[] = [];

  for (const match of html.matchAll(SCRIPT_TAG_PATTERN)) {
    const [, attributes, body] = match;
    if (
      COMPILED_SCRIPT_TYPES.has(scriptType(attributes)) &&
      !attributeValue(attributes, 'src')
    ) {
      sources.push(body);
    }
  }

  return sources.join('\n');
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

  const ordered = [...needed];
  return ordered.length
    ? [
        ARTIFACT_RUNTIME_BUNDLE,
        ...ordered.filter(name => name !== ARTIFACT_RUNTIME_BUNDLE),
      ]
    : [];
}

/**
 * Replaces CDN tags with the vendored bundle inline, in the same document
 * position, so an artifact's own inline scripts still find the globals they
 * expect when they run.
 */
export function rewriteArtifactCdnReferences(
  html: string,
  sources: Record<string, string>,
  missing: string[] = []
): string {
  const drop = (url: string): string | null => {
    if (!/^(?:https?:)?\/\//i.test(url)) return null;

    // The same resolver the bundle list is built from, so a tag can never be
    // called missing while its bundle was available.
    const bundle = artifactCdnBundle(url);

    if (bundle && sources[bundle]) {
      // The bundle is already in the document head; loading it again would
      // give Three.js, in particular, a second copy of itself.
      return `<!-- ${bundle} is provided by the local runtime -->`;
    }

    // Nothing local stands in for this one, and the frame cannot fetch it.
    missing.push(url);
    return `<!-- unavailable offline: ${escapeArtifactHtml(url)} -->`;
  };

  const withScripts = html.replace(
    SCRIPT_TAG_PATTERN,
    (tag, attributes: string) => {
      const url = attributeValue(attributes, 'src');
      return url ? (drop(url) ?? tag) : tag;
    }
  );

  // External stylesheets cannot load either — a Google Fonts link is the
  // usual one — so they get the same treatment: replaced by the local
  // equivalent where one exists, and named where none does.
  return withScripts.replace(LINK_TAG_PATTERN, (tag, attributes: string) => {
    const rel = (attributeValue(attributes, 'rel') ?? '').toLowerCase();
    if (/preconnect|dns-prefetch|icon|manifest/.test(rel)) return tag;

    const url = attributeValue(attributes, 'href');
    if (!url) return tag;
    if (!rel.includes('stylesheet') && !/\.css|fonts\.googleapis/i.test(url)) {
      return tag;
    }

    return drop(url) ?? tag;
  });
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
  const compiled = compileInlineScripts(
    buildHtmlArtifactDocument(content, title)
  );
  const html = rewriteArtifactCdnReferences(compiled, sources, missing);

  // Everything the document needs goes in the head, ahead of the artifact's
  // own scripts, so a library is ready whichever order the generated tags
  // happened to be in.
  const prelude = [
    scriptTag(ARTIFACT_STORAGE_SHIM),
    ...ordered.map(scriptTag),
    missing.length ? scriptTag(missingLibraryNotice(missing)) : '',
  ].join('');

  return injectDocumentPrelude(html, prelude);
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
