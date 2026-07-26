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
import {
  Briefcase,
  ChevronLeft,
  ChevronRight,
  MessageSquare,
} from 'lucide-react';
import { Button } from '@/components/ui';
import { Logo } from '@/components/Logo';
import { ThemeToggle } from '@/components/ThemeToggle';
import { cn } from '@/utils';

interface SidebarHeaderProps {
  sidebarCompact: boolean;
  isElectron: boolean;
  showWork: boolean;
  activeMode: 'chat' | 'work' | null;
  selectedModel: string;
  modelCount: number;
  onToggleCompact: () => void;
  onStartWork: () => void;
  onCreateSession: () => void;
}

export function SidebarHeader({
  sidebarCompact,
  isElectron,
  showWork,
  activeMode,
  selectedModel,
  modelCount,
  onToggleCompact,
  onStartWork,
  onCreateSession,
}: SidebarHeaderProps) {
  const { t } = useTranslation();
  const createDisabled = !selectedModel || modelCount === 0;
  const disabledTitle = createDisabled ? t('chat.model.noModelsTooltip') : '';

  return (
    <div
      className={cn(
        sidebarCompact ? 'px-2 pb-3 pt-3' : 'px-4 pb-4 pt-4',
        isElectron && 'pt-10'
      )}
    >
      <div
        className={cn(
          'flex items-center',
          sidebarCompact ? 'justify-center mb-3' : 'justify-between mb-4'
        )}
      >
        {!sidebarCompact ? (
          <>
            <Logo
              size='sm'
              className='text-gray-950 dark:text-dark-950 tracking-[-0.035em]'
            />
            <div className='flex items-center gap-0.5'>
              <ThemeToggle />
              <Button
                variant='ghost'
                size='sm'
                onClick={onToggleCompact}
                className='h-9 w-9 p-0 rounded-xl text-gray-500 dark:text-dark-600 hover:bg-white/80 dark:hover:bg-dark-200 hover:text-gray-950 dark:hover:text-dark-950 touch-manipulation'
                title={t('sidebar.toggleSize')}
                aria-label={t('sidebar.toggleSize')}
              >
                <ChevronLeft className='h-4 w-4 rtl:rotate-180' />
              </Button>
            </div>
          </>
        ) : (
          <div className='flex flex-col items-center gap-2'>
            <Logo
              size='sm'
              wordmark={false}
              className='text-gray-950 dark:text-dark-950 text-base tracking-[-0.035em]'
            />
            <Button
              variant='ghost'
              size='sm'
              onClick={onToggleCompact}
              className='h-9 w-9 p-0 rounded-xl text-gray-500 dark:text-dark-600 hover:bg-white/80 dark:hover:bg-dark-200 hover:text-gray-950 dark:hover:text-dark-950 touch-manipulation'
              title={t('sidebar.expandSidebar')}
              aria-label={t('sidebar.expandSidebar')}
            >
              <ChevronRight className='h-4 w-4 rtl:rotate-180' />
            </Button>
            <ThemeToggle />
          </div>
        )}
      </div>

      <div
        className={cn(
          'grid w-full gap-2',
          sidebarCompact || !showWork ? 'grid-cols-1' : 'grid-cols-2'
        )}
        data-testid='sidebar-create-actions'
      >
        {showWork && (
          <Button
            variant={activeMode === 'work' ? 'primary' : 'secondary'}
            onClick={onStartWork}
            className={cn(
              'h-10 rounded-xl shadow-none touch-manipulation',
              sidebarCompact && 'w-full p-0'
            )}
            size='sm'
            title={t('chat.session.work')}
            aria-label={t('chat.session.work')}
            aria-pressed={activeMode === 'work'}
            data-testid='sidebar-work-button'
          >
            <Briefcase className='h-4 w-4' />
            {!sidebarCompact && t('chat.session.work')}
          </Button>
        )}

        <Button
          variant={activeMode === 'chat' ? 'primary' : 'secondary'}
          onClick={onCreateSession}
          disabled={createDisabled}
          className={cn(
            'h-10 rounded-xl shadow-none touch-manipulation',
            sidebarCompact && 'w-full p-0'
          )}
          size='sm'
          title={createDisabled ? disabledTitle : t('chat.session.chat')}
          aria-label={t('chat.session.chat')}
          aria-pressed={activeMode === 'chat'}
          data-testid='sidebar-chat-button'
        >
          <MessageSquare className='h-4 w-4' />
          {!sidebarCompact && t('chat.session.chat')}
        </Button>
      </div>
    </div>
  );
}
