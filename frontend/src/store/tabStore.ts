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

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type AppTabKind = 'home' | 'chat' | 'work' | 'page';

export interface AppTab {
  id: string;
  kind: AppTabKind;
  path: string;
}

export const HOME_TAB: AppTab = { id: 'home', kind: 'home', path: '/' };

const PAGE_TAB_PATHS = [
  '/models',
  '/personas',
  '/gallery',
  '/agents',
  '/users',
  '/artifacts',
] as const;

/**
 * Maps a router pathname to its tab identity. Paths that are not part of the
 * tab shell (login, unknown routes) return null and leave the strip untouched.
 */
export const tabForPath = (pathname: string): AppTab | null => {
  if (pathname === '/' || pathname === '/home') return HOME_TAB;
  if (pathname === '/chat') {
    return { id: 'chat:new', kind: 'chat', path: '/chat' };
  }
  const chatMatch = pathname.match(/^\/c\/([^/]+)$/);
  if (chatMatch) {
    return { id: `chat:${chatMatch[1]}`, kind: 'chat', path: pathname };
  }
  if (pathname === '/work') {
    return { id: 'work:new', kind: 'work', path: '/work' };
  }
  const workMatch = pathname.match(/^\/work\/([^/]+)$/);
  if (workMatch) {
    return { id: `work:${workMatch[1]}`, kind: 'work', path: pathname };
  }
  if ((PAGE_TAB_PATHS as readonly string[]).includes(pathname)) {
    return { id: `page:${pathname}`, kind: 'page', path: pathname };
  }
  return null;
};

const withHomeFirst = (tabs: AppTab[]): AppTab[] => {
  const rest = tabs.filter(tab => tab.id !== HOME_TAB.id);
  return [HOME_TAB, ...rest];
};

interface TabState {
  tabs: AppTab[];
  activeTabId: string;
  /** Upserts the tab for a pathname and makes it active. */
  syncWithPath: (pathname: string) => void;
  /**
   * Removes a tab. Returns the tab to navigate to when the closed tab was
   * active, otherwise null. The Home tab cannot be closed.
   */
  closeTab: (id: string) => AppTab | null;
  reset: () => void;
}

export const useTabStore = create<TabState>()(
  persist(
    (set, get) => ({
      tabs: [HOME_TAB],
      activeTabId: HOME_TAB.id,

      syncWithPath: pathname => {
        const next = tabForPath(pathname);
        if (!next) return;
        set(state => {
          const tabs = withHomeFirst(state.tabs);
          const existing = tabs.find(tab => tab.id === next.id);
          if (existing) {
            return { tabs, activeTabId: existing.id };
          }
          const active = tabs.find(tab => tab.id === state.activeTabId);
          // A "New Chat"/"Work" landing tab morphs into the created session's
          // tab in place, so the strip does not grow an extra entry when the
          // first message creates the real session.
          if (
            active &&
            active.kind === next.kind &&
            active.id.endsWith(':new') &&
            !next.id.endsWith(':new')
          ) {
            return {
              tabs: tabs.map(tab => (tab.id === active.id ? next : tab)),
              activeTabId: next.id,
            };
          }
          return { tabs: [...tabs, next], activeTabId: next.id };
        });
      },

      closeTab: id => {
        if (id === HOME_TAB.id) return null;
        const state = get();
        const tabs = withHomeFirst(state.tabs);
        const index = tabs.findIndex(tab => tab.id === id);
        if (index === -1) return null;
        const remaining = tabs.filter(tab => tab.id !== id);
        if (state.activeTabId !== id) {
          set({ tabs: remaining });
          return null;
        }
        const fallback = remaining[Math.max(0, index - 1)] ?? HOME_TAB;
        set({ tabs: remaining, activeTabId: fallback.id });
        return fallback;
      },

      reset: () => set({ tabs: [HOME_TAB], activeTabId: HOME_TAB.id }),
    }),
    {
      name: 'libre-webui-tabs',
      merge: (persisted, current) => {
        const incoming = (persisted ?? {}) as Partial<TabState>;
        const tabs = Array.isArray(incoming.tabs)
          ? withHomeFirst(
              incoming.tabs.filter(
                (tab): tab is AppTab =>
                  !!tab &&
                  typeof tab.id === 'string' &&
                  typeof tab.path === 'string' &&
                  tabForPath(tab.path)?.id === tab.id
              )
            )
          : current.tabs;
        const activeTabId = tabs.some(tab => tab.id === incoming.activeTabId)
          ? (incoming.activeTabId as string)
          : HOME_TAB.id;
        return { ...current, tabs, activeTabId };
      },
    }
  )
);
