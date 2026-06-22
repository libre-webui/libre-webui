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

declare module 'react-syntax-highlighter/dist/esm/prism-light' {
  import * as React from 'react';
  import type { CSSProperties } from 'react';

  export interface PrismLightProps {
    language?: string;
    style?: Record<string, CSSProperties>;
    children: string | string[];
    customStyle?: CSSProperties;
    className?: string;
    showLineNumbers?: boolean;
    [key: string]: unknown;
  }

  export default class SyntaxHighlighter extends React.Component<PrismLightProps> {
    static registerLanguage(name: string, grammar: unknown): void;
    static alias(name: string, alias: string | string[]): void;
    static alias(aliases: Record<string, string | string[]>): void;
  }
}

declare module 'react-syntax-highlighter/dist/esm/languages/prism/*' {
  const language: unknown;
  export default language;
}

declare module 'react-syntax-highlighter/dist/esm/styles/prism/*' {
  import type { CSSProperties } from 'react';

  const style: Record<string, CSSProperties>;
  export default style;
}
