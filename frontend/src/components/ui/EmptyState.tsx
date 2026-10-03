/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
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
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/utils';
export type StateSize = 'sm' | 'md';
interface EmptyStateProps {
  icon: LucideIcon;
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  /** Render the title as a heading when the surrounding outline needs one. */
  titleAs?: 'p' | 'h2' | 'h3' | 'h4';
  /** sm for side panels and lists, md for page bodies. */
  size?: StateSize;
  testId?: string;
  className?: string;
}
const sizes: Record<
  StateSize,
  { root: string; tile: string; icon: string; title: string; text: string }
> = {
  sm: {
    root: 'gap-1.5 px-3 py-6',
    tile: 'h-9 w-9',
    icon: 'h-4 w-4',
    title: 'text-sm',
    text: 'text-xs',
  },
  md: {
    root: 'gap-2 px-4 py-16',
    tile: 'h-12 w-12',
    icon: 'h-5 w-5',
    title: 'text-base',
    text: 'text-sm',
  },
};
/** Neutral empty state shared by library pages, lists and side panels. */
export const EmptyState: React.FC<EmptyStateProps> = ({
  icon: Icon,
  title,
  description,
  action,
  titleAs: Title = 'p',
  size = 'md',
  testId,
  className,
}) => {
  const s = sizes[size];
  return (
    <div
      data-testid={testId}
      className={cn(
        'flex flex-col items-center text-center',
        s.root,
        className
      )}
    >
      <div
        className={cn(
          'mb-1 flex items-center justify-center rounded-xl bg-surface-subtle text-ink-muted',
          s.tile
        )}
      >
        <Icon className={s.icon} aria-hidden='true' />
      </div>
      <Title className={cn('font-medium text-ink', s.title)}>{title}</Title>
      {description && (
        <p className={cn('max-w-sm text-ink-muted', s.text)}>{description}</p>
      )}
      {action && <div className='mt-2'>{action}</div>}
    </div>
  );
};
