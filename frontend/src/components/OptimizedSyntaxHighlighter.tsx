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
import diff from 'react-syntax-highlighter/dist/esm/languages/prism/diff';
import java from 'react-syntax-highlighter/dist/esm/languages/prism/java';
import javascript from 'react-syntax-highlighter/dist/esm/languages/prism/javascript';
import json from 'react-syntax-highlighter/dist/esm/languages/prism/json';
import jsx from 'react-syntax-highlighter/dist/esm/languages/prism/jsx';
import markdown from 'react-syntax-highlighter/dist/esm/languages/prism/markdown';
import markup from 'react-syntax-highlighter/dist/esm/languages/prism/markup';
import python from 'react-syntax-highlighter/dist/esm/languages/prism/python';
import shellSession from 'react-syntax-highlighter/dist/esm/languages/prism/shell-session';
import tsx from 'react-syntax-highlighter/dist/esm/languages/prism/tsx';
import typescript from 'react-syntax-highlighter/dist/esm/languages/prism/typescript';
import oneDark from 'react-syntax-highlighter/dist/esm/styles/prism/one-dark';
import oneLight from 'react-syntax-highlighter/dist/esm/styles/prism/one-light';

interface OptimizedSyntaxHighlighterProps {
  children: string;
  language: string;
  isDark?: boolean;
  className?: string;
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
};

const registeredLanguages = {
  bash,
  c,
  cpp,
  css,
  diff,
  java,
  javascript,
  json,
  jsx,
  markdown,
  markup,
  python,
  'shell-session': shellSession,
  tsx,
  typescript,
};

Object.entries(registeredLanguages).forEach(([language, grammar]) => {
  SyntaxHighlighter.registerLanguage(language, grammar);
});

SyntaxHighlighter.alias('markup', ['html', 'xml', 'svg']);

const supportedLanguages = new Set(Object.keys(registeredLanguages));

export const OptimizedSyntaxHighlighter: React.FC<
  OptimizedSyntaxHighlighterProps
> = ({ children, language, isDark = false, className = '' }) => {
  const normalizedLanguage =
    languageMap[language.toLowerCase()] || language.toLowerCase();

  if (!supportedLanguages.has(normalizedLanguage)) {
    return (
      <pre
        className={`bg-gray-100 dark:bg-dark-200 p-3 rounded-lg overflow-x-auto text-sm font-mono ${className}`}
      >
        <code className=''>{children}</code>
      </pre>
    );
  }

  const selectedStyle = isDark ? oneDark : oneLight;

  return (
    <SyntaxHighlighter
      language={normalizedLanguage}
      style={selectedStyle}
      className={className}
      customStyle={{
        margin: 0,
        padding: '0.75rem',
        borderRadius: '0.5rem',
        fontSize: '0.875rem',
      }}
      showLineNumbers={false}
    >
      {children}
    </SyntaxHighlighter>
  );
};

export default OptimizedSyntaxHighlighter;
