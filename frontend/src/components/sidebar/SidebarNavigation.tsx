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
  CalendarDays,
  NotebookPen,
  Sparkles,
  User as UserIcon,
  Zap,
  MessagesSquare,
} from 'lucide-react';
import { cn } from '@/utils';
import { compactSidebarButtonClass } from './compactSidebarStyles';

interface SidebarNavigationProps {
  sidebarCompact: boolean;
  activePath: string;
  showAgents: boolean;
  /** Finished automation runs not yet acknowledged; badges the Zap icon. */
  unseenRunCount?: number;
  onMobileNavigate: () => void;
}

const DESTINATIONS = [
  {
    path: '/channels',
    icon: MessagesSquare,
    labelKey: 'sidebar.navigation.channels',
  },
  { path: '/notes', icon: NotebookPen, labelKey: 'sidebar.navigation.notes' },
  {
    path: '/calendar',
    icon: CalendarDays,
    labelKey: 'sidebar.navigation.calendar',
  },
  {
    path: '/automations',
    icon: Zap,
    labelKey: 'sidebar.navigation.automations',
  },
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
 * menu, Home, and the command palette. The expanded sidebar uses an icon row;
 * the compact rail stacks the same destinations between Chat/Work and Search.
 */
export function SidebarNavigation({
  sidebarCompact,
  activePath,
  showAgents,
  unseenRunCount = 0,
  onMobileNavigate,
}: SidebarNavigationProps) {
  const { t } = useTranslation();

  return (
    <div className={cn('shrink-0', sidebarCompact ? 'px-2' : 'px-3 pb-3')}>
      <nav
        data-testid='sidebar-navigation'
        aria-label={t('sidebar.navigation.exploreLabel', 'Explore')}
        className={cn(
          'flex',
          sidebarCompact
            ? 'flex-col items-center gap-[4px]'
            : 'items-center gap-1'
        )}
      >
        {DESTINATIONS.filter(
          destination => destination.path !== '/agents' || showAgents
        ).map(({ path, icon: Icon, labelKey }) => {
          const active =
            activePath === path || activePath.startsWith(`${path}/`);
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
                sidebarCompact
                  ? compactSidebarButtonClass
                  : 'relative flex h-9 flex-1 items-center justify-center rounded-xl transition-colors duration-150 touch-manipulation outline-none focus-visible:ring-2 focus-visible:ring-primary-500/30',
                active
                  ? 'bg-nav-active text-ink'
                  : !sidebarCompact &&
                      'text-ink-muted hover:bg-interactive-hover hover:text-ink'
              )}
            >
              <Icon aria-hidden='true' className='h-[18px] w-[18px] shrink-0' />
              {path === '/automations' && unseenRunCount > 0 && (
                <span
                  data-testid='automations-unseen-badge'
                  className='absolute -end-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-primary-500 px-0.5 text-[9px] font-semibold leading-none text-white'
                >
                  {unseenRunCount > 9 ? '9+' : unseenRunCount}
                </span>
              )}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
