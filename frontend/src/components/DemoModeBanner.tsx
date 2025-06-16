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

  const handleDismiss = () => {
    setIsDismissed(true);
    onDismiss?.();
  };

  if (isDismissed) return null;

  return (
    <div
      className={cn(
        'bg-gradient-to-r from-amber-50 to-orange-50 dark:from-amber-900/20 dark:to-orange-900/20',
        'border-b border-amber-200 dark:border-amber-800',
        'px-4 py-3',
        className
      )}
    >
      <div className='flex items-center justify-between max-w-7xl mx-auto'>
        <div className='flex items-center gap-3'>
          <div className='flex-shrink-0'>
            <Info className='h-5 w-5 text-amber-600 dark:text-amber-400' />
          </div>
          <div className='flex-1 min-w-0'>
            <p className='text-sm font-medium text-amber-800 dark:text-amber-200'>
              Demo Mode
            </p>
            <p className='text-xs text-amber-700 dark:text-amber-300 mt-0.5'>
              {message}
            </p>
          </div>
        </div>

        <div className='flex items-center gap-2 ml-4'>
          {/* Link to GitHub or documentation */}
          <Button
            variant='ghost'
            size='sm'
            className='text-amber-700 dark:text-amber-300 hover:text-amber-900 dark:hover:text-amber-100 h-8 px-2'
            onClick={() =>
              window.open(
                'https://github.com/libre-webui/libre-webui',
                '_blank'
              )
            }
            title='View on GitHub'
          >
            <ExternalLink className='h-4 w-4' />
            <span className='ml-1 hidden sm:inline'>GitHub</span>
          </Button>

          {/* Dismiss button */}
          <Button
            variant='ghost'
            size='sm'
            onClick={handleDismiss}
            className='text-amber-700 dark:text-amber-300 hover:text-amber-900 dark:hover:text-amber-100 h-8 w-8 p-0'
            title='Dismiss'
          >
            <X className='h-4 w-4' />
          </Button>
        </div>
      </div>
    </div>
  );
};
