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

import { useTranslation } from 'react-i18next';
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react';
import { Button } from '@/components/ui';
import { Logo } from '@/components/Logo';
import { cn } from '@/utils';

interface SidebarHeaderProps {
  sidebarCompact: boolean;
  isElectron: boolean;
  selectedModel: string;
  modelCount: number;
  onToggleCompact: () => void;
  onCreateSession: () => void;
}

export function SidebarHeader({
  sidebarCompact,
  isElectron,
  selectedModel,
  modelCount,
  onToggleCompact,
  onCreateSession,
}: SidebarHeaderProps) {
  const { t } = useTranslation();
  const createDisabled = !selectedModel || modelCount === 0;
  const disabledTitle = createDisabled ? t('chat.model.noModelsTooltip') : '';

  return (
    <div
      className={cn(
        'border-b border-gray-200/60 dark:border-dark-200/60',
        sidebarCompact ? 'p-2' : 'p-3',
        isElectron && 'pt-10'
      )}
    >
      <div
        className={cn(
          'flex items-center',
          sidebarCompact ? 'justify-center mb-2' : 'justify-between mb-2'
        )}
      >
        {!sidebarCompact ? (
          <>
            <Logo size='sm' className='text-gray-900 dark:text-dark-800' />
            <div className='flex items-center gap-1'>
              <Button
                variant='ghost'
                size='sm'
                onClick={onToggleCompact}
                className='h-7 w-7 p-0 hover:bg-gray-100 dark:hover:bg-dark-200 active:bg-gray-200 dark:active:bg-dark-100 touch-manipulation'
                title={t('sidebar.toggleSize')}
              >
                <ChevronLeft className='h-4 w-4' />
              </Button>
            </div>
          </>
        ) : (
          <div className='flex flex-col items-center gap-1.5'>
            <Logo
              size='sm'
              wordmark={false}
              className='text-gray-900 dark:text-dark-800'
            />
            <Button
              variant='ghost'
              size='sm'
              onClick={onToggleCompact}
              className='h-7 w-7 p-0 hover:bg-gray-100 dark:hover:bg-dark-200 active:bg-gray-200 dark:active:bg-dark-100 touch-manipulation'
              title={t('sidebar.expandSidebar')}
            >
              <ChevronRight className='h-4 w-4' />
            </Button>
          </div>
        )}
      </div>

      {!sidebarCompact ? (
        <Button
          onClick={onCreateSession}
          disabled={createDisabled}
          className='w-full bg-primary-600 hover:bg-primary-700 active:bg-primary-800 text-white shadow-sm hover:shadow-md active:shadow-lg transition-all duration-200 border-0 touch-manipulation'
          size='sm'
          title={disabledTitle}
        >
          <Plus className='h-4 w-4 mr-2' />
          {t('chat.session.new')}
        </Button>
      ) : (
        <Button
          onClick={onCreateSession}
          disabled={createDisabled}
          className='w-full h-9 bg-primary-600 hover:bg-primary-700 active:bg-primary-800 text-white shadow-sm hover:shadow-md active:shadow-lg transition-all duration-200 border-0 touch-manipulation p-0'
          title={createDisabled ? disabledTitle : t('chat.session.new')}
        >
          <Plus className='h-4 w-4' />
        </Button>
      )}
    </div>
  );
}
