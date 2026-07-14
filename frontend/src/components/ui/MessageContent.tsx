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
  shouldUseRichMarkdown,
} from './messageContentUtils';
import { StreamingMessageContent } from './StreamingMessageContent';

const RichMessageContent = React.lazy(() => import('./RichMessageContent'));

interface MessageContentProps {
  content: string;
  className?: string;
  isStreaming?: boolean;
}

function PlainMessageContent({
  content,
  className,
}: {
  content: string;
  className?: string;
}) {
  return (
    <div
      dir='auto'
      className={cn(
        'text-sm leading-relaxed text-gray-700 dark:text-dark-700 whitespace-pre-wrap break-words',
        className
      )}
    >
      {content}
    </div>
  );
}

export const MessageContent: React.FC<MessageContentProps> = ({
  content,
  className,
  isStreaming = false,
}) => {
  const streamingSegments = React.useMemo(
    () => (isStreaming ? getStreamingMarkdownSegments(content) : []),
    [content, isStreaming]
  );
  const hasStreamingCode = streamingSegments.some(
    segment => segment.type === 'code'
  );

  if (isStreaming && hasStreamingCode) {
    return (
      <StreamingMessageContent
        content={content}
        className={className}
        segments={streamingSegments}
      />
    );
  }

  let messageBody: React.ReactNode;

  if (!shouldUseRichMarkdown(content)) {
    messageBody = (
      <PlainMessageContent content={content} className={className} />
    );
  } else {
    messageBody = (
      <React.Suspense
        fallback={
          <StreamingMessageContent
            content={content}
            className={className}
            isStreaming={false}
          />
        }
      >
        <RichMessageContent content={content} className={className} />
      </React.Suspense>
    );
  }

  return (
    <>
      {messageBody}
      {isStreaming && (
        <span
          data-testid='message-streaming-cursor'
          aria-hidden='true'
          className='ms-1 inline-block h-5 w-1 animate-pulse rounded-full bg-primary-500 align-text-bottom'
        />
      )}
    </>
  );
};
