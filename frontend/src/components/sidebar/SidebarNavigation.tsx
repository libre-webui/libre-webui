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

import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import {
  Bot,
  Database,
  NotebookPen,
  Sparkles,
  User as UserIcon,
} from 'lucide-react';
import { cn } from '@/utils';

interface SidebarNavigationProps {
  sidebarCompact: boolean;
  activePath: string;
  showAgents: boolean;
  onMobileNavigate: () => void;
}

const DESTINATIONS = [
  { path: '/notes', icon: NotebookPen, labelKey: 'sidebar.navigation.notes' },
  { path: '/models', icon: Database, labelKey: 'sidebar.navigation.models' },
  {
    path: '/personas',
    icon: UserIcon,
    labelKey: 'sidebar.navigation.personas',
  },
  { path: '/gallery', icon: Sparkles, labelKey: 'sidebar.navigation.imagine' },
  { path: '/agents', icon: Bot, labelKey: 'sidebar.navigation.agents' },
] as const;

/**
 * Secondary destinations. They are also reachable from the tab bar's new-tab
 * menu, Home, and the command palette, so the sidebar keeps them to a single
 * icon row and gives the space back to the session list.
 */
export function SidebarNavigation({
  sidebarCompact,
  activePath,
  showAgents,
  onMobileNavigate,
}: SidebarNavigationProps) {
  const { t } = useTranslation();

  return (
    <div className={cn('pb-3', sidebarCompact ? 'px-2' : 'px-3')}>
      <nav
        data-testid='sidebar-navigation'
        aria-label={t('sidebar.navigation.exploreLabel', 'Explore')}
        className={cn(
          'flex gap-1',
          sidebarCompact ? 'flex-col items-center' : 'items-center'
        )}
      >
        {DESTINATIONS.filter(
          destination => destination.path !== '/agents' || showAgents
        ).map(({ path, icon: Icon, labelKey }) => {
          const active = activePath === path;
          const label = t(labelKey);
          return (
            <Link
              key={path}
              to={path}
              onClick={onMobileNavigate}
              title={label}
              aria-label={label}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'flex items-center justify-center rounded-xl transition-colors duration-150 touch-manipulation outline-none focus-visible:ring-2 focus-visible:ring-primary-500/30',
                sidebarCompact ? 'h-11 w-11' : 'h-9 flex-1',
                active
                  ? 'bg-white text-gray-950 ring-1 ring-black/[0.04] dark:bg-dark-200 dark:text-dark-950 dark:ring-white/[0.06]'
                  : 'text-gray-500 hover:bg-white/60 hover:text-gray-950 dark:text-dark-600 dark:hover:bg-dark-200/60 dark:hover:text-dark-950'
              )}
            >
              <Icon className='h-[18px] w-[18px] shrink-0' />
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
