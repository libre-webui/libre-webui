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

import React, { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import {
  Bot,
  Briefcase,
  Database,
  Home,
  MessageSquare,
  Package,
  Plus,
  Sparkles,
  User as UserIcon,
  Users,
  X,
} from 'lucide-react';
import { useTabStore, AppTab } from '@/store/tabStore';
import { useChatStore } from '@/store/chatStore';
import { useWorkStore } from '@/store/workStore';
import { useAuthStore } from '@/store/authStore';
import { cn, isMac } from '@/utils';
import { startNewChat, startNewWork } from '@/utils/appNavigation';

type IconComponent = React.ComponentType<{ className?: string }>;

const PAGE_META: Record<string, { icon: IconComponent; labelKey: string }> = {
  '/models': { icon: Database, labelKey: 'sidebar.navigation.models' },
  '/personas': { icon: UserIcon, labelKey: 'sidebar.navigation.personas' },
  '/gallery': { icon: Sparkles, labelKey: 'sidebar.navigation.imagine' },
  '/agents': { icon: Bot, labelKey: 'sidebar.navigation.agents' },
  '/users': { icon: Users, labelKey: 'tabs.users' },
  '/artifacts': { icon: Package, labelKey: 'tabs.artifacts' },
};

const tabIcon = (tab: AppTab): IconComponent => {
  if (tab.kind === 'home') return Home;
  if (tab.kind === 'chat') return MessageSquare;
  if (tab.kind === 'work') return Briefcase;
  return PAGE_META[tab.path]?.icon ?? Package;
};

const modKey = () => (isMac() ? '⌘' : 'Ctrl');

interface NewTabMenuItem {
  key: string;
  label: string;
  icon: IconComponent;
  shortcut?: string;
  action: () => void;
}

export const AppTabBar: React.FC = () => {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const tabs = useTabStore(state => state.tabs);
  const activeTabId = useTabStore(state => state.activeTabId);
  const syncWithPath = useTabStore(state => state.syncWithPath);
  const closeTab = useTabStore(state => state.closeTab);
  const sessions = useChatStore(state => state.sessions);
  const workTasks = useWorkStore(state => state.tasks);
  const { systemInfo, isAdmin } = useAuthStore();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);

  const showWork = systemInfo?.requiresAuth === false || isAdmin();

  useEffect(() => {
    syncWithPath(location.pathname);
  }, [location.pathname, syncWithPath]);

  // Keep the active tab visible when the strip overflows.
  useEffect(() => {
    const strip = stripRef.current;
    const active = strip?.querySelector<HTMLElement>('[data-active="true"]');
    active?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeTabId, tabs.length]);

  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [menuOpen]);

  const tabTitle = (tab: AppTab): string => {
    if (tab.kind === 'home') return t('tabs.home', 'Home');
    if (tab.kind === 'chat') {
      if (tab.id === 'chat:new') return t('tabs.newChat', 'New Chat');
      const sessionId = tab.id.slice('chat:'.length);
      return (
        sessions.find(session => session.id === sessionId)?.title ||
        t('tabs.chat', 'Chat')
      );
    }
    if (tab.kind === 'work') {
      if (tab.id === 'work:new') return t('tabs.work', 'Work');
      const taskId = tab.id.slice('work:'.length);
      return (
        workTasks.find(task => task.id === taskId)?.title ||
        t('tabs.work', 'Work')
      );
    }
    const meta = PAGE_META[tab.path];
    return meta ? t(meta.labelKey, tab.path.slice(1)) : tab.path.slice(1);
  };

  const handleClose = (event: React.MouseEvent<HTMLElement>, tab: AppTab) => {
    event.stopPropagation();
    event.preventDefault();
    const fallback = closeTab(tab.id);
    if (fallback) navigate(fallback.path);
  };

  const menuItems: NewTabMenuItem[] = [
    {
      key: 'chat',
      label: t('tabs.newChat', 'New Chat'),
      icon: MessageSquare,
      shortcut: `${modKey()}⇧O`,
      action: () => startNewChat(navigate),
    },
    ...(showWork
      ? [
          {
            key: 'work',
            label: t('tabs.newWork', 'New Work'),
            icon: Briefcase,
            shortcut: `${modKey()}⇧U`,
            action: () => startNewWork(navigate),
          },
        ]
      : []),
    ...['/models', '/personas', '/gallery', '/agents'].map(path => ({
      key: path,
      label: t(PAGE_META[path].labelKey, path.slice(1)),
      icon: PAGE_META[path].icon,
      action: () => navigate(path),
    })),
  ];

  return (
    <div
      data-testid='app-tab-bar'
      className='relative z-20 flex h-9 flex-none items-center gap-1 px-1 pb-1 lg:px-0'
    >
      <div
        ref={stripRef}
        role='tablist'
        aria-label={t('tabs.label', 'Open tabs')}
        className='flex min-w-0 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden'
      >
        {tabs.map(tab => {
          const Icon = tabIcon(tab);
          const isActive = tab.id === activeTabId;
          return (
            <button
              key={tab.id}
              type='button'
              role='tab'
              aria-selected={isActive}
              data-active={isActive || undefined}
              data-testid='app-tab'
              title={tabTitle(tab)}
              onClick={() => navigate(tab.path)}
              onAuxClick={event => {
                if (event.button === 1 && tab.id !== 'home') {
                  handleClose(event, tab);
                }
              }}
              className={cn(
                'group flex h-7 min-w-0 flex-none items-center gap-1.5 rounded-lg border text-[13px] transition-colors duration-150 outline-none focus-visible:ring-2 focus-visible:ring-primary-500/40',
                tab.id === 'home' ? 'px-2.5' : 'ps-2.5 pe-1',
                isActive
                  ? 'border-black/[0.06] bg-gray-50 text-gray-950 shadow-subtle dark:border-white/[0.07] dark:bg-dark-100 dark:text-dark-950'
                  : 'border-transparent text-gray-500 hover:bg-white/60 hover:text-gray-900 dark:text-dark-600 dark:hover:bg-dark-200/60 dark:hover:text-dark-900'
              )}
            >
              <Icon className='h-3.5 w-3.5 shrink-0' />
              <span className='max-w-[9rem] truncate'>{tabTitle(tab)}</span>
              {tab.id !== 'home' && (
                <span
                  role='button'
                  tabIndex={-1}
                  aria-label={t('tabs.close', 'Close tab')}
                  data-testid='app-tab-close'
                  onClick={event => handleClose(event, tab)}
                  className={cn(
                    'flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-gray-400 transition-opacity hover:bg-black/[0.06] hover:text-gray-700 dark:text-dark-500 dark:hover:bg-white/[0.08] dark:hover:text-dark-800',
                    isActive
                      ? 'opacity-100'
                      : 'sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-visible:opacity-100'
                  )}
                >
                  <X className='h-3 w-3' />
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div className='relative flex-none' ref={menuRef}>
        <button
          type='button'
          aria-label={t('tabs.new', 'New tab')}
          aria-expanded={menuOpen}
          data-testid='app-tab-new'
          onClick={() => setMenuOpen(open => !open)}
          className='flex h-7 w-7 items-center justify-center rounded-lg text-gray-500 transition-colors hover:bg-white/60 hover:text-gray-900 dark:text-dark-600 dark:hover:bg-dark-200/60 dark:hover:text-dark-900 outline-none focus-visible:ring-2 focus-visible:ring-primary-500/40'
        >
          <Plus className='h-4 w-4' />
        </button>
        {menuOpen && (
          <div
            role='menu'
            data-testid='app-tab-new-menu'
            className='absolute start-0 top-full z-50 mt-1 w-56 rounded-xl border border-line bg-surface-overlay/95 p-1 shadow-overlay backdrop-blur-xl animate-fade-in motion-reduce:animate-none'
          >
            {menuItems.map(item => (
              <button
                key={item.key}
                type='button'
                role='menuitem'
                onClick={() => {
                  setMenuOpen(false);
                  item.action();
                }}
                className='flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[13px] text-ink-muted transition-colors hover:bg-black/[0.05] hover:text-ink dark:hover:bg-white/[0.06]'
              >
                <item.icon className='h-4 w-4 shrink-0' />
                <span className='min-w-0 flex-1 truncate text-start'>
                  {item.label}
                </span>
                {item.shortcut && (
                  <span className='font-mono text-[10px] tracking-wide text-ink-subtle'>
                    {item.shortcut}
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
