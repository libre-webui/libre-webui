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

// Custom Ophelia theme - AMOLED black with purple accents
const opheliaTheme: { [key: string]: React.CSSProperties } = {
  'code[class*="language-"]': {
    color: '#e5e5e5',
    background: 'none',
    textShadow: 'none',
    fontFamily: "Consolas, Monaco, 'Andale Mono', 'Ubuntu Mono', monospace",
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
    color: '#e5e5e5',
    background: '#050505',
    textShadow: 'none',
    fontFamily: "Consolas, Monaco, 'Andale Mono', 'Ubuntu Mono', monospace",
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
  comment: { color: '#525252' },
  prolog: { color: '#525252' },
  doctype: { color: '#525252' },
  cdata: { color: '#525252' },
  punctuation: { color: '#737373' },
  property: { color: '#c084fc' },
  tag: { color: '#c084fc' },
  boolean: { color: '#c084fc' },
  number: { color: '#c084fc' },
  constant: { color: '#c084fc' },
  symbol: { color: '#c084fc' },
  deleted: { color: '#f87171' },
  selector: { color: '#a855f7' },
  'attr-name': { color: '#a855f7' },
  string: { color: '#86efac' },
  char: { color: '#86efac' },
  builtin: { color: '#a855f7' },
  inserted: { color: '#86efac' },
  operator: { color: '#e5e5e5' },
  entity: { color: '#e5e5e5', cursor: 'help' },
  url: { color: '#a855f7' },
  '.language-css .token.string': { color: '#e5e5e5' },
  '.style .token.string': { color: '#e5e5e5' },
  atrule: { color: '#e9d5ff' },
  'attr-value': { color: '#e9d5ff' },
  keyword: { color: '#e9d5ff' },
  function: { color: '#c084fc' },
  'class-name': { color: '#c084fc' },
  regex: { color: '#fcd34d' },
  important: { color: '#fcd34d', fontWeight: 'bold' },
  variable: { color: '#e5e5e5' },
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
        className={`bg-gray-100 dark:bg-dark-200 ophelia:bg-[#050505] p-3 rounded-lg overflow-x-auto text-sm font-mono ${className}`}
      >
        <code className='ophelia:text-[#e5e5e5]'>{children}</code>
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
        ...(isOphelia && { background: '#050505' }),
      }}
      showLineNumbers={false}
    >
      {children}
    </SyntaxHighlighter>
  );
};

export default OptimizedSyntaxHighlighter;
