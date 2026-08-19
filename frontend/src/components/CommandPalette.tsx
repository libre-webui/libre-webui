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

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import {
  Bot,
  Briefcase,
  CalendarDays,
  Database,
  Ghost,
  Home,
  MessageSquare,
  Moon,
  Search,
  Settings,
  Sparkles,
  User as UserIcon,
} from 'lucide-react';
import { useChatStore } from '@/store/chatStore';
import { useWorkStore } from '@/store/workStore';
import { useAuthStore } from '@/store/authStore';
import { useAppStore } from '@/store/appStore';
import {
  startIncognitoChat,
  startNewChat,
  startNewWork,
} from '@/utils/appNavigation';
import { cn, formatTimestamp, isMac } from '@/utils';

type IconComponent = React.ComponentType<{ className?: string }>;

interface PaletteItem {
  id: string;
  section: string;
  label: string;
  icon: IconComponent;
  hint?: string;
  keywords?: string;
  run: () => void;
}

const MAX_SESSION_RESULTS = 8;
const MAX_WORK_RESULTS = 6;

interface CommandPaletteProps {
  onOpenSettings: () => void;
}

export const CommandPalette: React.FC<CommandPaletteProps> = ({
  onOpenSettings,
}) => {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const sessions = useChatStore(state => state.sessions);
  const workTasks = useWorkStore(state => state.tasks);
  const toggleTheme = useAppStore(state => state.toggleTheme);
  const { canUseWork, canUseAgents } = useAuthStore();

  const showWork = canUseWork();
  const showAgents = canUseAgents();
  const mod = isMac() ? '⌘' : 'Ctrl';

  // Own capture-phase listener so ⌘K works even while typing in the composer.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        // Resetting on both edges keeps every open starting from a clean query.
        setQuery('');
        setSelectedIndex(0);
        setOpen(current => !current);
      }
    };
    const onOpenEvent = () => {
      setQuery('');
      setSelectedIndex(0);
      setOpen(true);
    };
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('libre:open-palette', onOpenEvent);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('libre:open-palette', onOpenEvent);
    };
  }, []);

  // Moving focus is a DOM side effect, so it belongs in an effect.
  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  const close = useCallback(() => setOpen(false), []);

  const items = useMemo((): PaletteItem[] => {
    const actionSection = t('palette.actions', 'Actions');
    const actions: PaletteItem[] = [
      {
        id: 'action:new-chat',
        section: actionSection,
        label: t('tabs.newChat', 'New Chat'),
        icon: MessageSquare,
        hint: `${mod}⇧O`,
        run: () => startNewChat(navigate),
      },
      {
        id: 'action:incognito-chat',
        section: actionSection,
        label: t('chat.session.incognito', 'Incognito Chat'),
        icon: Ghost,
        run: () => startIncognitoChat(navigate),
      },
      ...(showWork
        ? [
            {
              id: 'action:new-work',
              section: actionSection,
              label: t('tabs.newWork', 'New Work'),
              icon: Briefcase,
              hint: `${mod}⇧U`,
              run: () => startNewWork(navigate),
            },
          ]
        : []),
      {
        id: 'action:home',
        section: actionSection,
        label: t('tabs.home', 'Home'),
        icon: Home,
        run: () => navigate('/'),
      },
      {
        id: 'action:models',
        section: actionSection,
        label: t('sidebar.navigation.models', 'Models'),
        icon: Database,
        run: () => navigate('/models'),
      },
      {
        id: 'action:personas',
        section: actionSection,
        label: t('sidebar.navigation.personas', 'Personas'),
        icon: UserIcon,
        run: () => navigate('/personas'),
      },
      {
        id: 'action:gallery',
        section: actionSection,
        label: t('sidebar.navigation.imagine', 'Imagine'),
        icon: Sparkles,
        run: () => navigate('/gallery'),
      },
      {
        id: 'action:calendar',
        section: actionSection,
        label: t('sidebar.navigation.calendar', 'Calendar'),
        icon: CalendarDays,
        run: () => navigate('/calendar'),
      },
      ...(showAgents
        ? [
            {
              id: 'action:agents',
              section: actionSection,
              label: t('sidebar.navigation.agents', 'Agents'),
              icon: Bot,
              run: () => navigate('/agents'),
            },
          ]
        : []),
      {
        id: 'action:settings',
        section: actionSection,
        label: t('palette.settings', 'Settings'),
        icon: Settings,
        hint: `${mod},`,
        run: onOpenSettings,
      },
      {
        id: 'action:theme',
        section: actionSection,
        label: t('palette.toggleTheme', 'Toggle theme'),
        icon: Moon,
        hint: `${mod}D`,
        run: toggleTheme,
      },
    ];

    const sessionItems: PaletteItem[] = [...sessions]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(session => ({
        id: `session:${session.id}`,
        section: t('palette.chats', 'Chats'),
        label: session.title || t('tabs.chat', 'Chat'),
        icon: MessageSquare,
        hint: formatTimestamp(session.updatedAt, i18n.language),
        keywords: session.model,
        run: () => navigate(`/c/${session.id}`),
      }));

    const workItems: PaletteItem[] = showWork
      ? [...workTasks]
          .sort(
            (a, b) =>
              new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
          )
          .map(task => ({
            id: `work:${task.id}`,
            section: t('palette.work', 'Work'),
            label: task.title || t('work.tasks.untitled', 'Untitled task'),
            icon: Briefcase,
            hint: task.status,
            run: () => navigate(`/work/${task.id}`),
          }))
      : [];

    return [...actions, ...sessionItems, ...workItems];
  }, [
    t,
    mod,
    navigate,
    onOpenSettings,
    toggleTheme,
    sessions,
    workTasks,
    showWork,
    showAgents,
    i18n.language,
  ]);

  const filtered = useMemo(() => {
    const trimmed = query.trim().toLowerCase();
    if (!trimmed) {
      // Without a query: actions plus the freshest few of each list.
      const actions = items.filter(item => item.id.startsWith('action:'));
      const chats = items
        .filter(item => item.id.startsWith('session:'))
        .slice(0, 4);
      const work = items
        .filter(item => item.id.startsWith('work:'))
        .slice(0, 3);
      return [...actions, ...chats, ...work];
    }
    return items
      .filter(item =>
        `${item.label} ${item.keywords ?? ''}`.toLowerCase().includes(trimmed)
      )
      .slice(0, MAX_SESSION_RESULTS + MAX_WORK_RESULTS + 6);
  }, [items, query]);

  useEffect(() => {
    const selected = listRef.current?.querySelector<HTMLElement>(
      '[data-selected="true"]'
    );
    selected?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex, filtered.length]);

  const runItem = (item: PaletteItem | undefined) => {
    if (!item) return;
    close();
    item.run();
  };

  if (!open) return null;

  let lastSection = '';

  return createPortal(
    <div
      data-testid='command-palette'
      className='fixed inset-0 z-[120] flex items-start justify-center bg-black/25 px-4 pt-[14vh] backdrop-blur-[2px] dark:bg-black/45'
      onMouseDown={event => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div className='w-full max-w-lg overflow-hidden rounded-2xl border border-line bg-surface-overlay/95 shadow-overlay backdrop-blur-xl animate-scale-in motion-reduce:animate-none'>
        <div className='flex items-center gap-2.5 border-b border-line px-3.5'>
          <Search className='h-4 w-4 shrink-0 text-ink-subtle' />
          <input
            ref={inputRef}
            data-testid='command-palette-input'
            value={query}
            onChange={event => {
              setQuery(event.target.value);
              // A new query means the previous highlight no longer applies.
              setSelectedIndex(0);
            }}
            onKeyDown={event => {
              if (event.key === 'Escape') {
                event.preventDefault();
                close();
              } else if (event.key === 'ArrowDown') {
                event.preventDefault();
                setSelectedIndex(index =>
                  Math.min(filtered.length - 1, index + 1)
                );
              } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                setSelectedIndex(index => Math.max(0, index - 1));
              } else if (event.key === 'Enter') {
                event.preventDefault();
                runItem(filtered[selectedIndex]);
              }
            }}
            placeholder={t(
              'palette.placeholder',
              'Search chats, Work, actions…'
            )}
            className='h-11 w-full bg-transparent text-sm text-ink outline-none placeholder:text-ink-subtle'
          />
          <kbd className='shrink-0 rounded-md border border-line px-1.5 py-0.5 font-mono text-[10px] text-ink-subtle'>
            esc
          </kbd>
        </div>
        <div
          ref={listRef}
          className='max-h-[19rem] overflow-y-auto p-1.5 scrollbar-thin'
        >
          {filtered.length === 0 && (
            <p className='px-3 py-6 text-center text-sm text-ink-subtle'>
              {t('palette.empty', 'No matches.')}
            </p>
          )}
          {filtered.map((item, index) => {
            const showSection = item.section !== lastSection;
            lastSection = item.section;
            return (
              <React.Fragment key={item.id}>
                {showSection && (
                  <p className='px-2.5 pb-1 pt-2 text-[10px] font-medium uppercase tracking-[0.08em] text-ink-subtle first:pt-1'>
                    {item.section}
                  </p>
                )}
                <button
                  type='button'
                  data-selected={index === selectedIndex || undefined}
                  onMouseEnter={() => setSelectedIndex(index)}
                  onClick={() => runItem(item)}
                  className={cn(
                    'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-start text-sm transition-colors',
                    index === selectedIndex
                      ? 'bg-black/[0.05] text-ink dark:bg-white/[0.07]'
                      : 'text-ink-muted'
                  )}
                >
                  <item.icon className='h-4 w-4 shrink-0 text-ink-subtle' />
                  <span className='min-w-0 flex-1 truncate'>{item.label}</span>
                  {item.hint && (
                    <span className='shrink-0 font-mono text-[10px] text-ink-subtle'>
                      {item.hint}
                    </span>
                  )}
                </button>
              </React.Fragment>
            );
          })}
        </div>
      </div>
    </div>,
    document.body
  );
};
