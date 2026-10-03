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
import { AlertCircle, type LucideIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/utils';
import { Button } from './Button';
import type { StateSize } from './EmptyState';
interface ErrorStateProps {
  message: React.ReactNode;
  icon?: LucideIcon;
  /** Renders a secondary Retry button when provided. */
  onRetry?: () => void;
  size?: StateSize;
  testId?: string;
  className?: string;
}
const sizes: Record<StateSize, { root: string; icon: string; text: string }> = {
  sm: { root: 'gap-2 px-3 py-6', icon: 'h-4 w-4', text: 'text-xs' },
  md: { root: 'gap-3 px-4 py-16', icon: 'h-5 w-5', text: 'text-sm' },
};
/** Alert region for failed loads. Only the icon uses error colors. */
export const ErrorState: React.FC<ErrorStateProps> = ({
  message,
  icon: Icon = AlertCircle,
  onRetry,
  size = 'md',
  testId,
  className,
}) => {
  const { t } = useTranslation();
  const s = sizes[size];
  return (
    <div
      role='alert'
      data-testid={testId}
      className={cn(
        'flex flex-col items-center justify-center text-center',
        s.root,
        className
      )}
    >
      <Icon
        className={cn('text-error-600 dark:text-error-400', s.icon)}
        aria-hidden='true'
      />
      <p className={cn('max-w-sm text-ink', s.text)}>{message}</p>
      {onRetry && (
        <Button type='button' variant='secondary' size='sm' onClick={onRetry}>
          {t('common.retry')}
        </Button>
      )}
    </div>
  );
};
