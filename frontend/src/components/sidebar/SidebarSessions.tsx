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

import type React from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Edit3, MessageSquare, Trash2, X } from 'lucide-react';
import { Button, Input } from '@/components/ui';
import type { ChatSession, Persona } from '@/types';
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
}: SidebarSessionsProps) {
  const { t, i18n } = useTranslation();

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
            <span className='text-[10px] tabular-nums text-gray-400 dark:text-dark-500 font-medium'>
              {sessions.length}
            </span>
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
          <div className={cn('space-y-0.5', sidebarCompact && 'space-y-1')}>
            {sessions.map(session => {
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
                        onChange={e => onEditingTitleChange(e.target.value)}
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
                            {formatTimestamp(session.updatedAt, i18n.language)}
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
                                title={persona.description || persona.name}
                              >
                                {persona.avatar &&
                                  !persona.avatar.startsWith('data:') && (
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
    </div>
  );
}
