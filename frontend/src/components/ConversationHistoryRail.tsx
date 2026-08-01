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

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/utils';

export interface ConversationHistoryItem {
  id: string;
  prompt: string;
  response?: string;
}

interface ConversationHistoryRailProps {
  items: ConversationHistoryItem[];
  activeId: string | null;
  onSelect: (id: string) => void;
}

const prefersReducedMotion = () =>
  typeof window !== 'undefined' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const PREVIEW_TEXT_LIMIT = 220;

const previewText = (value: string) => {
  const normalized = value
    .slice(0, PREVIEW_TEXT_LIMIT * 4)
    .replace(/```(?:\w+)?\s*([\s\S]*?)```/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[#>*_~`|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return normalized.length > PREVIEW_TEXT_LIMIT
    ? `${normalized.slice(0, PREVIEW_TEXT_LIMIT - 1).trimEnd()}…`
    : normalized;
};

/**
 * A compact, keyboard-accessible map of the user turns in a conversation.
 * The rail is intentionally desktop-only so it never competes with the chat
 * surface on smaller screens.
 */
export const ConversationHistoryRail = React.memo(
  function ConversationHistoryRail({
    items,
    activeId,
    onSelect,
  }: ConversationHistoryRailProps) {
    const { t } = useTranslation();
    const navRef = useRef<HTMLElement>(null);
    const listRef = useRef<HTMLOListElement>(null);
    const buttonRefs = useRef(new Map<string, HTMLButtonElement>());
    const [previewId, setPreviewId] = useState<string | null>(null);
    const [previewTop, setPreviewTop] = useState(0);

    const showPreview = useCallback((id: string, element: HTMLElement) => {
      const nav = navRef.current;
      if (!nav) return;

      const navRect = nav.getBoundingClientRect();
      const markerRect = element.getBoundingClientRect();
      setPreviewTop(markerRect.top - navRect.top + markerRect.height / 2);
      setPreviewId(id);
    }, []);

    const selectAndFocus = useCallback(
      (index: number) => {
        const item = items[index];
        const marker = item ? buttonRefs.current.get(item.id) : undefined;
        if (!item || !marker) return;

        marker.focus();
        showPreview(item.id, marker);
        onSelect(item.id);
      },
      [items, onSelect, showPreview]
    );

    useEffect(() => {
      if (!activeId) return;

      const list = listRef.current;
      const marker = buttonRefs.current.get(activeId);
      if (!list || !marker) return;

      const listRect = list.getBoundingClientRect();
      const markerRect = marker.getBoundingClientRect();
      let nextTop: number | null = null;

      if (markerRect.top < listRect.top) {
        nextTop = list.scrollTop - (listRect.top - markerRect.top) - 8;
      } else if (markerRect.bottom > listRect.bottom) {
        nextTop = list.scrollTop + (markerRect.bottom - listRect.bottom) + 8;
      }

      if (nextTop !== null) {
        list.scrollTo({
          top: nextTop,
          behavior: prefersReducedMotion() ? 'auto' : 'smooth',
        });
      }
    }, [activeId]);

    if (items.length < 3) return null;

    const activeIndex = Math.max(
      0,
      items.findIndex(item => item.id === activeId)
    );
    const resolvedActiveId = items[activeIndex]?.id;
    const previewIndex = items.findIndex(item => item.id === previewId);
    const previewItem = previewIndex >= 0 ? items[previewIndex] : null;
    const previewIdValue =
      previewIndex >= 0
        ? `conversation-history-preview-${previewIndex}`
        : undefined;

    return (
      <nav
        ref={navRef}
        data-testid='conversation-history-rail'
        aria-label={t('chatHistory.label')}
        className='pointer-events-none absolute top-1/2 z-20 hidden h-[min(58vh,30rem)] w-7 -translate-y-1/2 lg:block xl:w-9'
        style={{ insetInlineStart: 'max(0.25rem, calc(50% - 27rem))' }}
        onPointerLeave={() => {
          if (!navRef.current?.contains(document.activeElement)) {
            setPreviewId(null);
          }
        }}
      >
        <ol
          ref={listRef}
          className='pointer-events-auto flex h-full min-h-0 flex-col overflow-y-auto py-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden [&>li:first-child]:mt-auto [&>li:last-child]:mb-auto'
        >
          {items.map((item, index) => {
            const isActive = item.id === resolvedActiveId;
            const distance = Math.abs(index - activeIndex);
            const tooltipId =
              previewId === item.id ? previewIdValue : undefined;

            return (
              <li key={item.id} className='flex h-4 flex-none items-center'>
                <button
                  ref={element => {
                    if (element) buttonRefs.current.set(item.id, element);
                    else buttonRefs.current.delete(item.id);
                  }}
                  type='button'
                  data-testid='conversation-history-marker'
                  aria-current={isActive ? 'location' : undefined}
                  aria-describedby={tooltipId}
                  aria-label={t('chatHistory.jumpToTurn', {
                    index: index + 1,
                    total: items.length,
                  })}
                  tabIndex={index === activeIndex ? 0 : -1}
                  className={cn(
                    'group flex h-4 w-7 items-center outline-none xl:w-9',
                    'focus-visible:ring-2 focus-visible:ring-primary-500/45 focus-visible:ring-offset-2 focus-visible:ring-offset-canvas',
                    'rounded-sm'
                  )}
                  onClick={() => onSelect(item.id)}
                  onPointerEnter={event =>
                    showPreview(item.id, event.currentTarget)
                  }
                  onFocus={event => showPreview(item.id, event.currentTarget)}
                  onBlur={() => {
                    window.requestAnimationFrame(() => {
                      if (!navRef.current?.contains(document.activeElement)) {
                        setPreviewId(null);
                      }
                    });
                  }}
                  onKeyDown={event => {
                    if (event.key === 'Escape') {
                      setPreviewId(null);
                      return;
                    }

                    let nextIndex: number | null = null;
                    if (event.key === 'ArrowDown') {
                      nextIndex = Math.min(items.length - 1, index + 1);
                    } else if (event.key === 'ArrowUp') {
                      nextIndex = Math.max(0, index - 1);
                    } else if (event.key === 'Home') {
                      nextIndex = 0;
                    } else if (event.key === 'End') {
                      nextIndex = items.length - 1;
                    }

                    if (nextIndex !== null) {
                      event.preventDefault();
                      selectAndFocus(nextIndex);
                    }
                  }}
                >
                  <span
                    aria-hidden='true'
                    className={cn(
                      'block h-0.5 rounded-full transition-[width,background-color,opacity] duration-150 motion-reduce:transition-none',
                      isActive
                        ? 'w-6 bg-ink xl:w-7'
                        : distance === 1
                          ? 'w-3.5 bg-ink-subtle opacity-80 group-hover:w-5 group-hover:bg-ink-muted group-hover:opacity-100 group-focus-visible:w-5'
                          : 'w-2.5 bg-line-strong opacity-70 group-hover:w-5 group-hover:bg-ink-muted group-hover:opacity-100 group-focus-visible:w-5'
                    )}
                  />
                </button>
              </li>
            );
          })}
        </ol>

        {previewItem && (
          <div
            id={previewIdValue}
            role='tooltip'
            className={cn(
              'pointer-events-none absolute start-full ms-2 w-72 -translate-y-1/2',
              'overflow-hidden rounded-xl border border-line bg-surface-overlay/95 shadow-overlay backdrop-blur-xl',
              'animate-fade-in motion-reduce:animate-none'
            )}
            style={{
              top: `clamp(3.5rem, ${previewTop}px, calc(100% - 3.5rem))`,
            }}
          >
            <div className='px-3.5 py-3'>
              <p
                dir='auto'
                className='truncate text-[13px] font-semibold leading-5 text-ink'
              >
                {previewText(previewItem.prompt)}
              </p>
              {previewItem.response && (
                <p
                  dir='auto'
                  className='mt-1 line-clamp-3 text-xs leading-5 text-ink-muted'
                >
                  {previewText(previewItem.response)}
                </p>
              )}
            </div>
          </div>
        )}
      </nav>
    );
  }
);
