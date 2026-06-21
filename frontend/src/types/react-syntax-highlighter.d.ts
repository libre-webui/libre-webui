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
