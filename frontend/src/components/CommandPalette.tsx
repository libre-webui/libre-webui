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
  Zap,
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

const MAX_RESULTS = 24;

interface FuzzyMatch {
  score: number;
  /** [start, end) ranges of matched characters in the text. */
  ranges: Array<[number, number]>;
}

/**
 * Score `query` against `text`. Exact substrings rank highest (earlier and
 * at word starts is better); otherwise an in-order character subsequence
 * still matches, rewarding contiguous runs and word-boundary hits so
 * "npc" finds "New Persona Chat" but scattered noise sinks to the bottom.
 */
function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
  const q = query.toLowerCase();
  const lower = text.toLowerCase();
  if (!q) return { score: 0, ranges: [] };

  const substringAt = lower.indexOf(q);
  if (substringAt !== -1) {
    const atWordStart =
      substringAt === 0 || /[\s\-_/.]/.test(lower[substringAt - 1]);
    return {
      score:
        100 +
        (atWordStart ? 40 : 0) -
        Math.min(substringAt, 20) -
        Math.min(lower.length - q.length, 10) / 10,
      ranges: [[substringAt, substringAt + q.length]],
    };
  }

  const ranges: Array<[number, number]> = [];
  let score = 0;
  let textIndex = 0;
  for (let queryIndex = 0; queryIndex < q.length; queryIndex++) {
    const found = lower.indexOf(q[queryIndex], textIndex);
    if (found === -1) return null;
    const contiguous = ranges.length > 0 && found === textIndex;
    const wordStart = found === 0 || /[\s\-_/.]/.test(lower[found - 1]);
    score += 2 + (contiguous ? 4 : 0) + (wordStart ? 6 : 0);
    if (!contiguous) score -= Math.min(found - textIndex, 6) / 2;
    const last = ranges[ranges.length - 1];
    if (last && last[1] === found) last[1] = found + 1;
    else ranges.push([found, found + 1]);
    textIndex = found + 1;
  }
  return { score, ranges };
}

/** Render a label with its fuzzy-matched characters emphasized. */
function HighlightedLabel({
  text,
  ranges,
}: {
  text: string;
  ranges: Array<[number, number]>;
}) {
  if (ranges.length === 0) return <>{text}</>;
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  ranges.forEach(([start, end], index) => {
    if (start > cursor) parts.push(text.slice(cursor, start));
    parts.push(
      <span key={index} className='font-semibold text-ink'>
        {text.slice(start, end)}
      </span>
    );
    cursor = end;
  });
  if (cursor < text.length) parts.push(text.slice(cursor));
  return <>{parts}</>;
}

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
        keywords: 'new chat conversation start',
        run: () => startNewChat(navigate),
      },
      {
        id: 'action:incognito-chat',
        section: actionSection,
        label: t('chat.session.incognito', 'Incognito Chat'),
        icon: Ghost,
        keywords: 'incognito private temporary ghost',
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
              keywords: 'new work task workspace',
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
        keywords: 'models ollama providers llm',
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
        keywords: 'imagine images generation gallery pictures',
        run: () => navigate('/gallery'),
      },
      {
        id: 'action:calendar',
        section: actionSection,
        label: t('sidebar.navigation.calendar', 'Calendar'),
        icon: CalendarDays,
        keywords: 'calendar events schedule agenda',
        run: () => navigate('/calendar'),
      },
      {
        id: 'action:automations',
        section: actionSection,
        label: t('sidebar.navigation.automations', 'Automations'),
        icon: Zap,
        keywords: 'automations schedule cron recurring routines',
        run: () => navigate('/automations'),
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
        keywords: 'settings preferences configuration options',
        run: onOpenSettings,
      },
      {
        id: 'action:theme',
        section: actionSection,
        label: t('palette.toggleTheme', 'Toggle theme'),
        icon: Moon,
        hint: `${mod}D`,
        keywords: 'theme dark light mode appearance',
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

  const filtered = useMemo((): Array<{
    item: PaletteItem;
    ranges: Array<[number, number]>;
  }> => {
    const trimmed = query.trim();
    if (!trimmed) {
      // Without a query: actions plus the freshest few of each list.
      const actions = items.filter(item => item.id.startsWith('action:'));
      const chats = items
        .filter(item => item.id.startsWith('session:'))
        .slice(0, 6);
      const work = items
        .filter(item => item.id.startsWith('work:'))
        .slice(0, 4);
      return [...actions, ...chats, ...work].map(item => ({
        item,
        ranges: [],
      }));
    }

    // Score labels first; fall back to hidden keywords (no highlight then).
    const scored = items.flatMap(item => {
      const labelMatch = fuzzyMatch(trimmed, item.label);
      if (labelMatch) return [{ item, ...labelMatch }];
      const keywordMatch = item.keywords
        ? fuzzyMatch(trimmed, item.keywords)
        : null;
      if (keywordMatch)
        return [{ item, score: keywordMatch.score - 30, ranges: [] }];
      return [];
    });

    // Rank sections by their best hit, items inside a section by score, so
    // relevance decides ordering without section headers interleaving.
    const bestPerSection = new Map<string, number>();
    scored.forEach(({ item, score }) => {
      const best = bestPerSection.get(item.section);
      if (best === undefined || score > best)
        bestPerSection.set(item.section, score);
    });
    return scored
      .sort(
        (a, b) =>
          (bestPerSection.get(b.item.section) ?? 0) -
            (bestPerSection.get(a.item.section) ?? 0) ||
          a.item.section.localeCompare(b.item.section) ||
          b.score - a.score
      )
      .slice(0, MAX_RESULTS)
      .map(({ item, ranges }) => ({ item, ranges }));
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

  return createPortal(
    <div
      data-testid='command-palette'
      className='fixed inset-0 z-[120] flex items-center justify-center bg-black/25 px-4 backdrop-blur-[2px] dark:bg-black/45'
      onMouseDown={event => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div className='flex h-[min(34rem,76vh)] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-line bg-surface-overlay/95 shadow-overlay backdrop-blur-xl animate-scale-in motion-reduce:animate-none'>
        <div className='flex shrink-0 items-center gap-2.5 border-b border-line px-4'>
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
                runItem(filtered[selectedIndex]?.item);
              }
            }}
            placeholder={t(
              'palette.placeholder',
              'Search chats, Work, actions…'
            )}
            className='h-[3.25rem] w-full bg-transparent text-[15px] text-ink outline-none placeholder:text-ink-subtle'
          />
          <kbd className='shrink-0 rounded-md border border-line px-1.5 py-0.5 font-mono text-[10px] text-ink-subtle'>
            esc
          </kbd>
        </div>
        <div
          ref={listRef}
          className='min-h-0 flex-1 overflow-y-auto p-2 scrollbar-thin'
        >
          {filtered.length === 0 && (
            <p className='px-3 py-6 text-center text-sm text-ink-subtle'>
              {t('palette.empty', 'No matches.')}
            </p>
          )}
          {filtered.map(({ item, ranges }, index) => {
            const showSection =
              index === 0 || item.section !== filtered[index - 1].item.section;
            return (
              <React.Fragment key={item.id}>
                {showSection && (
                  <p className='px-2.5 pb-1 pt-2.5 text-[10px] font-medium uppercase tracking-[0.08em] text-ink-subtle first:pt-1'>
                    {item.section}
                  </p>
                )}
                <button
                  type='button'
                  data-selected={index === selectedIndex || undefined}
                  onMouseEnter={() => setSelectedIndex(index)}
                  onClick={() => runItem(item)}
                  className={cn(
                    'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-start text-sm transition-colors',
                    index === selectedIndex
                      ? 'bg-black/[0.05] text-ink dark:bg-white/[0.07]'
                      : 'text-ink-muted'
                  )}
                >
                  <item.icon className='h-4 w-4 shrink-0 text-ink-subtle' />
                  <span className='min-w-0 flex-1 truncate'>
                    <HighlightedLabel text={item.label} ranges={ranges} />
                  </span>
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
        <div className='flex shrink-0 items-center gap-3 border-t border-line px-4 py-2 text-[10px] text-ink-subtle'>
          <span className='inline-flex items-center gap-1'>
            <kbd className='rounded-md border border-line px-1.5 py-0.5 font-mono'>
              ↑↓
            </kbd>
          </span>
          <span className='inline-flex items-center gap-1'>
            <kbd className='rounded-md border border-line px-1.5 py-0.5 font-mono'>
              ↵
            </kbd>
          </span>
          <span className='ms-auto inline-flex items-center gap-1'>
            <kbd className='rounded-md border border-line px-1.5 py-0.5 font-mono'>
              esc
            </kbd>
          </span>
        </div>
      </div>
    </div>,
    document.body
  );
};
