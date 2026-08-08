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
import { useTranslation } from 'react-i18next';
import {
  Archive,
  Check,
  ChevronDown,
  ChevronRight,
  Edit3,
  ExternalLink,
  Folder,
  FolderPlus,
  MessageSquare,
  MoreHorizontal,
  Pin,
  PinOff,
  Trash2,
  X,
} from 'lucide-react';
import { Button, Input } from '@/components/ui';
import type { ChatSession, Persona, SessionFolder } from '@/types';
import { cn, formatTimestamp, truncateText } from '@/utils';

interface SidebarSessionsProps {
  sessions: ChatSession[];
  personas: Record<string, Persona>;
  currentSessionId?: string | null;
  generatingTitleForSession: string | null;
  sidebarCompact: boolean;
  editingSessionId: string | null;
  editingTitle: string;
  onEditingTitleChange: (title: string) => void;
  onSelectSession: (session: ChatSession) => void;
  onStartEditing: (session: ChatSession, event: React.MouseEvent) => void;
  onSaveEdit: (sessionId: string) => void;
  onCancelEdit: () => void;
  onDeleteSession: (sessionId: string, event: React.MouseEvent) => void;
  onArchiveSession?: (sessionId: string, event: React.MouseEvent) => void;
  onTogglePinSession?: (sessionId: string, pinned: boolean) => void;
  folders?: SessionFolder[];
  onCreateFolder?: (name: string) => void;
  onRenameFolder?: (folderId: string, name: string) => void;
  onDeleteFolder?: (folderId: string) => void;
  onMoveSession?: (sessionId: string, folderId: string | null) => void;
  onExpandSidebar: () => void;
}

type SessionGroupKey =
  'today' | 'yesterday' | 'previous7Days' | 'previous30Days' | 'older';

function groupKeyForTimestamp(timestamp: number): SessionGroupKey {
  const now = new Date();
  const startOfToday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate()
  ).getTime();
  const day = 24 * 60 * 60 * 1000;

  if (timestamp >= startOfToday) return 'today';
  if (timestamp >= startOfToday - day) return 'yesterday';
  if (timestamp >= startOfToday - 7 * day) return 'previous7Days';
  if (timestamp >= startOfToday - 30 * day) return 'previous30Days';
  return 'older';
}

const GROUP_ORDER: SessionGroupKey[] = [
  'today',
  'yesterday',
  'previous7Days',
  'previous30Days',
  'older',
];

function compactMonogram(title: string) {
  const words = title.trim().split(/\s+/u).filter(Boolean);
  if (words.length === 0) return '•';
  if (words.length === 1) {
    return Array.from(words[0]).slice(0, 2).join('').toLocaleUpperCase();
  }

  return `${Array.from(words[0])[0]}${Array.from(words[words.length - 1])[0]}`.toLocaleUpperCase();
}

interface HoverPreviewState {
  session: ChatSession;
  top: number;
  left: number;
}

function SessionHoverPreview({ preview }: { preview: HoverPreviewState }) {
  const { t, i18n } = useTranslation();
  const { session } = preview;
  const firstUser = session.messages.find(
    message => message.role === 'user' && message.content.trim()
  );
  const firstAssistant = session.messages.find(
    message => message.role === 'assistant' && message.content.trim()
  );

  return createPortal(
    <div
      role='tooltip'
      className='pointer-events-none fixed z-[70] hidden w-72 rounded-2xl border border-black/[0.07] bg-surface/95 p-3.5 shadow-[0_16px_48px_rgba(15,23,42,0.18)] backdrop-blur-xl animate-scale-in dark:border-white/[0.09] dark:bg-dark-100/95 md:block'
      style={{
        top: Math.max(8, Math.min(preview.top, window.innerHeight - 220)),
        left: preview.left,
      }}
    >
      <p className='mb-1 truncate text-[13px] font-semibold text-gray-900 dark:text-dark-900'>
        {session.title}
      </p>
      <p className='mb-2 text-[10px] tabular-nums text-gray-400 dark:text-dark-500'>
        {formatTimestamp(session.updatedAt, i18n.language)}
      </p>
      {firstUser && (
        <div className='mb-1.5 flex justify-end'>
          <p
            dir='auto'
            className='max-w-[85%] rounded-xl rounded-ee-sm bg-gray-900 px-2.5 py-1.5 text-[11px] leading-snug text-white dark:bg-dark-300'
          >
            {truncateText(firstUser.content, 110)}
          </p>
        </div>
      )}
      {firstAssistant && (
        <p
          dir='auto'
          className='text-[11px] leading-snug text-gray-600 dark:text-dark-700'
        >
          {truncateText(firstAssistant.content.replace(/\s+/g, ' '), 180)}
        </p>
      )}
      {!firstUser && !firstAssistant && (
        <p className='text-[11px] italic text-gray-400 dark:text-dark-500'>
          {t('chat.session.noChats')}
        </p>
      )}
    </div>,
    document.body
  );
}

export function SidebarSessions({
  sessions,
  personas,
  currentSessionId,
  generatingTitleForSession,
  sidebarCompact,
  editingSessionId,
  editingTitle,
  onEditingTitleChange,
  onSelectSession,
  onStartEditing,
  onSaveEdit,
  onCancelEdit,
  onDeleteSession,
  onArchiveSession,
  onTogglePinSession,
  folders = [],
  onCreateFolder,
  onRenameFolder,
  onDeleteFolder,
  onMoveSession,
  onExpandSidebar,
}: SidebarSessionsProps) {
  const { t, i18n } = useTranslation();
  const [hoverPreview, setHoverPreview] = useState<HoverPreviewState | null>(
    null
  );
  const [mobileActionSessionId, setMobileActionSessionId] = useState<
    string | null
  >(null);
  const hoverTimerRef = useRef<number | null>(null);
  const mobileActionSession = mobileActionSessionId
    ? (sessions.find(session => session.id === mobileActionSessionId) ?? null)
    : null;

  useEffect(
    () => () => {
      if (hoverTimerRef.current !== null) {
        window.clearTimeout(hoverTimerRef.current);
      }
    },
    []
  );

  const clearHoverPreview = () => {
    if (hoverTimerRef.current !== null) {
      window.clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
    setHoverPreview(null);
  };

  const scheduleHoverPreview = (session: ChatSession, element: HTMLElement) => {
    const canHover = window.matchMedia(
      '(hover: hover) and (pointer: fine)'
    ).matches;
    if (sidebarCompact || window.innerWidth < 768 || !canHover) return;
    if (hoverTimerRef.current !== null) {
      window.clearTimeout(hoverTimerRef.current);
    }
    hoverTimerRef.current = window.setTimeout(() => {
      const rect = element.getBoundingClientRect();
      setHoverPreview({
        session,
        top: rect.top,
        left: rect.right + 10,
      });
    }, 500);
  };

  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(
    () => new Set()
  );
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [folderNameDraft, setFolderNameDraft] = useState('');
  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null);
  // Desktop "…" context menu, rendered through a portal so the scroll
  // region cannot clip it. Anchored to the button that opened it.
  const [sessionMenu, setSessionMenu] = useState<{
    sessionId: string;
    top: number;
    left: number;
  } | null>(null);
  const sessionMenuSession = sessionMenu
    ? (sessions.find(session => session.id === sessionMenu.sessionId) ?? null)
    : null;

  useEffect(() => {
    if (!sessionMenu) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSessionMenu(null);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [sessionMenu]);

  const SESSION_MENU_WIDTH = 208;
  const SESSION_MENU_MAX_HEIGHT = 340;

  const openSessionMenu = (
    session: ChatSession,
    event: React.MouseEvent<HTMLElement>
  ) => {
    event.stopPropagation();
    clearHoverPreview();
    if (sessionMenu?.sessionId === session.id) {
      setSessionMenu(null);
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    setSessionMenu({
      sessionId: session.id,
      top: Math.max(
        8,
        Math.min(
          rect.bottom + 6,
          window.innerHeight - SESSION_MENU_MAX_HEIGHT - 8
        )
      ),
      left: Math.max(
        8,
        Math.min(
          rect.right - SESSION_MENU_WIDTH,
          window.innerWidth - SESSION_MENU_WIDTH - 8
        )
      ),
    });
  };

  const openSessionInNewTab = (session: ChatSession) => {
    // Electron serves the app from file:// with hash routing.
    const isElectron = window.location.protocol === 'file:';
    const url = isElectron
      ? `${window.location.pathname}#/c/${session.id}`
      : `/c/${session.id}`;
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  const toggleFolderCollapsed = (folderId: string) => {
    setCollapsedFolders(previous => {
      const next = new Set(previous);
      if (next.has(folderId)) next.delete(folderId);
      else next.add(folderId);
      return next;
    });
  };

  const submitNewFolder = () => {
    const name = folderNameDraft.trim();
    setCreatingFolder(false);
    setFolderNameDraft('');
    if (name && onCreateFolder) onCreateFolder(name);
  };

  const submitFolderRename = (folderId: string) => {
    const name = folderNameDraft.trim();
    setRenamingFolderId(null);
    setFolderNameDraft('');
    if (name && onRenameFolder) onRenameFolder(folderId, name);
  };

  const folderIds = new Set(folders.map(folder => folder.id));
  // Pinned chats live in their own group at the top and leave their folder
  // and date groups until unpinned.
  const pinnedSessions = sessions.filter(session => session.pinned);
  const unpinnedSessions = sessions.filter(session => !session.pinned);
  const looseSessions = unpinnedSessions.filter(
    session => !session.folderId || !folderIds.has(session.folderId)
  );

  interface SidebarSection {
    key: string;
    labelKey?: SessionGroupKey | 'pinned';
    folder?: SessionFolder;
    sessions: ChatSession[];
  }

  const sections: SidebarSection[] = [
    ...(pinnedSessions.length > 0
      ? [
          {
            key: 'pinned',
            labelKey: 'pinned' as const,
            sessions: pinnedSessions,
          },
        ]
      : []),
    ...folders.map(folder => ({
      key: `folder:${folder.id}`,
      folder,
      sessions: unpinnedSessions.filter(
        session => session.folderId === folder.id
      ),
    })),
    ...GROUP_ORDER.map(key => ({
      key: key as string,
      labelKey: key,
      sessions: looseSessions.filter(
        session => groupKeyForTimestamp(session.updatedAt) === key
      ),
    })).filter(group => group.sessions.length > 0),
  ];
  const recentSessions = [...sessions].sort(
    (first, second) => second.updatedAt - first.updatedAt
  );
  const compactSessions = recentSessions;

  return (
    <div
      data-testid='sidebar-session-scroll-region'
      className='scroll-region min-h-0 flex-1 scrollbar-thin border-t border-black/[0.05] dark:border-white/[0.05]'
      style={{ willChange: 'scroll-position' }}
    >
      <div className={cn('px-3 py-3', sidebarCompact && 'px-2')}>
        {!sidebarCompact && sessions.length > 0 && (
          <div className='flex items-center justify-between mb-2 px-1'>
            <h3 className='text-[10px] font-semibold text-gray-500 dark:text-dark-500 uppercase tracking-[0.16em] rtl:tracking-normal'>
              {t('chat.session.chats')}
            </h3>
            <div className='flex items-center gap-1'>
              {onCreateFolder && (
                <button
                  onClick={() => {
                    setCreatingFolder(true);
                    setFolderNameDraft('');
                  }}
                  className='rounded-md p-0.5 text-gray-400 transition-colors hover:bg-white/70 hover:text-gray-700 dark:text-dark-500 dark:hover:bg-dark-200 dark:hover:text-dark-800'
                  title={t('chat.session.folder.new')}
                >
                  <FolderPlus className='h-3.5 w-3.5' />
                </button>
              )}
              <span className='text-[10px] tabular-nums text-gray-400 dark:text-dark-500 font-medium'>
                {sessions.length}
              </span>
            </div>
          </div>
        )}
        {!sidebarCompact && creatingFolder && (
          <div className='mb-2 px-1'>
            <Input
              value={folderNameDraft}
              onChange={e => setFolderNameDraft(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') submitNewFolder();
                else if (e.key === 'Escape') {
                  setCreatingFolder(false);
                  setFolderNameDraft('');
                }
              }}
              onBlur={submitNewFolder}
              placeholder={t('chat.session.folder.namePlaceholder')}
              className='h-8 text-sm'
              autoFocus
            />
          </div>
        )}
        {sidebarCompact ? (
          <div className='flex flex-col items-center gap-1'>
            <button
              type='button'
              onClick={onExpandSidebar}
              data-testid='sidebar-mobile-chats'
              aria-label={`${t('chat.session.chats')} (${sessions.length})`}
              title={t('chat.session.chats')}
              className='relative flex h-12 w-12 items-center justify-center rounded-xl text-gray-500 outline-none transition-colors hover:bg-white/70 hover:text-gray-950 focus-visible:ring-2 focus-visible:ring-primary-500/30 dark:text-dark-600 dark:hover:bg-dark-200 dark:hover:text-dark-950 md:hidden'
            >
              <MessageSquare className='h-[18px] w-[18px]' />
              {sessions.length > 0 && (
                <span className='absolute -end-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-md bg-primary-500 px-1 text-[9px] font-semibold tabular-nums text-white shadow-sm'>
                  {sessions.length > 99 ? '99+' : sessions.length}
                </span>
              )}
            </button>

            <div
              data-testid='sidebar-compact-session-list'
              className='flex w-full flex-col items-center gap-1'
            >
              {compactSessions.map(session => {
                const isActive = currentSessionId === session.id;
                return (
                  <button
                    type='button'
                    key={session.id}
                    onClick={() => onSelectSession(session)}
                    data-testid='sidebar-compact-session'
                    aria-current={isActive ? 'page' : undefined}
                    aria-label={session.title}
                    title={session.title}
                    className={cn(
                      'relative flex h-12 w-12 items-center justify-center rounded-xl outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary-500/30',
                      isActive
                        ? 'bg-gray-950 text-white ring-1 ring-black/10 shadow-[0_8px_24px_-14px_rgba(0,0,0,0.7)] dark:bg-white dark:text-gray-950 dark:ring-white/20 dark:shadow-[0_8px_24px_-14px_rgba(255,255,255,0.45)]'
                        : 'text-gray-500 hover:bg-white/70 hover:text-gray-950 dark:text-dark-600 dark:hover:bg-dark-200 dark:hover:text-dark-950'
                    )}
                  >
                    {isActive && (
                      <span
                        aria-hidden='true'
                        className='absolute -start-2 h-5 w-0.5 rounded-full bg-gray-950 shadow-[0_0_10px_rgba(0,0,0,0.35)] dark:bg-white dark:shadow-[0_0_10px_rgba(255,255,255,0.35)]'
                      />
                    )}
                    <span className='font-mono text-[11px] font-semibold tracking-[-0.03em]'>
                      {compactMonogram(session.title)}
                    </span>
                    {generatingTitleForSession === session.id && (
                      <span className='absolute end-1.5 top-1.5 h-1.5 w-1.5 animate-pulse rounded-full bg-primary-500' />
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        ) : sessions.length === 0 ? (
          <div
            className={cn('text-center py-8', sidebarCompact ? 'px-1' : 'px-2')}
          >
            <div
              className={cn(
                'mx-auto mb-3 bg-white/70 dark:bg-dark-200 rounded-xl flex items-center justify-center ring-1 ring-black/[0.04] dark:ring-white/[0.05]',
                sidebarCompact ? 'w-8 h-8' : 'w-12 h-12'
              )}
            >
              <MessageSquare
                className={cn(
                  'text-gray-400 dark:text-gray-500',
                  sidebarCompact ? 'h-4 w-4' : 'h-5 w-5'
                )}
              />
            </div>
            {!sidebarCompact && (
              <>
                <p className='text-sm font-medium text-gray-600 dark:text-dark-600'>
                  {t('chat.session.noChats')}
                </p>
                <p className='text-xs mt-1 text-gray-400 dark:text-dark-500'>
                  {t('chat.session.createFirst')}
                </p>
              </>
            )}
          </div>
        ) : (
          <div className={cn('space-y-2', sidebarCompact && 'space-y-1')}>
            {sections.map(group => (
              <div key={group.key}>
                {!sidebarCompact && group.folder && (
                  <div className='group/folder mb-1 flex items-center justify-between px-1'>
                    {renamingFolderId === group.folder.id ? (
                      <Input
                        value={folderNameDraft}
                        onChange={e => setFolderNameDraft(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Enter')
                            submitFolderRename(group.folder!.id);
                          else if (e.key === 'Escape') {
                            setRenamingFolderId(null);
                            setFolderNameDraft('');
                          }
                        }}
                        onBlur={() => submitFolderRename(group.folder!.id)}
                        className='h-7 text-sm'
                        autoFocus
                      />
                    ) : (
                      <>
                        <button
                          onClick={() =>
                            toggleFolderCollapsed(group.folder!.id)
                          }
                          className='flex min-w-0 flex-1 items-center gap-1 text-[11px] font-semibold text-gray-500 transition-colors hover:text-gray-800 dark:text-dark-600 dark:hover:text-dark-800'
                          aria-expanded={!collapsedFolders.has(group.folder.id)}
                        >
                          {collapsedFolders.has(group.folder.id) ? (
                            <ChevronRight className='h-3 w-3 shrink-0 rtl:rotate-180' />
                          ) : (
                            <ChevronDown className='h-3 w-3 shrink-0' />
                          )}
                          <Folder className='h-3 w-3 shrink-0' />
                          <span className='truncate'>{group.folder.name}</span>
                          <span className='text-[10px] font-medium tabular-nums text-gray-400 dark:text-dark-500'>
                            {group.sessions.length}
                          </span>
                        </button>
                        <div className='flex items-center gap-0.5 opacity-0 transition-opacity group-hover/folder:opacity-100'>
                          {onRenameFolder && (
                            <button
                              onClick={() => {
                                setRenamingFolderId(group.folder!.id);
                                setFolderNameDraft(group.folder!.name);
                              }}
                              className='rounded-md p-0.5 text-gray-400 hover:text-gray-700 dark:text-dark-500 dark:hover:text-dark-800'
                              title={t('chat.session.renameChat')}
                            >
                              <Edit3 className='h-3 w-3' />
                            </button>
                          )}
                          {onDeleteFolder && (
                            <button
                              onClick={() => {
                                if (
                                  window.confirm(
                                    t('chat.session.folder.deleteConfirm')
                                  )
                                ) {
                                  onDeleteFolder(group.folder!.id);
                                }
                              }}
                              className='rounded-md p-0.5 text-gray-400 hover:text-red-500 dark:text-dark-500 dark:hover:text-red-400'
                              title={t('chat.session.folder.delete')}
                            >
                              <Trash2 className='h-3 w-3' />
                            </button>
                          )}
                        </div>
                      </>
                    )}
                  </div>
                )}
                {!sidebarCompact && !group.folder && (
                  <p className='mb-1 px-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-gray-400 dark:text-dark-500 rtl:tracking-normal'>
                    {t(`chat.session.groups.${group.labelKey}`)}
                  </p>
                )}
                {group.folder &&
                collapsedFolders.has(group.folder.id) ? null : (
                  <div
                    className={cn('space-y-0.5', sidebarCompact && 'space-y-1')}
                  >
                    {group.sessions.map(session => {
                      const isActive = currentSessionId === session.id;
                      const persona = session.personaId
                        ? personas[session.personaId]
                        : null;

                      return (
                        <div
                          key={session.id}
                          className={cn(
                            'group relative cursor-pointer transition-colors duration-150 touch-manipulation outline-none',
                            sidebarCompact
                              ? 'rounded-xl p-1 flex items-center justify-center'
                              : 'rounded-lg px-2.5 py-2',
                            isActive
                              ? 'bg-white ring-1 ring-black/[0.04] dark:bg-dark-200 dark:ring-white/[0.05]'
                              : 'hover:bg-white/60 dark:hover:bg-dark-200/60'
                          )}
                          onClick={() => {
                            clearHoverPreview();
                            onSelectSession(session);
                          }}
                          onMouseEnter={event =>
                            scheduleHoverPreview(session, event.currentTarget)
                          }
                          onMouseLeave={clearHoverPreview}
                          title={
                            sidebarCompact
                              ? `${session.title} - ${session.model}`
                              : undefined
                          }
                        >
                          {sidebarCompact ? (
                            <div className='flex items-center justify-center w-full h-10'>
                              <div
                                className={cn(
                                  'flex h-9 w-9 items-center justify-center rounded-xl text-[11px] font-semibold uppercase transition-colors',
                                  generatingTitleForSession === session.id
                                    ? 'bg-white text-primary-600 animate-pulse dark:bg-dark-200 dark:text-primary-400'
                                    : isActive
                                      ? 'bg-gray-950 text-white dark:bg-white dark:text-gray-950'
                                      : 'bg-white/70 text-gray-500 ring-1 ring-black/[0.04] dark:bg-dark-200/70 dark:text-dark-600 dark:ring-white/[0.05]'
                                )}
                              >
                                {session.title.trim().charAt(0) || '•'}
                              </div>
                            </div>
                          ) : editingSessionId === session.id ? (
                            <div
                              className='flex items-center gap-2'
                              onClick={e => e.stopPropagation()}
                            >
                              <Input
                                value={editingTitle}
                                onChange={e =>
                                  onEditingTitleChange(e.target.value)
                                }
                                onKeyDown={e => {
                                  if (e.key === 'Enter') {
                                    onSaveEdit(session.id);
                                  } else if (e.key === 'Escape') {
                                    onCancelEdit();
                                  }
                                }}
                                className='text-sm h-8'
                                autoFocus
                              />
                              <Button
                                variant='ghost'
                                size='sm'
                                onClick={() => onSaveEdit(session.id)}
                                className='h-8 w-8 p-0 shrink-0 hover:bg-gray-100 dark:hover:bg-dark-300 active:bg-gray-200 dark:active:bg-dark-400 touch-manipulation'
                              >
                                <Check className='h-3 w-3' />
                              </Button>
                              <Button
                                variant='ghost'
                                size='sm'
                                onClick={onCancelEdit}
                                className='h-8 w-8 p-0 shrink-0 hover:bg-gray-100 dark:hover:bg-dark-300 active:bg-gray-200 dark:active:bg-dark-400 touch-manipulation'
                              >
                                <X className='h-3 w-3' />
                              </Button>
                            </div>
                          ) : (
                            <div className='flex items-center justify-between w-full'>
                              <div className='flex-1 min-w-0 me-2'>
                                <h3 className='text-[13px] font-medium truncate leading-tight text-gray-900 dark:text-dark-900'>
                                  {generatingTitleForSession === session.id ? (
                                    <span className='inline-flex items-center gap-1'>
                                      <span className='animate-pulse'>
                                        {t('chat.session.generatingTitle')}
                                      </span>
                                      <span className='inline-flex'>
                                        <span
                                          className='animate-bounce'
                                          style={{ animationDelay: '0ms' }}
                                        >
                                          .
                                        </span>
                                        <span
                                          className='animate-bounce'
                                          style={{ animationDelay: '150ms' }}
                                        >
                                          .
                                        </span>
                                        <span
                                          className='animate-bounce'
                                          style={{ animationDelay: '300ms' }}
                                        >
                                          .
                                        </span>
                                      </span>
                                    </span>
                                  ) : (
                                    truncateText(session.title, 32)
                                  )}
                                </h3>
                                <div className='flex items-center gap-1.5 mt-0.5'>
                                  <span
                                    dir='auto'
                                    className={cn(
                                      'text-[11px] tabular-nums',
                                      isActive
                                        ? 'text-gray-500 dark:text-dark-600'
                                        : 'text-gray-400 dark:text-dark-500'
                                    )}
                                  >
                                    {formatTimestamp(
                                      session.updatedAt,
                                      i18n.language
                                    )}
                                  </span>
                                  <span className='text-gray-300 dark:text-dark-400'>
                                    •
                                  </span>
                                  {session.personaId ? (
                                    persona ? (
                                      <span
                                        className={cn(
                                          'flex items-center gap-1 text-[11px] font-medium',
                                          isActive
                                            ? 'text-primary-600 dark:text-primary-400'
                                            : 'text-primary-500 dark:text-primary-500'
                                        )}
                                        title={
                                          persona.description || persona.name
                                        }
                                      >
                                        {persona.avatar &&
                                          !persona.avatar.startsWith(
                                            'data:'
                                          ) && (
                                            <span className='text-[10px]'>
                                              {persona.avatar}
                                            </span>
                                          )}
                                        <span className='truncate max-w-[100px]'>
                                          {persona.name}
                                        </span>
                                      </span>
                                    ) : (
                                      <span
                                        className={cn(
                                          'text-[11px] font-medium italic',
                                          isActive
                                            ? 'text-gray-500 dark:text-gray-500'
                                            : 'text-gray-400 dark:text-gray-600'
                                        )}
                                      >
                                        Persona
                                      </span>
                                    )
                                  ) : (
                                    <span
                                      dir='ltr'
                                      className={cn(
                                        'font-mono text-[10px] truncate max-w-[108px]',
                                        isActive
                                          ? 'text-gray-700 dark:text-gray-300'
                                          : 'text-gray-600 dark:text-gray-400'
                                      )}
                                      title={session.model}
                                    >
                                      {session.model}
                                    </span>
                                  )}
                                </div>
                              </div>

                              <Button
                                variant='ghost'
                                size='sm'
                                onClick={event => {
                                  event.stopPropagation();
                                  clearHoverPreview();
                                  setMobileActionSessionId(session.id);
                                }}
                                className='h-8 w-8 shrink-0 rounded-lg p-0 touch-manipulation sm:hidden'
                                title={t('palette.actions')}
                                aria-label={t('palette.actions')}
                                data-testid='sidebar-session-actions-mobile'
                              >
                                <MoreHorizontal className='h-4 w-4' />
                              </Button>

                              <div className='hidden shrink-0 sm:block'>
                                <Button
                                  variant='ghost'
                                  size='sm'
                                  onClick={event =>
                                    openSessionMenu(session, event)
                                  }
                                  className={cn(
                                    'h-7 w-7 rounded-lg p-0 opacity-0 transition-opacity duration-150 hover:bg-gray-100 group-hover:opacity-100 group-focus-within:opacity-100 dark:hover:bg-dark-300 touch-manipulation',
                                    sessionMenu?.sessionId === session.id &&
                                      'bg-gray-100 opacity-100 dark:bg-dark-300'
                                  )}
                                  title={t('palette.actions')}
                                  aria-label={t('palette.actions')}
                                  aria-haspopup='menu'
                                  aria-expanded={
                                    sessionMenu?.sessionId === session.id
                                  }
                                  data-testid='sidebar-session-actions'
                                >
                                  <MoreHorizontal className='h-4 w-4' />
                                </Button>
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
      {hoverPreview && <SessionHoverPreview preview={hoverPreview} />}
      {sessionMenu &&
        sessionMenuSession &&
        createPortal(
          <div className='fixed inset-0 z-[75] hidden sm:block'>
            <button
              type='button'
              tabIndex={-1}
              aria-label={t('common.close')}
              className='absolute inset-0 cursor-default'
              onClick={() => setSessionMenu(null)}
            />
            <div
              role='menu'
              aria-label={sessionMenuSession.title}
              data-testid='sidebar-session-menu'
              className='absolute overflow-y-auto rounded-2xl border border-black/[0.08] bg-surface/95 p-1.5 shadow-[0_16px_48px_rgba(15,23,42,0.2)] backdrop-blur-xl animate-scale-in dark:border-white/[0.09] dark:bg-dark-100/95'
              style={{
                top: sessionMenu.top,
                left: sessionMenu.left,
                width: SESSION_MENU_WIDTH,
                maxHeight: SESSION_MENU_MAX_HEIGHT,
              }}
            >
              <button
                type='button'
                role='menuitem'
                onClick={() => {
                  setSessionMenu(null);
                  openSessionInNewTab(sessionMenuSession);
                }}
                className='flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-start text-[13px] text-gray-700 hover:bg-gray-100 dark:text-dark-800 dark:hover:bg-dark-200'
              >
                <ExternalLink className='h-3.5 w-3.5 shrink-0' />
                {t('chat.session.openNewTab')}
              </button>
              <button
                type='button'
                role='menuitem'
                onClick={event => {
                  setSessionMenu(null);
                  onStartEditing(sessionMenuSession, event);
                }}
                className='flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-start text-[13px] text-gray-700 hover:bg-gray-100 dark:text-dark-800 dark:hover:bg-dark-200'
              >
                <Edit3 className='h-3.5 w-3.5 shrink-0' />
                {t('chat.session.renameChat')}
              </button>
              {onTogglePinSession && (
                <button
                  type='button'
                  role='menuitem'
                  onClick={() => {
                    setSessionMenu(null);
                    onTogglePinSession(
                      sessionMenuSession.id,
                      !sessionMenuSession.pinned
                    );
                  }}
                  className='flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-start text-[13px] text-gray-700 hover:bg-gray-100 dark:text-dark-800 dark:hover:bg-dark-200'
                >
                  {sessionMenuSession.pinned ? (
                    <PinOff className='h-3.5 w-3.5 shrink-0' />
                  ) : (
                    <Pin className='h-3.5 w-3.5 shrink-0' />
                  )}
                  {sessionMenuSession.pinned
                    ? t('chat.session.unpinChat')
                    : t('chat.session.pinChat')}
                </button>
              )}
              {onArchiveSession && (
                <button
                  type='button'
                  role='menuitem'
                  onClick={event => {
                    setSessionMenu(null);
                    onArchiveSession(sessionMenuSession.id, event);
                  }}
                  className='flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-start text-[13px] text-gray-700 hover:bg-gray-100 dark:text-dark-800 dark:hover:bg-dark-200'
                >
                  <Archive className='h-3.5 w-3.5 shrink-0' />
                  {t('chat.session.archiveChat')}
                </button>
              )}
              {onMoveSession && folders.length > 0 && (
                <div className='mt-1 border-t border-black/[0.06] pt-1 dark:border-white/[0.07]'>
                  <p className='px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-gray-400 dark:text-dark-500 rtl:tracking-normal'>
                    {t('chat.session.folder.move')}
                  </p>
                  {folders.map(folder => (
                    <button
                      key={folder.id}
                      type='button'
                      role='menuitem'
                      onClick={() => {
                        setSessionMenu(null);
                        onMoveSession(sessionMenuSession.id, folder.id);
                      }}
                      className={cn(
                        'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-start text-[13px] text-gray-700 hover:bg-gray-100 dark:text-dark-800 dark:hover:bg-dark-200',
                        sessionMenuSession.folderId === folder.id &&
                          'text-primary-600 dark:text-primary-400'
                      )}
                    >
                      <Folder className='h-3.5 w-3.5 shrink-0' />
                      <span className='truncate'>{folder.name}</span>
                    </button>
                  ))}
                  {sessionMenuSession.folderId && (
                    <button
                      type='button'
                      role='menuitem'
                      onClick={() => {
                        setSessionMenu(null);
                        onMoveSession(sessionMenuSession.id, null);
                      }}
                      className='flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-start text-[13px] text-gray-500 hover:bg-gray-100 dark:text-dark-600 dark:hover:bg-dark-200'
                    >
                      <X className='h-3.5 w-3.5 shrink-0' />
                      {t('chat.session.folder.remove')}
                    </button>
                  )}
                </div>
              )}
              <button
                type='button'
                role='menuitem'
                onClick={event => {
                  setSessionMenu(null);
                  onDeleteSession(sessionMenuSession.id, event);
                }}
                className='mt-1 flex w-full items-center gap-2.5 rounded-lg border-t border-black/[0.06] px-2.5 py-2 text-start text-[13px] text-red-500 hover:bg-red-50 dark:border-white/[0.07] dark:hover:bg-red-900/20'
              >
                <Trash2 className='h-3.5 w-3.5 shrink-0' />
                {t('chat.session.deleteChat')}
              </button>
            </div>
          </div>,
          document.body
        )}
      {mobileActionSession &&
        createPortal(
          <div className='fixed inset-0 z-[80] sm:hidden'>
            <button
              type='button'
              className='absolute inset-0 bg-black/35 backdrop-blur-[2px]'
              onClick={() => setMobileActionSessionId(null)}
              aria-label={t('common.close')}
            />
            <div
              role='dialog'
              aria-modal='true'
              aria-label={t('palette.actions')}
              className='absolute inset-x-3 bottom-3 rounded-2xl border border-black/[0.08] bg-surface p-2 shadow-[0_20px_70px_rgba(0,0,0,0.3)] dark:border-white/[0.09] dark:bg-dark-100'
              data-testid='sidebar-session-actions-sheet'
            >
              <div className='flex items-center justify-between gap-3 px-2 pb-2 pt-1'>
                <p className='min-w-0 truncate text-sm font-semibold text-gray-900 dark:text-dark-900'>
                  {mobileActionSession.title}
                </p>
                <Button
                  variant='ghost'
                  size='sm'
                  onClick={() => setMobileActionSessionId(null)}
                  className='h-9 w-9 shrink-0 rounded-xl p-0'
                  title={t('common.close')}
                  aria-label={t('common.close')}
                >
                  <X className='h-4 w-4' />
                </Button>
              </div>

              <button
                type='button'
                onClick={event => {
                  setMobileActionSessionId(null);
                  onStartEditing(mobileActionSession, event);
                }}
                className='flex min-h-11 w-full items-center gap-3 rounded-xl px-3 py-2 text-start text-sm text-gray-700 hover:bg-gray-100 dark:text-dark-800 dark:hover:bg-dark-200'
              >
                <Edit3 className='h-4 w-4 shrink-0' />
                {t('chat.session.renameChat')}
              </button>

              {onTogglePinSession && (
                <button
                  type='button'
                  onClick={() => {
                    setMobileActionSessionId(null);
                    onTogglePinSession(
                      mobileActionSession.id,
                      !mobileActionSession.pinned
                    );
                  }}
                  className='flex min-h-11 w-full items-center gap-3 rounded-xl px-3 py-2 text-start text-sm text-gray-700 hover:bg-gray-100 dark:text-dark-800 dark:hover:bg-dark-200'
                >
                  {mobileActionSession.pinned ? (
                    <PinOff className='h-4 w-4 shrink-0' />
                  ) : (
                    <Pin className='h-4 w-4 shrink-0' />
                  )}
                  {mobileActionSession.pinned
                    ? t('chat.session.unpinChat')
                    : t('chat.session.pinChat')}
                </button>
              )}

              {onArchiveSession && (
                <button
                  type='button'
                  onClick={event => {
                    setMobileActionSessionId(null);
                    void onArchiveSession(mobileActionSession.id, event);
                  }}
                  className='flex min-h-11 w-full items-center gap-3 rounded-xl px-3 py-2 text-start text-sm text-gray-700 hover:bg-gray-100 dark:text-dark-800 dark:hover:bg-dark-200'
                >
                  <Archive className='h-4 w-4 shrink-0' />
                  {t('chat.session.archiveChat')}
                </button>
              )}

              {onMoveSession && folders.length > 0 && (
                <div className='mt-1 border-t border-black/[0.06] pt-1 dark:border-white/[0.07]'>
                  <p className='px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-gray-400 dark:text-dark-500'>
                    {t('chat.session.folder.move')}
                  </p>
                  {folders.map(folder => (
                    <button
                      key={folder.id}
                      type='button'
                      onClick={() => {
                        setMobileActionSessionId(null);
                        onMoveSession(mobileActionSession.id, folder.id);
                      }}
                      className={cn(
                        'flex min-h-11 w-full items-center gap-3 rounded-xl px-3 py-2 text-start text-sm text-gray-700 hover:bg-gray-100 dark:text-dark-800 dark:hover:bg-dark-200',
                        mobileActionSession.folderId === folder.id &&
                          'text-primary-600 dark:text-primary-400'
                      )}
                    >
                      <Folder className='h-4 w-4 shrink-0' />
                      <span className='truncate'>{folder.name}</span>
                    </button>
                  ))}
                  {mobileActionSession.folderId && (
                    <button
                      type='button'
                      onClick={() => {
                        setMobileActionSessionId(null);
                        onMoveSession(mobileActionSession.id, null);
                      }}
                      className='flex min-h-11 w-full items-center gap-3 rounded-xl px-3 py-2 text-start text-sm text-gray-500 hover:bg-gray-100 dark:text-dark-600 dark:hover:bg-dark-200'
                    >
                      <X className='h-4 w-4 shrink-0' />
                      {t('chat.session.folder.remove')}
                    </button>
                  )}
                </div>
              )}

              <button
                type='button'
                onClick={event => {
                  setMobileActionSessionId(null);
                  void onDeleteSession(mobileActionSession.id, event);
                }}
                className='mt-1 flex min-h-11 w-full items-center gap-3 rounded-xl border-t border-black/[0.06] px-3 py-2 text-start text-sm text-red-500 hover:bg-red-50 dark:border-white/[0.07] dark:hover:bg-red-900/20'
              >
                <Trash2 className='h-4 w-4 shrink-0' />
                {t('chat.session.deleteChat')}
              </button>
            </div>
          </div>,
          document.body
        )}
    </div>
  );
}
