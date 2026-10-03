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
interface WorkspaceToolbarProps extends Omit<
  React.HTMLAttributes<HTMLDivElement>,
  'title'
> {
  title: React.ReactNode;
  icon?: LucideIcon;
  description?: React.ReactNode;
  /** End-aligned controls; they wrap below the title on narrow widths. */
  actions?: React.ReactNode;
  /** Inline companions to the title, such as tabs or filters. */
  children?: React.ReactNode;
}
/**
 * Header bar shared by workspace-style pages (Automations, Calendar, Notes,
 * Strands). Owns the single h1 style so those pages stay visually aligned.
 * Uses logical properties only, so it mirrors correctly in RTL.
 */
export const WorkspaceToolbar: React.FC<WorkspaceToolbarProps> = ({
  title,
  icon: Icon,
  description,
  actions,
  children,
  className,
  ...props
}) => (
  <div
    className={cn(
      'flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-line px-4 py-3 text-start',
      className
    )}
    {...props}
  >
    <div className='flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2'>
      <div className='flex min-w-0 items-center gap-2'>
        {Icon && (
          <Icon
            className='h-4 w-4 shrink-0 text-ink-muted'
            aria-hidden='true'
          />
        )}
        <div className='min-w-0'>
          <h1 className='text-base font-semibold tracking-[-0.01em] text-ink rtl:tracking-normal'>
            {title}
          </h1>
          {description && (
            <p className='mt-0.5 text-xs text-ink-muted'>{description}</p>
          )}
        </div>
      </div>
      {children}
    </div>
    {actions && (
      <div className='flex flex-wrap items-center gap-2'>{actions}</div>
    )}
  </div>
);
