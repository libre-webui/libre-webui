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
  Search,
} from 'lucide-react';
import { Button } from '@/components/ui';
import { Logo } from '@/components/Logo';
import { LogoMark } from '@/components/LogoMark';
import { ThemeToggle } from '@/components/ThemeToggle';
import { cn, isMac } from '@/utils';

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
        sidebarCompact ? 'px-2 pb-2 pt-3' : 'px-4 pb-4 pt-4',
        isElectron && 'pt-10'
      )}
    >
      <div
        className={cn(
          'flex min-w-0 items-center',
          sidebarCompact ? 'justify-center mb-3' : 'justify-between mb-4'
        )}
      >
        {!sidebarCompact ? (
          <>
            <div className='flex min-w-0 items-center gap-2 text-gray-950 dark:text-dark-950'>
              <LogoMark size='sm' label={null} />
              <Logo size='sm' className='tracking-[-0.035em]' />
            </div>
            <div className='flex items-center gap-0.5'>
              <div className='hidden sm:block'>
                <ThemeToggle />
              </div>
              <Button
                variant='ghost'
                size='sm'
                onClick={onToggleCompact}
                className='h-9 w-9 p-0 rounded-xl text-gray-500 dark:text-dark-600 hover:bg-white/80 dark:hover:bg-dark-200 hover:text-gray-950 dark:hover:text-dark-950 touch-manipulation'
                title={t('sidebar.toggleSize')}
                aria-label={t('sidebar.toggleSize')}
                data-testid='sidebar-toggle-size'
              >
                <ChevronLeft className='h-4 w-4 rtl:rotate-180' />
              </Button>
            </div>
          </>
        ) : (
          <div className='flex flex-col items-center gap-2'>
            <LogoMark
              size='sm'
              className='h-11 w-11 p-2.5 text-gray-950 dark:text-dark-950'
            />
            <Button
              type='button'
              variant='ghost'
              size='sm'
              onClick={onToggleCompact}
              className='h-11 w-11 rounded-xl p-0 text-gray-600 ring-1 ring-black/[0.06] transition-colors hover:bg-white hover:text-gray-950 dark:text-dark-600 dark:ring-white/[0.08] dark:hover:bg-dark-200 dark:hover:text-dark-950'
              title={t('sidebar.expandSidebar')}
              aria-label={t('sidebar.expandSidebar')}
              data-testid='sidebar-rail-expand'
            >
              <ChevronRight className='h-5 w-5 rtl:rotate-180' />
            </Button>
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
              sidebarCompact && 'mx-auto h-11 w-11 p-0'
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
            sidebarCompact && 'mx-auto h-11 w-11 p-0'
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

      <button
        type='button'
        data-testid='sidebar-search-button'
        onClick={() => window.dispatchEvent(new Event('libre:open-palette'))}
        title={t('palette.search', 'Search')}
        aria-label={t('palette.search', 'Search')}
        className={cn(
          'mt-2 flex items-center gap-2.5 rounded-xl text-[13px] text-gray-500 transition-colors hover:bg-white/60 hover:text-gray-950 dark:text-dark-600 dark:hover:bg-dark-200/60 dark:hover:text-dark-950 outline-none focus-visible:ring-2 focus-visible:ring-primary-500/30 touch-manipulation',
          sidebarCompact
            ? 'h-11 w-11 justify-center p-0 mx-auto'
            : 'w-full px-2.5 py-2'
        )}
      >
        <Search className='h-4 w-4 shrink-0' />
        {!sidebarCompact && (
          <>
            <span className='flex-1 text-start'>
              {t('palette.search', 'Search')}
            </span>
            <span className='font-mono text-[10px] tracking-wide text-gray-400 dark:text-dark-500'>
              {isMac() ? '⌘' : 'Ctrl'}K
            </span>
          </>
        )}
      </button>
    </div>
  );
}
