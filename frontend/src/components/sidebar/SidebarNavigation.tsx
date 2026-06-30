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
      'flex items-center gap-2.5 rounded-lg text-sm font-medium transition-all duration-200 touch-manipulation',
      sidebarCompact ? 'w-11 h-11 justify-center p-0' : 'w-full px-2.5 py-2',
      active
        ? 'bg-primary-100 dark:bg-primary-900/30 text-primary-800 dark:text-primary-200 shadow-sm'
        : 'text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-dark-200/50 hover:text-gray-900 dark:hover:text-gray-100 active:bg-gray-100 dark:active:bg-dark-200'
    );

  return (
    <div className={cn('py-1.5', sidebarCompact ? 'px-1' : 'px-2.5')}>
      <nav
        className={cn(
          'space-y-0.5',
          sidebarCompact && 'flex flex-col items-center'
        )}
      >
        <button
          onClick={onChatClick}
          className={cn(
            itemClass(activePath === '/chat' || activePath === '/'),
            'text-left'
          )}
          title={sidebarCompact ? t('sidebar.navigation.chat') : undefined}
        >
          <MessageSquare className='h-4 w-4 shrink-0' />
          {!sidebarCompact && t('sidebar.navigation.chat')}
        </button>

        <Link
          to='/models'
          onClick={onMobileNavigate}
          className={itemClass(activePath === '/models')}
          title={sidebarCompact ? t('sidebar.navigation.models') : undefined}
        >
          <Database className='h-4 w-4 shrink-0' />
          {!sidebarCompact && t('sidebar.navigation.models')}
        </Link>

        <Link
          to='/personas'
          onClick={onMobileNavigate}
          className={itemClass(activePath === '/personas')}
          title={sidebarCompact ? t('sidebar.navigation.personas') : undefined}
        >
          <UserIcon className='h-4 w-4 shrink-0' />
          {!sidebarCompact && t('sidebar.navigation.personas')}
        </Link>

        <Link
          to='/gallery'
          onClick={onMobileNavigate}
          className={itemClass(activePath === '/gallery')}
          title={sidebarCompact ? t('sidebar.navigation.imagine') : undefined}
        >
          <Sparkles className='h-4 w-4 shrink-0' />
          {!sidebarCompact && t('sidebar.navigation.imagine')}
        </Link>

        <Link
          to='/agents'
          onClick={onMobileNavigate}
          className={itemClass(activePath === '/agents')}
          title={sidebarCompact ? t('sidebar.navigation.agents') : undefined}
        >
          <Bot className='h-4 w-4 shrink-0' />
          {!sidebarCompact && t('sidebar.navigation.agents')}
        </Link>
      </nav>
    </div>
  );
}
