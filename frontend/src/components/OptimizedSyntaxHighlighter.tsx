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
