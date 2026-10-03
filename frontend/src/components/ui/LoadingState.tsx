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
import { useTranslation } from 'react-i18next';
import { cn } from '@/utils';
import type { StateSize } from './EmptyState';
interface LoadingStateProps {
  /** Defaults to t('common.loading'). */
  label?: React.ReactNode;
  /** Keep the text for assistive technology only. */
  srOnly?: boolean;
  size?: StateSize;
  testId?: string;
  className?: string;
}
const sizes: Record<
  StateSize,
  { root: string; spinner: string; text: string }
> = {
  sm: { root: 'gap-2 py-6', spinner: 'h-4 w-4', text: 'text-xs' },
  md: { root: 'gap-3 py-16', spinner: 'h-6 w-6', text: 'text-sm' },
};
/**
 * Status region with a spinner. The text keeps the state meaningful when
 * motion is reduced, since reduced motion is handled globally.
 */
export const LoadingState: React.FC<LoadingStateProps> = ({
  label,
  srOnly = false,
  size = 'md',
  testId,
  className,
}) => {
  const { t } = useTranslation();
  const s = sizes[size];
  return (
    <div
      role='status'
      data-testid={testId}
      className={cn(
        'flex flex-col items-center justify-center text-center',
        s.root,
        className
      )}
    >
      <span
        aria-hidden='true'
        className={cn(
          'animate-spin rounded-full border-2 border-line border-t-primary-500',
          s.spinner
        )}
      />
      <span className={srOnly ? 'sr-only' : cn('text-ink-muted', s.text)}>
        {label ?? t('common.loading')}
      </span>
    </div>
  );
};
