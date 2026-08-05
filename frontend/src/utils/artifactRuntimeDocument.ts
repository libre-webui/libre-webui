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
 * Artifacts have no network access, so anything a generated artifact expects
 * to fetch from a CDN is served from the application's own build instead: a
 * React artifact gets an import map, and an HTML artifact that loads Tailwind
 * or Chart.js from a CDN gets those tags pointed at the vendored equivalents.
 */

import {
  ARTIFACT_CDN_REPLACEMENTS,
  artifactGlobalUrl,
  artifactImportMap,
  artifactModuleUrl,
  ARTIFACT_MODULES,
} from '@/artifact-runtime/manifest';
import {
  buildHtmlArtifactDocument,
  escapeArtifactHtml,
} from '@/utils/artifactHtml';

export type ArtifactSandboxKind = 'html' | 'react' | 'mermaid';

/** The sandbox kind for an artifact type, or null when it has no live preview. */
export function artifactSandboxKind(type: string): ArtifactSandboxKind | null {
  return type === 'html' || type === 'react' || type === 'mermaid'
    ? type
    : null;
}

export interface ArtifactDocumentOptions {
  /** Origin serving the vendored runtime bundles. */
  origin: string;
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
 * Artifact source travels inside an inert script tag, so a `</script>` in the
 * source would end it early.
 */
const inertScriptText = (source: string): string =>
  source.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--');

/** Local stand-in for a CDN URL, or null when the URL is not one we vendor. */
const localReplacement = (
  url: string,
  origin: string,
  asModule: boolean
): string | null => {
  if (!/^(?:https?:)?\/\//i.test(url)) return null;

  for (const { pattern, global } of ARTIFACT_CDN_REPLACEMENTS) {
    if (!pattern.test(url)) continue;
    if (
      asModule &&
      ARTIFACT_MODULES[global === 'chart' ? 'chart.js' : global]
    ) {
      return artifactModuleUrl(
        origin,
        ARTIFACT_MODULES[global === 'chart' ? 'chart.js' : global]
      );
    }
    return artifactGlobalUrl(origin, global);
  }

  return null;
};

/**
 * Points CDN tags at the vendored bundles. Classic scripts keep their position
 * in the document, so an artifact's own inline scripts still find the globals
 * they expect when they run.
 */
export function rewriteArtifactCdnReferences(
  html: string,
  origin: string
): string {
  const withScripts = html.replace(
    /<script\b([^>]*)\bsrc\s*=\s*("|')(.*?)\2([^>]*)>/gi,
    (tag, before: string, quote: string, url: string, after: string) => {
      const asModule = /type\s*=\s*("|')module\1/i.test(`${before}${after}`);
      const replacement = localReplacement(url, origin, asModule);
      if (!replacement) return tag;
      return `<script${before}src=${quote}${replacement}${quote}${after}>`;
    }
  );

  // A Tailwind stylesheet link becomes the browser build, which generates the
  // same utilities from the markup it finds.
  return withScripts.replace(
    /<link\b[^>]*\bhref\s*=\s*("|')(.*?)\1[^>]*>/gi,
    (tag, _quote: string, url: string) => {
      const replacement = localReplacement(url, origin, false);
      if (!replacement || !/tailwind/i.test(url)) return tag;
      return `<script src="${replacement}"></script>`;
    }
  );
}

const runtimeDocument = (
  title: string,
  source: string,
  bootstrap: string,
  options: ArtifactDocumentOptions,
  head = ''
): string => `<!DOCTYPE html>
<html lang="en" data-color-scheme="${options.colorScheme ?? 'light'}">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <base target="_blank" />
    <title>${escapeArtifactHtml(title)}</title>
${head}    <style>${PAGE_STYLE}</style>
  </head>
  <body>
    <div id="root"></div>
    <script type="text/plain" id="libre-artifact-source">${inertScriptText(source)}</script>
    <script type="module" src="${artifactModuleUrl(options.origin, bootstrap)}"></script>
  </body>
</html>`;

/**
 * A React artifact: JSX or TSX source compiled in the frame, mounted against
 * the shared React instance, with Tailwind utilities available.
 */
export function buildReactArtifactDocument(
  content: string,
  title: string,
  options: ArtifactDocumentOptions
): string {
  const importMap = `    <script type="importmap">${artifactImportMap(options.origin)}</script>\n`;
  return runtimeDocument(title, content, 'react-bootstrap', options, importMap);
}

export function buildMermaidArtifactDocument(
  content: string,
  title: string,
  options: ArtifactDocumentOptions
): string {
  return runtimeDocument(title, content, 'mermaid-bootstrap', options);
}

/** The document for an artifact of the given kind, ready to hand the sandbox. */
export function buildArtifactSandboxDocument(
  kind: ArtifactSandboxKind,
  content: string,
  title: string,
  options: ArtifactDocumentOptions
): string {
  switch (kind) {
    case 'react':
      return buildReactArtifactDocument(content, title, options);
    case 'mermaid':
      return buildMermaidArtifactDocument(content, title, options);
    case 'html':
    default:
      return rewriteArtifactCdnReferences(
        buildHtmlArtifactDocument(content, title),
        options.origin
      );
  }
}
