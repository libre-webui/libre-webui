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

import React, { useMemo } from 'react';
import { cn } from '@/utils';
import { Code2 } from 'lucide-react';

interface CodeAwareTextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  value: string;
  onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
}

function detectCodeBlocks(text: string): {
  hasCodeBlocks: boolean;
  isInCodeBlock: boolean;
  language: string | null;
} {
  // Count opening and closing backticks
  const openings = (text.match(/```/g) || []).length;

  // Check if we're currently inside an unclosed code block
  const isInCodeBlock = openings % 2 === 1;

  // Try to detect the language if in a code block
  let language: string | null = null;
  if (isInCodeBlock) {
    // Find the last opening ```
    const lastOpening = text.lastIndexOf('```');
    if (lastOpening !== -1) {
      // Get text after ```
      const afterBackticks = text.slice(lastOpening + 3);
      // Extract language (first word after ```)
      const langMatch = afterBackticks.match(/^(\w+)/);
      if (langMatch) {
        language = langMatch[1];
      }
    }
  }

  return {
    hasCodeBlocks: openings > 0,
    isInCodeBlock,
    language,
  };
}

export const CodeAwareTextarea = React.forwardRef<
  HTMLTextAreaElement,
  CodeAwareTextareaProps
>(
  (
    { value, onChange, className, placeholder, disabled, onKeyDown, ...props },
    ref
  ) => {
    const { hasCodeBlocks, isInCodeBlock, language } = useMemo(
      () => detectCodeBlocks(value),
      [value]
    );

    return (
      <div className='relative w-full'>
        <textarea
          ref={ref}
          value={value}
          onChange={onChange}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          disabled={disabled}
          className={cn(
            'w-full resize-none transition-all duration-200',
            isInCodeBlock && [
              'font-mono text-[13px]',
              'bg-gray-50 dark:bg-dark-100/50 ophelia:bg-[#0f0f0f]',
              'rounded-lg',
            ],
            className
          )}
          {...props}
        />

        {/* Code indicator badge */}
        {hasCodeBlocks && (
          <div className='absolute right-0 top-0 pointer-events-none flex items-center gap-1'>
            <div
              className={cn(
                'flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] font-medium',
                'bg-gray-100 dark:bg-dark-200 ophelia:bg-[#1a1a1a]',
                'text-gray-500 dark:text-gray-400 ophelia:text-[#a3a3a3]',
                'border border-gray-200/50 dark:border-dark-300/50 ophelia:border-[#262626]/50',
                isInCodeBlock && 'animate-pulse'
              )}
            >
              <Code2 className='h-3 w-3' />
              {language && <span>{language}</span>}
              {!language && isInCodeBlock && <span>code</span>}
            </div>
          </div>
        )}
      </div>
    );
  }
);

CodeAwareTextarea.displayName = 'CodeAwareTextarea';

export default CodeAwareTextarea;
