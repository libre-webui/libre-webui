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

export const MESSAGE_CODE_BACKGROUND = '#0D1117';

export const messageCodeBodyClassName =
  'max-h-[60vh] min-h-12 overflow-auto bg-[#0D1117] p-4 text-left font-mono text-[14px] leading-6 text-[#E6EDF3] whitespace-pre tabular-nums';

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
