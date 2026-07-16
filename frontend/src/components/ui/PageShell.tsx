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
import { cn } from '@/utils';

type PageWidth = 'narrow' | 'default' | 'wide';

const pageWidths: Record<PageWidth, string> = {
  narrow: 'max-w-4xl',
  default: 'max-w-6xl',
  wide: 'max-w-7xl',
};

interface PageShellProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
  width?: PageWidth;
  contentClassName?: string;
}

/**
 * Shared scroll and spacing contract for top-level application pages.
 * The shell intentionally owns no opaque background so custom user
 * backgrounds can continue to show through the application frame.
 */
export const PageShell: React.FC<PageShellProps> = ({
  children,
  width = 'default',
  className,
  contentClassName,
  ...props
}) => (
  <div
    data-testid='page-scroll-region'
    className={cn('scroll-region h-full min-h-0 scrollbar-thin', className)}
    {...props}
  >
    <div
      className={cn(
        'mx-auto w-full px-4 pb-16 pt-7 sm:px-6 sm:pb-20 sm:pt-10 lg:px-8',
        pageWidths[width],
        contentClassName
      )}
    >
      {children}
    </div>
  </div>
);

interface PageHeaderProps extends Omit<
  React.HTMLAttributes<HTMLElement>,
  'title'
> {
  title: React.ReactNode;
  description?: React.ReactNode;
  eyebrow?: React.ReactNode;
  actions?: React.ReactNode;
  meta?: React.ReactNode;
}

/** Editorial, start-aligned hierarchy shared by secondary application pages. */
export const PageHeader: React.FC<PageHeaderProps> = ({
  title,
  description,
  eyebrow,
  actions,
  meta,
  className,
  ...props
}) => (
  <header
    className={cn(
      'mb-8 flex flex-col gap-6 border-b border-gray-200/70 pb-7 text-start dark:border-white/[0.08] sm:mb-10 sm:pb-9 md:flex-row md:items-end md:justify-between',
      className
    )}
    {...props}
  >
    <div className='min-w-0 max-w-3xl'>
      {eyebrow && (
        <div className='mb-3 text-[11px] font-medium uppercase tracking-[0.18em] text-gray-500 dark:text-dark-500 rtl:tracking-normal'>
          {eyebrow}
        </div>
      )}
      <h1 className='text-balance text-3xl font-normal leading-[1.02] tracking-[-0.04em] text-gray-950 dark:text-dark-950 sm:text-5xl rtl:leading-[1.15] rtl:tracking-normal'>
        {title}
      </h1>
      {description && (
        <p className='mt-4 max-w-2xl text-sm leading-6 text-gray-600 dark:text-dark-600 sm:text-base sm:leading-7'>
          {description}
        </p>
      )}
      {meta && <div className='mt-4'>{meta}</div>}
    </div>
    {actions && (
      <div className='flex shrink-0 flex-wrap items-center gap-2 md:justify-end'>
        {actions}
      </div>
    )}
  </header>
);
