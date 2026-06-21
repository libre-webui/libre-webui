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
import { cn } from '@/utils';
import {
  getStreamingMarkdownSegments,
  type StreamingMarkdownCodeSegment,
} from './messageContentUtils';

interface StreamingMessageContentProps {
  content: string;
  className?: string;
}

function StreamingTextSegment({ content }: { content: string }) {
  if (!content) return null;

  return (
    <div className='whitespace-pre-wrap break-words leading-relaxed'>
      {content}
    </div>
  );
}

function StreamingCodeBlock({
  content,
  language,
  complete,
}: StreamingMarkdownCodeSegment) {
  return (
    <div className='my-4 overflow-hidden rounded-xl border border-gray-200 dark:border-dark-300 bg-gray-950 shadow-sm dark:bg-black/40'>
      <div className='flex h-11 items-center justify-between border-b border-white/10 bg-gray-900 px-4 dark:bg-dark-200'>
        <span className='truncate text-xs font-semibold uppercase tracking-wide text-gray-300 dark:text-dark-700'>
          {language || 'code'}
        </span>
        {!complete && (
          <span
            className='flex h-6 w-6 items-center justify-center rounded-full bg-primary-500/10 text-primary-300 dark:text-primary-400'
            aria-label='Streaming code block'
          >
            <span className='h-1.5 w-1.5 rounded-full bg-current animate-pulse' />
          </span>
        )}
      </div>
      <pre className='max-h-[60vh] min-h-[3rem] overflow-auto p-4 text-sm leading-relaxed text-gray-100 font-mono whitespace-pre tabular-nums'>
        <code>
          {content}
          {!complete && (
            <span
              aria-hidden='true'
              className='ml-0.5 inline-block h-4 w-2 translate-y-0.5 animate-pulse rounded-sm bg-primary-300 align-baseline dark:bg-primary-400'
            />
          )}
        </code>
      </pre>
    </div>
  );
}

export const StreamingMessageContent: React.FC<
  StreamingMessageContentProps
> = ({ content, className }) => {
  const segments = React.useMemo(
    () => getStreamingMarkdownSegments(content),
    [content]
  );

  return (
    <div
      className={cn(
        'text-sm leading-relaxed text-gray-700 dark:text-dark-700',
        className
      )}
    >
      {segments.map((segment, index) =>
        segment.type === 'code' ? (
          <StreamingCodeBlock key={`${segment.type}-${index}`} {...segment} />
        ) : (
          <StreamingTextSegment
            key={`${segment.type}-${index}`}
            content={segment.content}
          />
        )
      )}
    </div>
  );
};

export default StreamingMessageContent;
