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
  type StreamingMarkdownSegment,
} from './messageContentUtils';
import { MessageCodeBlock } from './MessageCodeBlock';
import { messageCodeBodyClassName } from './messageCodeStyles';

interface StreamingMessageContentProps {
  content: string;
  className?: string;
  segments?: StreamingMarkdownSegment[];
  isStreaming?: boolean;
}

function StreamingTextSegment({ content }: { content: string }) {
  if (!content) return null;

  return (
    <div dir='auto' className='whitespace-pre-wrap break-words leading-relaxed'>
      {content}
    </div>
  );
}

function StreamingCodeBlock({
  content,
  language,
  complete,
}: StreamingMarkdownCodeSegment) {
  const displayedContent = complete ? content.replace(/\r?\n$/, '') : content;
  const viewportRef = React.useRef<HTMLPreElement>(null);
  const shouldFollowTailRef = React.useRef(true);

  React.useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (viewport && shouldFollowTailRef.current) {
      viewport.scrollTop = viewport.scrollHeight;
    }
  }, [displayedContent]);

  const handleScroll = () => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    const distanceFromBottom =
      viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
    shouldFollowTailRef.current = distanceFromBottom < 24;
  };

  return (
    <MessageCodeBlock
      code={displayedContent}
      language={language}
      state={complete ? 'complete' : 'streaming'}
    >
      <pre
        ref={viewportRef}
        onScroll={handleScroll}
        className={messageCodeBodyClassName}
      >
        <code>{displayedContent}</code>
      </pre>
    </MessageCodeBlock>
  );
}

export const StreamingMessageContent: React.FC<
  StreamingMessageContentProps
> = ({
  content,
  className,
  segments: providedSegments,
  isStreaming = true,
}) => {
  const segments = React.useMemo(
    () => providedSegments ?? getStreamingMarkdownSegments(content),
    [content, providedSegments]
  );
  const lastSegment = segments[segments.length - 1];
  const isStreamingInsideCode =
    lastSegment?.type === 'code' && !lastSegment.complete;

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
      {isStreaming && !isStreamingInsideCode && (
        <span
          data-testid='message-streaming-cursor'
          aria-hidden='true'
          className='ms-1 inline-block h-5 w-1 animate-pulse rounded-full bg-primary-500 align-text-bottom'
        />
      )}
    </div>
  );
};

export default StreamingMessageContent;
