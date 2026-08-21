/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import type { CSSProperties } from 'react';

// The same surface the artifact code view uses, so message code blocks
// follow the active theme (including AMOLED black) instead of pinning
// GitHub's palette.
export const MESSAGE_CODE_BACKGROUND_DARK = 'rgb(var(--color-dark-50))';
export const MESSAGE_CODE_BACKGROUND_LIGHT = 'rgb(var(--color-surface-subtle))';

export const messageCodeBodyClassName =
  'max-h-[60vh] min-h-12 overflow-auto bg-surface-subtle p-4 text-left font-mono text-[14px] leading-6 text-ink whitespace-pre tabular-nums dark:bg-dark-50 dark:text-dark-900';

export const messageCodeBodyStyle: CSSProperties = {
  maxHeight: '60vh',
  minHeight: '3rem',
  overflow: 'auto',
  padding: '1rem',
  fontSize: '14px',
  lineHeight: '1.5rem',
  fontFamily: '"JetBrains Mono", ui-monospace, SFMono-Regular, monospace',
  whiteSpace: 'pre',
};
