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
];

export const OptimizedSyntaxHighlighter: React.FC<
  OptimizedSyntaxHighlighterProps
> = ({ children, language, isDark = false, className = '' }) => {
  const normalizedLanguage =
    languageMap[language.toLowerCase()] || language.toLowerCase();

  // Fallback to simple pre/code if language is not supported
  if (!supportedLanguages.includes(normalizedLanguage)) {
    return (
      <pre
        className={`bg-gray-100 dark:bg-dark-200 p-3 rounded-lg overflow-x-auto text-sm font-mono ${className}`}
      >
        <code>{children}</code>
      </pre>
    );
  }

  return (
    <SyntaxHighlighter
      language={normalizedLanguage}
      style={isDark ? oneDark : oneLight}
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
