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
import SyntaxHighlighter from 'react-syntax-highlighter/dist/esm/prism-light';
import bash from 'react-syntax-highlighter/dist/esm/languages/prism/bash';
import c from 'react-syntax-highlighter/dist/esm/languages/prism/c';
import cpp from 'react-syntax-highlighter/dist/esm/languages/prism/cpp';
import css from 'react-syntax-highlighter/dist/esm/languages/prism/css';
import csharp from 'react-syntax-highlighter/dist/esm/languages/prism/csharp';
import diff from 'react-syntax-highlighter/dist/esm/languages/prism/diff';
import go from 'react-syntax-highlighter/dist/esm/languages/prism/go';
import java from 'react-syntax-highlighter/dist/esm/languages/prism/java';
import javascript from 'react-syntax-highlighter/dist/esm/languages/prism/javascript';
import json from 'react-syntax-highlighter/dist/esm/languages/prism/json';
import jsx from 'react-syntax-highlighter/dist/esm/languages/prism/jsx';
import kotlin from 'react-syntax-highlighter/dist/esm/languages/prism/kotlin';
import markdown from 'react-syntax-highlighter/dist/esm/languages/prism/markdown';
import markup from 'react-syntax-highlighter/dist/esm/languages/prism/markup';
import php from 'react-syntax-highlighter/dist/esm/languages/prism/php';
import python from 'react-syntax-highlighter/dist/esm/languages/prism/python';
import ruby from 'react-syntax-highlighter/dist/esm/languages/prism/ruby';
import rust from 'react-syntax-highlighter/dist/esm/languages/prism/rust';
import shellSession from 'react-syntax-highlighter/dist/esm/languages/prism/shell-session';
import sql from 'react-syntax-highlighter/dist/esm/languages/prism/sql';
import swift from 'react-syntax-highlighter/dist/esm/languages/prism/swift';
import tsx from 'react-syntax-highlighter/dist/esm/languages/prism/tsx';
import typescript from 'react-syntax-highlighter/dist/esm/languages/prism/typescript';
import yaml from 'react-syntax-highlighter/dist/esm/languages/prism/yaml';
import nightOwl from 'react-syntax-highlighter/dist/esm/styles/prism/night-owl';
import oneDark from 'react-syntax-highlighter/dist/esm/styles/prism/one-dark';
import oneLight from 'react-syntax-highlighter/dist/esm/styles/prism/one-light';

interface OptimizedSyntaxHighlighterProps {
  children: string;
  language: string;
  isDark?: boolean;
  className?: string;
  backgroundColor?: string;
  borderRadius?: string | number;
  customStyle?: React.CSSProperties;
  showLineNumbers?: boolean;
  /** 'night' swaps the dark style for Night Owl — used by artifact views. */
  codeTheme?: 'default' | 'night';
  /** Rendered as the outer pre; lets callers own scrolling and refs. */
  preTag?: React.ComponentType<React.HTMLAttributes<HTMLPreElement>>;
}

const languageMap: Record<string, string> = {
  js: 'javascript',
  ts: 'typescript',
  py: 'python',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  terminal: 'shell-session',
  console: 'shell-session',
  html: 'markup',
  xml: 'markup',
  svg: 'markup',
  'c++': 'cpp',
  cs: 'csharp',
  'c#': 'csharp',
  golang: 'go',
  kt: 'kotlin',
  rb: 'ruby',
  rs: 'rust',
  yml: 'yaml',
};

const registeredLanguages = {
  bash,
  c,
  cpp,
  css,
  csharp,
  diff,
  go,
  java,
  javascript,
  json,
  jsx,
  kotlin,
  markdown,
  markup,
  php,
  python,
  ruby,
  rust,
  'shell-session': shellSession,
  sql,
  swift,
  tsx,
  typescript,
  yaml,
};

Object.entries(registeredLanguages).forEach(([language, grammar]) => {
  SyntaxHighlighter.registerLanguage(language, grammar);
});

SyntaxHighlighter.alias('markup', ['html', 'xml', 'svg']);

const supportedLanguages = new Set(Object.keys(registeredLanguages));

export const OptimizedSyntaxHighlighter: React.FC<
  OptimizedSyntaxHighlighterProps
> = ({
  children,
  language,
  isDark = false,
  className = '',
  backgroundColor,
  borderRadius = '0.5rem',
  customStyle,
  showLineNumbers = false,
  codeTheme = 'default',
  preTag,
}) => {
  const normalizedLanguage =
    languageMap[language.toLowerCase()] || language.toLowerCase();

  if (!supportedLanguages.has(normalizedLanguage)) {
    // The plain fallback must still honor the caller's pre element so
    // scroll ownership (streaming tail-follow) survives unknown languages.
    const PlainPre = preTag ?? 'pre';
    return (
      <PlainPre
        dir='ltr'
        style={{
          ...customStyle,
          ...(backgroundColor ? { backgroundColor } : {}),
        }}
        className={`${isDark ? 'bg-dark-50 text-dark-900' : 'bg-gray-100 text-gray-900'} overflow-x-auto rounded-lg p-3 text-left font-mono text-sm ${className}`}
      >
        <code className=''>{children}</code>
      </PlainPre>
    );
  }

  const selectedStyle = isDark
    ? codeTheme === 'night'
      ? nightOwl
      : oneDark
    : oneLight;

  return (
    <div dir='ltr' className='text-left'>
      <SyntaxHighlighter
        language={normalizedLanguage}
        style={selectedStyle}
        className={className}
        customStyle={{
          margin: 0,
          padding: '0.75rem',
          borderRadius,
          fontSize: '0.875rem',
          fontFamily:
            '"JetBrains Mono", ui-monospace, SFMono-Regular, monospace',
          ...customStyle,
          ...(backgroundColor
            ? { background: backgroundColor, backgroundColor }
            : {}),
        }}
        showLineNumbers={showLineNumbers}
        lineNumberStyle={{
          minWidth: '2.5em',
          paddingRight: '1.25em',
          color: isDark ? '#6E7681' : '#9CA3AF',
          userSelect: 'none',
        }}
        {...(preTag ? { PreTag: preTag } : {})}
      >
        {children}
      </SyntaxHighlighter>
    </div>
  );
};

export default OptimizedSyntaxHighlighter;
