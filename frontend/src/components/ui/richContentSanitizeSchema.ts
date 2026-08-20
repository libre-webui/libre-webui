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

import { defaultSchema } from 'rehype-sanitize';
import type { Schema } from 'hast-util-sanitize';

const SVG_PRESENTATION_ATTRIBUTES = [
  'clipPath',
  'clipRule',
  'd',
  'dominantBaseline',
  'fill',
  'fillOpacity',
  'fillRule',
  'fontFamily',
  'fontSize',
  'fontStyle',
  'fontWeight',
  'letterSpacing',
  'markerEnd',
  'markerMid',
  'markerStart',
  'mask',
  'opacity',
  'paintOrder',
  'stroke',
  'strokeDasharray',
  'strokeDashoffset',
  'strokeLinecap',
  'strokeLinejoin',
  'strokeMiterlimit',
  'strokeOpacity',
  'strokeWidth',
  'textAnchor',
  'transform',
  'vectorEffect',
] as const;

const SVG_TAG_ATTRIBUTES: Record<string, string[]> = {
  svg: ['viewBox', 'xmlns', 'preserveAspectRatio', 'role', 'ariaLabel'],
  g: [],
  defs: [],
  symbol: ['viewBox', 'preserveAspectRatio'],
  use: ['href', 'x', 'y'],
  title: [],
  desc: [],
  path: ['pathLength'],
  circle: ['cx', 'cy', 'r'],
  ellipse: ['cx', 'cy', 'rx', 'ry'],
  rect: ['x', 'y', 'rx', 'ry'],
  line: ['x1', 'y1', 'x2', 'y2'],
  polyline: ['points'],
  polygon: ['points'],
  text: ['x', 'y', 'dx', 'dy', 'rotate', 'textLength'],
  tspan: ['x', 'y', 'dx', 'dy', 'rotate'],
  linearGradient: [
    'x1',
    'y1',
    'x2',
    'y2',
    'gradientUnits',
    'gradientTransform',
    'spreadMethod',
    'href',
  ],
  radialGradient: [
    'cx',
    'cy',
    'r',
    'fx',
    'fy',
    'gradientUnits',
    'gradientTransform',
    'spreadMethod',
    'href',
  ],
  stop: ['offset', 'stopColor', 'stopOpacity'],
  clipPath: ['clipPathUnits'],
  mask: ['maskUnits', 'maskContentUnits', 'x', 'y'],
  pattern: [
    'patternUnits',
    'patternContentUnits',
    'patternTransform',
    'viewBox',
    'x',
    'y',
  ],
  marker: [
    'markerWidth',
    'markerHeight',
    'markerUnits',
    'refX',
    'refY',
    'orient',
    'viewBox',
  ],
};

const svgAttributes = Object.fromEntries(
  Object.entries(SVG_TAG_ATTRIBUTES).map(([tag, extra]) => [
    tag,
    [...SVG_PRESENTATION_ATTRIBUTES, ...extra],
  ])
);

/**
 * Sanitization schema for user-authored raw HTML in rich content previews.
 * Extends the GitHub-style default with inline SVG (presentation attributes
 * only — no <script>, <foreignObject>, event handlers, or style attributes)
 * and keeps the remark-math classes rehype-katex needs, since KaTeX runs
 * after sanitization. Ids are not clobber-prefixed so fill="url(#id)"
 * gradient/clip references keep resolving.
 */
export const richContentSanitizeSchema: Schema = {
  ...defaultSchema,
  clobberPrefix: '',
  tagNames: [...(defaultSchema.tagNames ?? []), ...Object.keys(svgAttributes)],
  attributes: {
    ...defaultSchema.attributes,
    ...svgAttributes,
    code: [['className', /^language-./, 'math-inline', 'math-display']],
  },
  protocols: {
    ...defaultSchema.protocols,
    href: [...(defaultSchema.protocols?.href ?? [])],
  },
};
