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

import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  Bot,
  Database,
  MessageSquare,
  Sparkles,
  User as UserIcon,
} from 'lucide-react';
import { cn } from '@/utils';

interface SidebarNavigationProps {
  sidebarCompact: boolean;
  activePath: string;
  onChatClick: () => void;
  onMobileNavigate: () => void;
}

export function SidebarNavigation({
  sidebarCompact,
  activePath,
  onChatClick,
  onMobileNavigate,
}: SidebarNavigationProps) {
  const { t } = useTranslation();
  const itemClass = (active: boolean) =>
    cn(
      'flex items-center gap-3 rounded-xl text-[13px] font-medium transition-colors duration-150 touch-manipulation outline-none focus-visible:ring-2 focus-visible:ring-primary-500/30',
      sidebarCompact ? 'w-11 h-11 justify-center p-0' : 'w-full px-3 py-2.5',
      active
        ? 'bg-white text-gray-950 ring-1 ring-black/[0.04] dark:bg-dark-200 dark:text-dark-950 dark:ring-white/[0.06]'
        : 'text-gray-600 dark:text-dark-600 hover:bg-white/60 dark:hover:bg-dark-200/60 hover:text-gray-950 dark:hover:text-dark-950 active:bg-white dark:active:bg-dark-200'
    );

  const chatActive =
    activePath === '/chat' ||
    activePath === '/' ||
    activePath.startsWith('/c/');

  return (
    <div className={cn('pb-3', sidebarCompact ? 'px-2' : 'px-3')}>
      <nav
        className={cn(
          'space-y-0.5',
          sidebarCompact && 'flex flex-col items-center'
        )}
      >
        <button
          onClick={onChatClick}
          className={cn(itemClass(chatActive), 'text-left')}
          title={sidebarCompact ? t('sidebar.navigation.chat') : undefined}
          aria-current={chatActive ? 'page' : undefined}
        >
          <MessageSquare className='h-[18px] w-[18px] shrink-0' />
          {!sidebarCompact && t('sidebar.navigation.chat')}
        </button>

        <Link
          to='/models'
          onClick={onMobileNavigate}
          className={itemClass(activePath === '/models')}
          title={sidebarCompact ? t('sidebar.navigation.models') : undefined}
          aria-current={activePath === '/models' ? 'page' : undefined}
        >
          <Database className='h-[18px] w-[18px] shrink-0' />
          {!sidebarCompact && t('sidebar.navigation.models')}
        </Link>

        <Link
          to='/personas'
          onClick={onMobileNavigate}
          className={itemClass(activePath === '/personas')}
          title={sidebarCompact ? t('sidebar.navigation.personas') : undefined}
          aria-current={activePath === '/personas' ? 'page' : undefined}
        >
          <UserIcon className='h-[18px] w-[18px] shrink-0' />
          {!sidebarCompact && t('sidebar.navigation.personas')}
        </Link>

        <Link
          to='/gallery'
          onClick={onMobileNavigate}
          className={itemClass(activePath === '/gallery')}
          title={sidebarCompact ? t('sidebar.navigation.imagine') : undefined}
          aria-current={activePath === '/gallery' ? 'page' : undefined}
        >
          <Sparkles className='h-[18px] w-[18px] shrink-0' />
          {!sidebarCompact && t('sidebar.navigation.imagine')}
        </Link>

        <Link
          to='/agents'
          onClick={onMobileNavigate}
          className={itemClass(activePath === '/agents')}
          title={sidebarCompact ? t('sidebar.navigation.agents') : undefined}
          aria-current={activePath === '/agents' ? 'page' : undefined}
        >
          <Bot className='h-[18px] w-[18px] shrink-0' />
          {!sidebarCompact && t('sidebar.navigation.agents')}
        </Link>
      </nav>
    </div>
  );
}
