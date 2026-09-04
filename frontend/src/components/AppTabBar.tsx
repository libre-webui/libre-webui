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
import { createPortal } from 'react-dom';
import { useLocation, useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import {
  Bot,
  Briefcase,
  ChartNoAxesCombined,
  Ghost,
  Home,
  ListX,
  MessageSquare,
  CalendarDays,
  NotebookPen,
  Package,
  PanelRightClose,
  Plus,
  Server,
  Sparkles,
  SquareX,
  User as UserIcon,
  X,
  Zap,
  MessagesSquare,
} from 'lucide-react';
import { useTabStore, AppTab } from '@/store/tabStore';
import { useChatStore } from '@/store/chatStore';
import { useWorkStore } from '@/store/workStore';
import { useAuthStore } from '@/store/authStore';
import { cn, isMac } from '@/utils';
import {
  startIncognitoChat,
  startNewChat,
  startNewWork,
} from '@/utils/appNavigation';

type IconComponent = React.ComponentType<{ className?: string }>;

const PAGE_META: Record<string, { icon: IconComponent; labelKey: string }> = {
  '/notes': { icon: NotebookPen, labelKey: 'sidebar.navigation.notes' },
  '/calendar': { icon: CalendarDays, labelKey: 'sidebar.navigation.calendar' },
  '/automations': { icon: Zap, labelKey: 'sidebar.navigation.automations' },
  '/channels': {
    icon: MessagesSquare,
    labelKey: 'sidebar.navigation.channels',
  },
  '/personas': { icon: UserIcon, labelKey: 'sidebar.navigation.personas' },
  '/gallery': { icon: Sparkles, labelKey: 'sidebar.navigation.imagine' },
  '/agents': { icon: Bot, labelKey: 'sidebar.navigation.agents' },
  '/usage': { icon: ChartNoAxesCombined, labelKey: 'usageAnalytics.title' },
  '/system': { icon: Server, labelKey: 'systemPage.title' },
  '/artifacts': { icon: Package, labelKey: 'tabs.artifacts' },
};

const tabIcon = (tab: AppTab): IconComponent => {
  if (tab.kind === 'home') return Home;
  if (tab.kind === 'chat') return MessageSquare;
  if (tab.kind === 'work') return Briefcase;
  return PAGE_META[tab.path]?.icon ?? Package;
};

const modKey = () => (isMac() ? '⌘' : 'Ctrl');

const ADMIN_ONLY_TAB_PATHS = new Set(['/agents', '/usage', '/system']);

// Work tabs follow Work access (admins, or everyone once an administrator
// opens Work up); the listed paths stay admin-only regardless.
const isRestrictedTab = (tab: AppTab, canWork: boolean) =>
  tab.kind === 'work' ? !canWork : ADMIN_ONLY_TAB_PATHS.has(tab.path);

interface NewTabMenuItem {
  key: string;
  label: string;
  icon: IconComponent;
  shortcut?: string;
  separatorBefore?: boolean;
  action: () => void;
}

interface TabContextMenuState {
  tabId: string;
  x: number;
  y: number;
}

interface NewTabMenuPosition {
  left: number;
  top: number;
  width: number;
}

export const AppTabBar: React.FC = () => {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const tabs = useTabStore(state => state.tabs);
  const activeTabId = useTabStore(state => state.activeTabId);
  const syncWithPath = useTabStore(state => state.syncWithPath);
  const closeTab = useTabStore(state => state.closeTab);
  const closeTabs = useTabStore(state => state.closeTabs);
  const sessions = useChatStore(state => state.sessions);
  const currentSession = useChatStore(state => state.currentSession);
  const workTasks = useWorkStore(state => state.tasks);
  const { systemInfo, isAdmin, canUseWork, canUseAgents } = useAuthStore();
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState<NewTabMenuPosition | null>(
    null
  );
  const [contextMenu, setContextMenu] = useState<TabContextMenuState | null>(
    null
  );
  const menuRef = useRef<HTMLDivElement>(null);
  const newTabMenuRef = useRef<HTMLDivElement>(null);
  const newTabButtonRef = useRef<HTMLButtonElement>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);

  const admin = isAdmin();
  const showAdminWorkspace = systemInfo?.requiresAuth === false || admin;
  const showWork = canUseWork();
  const accessibleTabs = showAdminWorkspace
    ? tabs
    : tabs.filter(tab => !isRestrictedTab(tab, showWork));

  useEffect(() => {
    syncWithPath(location.pathname);
  }, [location.pathname, syncWithPath]);

  // Keep the active tab visible when the strip overflows.
  useEffect(() => {
    const strip = stripRef.current;
    const active = strip?.querySelector<HTMLElement>('[data-active="true"]');
    active?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [accessibleTabs.length, activeTabId]);

  useEffect(() => {
    if (!systemInfo || showAdminWorkspace) return;
    const restrictedTabIds = tabs
      .filter(tab => isRestrictedTab(tab, showWork))
      .map(tab => tab.id);
    if (restrictedTabIds.length === 0) return;
    const fallback = closeTabs(restrictedTabIds, 'home');
    if (fallback) navigate(fallback.path, { replace: true });
  }, [closeTabs, navigate, showAdminWorkspace, showWork, systemInfo, tabs]);

  useEffect(() => {
    if (!menuOpen && !contextMenu) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        !menuRef.current?.contains(target) &&
        !newTabMenuRef.current?.contains(target) &&
        !contextMenuRef.current?.contains(target)
      ) {
        setMenuOpen(false);
        setContextMenu(null);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMenuOpen(false);
        setContextMenu(null);
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [contextMenu, menuOpen]);

  useEffect(() => {
    if (!menuOpen) return;

    const positionMenu = () => {
      const button = newTabButtonRef.current;
      if (!button) return;

      const buttonRect = button.getBoundingClientRect();
      const contentRect = button
        .closest<HTMLElement>('[data-testid="app-shell-content"]')
        ?.getBoundingClientRect();
      const boundaryLeft = contentRect?.left ?? 0;
      const boundaryRight = contentRect?.right ?? window.innerWidth;
      const viewportPadding = 8;
      const leftLimit = boundaryLeft + viewportPadding;
      const rightLimit = boundaryRight - viewportPadding;
      const width = Math.max(0, Math.min(224, rightLimit - leftLimit));
      const roomOnRight = rightLimit - buttonRect.left;
      const preferredLeft =
        roomOnRight >= width ? buttonRect.left : buttonRect.right - width;
      const left = Math.max(
        leftLimit,
        Math.min(preferredLeft, rightLimit - width)
      );

      setMenuPosition({
        left,
        top: buttonRect.bottom + 4,
        width,
      });
    };

    positionMenu();
    window.addEventListener('resize', positionMenu);
    return () => window.removeEventListener('resize', positionMenu);
  }, [menuOpen]);

  useEffect(() => {
    if (!contextMenu) return;
    contextMenuRef.current
      ?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')
      ?.focus();
  }, [contextMenu]);

  const tabTitle = (tab: AppTab): string => {
    if (tab.kind === 'home') return t('tabs.home', 'Home');
    if (tab.kind === 'chat') {
      if (tab.id === 'chat:new') {
        return currentSession?.isPrivate
          ? t('chat.session.incognito', 'Incognito Chat')
          : t('tabs.newChat', 'New Chat');
      }
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

  const openContextMenu = (tab: AppTab, x: number, y: number) => {
    const viewportPadding = 8;
    const menuWidth = 224;
    const menuHeight = 176;
    setMenuOpen(false);
    setContextMenu({
      tabId: tab.id,
      x: Math.max(
        viewportPadding,
        Math.min(x, window.innerWidth - menuWidth - viewportPadding)
      ),
      y: Math.max(
        viewportPadding,
        Math.min(y, window.innerHeight - menuHeight - viewportPadding)
      ),
    });
  };

  const handleTabContextMenu = (
    event: React.MouseEvent<HTMLButtonElement>,
    tab: AppTab
  ) => {
    event.preventDefault();
    event.stopPropagation();
    openContextMenu(tab, event.clientX, event.clientY);
  };

  const handleTabContextKeyDown = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    tab: AppTab
  ) => {
    if (
      event.key !== 'ContextMenu' &&
      !(event.shiftKey && event.key === 'F10')
    ) {
      return;
    }
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    openContextMenu(tab, rect.left + 12, rect.bottom + 4);
  };

  const handleContextMenuKeyDown = (
    event: React.KeyboardEvent<HTMLDivElement>
  ) => {
    const items = Array.from(
      contextMenuRef.current?.querySelectorAll<HTMLButtonElement>(
        '[role="menuitem"]:not(:disabled)'
      ) ?? []
    );
    if (items.length === 0) return;
    const currentIndex = items.indexOf(
      document.activeElement as HTMLButtonElement
    );
    let nextIndex = currentIndex;
    if (event.key === 'ArrowDown') {
      nextIndex = (currentIndex + 1 + items.length) % items.length;
    } else if (event.key === 'ArrowUp') {
      nextIndex = (currentIndex - 1 + items.length) % items.length;
    } else if (event.key === 'Home') {
      nextIndex = 0;
    } else if (event.key === 'End') {
      nextIndex = items.length - 1;
    } else {
      return;
    }
    event.preventDefault();
    items[nextIndex]?.focus();
  };

  const closeTabSet = (ids: string[], preferredTabId?: string) => {
    const fallback = closeTabs(ids, preferredTabId);
    setContextMenu(null);
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
    {
      key: 'incognito-chat',
      label: t('chat.session.incognito', 'Incognito Chat'),
      icon: Ghost,
      action: () => startIncognitoChat(navigate),
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
    ...[
      '/channels',
      '/notes',
      '/calendar',
      '/automations',
      '/personas',
      '/gallery',
    ].map(path => ({
      key: path,
      label: t(PAGE_META[path].labelKey, path.slice(1)),
      icon: PAGE_META[path].icon,
      action: () => navigate(path),
    })),
    ...(canUseAgents()
      ? [
          {
            key: '/agents',
            label: t(PAGE_META['/agents'].labelKey, 'Agents'),
            icon: PAGE_META['/agents'].icon,
            separatorBefore: true,
            action: () => navigate('/agents'),
          },
        ]
      : []),
    ...(admin
      ? ['/system', '/usage'].map(path => ({
          key: path,
          label: t(PAGE_META[path].labelKey, path.slice(1)),
          icon: PAGE_META[path].icon,
          action: () => navigate(path),
        }))
      : []),
  ];

  const contextTab = contextMenu
    ? accessibleTabs.find(tab => tab.id === contextMenu.tabId)
    : undefined;
  const contextTabIndex = contextTab
    ? accessibleTabs.findIndex(tab => tab.id === contextTab.id)
    : -1;
  const otherTabIds = contextTab
    ? accessibleTabs
        .filter(tab => tab.id !== 'home' && tab.id !== contextTab.id)
        .map(tab => tab.id)
    : [];
  const rightTabIds =
    contextTabIndex >= 0
      ? accessibleTabs
          .slice(contextTabIndex + 1)
          .filter(tab => tab.id !== 'home')
          .map(tab => tab.id)
      : [];
  const allClosableTabIds = accessibleTabs
    .filter(tab => tab.id !== 'home')
    .map(tab => tab.id);

  return (
    <div
      data-testid='app-tab-bar'
      data-app-tabbar=''
      className='relative z-20 flex h-9 flex-none items-center gap-1 px-1 pb-1 lg:px-0'
    >
      <div
        ref={stripRef}
        role='tablist'
        aria-label={t('tabs.label', 'Open tabs')}
        className='flex min-w-0 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden'
      >
        {accessibleTabs.map(tab => {
          const Icon =
            tab.id === 'chat:new' && currentSession?.isPrivate
              ? Ghost
              : tabIcon(tab);
          const isActive = tab.id === activeTabId;
          return (
            <button
              key={tab.id}
              type='button'
              role='tab'
              aria-selected={isActive}
              data-active={isActive || undefined}
              data-tab-id={tab.id}
              data-testid='app-tab'
              title={tabTitle(tab)}
              onClick={() => navigate(tab.path)}
              onContextMenu={event => handleTabContextMenu(event, tab)}
              onKeyDown={event => handleTabContextKeyDown(event, tab)}
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

      {/* Both menus render through a portal: the tab bar's own stacking
          context (z-20) would otherwise trap them below page headers and
          banners (e.g. the Work header at z-50). */}
      {contextMenu &&
        contextTab &&
        createPortal(
          <div
            ref={contextMenuRef}
            role='menu'
            aria-label={t('tabs.actions', 'Tab actions')}
            data-testid='app-tab-context-menu'
            onContextMenu={event => event.preventDefault()}
            onKeyDown={handleContextMenuKeyDown}
            className='fixed z-[100] w-56 rounded-xl border border-line bg-surface-overlay/95 p-1 shadow-overlay backdrop-blur-xl animate-fade-in motion-reduce:animate-none'
            style={{ left: contextMenu.x, top: contextMenu.y }}
          >
            <button
              type='button'
              role='menuitem'
              data-testid='app-tab-context-close'
              disabled={contextTab.id === 'home'}
              onClick={() => {
                const fallback = closeTab(contextTab.id);
                setContextMenu(null);
                if (fallback) navigate(fallback.path);
              }}
              className='flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[13px] text-ink-muted transition-colors hover:bg-black/[0.05] hover:text-ink disabled:cursor-not-allowed disabled:opacity-40 dark:hover:bg-white/[0.06]'
            >
              <X className='h-4 w-4 shrink-0' />
              <span>{t('tabs.close', 'Close tab')}</span>
            </button>
            <button
              type='button'
              role='menuitem'
              data-testid='app-tab-context-close-others'
              disabled={otherTabIds.length === 0}
              onClick={() => closeTabSet(otherTabIds, contextTab.id)}
              className='flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[13px] text-ink-muted transition-colors hover:bg-black/[0.05] hover:text-ink disabled:cursor-not-allowed disabled:opacity-40 dark:hover:bg-white/[0.06]'
            >
              <SquareX className='h-4 w-4 shrink-0' />
              <span>{t('tabs.closeOthers', 'Close other tabs')}</span>
            </button>
            <button
              type='button'
              role='menuitem'
              data-testid='app-tab-context-close-right'
              disabled={rightTabIds.length === 0}
              onClick={() => closeTabSet(rightTabIds, contextTab.id)}
              className='flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[13px] text-ink-muted transition-colors hover:bg-black/[0.05] hover:text-ink disabled:cursor-not-allowed disabled:opacity-40 dark:hover:bg-white/[0.06]'
            >
              <PanelRightClose className='h-4 w-4 shrink-0' />
              <span>{t('tabs.closeRight', 'Close tabs to the right')}</span>
            </button>
            <div className='mx-2 my-1 h-px bg-line' role='separator' />
            <button
              type='button'
              role='menuitem'
              data-testid='app-tab-context-close-all'
              disabled={allClosableTabIds.length === 0}
              onClick={() => closeTabSet(allClosableTabIds, 'home')}
              className='flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[13px] text-ink-muted transition-colors hover:bg-black/[0.05] hover:text-ink disabled:cursor-not-allowed disabled:opacity-40 dark:hover:bg-white/[0.06]'
            >
              <ListX className='h-4 w-4 shrink-0' />
              <span>{t('tabs.closeAll', 'Close all tabs')}</span>
            </button>
          </div>,
          document.body
        )}

      <div className='relative flex-none' ref={menuRef}>
        <button
          ref={newTabButtonRef}
          type='button'
          aria-label={t('tabs.new', 'New tab')}
          aria-expanded={menuOpen}
          data-testid='app-tab-new'
          onClick={() => setMenuOpen(open => !open)}
          className='flex h-7 w-7 items-center justify-center rounded-lg text-gray-500 transition-colors hover:bg-white/60 hover:text-gray-900 dark:text-dark-600 dark:hover:bg-dark-200/60 dark:hover:text-dark-900 outline-none focus-visible:ring-2 focus-visible:ring-primary-500/40'
        >
          <Plus className='h-4 w-4' />
        </button>
        {menuOpen &&
          menuPosition &&
          createPortal(
            <div
              ref={newTabMenuRef}
              role='menu'
              data-testid='app-tab-new-menu'
              className='fixed z-[100] max-h-[calc(100dvh-4rem)] overflow-y-auto rounded-xl border border-line bg-surface-overlay/95 p-1 shadow-overlay backdrop-blur-xl animate-fade-in motion-reduce:animate-none'
              style={menuPosition}
            >
              {menuItems.map(item => (
                <React.Fragment key={item.key}>
                  {item.separatorBefore && (
                    <div className='mx-2 my-1 h-px bg-line' role='separator' />
                  )}
                  <button
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
                </React.Fragment>
              ))}
            </div>,
            document.body
          )}
      </div>
    </div>
  );
};
