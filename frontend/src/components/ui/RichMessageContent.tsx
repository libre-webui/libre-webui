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
import ReactMarkdown, {
  type Components,
  type ExtraProps,
} from 'react-markdown';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import { Copy, Check } from 'lucide-react';
import { useAppStore } from '@/store/appStore';
import { cn } from '@/utils';
import { createLogger } from '@/utils/logger';
import { preprocessLaTeX } from './messageContentUtils';

const logger = createLogger('components:ui:rich-message-content');
const LazySyntaxHighlighter = React.lazy(
  () => import('@/components/OptimizedSyntaxHighlighter')
);

interface RichMessageContentProps {
  content: string;
  className?: string;
}

type MarkdownCodeProps = React.ComponentPropsWithoutRef<'code'> & ExtraProps;
type MarkdownPreProps = React.ComponentPropsWithoutRef<'pre'> & ExtraProps;

function CodeFallback({
  children,
  className,
}: {
  children: string;
  className?: string;
}) {
  return (
    <pre
      dir='ltr'
      className={cn(
        'bg-gray-100 dark:bg-dark-200 p-3 rounded-lg overflow-x-auto text-left text-sm font-mono',
        className
      )}
    >
      <code>{children}</code>
    </pre>
  );
}

export const RichMessageContent: React.FC<RichMessageContentProps> = ({
  content,
  className,
}) => {
  const { theme } = useAppStore();
  const [copiedCode, setCopiedCode] = React.useState<string | null>(null);

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
      logger.error('Failed to copy text:', _error);
    }
  };

  const markdownComponents: Components = {
    code({ className, children, node: _node, ...props }: MarkdownCodeProps) {
      const match = /language-([^\s]+)/.exec(className || '');
      const rawCode = String(children);
      const codeString = rawCode.replace(/\n$/, '');
      const language = match ? match[1] : null;
      const isBlockCode = Boolean(language) || rawCode.includes('\n');

      if (isBlockCode) {
        return (
          <div
            dir='ltr'
            className='relative group my-4 overflow-hidden rounded-xl border border-gray-200 dark:border-dark-300 shadow-sm text-left'
          >
            <div className='flex items-center justify-between bg-gray-50 dark:bg-dark-100 px-4 py-3 border-b border-gray-200 dark:border-dark-300'>
              <span className='text-xs font-semibold text-gray-700 dark:text-dark-700 uppercase tracking-wide'>
                {language || 'text'}
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
              <React.Suspense
                fallback={
                  <CodeFallback className='!m-0 !rounded-none !border-none'>
                    {codeString}
                  </CodeFallback>
                }
              >
                <LazySyntaxHighlighter
                  language={language || 'text'}
                  isDark={theme.mode === 'dark'}
                  className='!m-0 !rounded-none !border-none'
                >
                  {codeString}
                </LazySyntaxHighlighter>
              </React.Suspense>
            </div>
          </div>
        );
      }

      return (
        <code
          dir='ltr'
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
    pre({ children, className, node: _node, ...props }: MarkdownPreProps) {
      return (
        <pre dir='ltr' className={cn('text-left', className)} {...props}>
          {children}
        </pre>
      );
    },
    p({ children, ...props }) {
      return (
        <div dir='auto' className='mb-4 last:mb-0 leading-relaxed' {...props}>
          {children}
        </div>
      );
    },
    ul({ children, ...props }) {
      return (
        <ul
          dir='auto'
          className='list-disc list-inside mb-4 space-y-2 ps-4'
          {...props}
        >
          {children}
        </ul>
      );
    },
    ol({ children, ...props }) {
      return (
        <ol
          dir='auto'
          className='list-decimal list-inside mb-4 space-y-2 ps-4'
          {...props}
        >
          {children}
        </ol>
      );
    },
    li({ children, ...props }) {
      return (
        <li
          dir='auto'
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
          dir='auto'
          className='border-s-4 border-primary-400 dark:border-primary-500 bg-primary-25 dark:bg-primary-950/30 ps-4 py-3 my-4 rounded-e-lg italic text-gray-700 dark:text-dark-700'
          {...props}
        >
          {children}
        </blockquote>
      );
    },
    h1({ children, ...props }) {
      return (
        <h1
          dir='auto'
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
          dir='auto'
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
          dir='auto'
          className='text-lg font-medium mb-3 mt-4 first:mt-0 text-gray-900 dark:text-dark-800'
          {...props}
        >
          {children}
        </h3>
      );
    },
  };

  return (
    <div
      dir='auto'
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
        components={markdownComponents}
      >
        {processedContent}
      </ReactMarkdown>
    </div>
  );
};

export default RichMessageContent;
