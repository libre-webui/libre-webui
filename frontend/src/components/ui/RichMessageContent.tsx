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
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import { useAppStore } from '@/store/appStore';
import { cn } from '@/utils';
import { preprocessLaTeX } from './messageContentUtils';
import { MessageCodeBlock } from './MessageCodeBlock';
import {
  MESSAGE_CODE_BACKGROUND_DARK,
  MESSAGE_CODE_BACKGROUND_LIGHT,
  messageCodeBodyClassName,
  messageCodeBodyStyle,
} from './messageCodeStyles';

const LazySyntaxHighlighter = React.lazy(
  () => import('@/components/OptimizedSyntaxHighlighter')
);

interface RichMessageContentProps {
  content: string;
  className?: string;
}

type MarkdownCodeProps = React.ComponentPropsWithoutRef<'code'> & ExtraProps;
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
      className={cn(messageCodeBodyClassName, 'rounded-lg', className)}
    >
      <code>{children}</code>
    </pre>
  );
}

export const RichMessageContent: React.FC<RichMessageContentProps> = ({
  content,
  className,
}) => {
  const isDark = useAppStore(state => state.theme.mode === 'dark');
  const processedContent = React.useMemo(
    () => preprocessLaTeX(content),
    [content]
  );

  const markdownComponents: Components = {
    code({ className, children, node: _node, ...props }: MarkdownCodeProps) {
      const match = /language-([^\s]+)/.exec(className || '');
      const rawCode = String(children);
      const codeString = rawCode.replace(/\n$/, '');
      const language = match ? match[1] : null;
      const isBlockCode = Boolean(language) || rawCode.includes('\n');

      if (isBlockCode) {
        return (
          <MessageCodeBlock
            code={codeString}
            language={language}
            state='complete'
          >
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
                  isDark={isDark}
                  backgroundColor={
                    isDark
                      ? MESSAGE_CODE_BACKGROUND_DARK
                      : MESSAGE_CODE_BACKGROUND_LIGHT
                  }
                  borderRadius={0}
                  customStyle={messageCodeBodyStyle}
                  className='!m-0 !rounded-none !border-none'
                  showLineNumbers
                >
                  {codeString}
                </LazySyntaxHighlighter>
              </React.Suspense>
            </div>
          </MessageCodeBlock>
        );
      }

      return (
        <code
          dir='ltr'
          className={cn(
            'px-1.5 py-0.5 rounded-md bg-gray-100 dark:bg-dark-200 text-gray-800 dark:text-dark-800',
            'font-mono text-[0.85em] border border-gray-200 dark:border-dark-300',
            className
          )}
          {...props}
        >
          {children}
        </code>
      );
    },
    pre({ children }) {
      return <>{children}</>;
    },
    p({ children, ...props }) {
      return (
        <div dir='auto' className='mb-2.5 last:mb-0 leading-relaxed' {...props}>
          {children}
        </div>
      );
    },
    ul({ children, ...props }) {
      return (
        <ul
          dir='auto'
          className='list-disc list-inside mb-2.5 space-y-1 ps-4'
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
          className='list-decimal list-inside mb-2.5 space-y-1 ps-4'
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
          className='border-s-2 border-primary-400 dark:border-primary-500 bg-primary-25 dark:bg-primary-950/30 ps-3 py-2 my-3 rounded-e-lg italic text-gray-700 dark:text-dark-700'
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
          className='text-xl font-bold mb-3 mt-5 first:mt-0 text-gray-900 dark:text-dark-800 border-b border-gray-200 dark:border-dark-300 pb-1.5'
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
          className='text-lg font-semibold mb-2 mt-5 first:mt-0 text-gray-900 dark:text-dark-800'
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
          className='text-base font-medium mb-2 mt-4 first:mt-0 text-gray-900 dark:text-dark-800'
          {...props}
        >
          {children}
        </h3>
      );
    },
    table({ children, node: _node, ...props }) {
      return (
        <div
          className={cn(
            'my-4 w-full overflow-x-auto rounded-xl border border-line bg-surface shadow-subtle',
            'focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/40'
          )}
          tabIndex={0}
        >
          <table
            dir='auto'
            className='w-full min-w-[42rem] border-separate border-spacing-0 text-start text-sm'
            {...props}
          >
            {children}
          </table>
        </div>
      );
    },
    thead({ children, node: _node, ...props }) {
      return (
        <thead className='bg-surface-subtle' {...props}>
          {children}
        </thead>
      );
    },
    tbody({ children, node: _node, ...props }) {
      return <tbody {...props}>{children}</tbody>;
    },
    tr({ children, node: _node, ...props }) {
      return (
        <tr
          className='transition-colors hover:bg-black/[0.025] last:[&>td]:border-b-0 dark:hover:bg-white/[0.025]'
          {...props}
        >
          {children}
        </tr>
      );
    },
    th({ align, children, node: _node, ...props }) {
      return (
        <th
          className={cn(
            'border-b border-e border-line-strong px-3 py-2.5 align-bottom font-semibold text-ink last:border-e-0',
            align === 'center'
              ? 'text-center'
              : align === 'right'
                ? 'text-right'
                : align === 'left'
                  ? 'text-left'
                  : 'text-start'
          )}
          {...props}
        >
          {children}
        </th>
      );
    },
    td({ align, children, node: _node, ...props }) {
      return (
        <td
          className={cn(
            'min-w-40 border-b border-e border-line px-3 py-2.5 align-top leading-relaxed text-ink last:border-e-0',
            align === 'center'
              ? 'text-center'
              : align === 'right'
                ? 'text-right'
                : align === 'left'
                  ? 'text-left'
                  : 'text-start'
          )}
          {...props}
        >
          {children}
        </td>
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
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={markdownComponents}
      >
        {processedContent}
      </ReactMarkdown>
    </div>
  );
};

export default RichMessageContent;
