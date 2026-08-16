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
import { useAppStore } from '@/store/appStore';
import {
  getStreamingMarkdownSegments,
  type StreamingMarkdownCodeSegment,
  type StreamingMarkdownSegment,
} from './messageContentUtils';
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

/**
 * Above this size, a still-streaming block falls back to plain text so the
 * highlighter cannot make token rendering feel sluggish; the block is fully
 * highlighted once the message re-renders as complete markdown.
 */
const STREAMING_HIGHLIGHT_CHAR_LIMIT = 80_000;

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
  const isDark = useAppStore(state => state.theme.mode === 'dark');
  const viewportRef = React.useRef<HTMLPreElement>(null);
  const shouldFollowTailRef = React.useRef(true);

  // Highlighting trails the raw stream by a frame so token delivery stays
  // urgent and the (heavier) highlighted subtree renders when idle.
  const highlightSource = React.useDeferredValue(displayedContent);
  const highlightWhileStreaming =
    displayedContent.length <= STREAMING_HIGHLIGHT_CHAR_LIMIT;

  // Ref callback rather than a plain ref: when the lazy highlighter swaps
  // in for the plain fallback, the replacement pre mounts at scrollTop 0
  // and must jump to the tail immediately, not on the next chunk.
  const setViewport = React.useCallback((node: HTMLPreElement | null) => {
    viewportRef.current = node;
    if (node && shouldFollowTailRef.current) {
      node.scrollTop = node.scrollHeight;
    }
  }, []);

  React.useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (viewport && shouldFollowTailRef.current) {
      viewport.scrollTop = viewport.scrollHeight;
    }
  }, [displayedContent, highlightSource]);

  const handleScroll = () => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    const distanceFromBottom =
      viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
    shouldFollowTailRef.current = distanceFromBottom < 24;
  };

  // The highlighter renders through this pre so the scroll viewport, the
  // tail-follow behavior, and the `pre code` structure stay identical to the
  // plain fallback. Stable identity: remounting it would reset scrolling on
  // every streamed chunk.
  const StreamingPre = React.useMemo(() => {
    const PreTag = ({
      children,
      ...props
    }: React.HTMLAttributes<HTMLPreElement>) => (
      <pre
        {...props}
        ref={setViewport}
        onScroll={event => {
          handleScroll();
          props.onScroll?.(event);
        }}
      >
        {children}
      </pre>
    );
    return PreTag;
  }, []);

  const plainBody = (
    <pre
      ref={setViewport}
      onScroll={handleScroll}
      className={messageCodeBodyClassName}
    >
      <code>{displayedContent}</code>
    </pre>
  );

  return (
    <MessageCodeBlock
      code={displayedContent}
      language={language}
      state={complete ? 'complete' : 'streaming'}
    >
      {highlightWhileStreaming ? (
        <React.Suspense fallback={plainBody}>
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
            preTag={StreamingPre}
          >
            {highlightSource}
          </LazySyntaxHighlighter>
        </React.Suspense>
      ) : (
        plainBody
      )}
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
