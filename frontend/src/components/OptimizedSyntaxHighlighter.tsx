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
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import {
  oneDark,
  oneLight,
} from 'react-syntax-highlighter/dist/esm/styles/prism';
import { useAppStore } from '@/store/appStore';

interface OptimizedSyntaxHighlighterProps {
  children: string;
  language: string;
  isDark?: boolean;
  className?: string;
}

// Custom Ophelia theme - Cosmic Space (matching Kitty terminal)
const opheliaTheme: { [key: string]: React.CSSProperties } = {
  'code[class*="language-"]': {
    color: '#f8f8f2',
    background: 'none',
    textShadow: 'none',
    fontFamily: "'JetBrains Mono', Consolas, Monaco, 'Andale Mono', monospace",
    fontSize: '1em',
    textAlign: 'left',
    whiteSpace: 'pre',
    wordSpacing: 'normal',
    wordBreak: 'normal',
    wordWrap: 'normal',
    lineHeight: '1.5',
    tabSize: 4,
    hyphens: 'none',
  },
  'pre[class*="language-"]': {
    color: '#f8f8f2',
    background: '#1a1b26',
    textShadow: 'none',
    fontFamily: "'JetBrains Mono', Consolas, Monaco, 'Andale Mono', monospace",
    fontSize: '1em',
    textAlign: 'left',
    whiteSpace: 'pre',
    wordSpacing: 'normal',
    wordBreak: 'normal',
    wordWrap: 'normal',
    lineHeight: '1.5',
    tabSize: 4,
    hyphens: 'none',
    padding: '1em',
    margin: '.5em 0',
    overflow: 'auto',
    borderRadius: '0.5rem',
  },
  comment: { color: '#6272a4' },
  prolog: { color: '#6272a4' },
  doctype: { color: '#6272a4' },
  cdata: { color: '#6272a4' },
  punctuation: { color: '#f8f8f2' },
  property: { color: '#ff79c6' },
  tag: { color: '#ff79c6' },
  boolean: { color: '#bd93f9' },
  number: { color: '#bd93f9' },
  constant: { color: '#bd93f9' },
  symbol: { color: '#bd93f9' },
  deleted: { color: '#ff5555' },
  selector: { color: '#50fa7b' },
  'attr-name': { color: '#50fa7b' },
  string: { color: '#f1fa8c' },
  char: { color: '#f1fa8c' },
  builtin: { color: '#8be9fd' },
  inserted: { color: '#50fa7b' },
  operator: { color: '#ff79c6' },
  entity: { color: '#f8f8f2', cursor: 'help' },
  url: { color: '#8be9fd' },
  '.language-css .token.string': { color: '#f1fa8c' },
  '.style .token.string': { color: '#f1fa8c' },
  atrule: { color: '#ff79c6' },
  'attr-value': { color: '#f1fa8c' },
  keyword: { color: '#ff79c6' },
  function: { color: '#50fa7b' },
  'class-name': { color: '#8be9fd' },
  regex: { color: '#f1fa8c' },
  important: { color: '#ff5555', fontWeight: 'bold' },
  variable: { color: '#f8f8f2' },
};

const languageMap: Record<string, string> = {
  js: 'javascript',
  ts: 'typescript',
  py: 'python',
  sh: 'bash',
  shell: 'bash',
  c: 'cpp',
  'c++': 'cpp',
};

// Only support essential languages to reduce bundle size
const supportedLanguages = [
  'javascript',
  'typescript',
  'python',
  'java',
  'cpp',
  'bash',
  'json',
  'markdown',
  'css',
  'html',
  'jsx', // Added for React components
  'xml', // Added for SVG
];

export const OptimizedSyntaxHighlighter: React.FC<
  OptimizedSyntaxHighlighterProps
> = ({ children, language, isDark = false, className = '' }) => {
  const { theme } = useAppStore();
  const isOphelia = theme.mode === 'ophelia';

  const normalizedLanguage =
    languageMap[language.toLowerCase()] || language.toLowerCase();

  // Fallback to simple pre/code if language is not supported
  if (!supportedLanguages.includes(normalizedLanguage)) {
    return (
      <pre
        className={`bg-gray-100 dark:bg-dark-200 ophelia:bg-[#1a1b26] p-3 rounded-lg overflow-x-auto text-sm font-mono ${className}`}
      >
        <code className='ophelia:text-[#f8f8f2]'>{children}</code>
      </pre>
    );
  }

  // Select the appropriate theme
  const selectedStyle = isOphelia ? opheliaTheme : isDark ? oneDark : oneLight;

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
        ...(isOphelia && { background: '#1a1b26' }),
      }}
      showLineNumbers={false}
    >
      {children}
    </SyntaxHighlighter>
  );
};

export default OptimizedSyntaxHighlighter;
