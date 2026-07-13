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

import React, { useState } from 'react';
import { X, Info, ExternalLink } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui';
import { cn } from '@/utils';

interface DemoModeBannerProps {
  message?: string;
  onDismiss?: () => void;
  className?: string;
}

export const DemoModeBanner: React.FC<DemoModeBannerProps> = ({
  message = 'This is a demo version for presentation purposes only. The Ollama backend is not connected.',
  onDismiss,
  className,
}) => {
  const [isDismissed, setIsDismissed] = useState(false);
  const { t } = useTranslation();

  const handleDismiss = () => {
    setIsDismissed(true);
    onDismiss?.();
  };

  if (isDismissed) return null;

  return (
    <div
      className={cn(
        'bg-gray-950 text-white dark:bg-white dark:text-gray-950',
        'border-b border-black/10 dark:border-white/10',
        'px-4 py-2',
        className
      )}
    >
      <div className='flex items-center justify-between max-w-6xl mx-auto gap-3'>
        <div className='flex items-center gap-2.5 min-w-0'>
          <div className='flex-shrink-0'>
            <Info className='h-4 w-4 text-white/65 dark:text-gray-950/60' />
          </div>
          <div className='flex min-w-0 items-baseline gap-2'>
            <p className='shrink-0 text-xs font-semibold tracking-wide'>
              {t('demoMode.title')}
            </p>
            <p className='hidden truncate text-xs text-white/60 dark:text-gray-950/60 sm:block'>
              {message}
            </p>
          </div>
        </div>

        <div className='flex items-center gap-2 ml-4'>
          {/* Link to GitHub or documentation */}
          <Button
            variant='ghost'
            size='sm'
            className='h-8 px-2 text-white/70 hover:bg-white/10 hover:text-white dark:text-gray-950/70 dark:hover:bg-black/[0.06] dark:hover:text-gray-950'
            onClick={() =>
              window.open(
                'https://github.com/libre-webui/libre-webui',
                '_blank'
              )
            }
            title='View on GitHub'
          >
            <ExternalLink className='h-4 w-4' />
            <span className='ml-1 hidden sm:inline'>
              {t('demoMode.github')}
            </span>
          </Button>

          {/* Dismiss button */}
          <Button
            variant='ghost'
            size='sm'
            onClick={handleDismiss}
            className='h-8 w-8 p-0 text-white/70 hover:bg-white/10 hover:text-white dark:text-gray-950/70 dark:hover:bg-black/[0.06] dark:hover:text-gray-950'
            title='Dismiss'
          >
            <X className='h-4 w-4' />
          </Button>
        </div>
      </div>
    </div>
  );
};
