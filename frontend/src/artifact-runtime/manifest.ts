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
 * The artifact runtime: the libraries generated artifacts expect to be there.
 *
 * Everything is vendored into the application build. The sandbox frame never
 * fetches any of it: the application page loads these bundles itself and hands
 * the source to the frame, which runs them inline. That keeps artifacts
 * working when the deployment sits behind an authenticating proxy — Cloudflare
 * Access, Authelia, oauth2-proxy — where a sandboxed frame's requests carry no
 * session cookie and would be redirected to a login page.
 *
 * This module is the single source of truth: the build derives its entry
 * points from it, and the sandbox derives its module registry from it. It must
 * stay free of browser and Node APIs so both can read it.
 */

/** Path the built bundles are served from, for the application page to fetch. */
export const ARTIFACT_RUNTIME_PATH = '/artifact-runtime';

/** Registry and the code that compiles and mounts an artifact. Tiny. */
export const ARTIFACT_RUNTIME_BUNDLE = 'runtime';

/** React, ReactDOM and the JSX runtime, shared by every other bundle. */
export const ARTIFACT_REACT_BUNDLE = 'react';

/** Turns the JSX or TSX an artifact is written in into something runnable. */
export const ARTIFACT_BABEL_BUNDLE = 'babel';

/** Generates utility classes from the markup an artifact renders. */
export const ARTIFACT_TAILWIND_BUNDLE = 'tailwind';

/** The application's self-hosted Inter, inlined for artifacts to use. */
export const ARTIFACT_FONTS_BUNDLE = 'fonts';

/**
 * Bare specifiers artifact code may import, and the bundle that provides each.
 * A bundle registers itself under every specifier listed here.
 */
export const ARTIFACT_MODULES: Record<string, string> = {
  react: ARTIFACT_REACT_BUNDLE,
  'react-dom': ARTIFACT_REACT_BUNDLE,
  'react-dom/client': ARTIFACT_REACT_BUNDLE,
  'react/jsx-runtime': ARTIFACT_REACT_BUNDLE,
  'react/jsx-dev-runtime': ARTIFACT_REACT_BUNDLE,
  recharts: 'recharts',
  'lucide-react': 'lucide-react',
  d3: 'd3',
  three: 'three',
  papaparse: 'papaparse',
  lodash: 'lodash',
  'lodash-es': 'lodash',
  mermaid: 'mermaid',
  'chart.js': 'chart',
  'chart.js/auto': 'chart',
  tone: 'tone',
  mathjs: 'mathjs',
  'plotly.js': 'plotly',
  'plotly.js-dist-min': 'plotly',
  'framer-motion': 'framer-motion',
  'motion/react': 'framer-motion',
  motion: 'framer-motion',
  'three/addons/controls/OrbitControls.js': 'three',
  'three/examples/jsm/controls/OrbitControls.js': 'three',
};

/** Bundles built against the shared React instance in the react bundle. */
export const ARTIFACT_LIBRARY_BUNDLES = [
  'recharts',
  'lucide-react',
  'd3',
  'three',
  'papaparse',
  'lodash',
  ARTIFACT_FONTS_BUNDLE,
  'mermaid',
  'chart',
  'tone',
  'mathjs',
  'plotly',
  'framer-motion',
];

export const ARTIFACT_BUNDLES = [
  ARTIFACT_RUNTIME_BUNDLE,
  ARTIFACT_REACT_BUNDLE,
  ARTIFACT_BABEL_BUNDLE,
  ARTIFACT_TAILWIND_BUNDLE,
  ...ARTIFACT_LIBRARY_BUNDLES,
];

/** Bundles a React artifact always needs, in load order. */
export const ARTIFACT_REACT_PRELUDE = [
  ARTIFACT_RUNTIME_BUNDLE,
  ARTIFACT_REACT_BUNDLE,
  ARTIFACT_BABEL_BUNDLE,
  ARTIFACT_TAILWIND_BUNDLE,
];

/** Bundles a Mermaid artifact needs, in load order. */
export const ARTIFACT_MERMAID_PRELUDE = [ARTIFACT_RUNTIME_BUNDLE, 'mermaid'];

/**
 * CDN hosts a generated HTML artifact is likely to reach for, and the bundle
 * that replaces each. The tag is replaced by the bundle's source inline, in
 * the same document position, so the artifact's own inline scripts still find
 * the globals they expect when they run.
 */
export const ARTIFACT_CDN_REPLACEMENTS: {
  pattern: RegExp;
  bundle: string;
}[] = [
  { pattern: /cdn\.tailwindcss\.com/i, bundle: ARTIFACT_TAILWIND_BUNDLE },
  {
    pattern: /(?:^|\/)tailwindcss(?:@[\d.]+)?(?:\/|$)/i,
    bundle: ARTIFACT_TAILWIND_BUNDLE,
  },
  { pattern: /(?:^|\/)chart\.js(?:@[\d.]+)?(?:\/|$|\?)/i, bundle: 'chart' },
  { pattern: /(?:^|\/)chart(?:\.min)?\.js(?:$|\?)/i, bundle: 'chart' },
  { pattern: /(?:^|\/)d3(?:@[\d.]+)?(?:\/|$|\?)/i, bundle: 'd3' },
  { pattern: /(?:^|\/)d3(?:\.min)?\.js(?:$|\?)/i, bundle: 'd3' },
  { pattern: /(?:^|\/)three(?:@[\d.]+)?(?:\/|$|\?)/i, bundle: 'three' },
  { pattern: /(?:^|\/)three(?:\.min)?\.js(?:$|\?)/i, bundle: 'three' },
  { pattern: /papaparse/i, bundle: 'papaparse' },
  { pattern: /(?:^|\/)lodash(?:@[\d.]+)?(?:\/|$|\?)/i, bundle: 'lodash' },
  { pattern: /(?:^|\/)lodash(?:\.min)?\.js(?:$|\?)/i, bundle: 'lodash' },
  {
    pattern: /fonts\.(?:googleapis|gstatic)\.com/i,
    bundle: ARTIFACT_FONTS_BUNDLE,
  },
  { pattern: /mermaid/i, bundle: 'mermaid' },
  {
    pattern: /(?:^|\/)tone(?:@[\d.]+)?(?:\/|$|\?)|tone(?:\.min)?\.js/i,
    bundle: 'tone',
  },
  { pattern: /mathjs|math(?:\.min)?\.js/i, bundle: 'mathjs' },
  { pattern: /plotly/i, bundle: 'plotly' },
  {
    pattern: /framer-motion|(?:^|\/)motion(?:@[\d.]+)?(?:\/|$)/i,
    bundle: 'framer-motion',
  },
  { pattern: /react-dom/i, bundle: ARTIFACT_REACT_BUNDLE },
  {
    pattern: /(?:^|\/)react(?:@[\d.]+)?(?:\/|$|\?)/i,
    bundle: ARTIFACT_REACT_BUNDLE,
  },
  {
    pattern: /babel(?:-standalone|\/standalone)/i,
    bundle: ARTIFACT_BABEL_BUNDLE,
  },
];

/** Global the bundles register themselves on inside the sandbox frame. */
export const ARTIFACT_RUNTIME_GLOBAL = '__libreArtifactRuntime';

/**
 * The registry key for whatever an artifact wrote in an import: a bare
 * specifier, a CDN URL, or a subpath of one of the vendored packages. This is
 * what lets `import * as THREE from 'https://cdn.../three.module.js'` and
 * `import 'three'` land on the same instance.
 */
export function artifactModuleKey(specifier: string): string | null {
  if (ARTIFACT_MODULES[specifier]) return specifier;

  const bundle = ARTIFACT_CDN_REPLACEMENTS.find(({ pattern }) =>
    pattern.test(specifier)
  )?.bundle;

  const fromBundle =
    bundle ??
    // A subpath of a vendored package, such as three/addons/... — the bundle
    // merges its addons, so the package itself answers for them.
    Object.values(ARTIFACT_MODULES).find(name =>
      specifier.startsWith(`${name}/`)
    );

  if (!fromBundle) return null;

  return (
    Object.entries(ARTIFACT_MODULES).find(
      ([, name]) => name === fromBundle
    )?.[0] ?? null
  );
}

/** Bundles needed by the imports written inside a script body. */
export function artifactBundlesForImports(source: string): string[] {
  const needed = new Set<string>();
  const specifiers = source.matchAll(
    /(?:from|import|require)\s*\(?\s*['"`]([^'"`]+)['"`]/g
  );

  for (const [, specifier] of specifiers) {
    const key = artifactModuleKey(specifier);
    if (key) needed.add(ARTIFACT_MODULES[key]);
  }

  return [...needed];
}

/**
 * Whether markup is written against Tailwind. Generated HTML often uses the
 * utilities without loading anything, because the environment it was written
 * for supplies them; without this the artifact renders unstyled.
 *
 * Several distinct utilities are required so ordinary class names — a `grid`
 * or a `card` — do not drag Tailwind's reset into a hand-styled artifact.
 */
const TAILWIND_UTILITIES =
  /\b(?:flex|grid|hidden|absolute|relative|(?:p|m|px|py|mx|my|mt|mb|ml|mr|gap|space)-\d|(?:w|h|max-w|min-h)-(?:\d|full|screen|auto)|text-(?:xs|sm|base|lg|xl|\dxl|center|left|right|white|black|gray-\d)|bg-(?:white|black|transparent|[a-z]+-\d)|rounded(?:-[a-z]+)?|shadow(?:-[a-z]+)?|border(?:-\d)?|items-(?:center|start|end)|justify-(?:center|between|around|end)|font-(?:bold|medium|semibold|light)|hover:[a-z-]+|(?:sm|md|lg|xl):[a-z-]+)\b/g;

export function artifactUsesTailwind(html: string): boolean {
  const classAttributes = [...html.matchAll(/class\s*=\s*("|')(.*?)\1/gi)]
    .map(match => match[2])
    .join(' ');

  const matched = new Set(classAttributes.match(TAILWIND_UTILITIES) ?? []);
  return matched.size >= 3;
}

/** Bundles a piece of artifact code needs, based on what it imports. */
export function artifactBundlesFor(source: string): string[] {
  const needed = new Set<string>();

  for (const [specifier, bundle] of Object.entries(ARTIFACT_MODULES)) {
    const quoted = specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const referenced = new RegExp(
      `(?:from|import|require)\\s*\\(?\\s*['"\`]${quoted}['"\`]`
    ).test(source);
    if (referenced) {
      needed.add(bundle);
    }
  }

  return [...needed];
}

/**
 * The bundle that stands in for a URL, or null when nothing local does.
 *
 * The patterns above are anchored to the end of a URL, so they must be tested
 * against one URL at a time. Testing them against a whole document silently
 * matches nothing, which is how a tag ends up reported as missing while its
 * bundle sits unused.
 */
export function artifactCdnBundle(url: string): string | null {
  return (
    ARTIFACT_CDN_REPLACEMENTS.find(({ pattern }) => pattern.test(url))
      ?.bundle ?? null
  );
}

/** Every URL a document references, from a tag attribute or an import. */
export function artifactReferencedUrls(html: string): string[] {
  const urls = new Set<string>();

  for (const match of html.matchAll(/\b(?:src|href)\s*=\s*("|')(.*?)\1/gi)) {
    urls.add(match[2]);
  }
  for (const match of html.matchAll(
    /(?:from|import|require)\s*\(?\s*['"`]([^'"`]+)['"`]/g
  )) {
    urls.add(match[1]);
  }

  return [...urls];
}

/** Bundles referenced by the URLs in generated HTML. */
export function artifactCdnBundlesFor(html: string): string[] {
  const needed = new Set<string>();

  for (const url of artifactReferencedUrls(html)) {
    const bundle = artifactCdnBundle(url);
    if (bundle) needed.add(bundle);
  }

  return [...needed];
}
