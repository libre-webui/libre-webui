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
import { shouldUseRichMarkdown } from './messageContentUtils';

const RichMessageContent = React.lazy(() => import('./RichMessageContent'));

interface MessageContentProps {
  content: string;
  className?: string;
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
}) => {
  if (!shouldUseRichMarkdown(content)) {
    return <PlainMessageContent content={content} className={className} />;
  }

  return (
    <React.Suspense
      fallback={<PlainMessageContent content={content} className={className} />}
    >
      <RichMessageContent content={content} className={className} />
    </React.Suspense>
  );
};
