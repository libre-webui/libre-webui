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
import { appSectionById, type AppSection } from '@/config/appSections';
import { useAppStore } from '@/store/appStore';
import { cn } from '@/utils';

interface SidebarPinnedNavigationProps {
  activePath: string;
  showAgents: boolean;
  showAdmin: boolean;
  onMobileNavigate: () => void;
}

/**
 * The user's pinned app sections, rendered as labeled links under the
 * primary sidebar navigation. Only shown in the expanded sidebar; the
 * compact rail keeps its fixed icon row.
 */
export function SidebarPinnedNavigation({
  activePath,
  showAgents,
  showAdmin,
  onMobileNavigate,
}: SidebarPinnedNavigationProps) {
  const { t } = useTranslation();
  const pinnedNavItems = useAppStore(state => state.preferences.pinnedNavItems);

  const sections = (pinnedNavItems ?? [])
    .map(id => appSectionById.get(id))
    .filter((section): section is AppSection => Boolean(section))
    .filter(section => {
      if (section.gate === 'agents') return showAgents;
      if (section.gate === 'admin') return showAdmin;
      return true;
    });

  if (sections.length === 0) return null;

  return (
    <div className='px-3 pb-3'>
      <nav
        data-testid='sidebar-pinned-navigation'
        aria-label={t('sidebar.pinned.label', 'Pinned')}
        className='flex flex-col gap-0.5'
      >
        {sections.map(({ id, path, icon: Icon, labelKey }) => {
          const active = activePath === path;
          const label = t(labelKey, path.slice(1));
          return (
            <Link
              key={id}
              to={path}
              onClick={onMobileNavigate}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'flex h-8 items-center gap-2.5 rounded-xl px-2.5 text-[13px] transition-colors duration-150 touch-manipulation outline-none focus-visible:ring-2 focus-visible:ring-primary-500/30',
                active
                  ? 'bg-nav-active text-ink'
                  : 'text-ink-muted hover:bg-interactive-hover hover:text-ink'
              )}
            >
              <Icon className='h-4 w-4 shrink-0' />
              <span className='min-w-0 truncate'>{label}</span>
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
