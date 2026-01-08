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
import ReactMarkdown from 'react-markdown';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import { OptimizedSyntaxHighlighter } from '@/components/OptimizedSyntaxHighlighter';
import { Copy, Check } from 'lucide-react';
import { useAppStore } from '@/store/appStore';
import { cn } from '@/utils';

interface MessageContentProps {
  content: string;
  className?: string;
}

// Preprocess content to normalize LaTeX delimiters
// Converts \[...\] to $$...$$ and \(...\) to $...$
const preprocessLaTeX = (content: string): string => {
  // First, protect code blocks from LaTeX processing
  const codeBlocks: string[] = [];
  let processed = content.replace(/```[\s\S]*?```|`[^`\n]+`/g, match => {
    codeBlocks.push(match);
    return `__CODE_BLOCK_${codeBlocks.length - 1}__`;
  });

  // Convert \[...\] to $$...$$ (block math)
  // Using function replacement to avoid backreference issues
  processed = processed.replace(/\\\[([\s\S]*?)\\\]/g, (_, p1) => `$$${p1}$$`);

  // Convert \(...\) to $...$ (inline math)
  processed = processed.replace(/\\\(([\s\S]*?)\\\)/g, (_, p1) => `$${p1}$`);

  // Restore code blocks
  codeBlocks.forEach((block, i) => {
    processed = processed.replace(`__CODE_BLOCK_${i}__`, block);
  });

  return processed;
};

export const MessageContent: React.FC<MessageContentProps> = ({
  content,
  className,
}) => {
  const { theme } = useAppStore();
  const [copiedCode, setCopiedCode] = React.useState<string | null>(null);

  // Preprocess content to normalize LaTeX delimiters
  const processedContent = React.useMemo(
    () => preprocessLaTeX(content),
    [content]
  );

  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedCode(text);
      setTimeout(() => setCopiedCode(null), 2000);
    } catch (_error) {
      console.error('Failed to copy text:', _error);
    }
  };

  return (
    <div
      className={cn(
        'prose prose-sm max-w-none dark:prose-invert prose-gray',
        '[&_.katex-display]:overflow-x-auto [&_.katex-display]:overflow-y-hidden [&_.katex-display]:py-2',
        '[&_.katex]:text-inherit',
        className
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={{
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          code({ inline, className, children, ...props }: any) {
            const match = /language-(\w+)/.exec(className || '');
            const codeString = String(children).replace(/\n$/, '');

            if (!inline && match) {
              return (
                <div className='relative group my-4 overflow-hidden rounded-xl border border-gray-200 dark:border-dark-300 shadow-sm'>
                  <div className='flex items-center justify-between bg-gray-50 dark:bg-dark-100 px-4 py-3 border-b border-gray-200 dark:border-dark-300'>
                    <span className='text-xs font-semibold text-gray-700 dark:text-dark-700 uppercase tracking-wide'>
                      {match[1]}
                    </span>
                    <button
                      onClick={() => copyToClipboard(codeString)}
                      className='opacity-0 group-hover:opacity-100 transition-all duration-200 p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-dark-300 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:ring-offset-1'
                      title='Copy code'
                    >
                      {copiedCode === codeString ? (
                        <Check className='h-4 w-4 text-success-600 dark:text-success-400' />
                      ) : (
                        <Copy className='h-4 w-4 text-gray-500 dark:text-dark-600' />
                      )}
                    </button>
                  </div>
                  <div className='overflow-x-auto'>
                    <OptimizedSyntaxHighlighter
                      language={match[1]}
                      isDark={theme.mode === 'dark'}
                      className='!m-0 !rounded-none !border-none'
                    >
                      {codeString}
                    </OptimizedSyntaxHighlighter>
                  </div>
                </div>
              );
            }

            return (
              <code
                className={cn(
                  'px-2 py-1 rounded-md bg-gray-100 dark:bg-dark-200 text-gray-800 dark:text-dark-800',
                  'font-mono text-sm border border-gray-200 dark:border-dark-300',
                  className
                )}
                {...props}
              >
                {children}
              </code>
            );
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          pre({ children, ...props }: any) {
            return <pre {...props}>{children}</pre>;
          },
          p({ children, ...props }) {
            return (
              <p className='mb-4 last:mb-0 leading-relaxed' {...props}>
                {children}
              </p>
            );
          },
          ul({ children, ...props }) {
            return (
              <ul
                className='list-disc list-inside mb-4 space-y-2 pl-4'
                {...props}
              >
                {children}
              </ul>
            );
          },
          ol({ children, ...props }) {
            return (
              <ol
                className='list-decimal list-inside mb-4 space-y-2 pl-4'
                {...props}
              >
                {children}
              </ol>
            );
          },
          li({ children, ...props }) {
            return (
              <li
                className='text-gray-700 dark:text-dark-700 leading-relaxed'
                {...props}
              >
                {children}
              </li>
            );
          },
          blockquote({ children, ...props }) {
            return (
              <blockquote
                className='border-l-4 border-primary-400 dark:border-primary-500 ophelia:border-[#a855f7] bg-primary-25 dark:bg-primary-950/30 ophelia:bg-[rgba(168,85,247,0.1)] pl-4 py-3 my-4 rounded-r-lg italic text-gray-700 dark:text-dark-700 ophelia:text-[#d4d4d4]'
                {...props}
              >
                {children}
              </blockquote>
            );
          },
          h1({ children, ...props }) {
            return (
              <h1
                className='text-2xl font-bold mb-4 mt-6 first:mt-0 text-gray-900 dark:text-dark-800 border-b border-gray-200 dark:border-dark-300 pb-2'
                {...props}
              >
                {children}
              </h1>
            );
          },
          h2({ children, ...props }) {
            return (
              <h2
                className='text-xl font-semibold mb-3 mt-6 first:mt-0 text-gray-900 dark:text-dark-800'
                {...props}
              >
                {children}
              </h2>
            );
          },
          h3({ children, ...props }) {
            return (
              <h3
                className='text-lg font-medium mb-3 mt-4 first:mt-0 text-gray-900 dark:text-dark-800'
                {...props}
              >
                {children}
              </h3>
            );
          },
        }}
      >
        {processedContent}
      </ReactMarkdown>
    </div>
  );
};
