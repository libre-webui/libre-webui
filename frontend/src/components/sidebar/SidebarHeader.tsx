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
import { Briefcase, MessageSquare, PanelLeft, Search } from 'lucide-react';
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

/**
 * Sidebar top block: logo row with the panel toggle at the trailing edge,
 * then elevated "New" action buttons and the search trigger. Collapsed, the
 * same controls stack as a slim icon rail (logo, actions, search — one 36px
 * icon each).
 */
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

  const railButton =
    'flex h-9 w-9 items-center justify-center rounded-full text-ink transition-colors hover:bg-interactive-hover outline-none focus-visible:ring-2 focus-visible:ring-primary-500/30 touch-manipulation';

  if (sidebarCompact) {
    return (
      <div
        className={cn(
          'flex flex-col items-center gap-3 px-2 pt-4 pb-2',
          isElectron && 'pt-10'
        )}
      >
        <button
          type='button'
          onClick={onToggleCompact}
          className={cn(railButton, 'group')}
          title={t('sidebar.expandSidebar')}
          aria-label={t('sidebar.expandSidebar')}
          data-testid='sidebar-rail-expand'
        >
          <LogoMark
            size='sm'
            label={null}
            className='h-6 w-6 p-0 text-ink group-hover:hidden'
          />
          <PanelLeft className='hidden h-[18px] w-[18px] group-hover:block rtl:rotate-180' />
        </button>

        <button
          type='button'
          onClick={onCreateSession}
          disabled={createDisabled}
          className={cn(railButton, createDisabled && 'opacity-40')}
          title={createDisabled ? disabledTitle : t('chat.session.chat')}
          aria-label={t('chat.session.chat')}
          aria-pressed={activeMode === 'chat'}
          data-testid='sidebar-chat-button'
        >
          <MessageSquare className='h-[18px] w-[18px]' />
        </button>

        {showWork && (
          <button
            type='button'
            onClick={onStartWork}
            className={railButton}
            title={t('chat.session.work')}
            aria-label={t('chat.session.work')}
            aria-pressed={activeMode === 'work'}
            data-testid='sidebar-work-button'
          >
            <Briefcase className='h-[18px] w-[18px]' />
          </button>
        )}

        <button
          type='button'
          data-testid='sidebar-search-button'
          onClick={() => window.dispatchEvent(new Event('libre:open-palette'))}
          title={t('palette.search', 'Search')}
          aria-label={t('palette.search', 'Search')}
          className={railButton}
        >
          <Search className='h-[18px] w-[18px]' />
        </button>
      </div>
    );
  }

  return (
    <div className={cn('px-3 pb-2 pt-2', isElectron && 'pt-10')}>
      <div className='mb-2 flex h-[52px] min-w-0 items-center justify-between ps-1'>
        <div className='flex min-w-0 items-center gap-2 text-ink'>
          <LogoMark size='sm' label={null} />
          <Logo size='sm' className='tracking-[-0.035em]' />
        </div>
        <div className='flex items-center gap-0.5'>
          <div className='hidden sm:block'>
            <ThemeToggle />
          </div>
          <button
            type='button'
            onClick={onToggleCompact}
            className='flex h-7 w-7 items-center justify-center rounded-full text-ink-muted transition-colors hover:bg-interactive-hover hover:text-ink outline-none focus-visible:ring-2 focus-visible:ring-primary-500/30 touch-manipulation'
            title={t('sidebar.toggleSize')}
            aria-label={t('sidebar.toggleSize')}
            data-testid='sidebar-toggle-size'
          >
            <PanelLeft className='h-4 w-4 rtl:rotate-180' />
          </button>
        </div>
      </div>

      <div
        className={cn(
          'grid w-full gap-2',
          !showWork && 'grid-cols-1',
          showWork && 'grid-cols-2'
        )}
        data-testid='sidebar-create-actions'
      >
        <button
          type='button'
          onClick={onCreateSession}
          disabled={createDisabled}
          className={cn(
            'flex h-[38px] items-center justify-center gap-1.5 rounded-xl border text-sm font-medium transition-colors touch-manipulation outline-none focus-visible:ring-2 focus-visible:ring-primary-500/30',
            activeMode === 'chat'
              ? 'border-transparent bg-nav-active text-ink'
              : 'border-line bg-surface-raised text-ink hover:bg-hover-solid dark:border-white/[0.12] dark:bg-dark-25 dark:hover:bg-dark-300',
            createDisabled && 'opacity-50'
          )}
          title={createDisabled ? disabledTitle : t('chat.session.chat')}
          aria-label={t('chat.session.chat')}
          aria-pressed={activeMode === 'chat'}
          data-testid='sidebar-chat-button'
        >
          <MessageSquare className='h-4 w-4' />
          {t('chat.session.chat')}
        </button>

        {showWork && (
          <button
            type='button'
            onClick={onStartWork}
            className={cn(
              'flex h-[38px] items-center justify-center gap-1.5 rounded-xl border text-sm font-medium transition-colors touch-manipulation outline-none focus-visible:ring-2 focus-visible:ring-primary-500/30',
              activeMode === 'work'
                ? 'border-transparent bg-nav-active text-ink'
                : 'border-line bg-surface-raised text-ink hover:bg-hover-solid dark:border-white/[0.12] dark:bg-dark-25 dark:hover:bg-dark-300'
            )}
            title={t('chat.session.work')}
            aria-label={t('chat.session.work')}
            aria-pressed={activeMode === 'work'}
            data-testid='sidebar-work-button'
          >
            <Briefcase className='h-4 w-4' />
            {t('chat.session.work')}
          </button>
        )}
      </div>

      <button
        type='button'
        data-testid='sidebar-search-button'
        onClick={() => window.dispatchEvent(new Event('libre:open-palette'))}
        title={t('palette.search', 'Search')}
        aria-label={t('palette.search', 'Search')}
        className='mt-1.5 flex h-[34px] w-full items-center gap-2 rounded-xl px-2.5 text-sm text-ink-muted transition-colors hover:bg-interactive-hover hover:text-ink outline-none focus-visible:ring-2 focus-visible:ring-primary-500/30 touch-manipulation'
      >
        <Search className='h-4 w-4 shrink-0' />
        <span className='flex-1 text-start'>
          {t('palette.search', 'Search')}
        </span>
        <span className='font-mono text-[10px] tracking-wide text-ink-subtle'>
          {isMac() ? '⌘' : 'Ctrl'}K
        </span>
      </button>
    </div>
  );
}
