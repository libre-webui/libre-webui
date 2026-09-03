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

import React from 'react';

type MathModule = typeof import('./markdownMath');
type HtmlModule = typeof import('./markdownHtml');

// Module-level caches: once a pipeline has loaded it is shared by every
// message on the page, and later renders never wait on it again.
let mathModule: MathModule | null = null;
let htmlModule: HtmlModule | null = null;
let mathPromise: Promise<MathModule> | null = null;
let htmlPromise: Promise<HtmlModule> | null = null;

const loadMath = () =>
  (mathPromise ??= import('./markdownMath').then(module => {
    mathModule = module;
    return module;
  }));

const loadHtml = () =>
  (htmlPromise ??= import('./markdownHtml').then(module => {
    htmlModule = module;
    return module;
  }));

/** Whether markdown text carries a remark-math delimiter after preprocessing. */
export const hasMathDelimiters = (content: string): boolean =>
  content.includes('$');

/**
 * Resolve the optional markdown pipelines a message needs. Returns null for
 * a pipeline until its chunk arrives; the caller renders without it in the
 * meantime and re-renders once it is available.
 */
export function useMarkdownExtras(options: {
  needsMath: boolean;
  needsHtml: boolean;
}): { math: MathModule | null; html: HtmlModule | null } {
  const { needsMath, needsHtml } = options;
  const [, rerender] = React.useReducer((count: number) => count + 1, 0);

  React.useEffect(() => {
    if (!needsMath || mathModule) return;
    let cancelled = false;
    void loadMath().then(() => {
      if (!cancelled) rerender();
    });
    return () => {
      cancelled = true;
    };
  }, [needsMath]);

  React.useEffect(() => {
    if (!needsHtml || htmlModule) return;
    let cancelled = false;
    void loadHtml().then(() => {
      if (!cancelled) rerender();
    });
    return () => {
      cancelled = true;
    };
  }, [needsHtml]);

  return {
    math: needsMath ? mathModule : null,
    html: needsHtml ? htmlModule : null,
  };
}
