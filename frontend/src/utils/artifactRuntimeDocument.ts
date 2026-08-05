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
  ARTIFACT_CDN_REPLACEMENTS,
  ARTIFACT_MERMAID_PRELUDE,
  ARTIFACT_REACT_PRELUDE,
  ARTIFACT_RUNTIME_GLOBAL,
  artifactBundlesFor,
  artifactCdnBundlesFor,
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
 * Script bodies are raw text until the parser meets `</script`, so any such
 * sequence inside one has to be broken up.
 */
const inlineScriptText = (source: string): string =>
  source.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--');

const scriptTag = (source: string): string =>
  `<script>${inlineScriptText(source)}</script>`;

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
  return artifactCdnBundlesFor(content);
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
  // One bundle often stands in for several tags — three.min.js and
  // OrbitControls.js both map to Three — and running it twice would load a
  // second copy of the library, which Three in particular refuses to work
  // with. Later tags for a bundle already inlined are dropped.
  const inlined = new Set<string>();

  const replacement = (url: string): string | null => {
    if (!/^(?:https?:)?\/\//i.test(url)) return null;
    for (const { pattern, bundle } of ARTIFACT_CDN_REPLACEMENTS) {
      if (!pattern.test(url)) continue;
      const source = sources[bundle];
      if (!source) return null;
      if (inlined.has(bundle)) {
        return `<!-- ${bundle} is already loaded above -->`;
      }
      inlined.add(bundle);
      return scriptTag(source);
    }
    return null;
  };

  const withScripts = html.replace(
    /<script\b[^>]*\bsrc\s*=\s*("|')(.*?)\1[^>]*>\s*<\/script>/gi,
    (tag, _quote: string, url: string) => {
      const local = replacement(url);
      if (local) return local;
      // An external script the sandbox has no local stand-in for. It cannot
      // load — artifacts have no network — so record it and drop the tag
      // rather than leave a policy violation in the console.
      if (/^(?:https?:)?\/\//i.test(url)) {
        missing.push(url);
        return `<!-- unavailable offline: ${escapeArtifactHtml(url)} -->`;
      }
      return tag;
    }
  );

  // A Tailwind stylesheet link becomes the browser build, which generates the
  // same utilities from the markup it finds.
  return withScripts.replace(
    /<link\b[^>]*\bhref\s*=\s*("|')(.*?)\1[^>]*>/gi,
    (tag, _quote: string, url: string) => {
      if (!/tailwind/i.test(url)) return tag;
      return replacement(url) ?? tag;
    }
  );
}

/**
 * Names what an artifact asked for and could not have. Silence would leave a
 * blank preview and a Content Security Policy line in the console; this says
 * plainly which library is missing.
 */
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
    <script type="text/plain" id="libre-artifact-source">${inlineScriptText(source)}</script>
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
  const html = rewriteArtifactCdnReferences(
    buildHtmlArtifactDocument(content, title),
    sources,
    missing
  );
  const prelude =
    scriptTag(ARTIFACT_STORAGE_SHIM) +
    (missing.length ? scriptTag(missingLibraryNotice(missing)) : '');

  return html.replace(
    /<head([^>]*)>/i,
    (tag, attributes: string) => `<head${attributes}>${prelude}`
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
