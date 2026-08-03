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
  Folder,
  FolderInput,
  FolderPlus,
  MessageSquare,
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
  folders?: SessionFolder[];
  onCreateFolder?: (name: string) => void;
  onRenameFolder?: (folderId: string, name: string) => void;
  onDeleteFolder?: (folderId: string) => void;
  onMoveSession?: (sessionId: string, folderId: string | null) => void;
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
      className='pointer-events-none fixed z-[70] w-72 rounded-2xl border border-black/[0.07] bg-surface/95 p-3.5 shadow-[0_16px_48px_rgba(15,23,42,0.18)] backdrop-blur-xl animate-scale-in dark:border-white/[0.09] dark:bg-dark-100/95'
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
  folders = [],
  onCreateFolder,
  onRenameFolder,
  onDeleteFolder,
  onMoveSession,
}: SidebarSessionsProps) {
  const { t, i18n } = useTranslation();
  const [hoverPreview, setHoverPreview] = useState<HoverPreviewState | null>(
    null
  );
  const hoverTimerRef = useRef<number | null>(null);

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
    if (sidebarCompact) return;
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
  const [folderMenuSessionId, setFolderMenuSessionId] = useState<string | null>(
    null
  );

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
  const looseSessions = sessions.filter(
    session => !session.folderId || !folderIds.has(session.folderId)
  );

  interface SidebarSection {
    key: string;
    labelKey?: SessionGroupKey;
    folder?: SessionFolder;
    sessions: ChatSession[];
  }

  const sections: SidebarSection[] = [
    ...folders.map(folder => ({
      key: `folder:${folder.id}`,
      folder,
      sessions: sessions.filter(session => session.folderId === folder.id),
    })),
    ...GROUP_ORDER.map(key => ({
      key: key as string,
      labelKey: key,
      sessions: looseSessions.filter(
        session => groupKeyForTimestamp(session.updatedAt) === key
      ),
    })).filter(group => group.sessions.length > 0),
  ];

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
        {sessions.length === 0 ? (
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
                          onClick={() => onSelectSession(session)}
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

                              <div className='flex items-center gap-0.5 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100 transition-opacity duration-150 shrink-0'>
                                <Button
                                  variant='ghost'
                                  size='sm'
                                  onClick={e => onStartEditing(session, e)}
                                  className='h-7 w-7 sm:h-7 sm:w-7 p-0 hover:bg-gray-100 dark:hover:bg-dark-300 rounded-lg touch-manipulation'
                                  title={t('chat.session.renameChat')}
                                >
                                  <Edit3 className='h-3 w-3' />
                                </Button>
                                {onMoveSession && folders.length > 0 && (
                                  <div className='relative'>
                                    <Button
                                      variant='ghost'
                                      size='sm'
                                      onClick={e => {
                                        e.stopPropagation();
                                        clearHoverPreview();
                                        setFolderMenuSessionId(current =>
                                          current === session.id
                                            ? null
                                            : session.id
                                        );
                                      }}
                                      className='h-7 w-7 sm:h-7 sm:w-7 p-0 hover:bg-gray-100 dark:hover:bg-dark-300 rounded-lg touch-manipulation'
                                      title={t('chat.session.folder.move')}
                                    >
                                      <FolderInput className='h-3 w-3' />
                                    </Button>
                                    {folderMenuSessionId === session.id && (
                                      <div
                                        className='absolute end-0 top-full z-40 mt-1 w-44 rounded-xl border border-black/[0.08] bg-surface/95 p-1 shadow-[0_12px_36px_rgba(15,23,42,0.16)] backdrop-blur-xl dark:border-white/[0.09] dark:bg-dark-100/95'
                                        onClick={e => e.stopPropagation()}
                                      >
                                        {folders.map(folder => (
                                          <button
                                            key={folder.id}
                                            onClick={() => {
                                              setFolderMenuSessionId(null);
                                              onMoveSession(
                                                session.id,
                                                folder.id
                                              );
                                            }}
                                            className={cn(
                                              'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-start text-[12px] text-gray-700 hover:bg-gray-100 dark:text-dark-800 dark:hover:bg-dark-200',
                                              session.folderId === folder.id &&
                                                'text-primary-600 dark:text-primary-400'
                                            )}
                                          >
                                            <Folder className='h-3 w-3 shrink-0' />
                                            <span className='truncate'>
                                              {folder.name}
                                            </span>
                                          </button>
                                        ))}
                                        {session.folderId && (
                                          <button
                                            onClick={() => {
                                              setFolderMenuSessionId(null);
                                              onMoveSession(session.id, null);
                                            }}
                                            className='flex w-full items-center gap-2 rounded-lg border-t border-gray-100 px-2 py-1.5 text-start text-[12px] text-gray-500 hover:bg-gray-100 dark:border-dark-300 dark:text-dark-600 dark:hover:bg-dark-200'
                                          >
                                            <X className='h-3 w-3 shrink-0' />
                                            {t('chat.session.folder.remove')}
                                          </button>
                                        )}
                                      </div>
                                    )}
                                  </div>
                                )}
                                {onArchiveSession && (
                                  <Button
                                    variant='ghost'
                                    size='sm'
                                    onClick={e => {
                                      clearHoverPreview();
                                      onArchiveSession(session.id, e);
                                    }}
                                    className='h-7 w-7 sm:h-7 sm:w-7 p-0 hover:bg-gray-100 dark:hover:bg-dark-300 rounded-lg touch-manipulation'
                                    title={t('chat.session.archiveChat')}
                                  >
                                    <Archive className='h-3 w-3' />
                                  </Button>
                                )}
                                <Button
                                  variant='ghost'
                                  size='sm'
                                  onClick={e => onDeleteSession(session.id, e)}
                                  className='h-7 w-7 sm:h-7 sm:w-7 p-0 text-red-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg touch-manipulation'
                                  title={t('chat.session.deleteChat')}
                                >
                                  <Trash2 className='h-3 w-3' />
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
    </div>
  );
}
