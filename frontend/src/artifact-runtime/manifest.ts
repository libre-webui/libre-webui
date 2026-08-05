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
 * Everything here is vendored into the application build and served from the
 * application's own origin. Artifacts run with no network access at all, so a
 * CDN reference would simply fail; these bundles are what makes an artifact
 * that imports `recharts` or loads Tailwind work anyway.
 *
 * This module is the single source of truth: the build derives its entry
 * points from it, and the sandbox derives its import map and CDN rewrites from
 * it. It must stay free of browser and Node APIs so both can read it.
 */

/** Public path the built bundles are served from. */
export const ARTIFACT_RUNTIME_PATH = '/artifact-runtime';

/**
 * Bare specifiers artifact modules may import, mapped to the bundle that
 * provides them. React and friends are built in a pass of their own so that
 * every library shares one React instance.
 */
export const ARTIFACT_MODULES: Record<string, string> = {
  react: 'react',
  'react-dom': 'react-dom',
  'react-dom/client': 'react-dom-client',
  'react/jsx-runtime': 'jsx-runtime',
  'react/jsx-dev-runtime': 'jsx-runtime',
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
};

/** Entry points for the React-sharing pass. */
export const ARTIFACT_CORE_ENTRIES = [
  'react',
  'react-dom',
  'react-dom-client',
  'jsx-runtime',
];

/** Entry points built against the shared React instance. */
export const ARTIFACT_LIBRARY_ENTRIES = [
  'recharts',
  'lucide-react',
  'd3',
  'three',
  'papaparse',
  'lodash',
  'mermaid',
  'chart',
  'react-bootstrap',
  'mermaid-bootstrap',
];

/**
 * Classic scripts that stand in for the CDN bundles HTML artifacts load. They
 * assign the same globals, in the same document position, so an artifact's own
 * inline scripts still find `Chart`, `d3`, or `React` when they run.
 */
export const ARTIFACT_GLOBAL_ENTRIES = [
  'tailwind',
  'chart',
  'd3',
  'three',
  'papaparse',
  'lodash',
  'mermaid',
  'react',
  'babel',
];

/**
 * CDN hosts a generated artifact is likely to reach for, and the local bundle
 * that replaces each one. Matched against the `src`/`href` of a tag.
 */
export const ARTIFACT_CDN_REPLACEMENTS: {
  pattern: RegExp;
  global: string;
}[] = [
  { pattern: /cdn\.tailwindcss\.com/i, global: 'tailwind' },
  { pattern: /(?:^|\/)tailwindcss(?:@[\d.]+)?(?:\/|$)/i, global: 'tailwind' },
  { pattern: /(?:^|\/)chart\.js(?:@[\d.]+)?(?:\/|$|\?)/i, global: 'chart' },
  { pattern: /(?:^|\/)chart(?:\.min)?\.js(?:$|\?)/i, global: 'chart' },
  { pattern: /(?:^|\/)d3(?:@[\d.]+)?(?:\/|$|\?)/i, global: 'd3' },
  { pattern: /(?:^|\/)d3(?:\.min)?\.js(?:$|\?)/i, global: 'd3' },
  { pattern: /(?:^|\/)three(?:@[\d.]+)?(?:\/|$|\?)/i, global: 'three' },
  { pattern: /(?:^|\/)three(?:\.min)?\.js(?:$|\?)/i, global: 'three' },
  { pattern: /papaparse/i, global: 'papaparse' },
  { pattern: /(?:^|\/)lodash(?:@[\d.]+)?(?:\/|$|\?)/i, global: 'lodash' },
  { pattern: /(?:^|\/)lodash(?:\.min)?\.js(?:$|\?)/i, global: 'lodash' },
  { pattern: /mermaid/i, global: 'mermaid' },
  { pattern: /react-dom/i, global: 'react' },
  { pattern: /(?:^|\/)react(?:@[\d.]+)?(?:\/|$|\?)/i, global: 'react' },
  { pattern: /babel(?:-standalone|\/standalone)/i, global: 'babel' },
];

export const artifactModuleUrl = (origin: string, bundle: string): string =>
  `${origin}${ARTIFACT_RUNTIME_PATH}/${bundle}.js`;

export const artifactGlobalUrl = (origin: string, bundle: string): string =>
  `${origin}${ARTIFACT_RUNTIME_PATH}/globals/${bundle}.js`;

/** Import map exposed to artifact modules, resolved against `origin`. */
export const artifactImportMap = (origin: string): string =>
  JSON.stringify({
    imports: Object.fromEntries(
      Object.entries(ARTIFACT_MODULES).map(([specifier, bundle]) => [
        specifier,
        artifactModuleUrl(origin, bundle),
      ])
    ),
  });
