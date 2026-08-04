/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { Briefcase, Loader2, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { WorkTaskSummary } from '@/types/work';
import { cn, formatTimestamp, truncateText } from '@/utils';
import { workStatusPresentation } from '@/utils/workStatus';

interface SidebarWorkTasksProps {
  tasks: WorkTaskSummary[];
  currentTaskId: string | null;
  loading: boolean;
  actionLoading: boolean;
  sidebarCompact: boolean;
  onSelectTask: (taskId: string) => void;
  onDeleteTask: (task: WorkTaskSummary) => void;
  onExpandSidebar: () => void;
}

function compactMonogram(title: string) {
  const words = title.trim().split(/\s+/u).filter(Boolean);
  if (words.length === 0) return '•';
  if (words.length === 1) {
    return Array.from(words[0]).slice(0, 2).join('').toLocaleUpperCase();
  }

  return `${Array.from(words[0])[0]}${Array.from(words[words.length - 1])[0]}`.toLocaleUpperCase();
}

export function SidebarWorkTasks({
  tasks,
  currentTaskId,
  loading,
  actionLoading,
  sidebarCompact,
  onSelectTask,
  onDeleteTask,
  onExpandSidebar,
}: SidebarWorkTasksProps) {
  const { t, i18n } = useTranslation();
  const sortedTasks = [...tasks].sort(
    (first, second) => second.updatedAt - first.updatedAt
  );
  const compactTasks = sortedTasks;

  return (
    <div
      data-testid='sidebar-work-task-scroll-region'
      className='scroll-region min-h-0 flex-1 border-t border-black/[0.05] scrollbar-thin dark:border-white/[0.05]'
      style={{ willChange: 'scroll-position' }}
    >
      <div className={cn('px-3 py-3', sidebarCompact && 'px-2')}>
        {!sidebarCompact && tasks.length > 0 && (
          <div className='mb-2 flex items-center justify-between px-1'>
            <h3 className='text-[10px] font-semibold uppercase tracking-[0.16em] text-gray-500 dark:text-dark-500 rtl:tracking-normal'>
              {t('work.tasks.title', { defaultValue: 'Work tasks' })}
            </h3>
            <span className='text-[10px] font-medium tabular-nums text-gray-400 dark:text-dark-500'>
              {tasks.length}
            </span>
          </div>
        )}

        {sidebarCompact ? (
          <div className='flex flex-col items-center gap-1'>
            <button
              type='button'
              onClick={onExpandSidebar}
              data-testid='sidebar-mobile-work-tasks'
              aria-label={`${t('work.tasks.title', { defaultValue: 'Work tasks' })} (${tasks.length})`}
              title={t('work.tasks.title', { defaultValue: 'Work tasks' })}
              className='relative flex h-12 w-12 items-center justify-center rounded-xl text-gray-500 outline-none transition-colors hover:bg-white/70 hover:text-gray-950 focus-visible:ring-2 focus-visible:ring-primary-500/30 dark:text-dark-600 dark:hover:bg-dark-200 dark:hover:text-dark-950 md:hidden'
            >
              <Briefcase className='h-[18px] w-[18px]' />
              {tasks.length > 0 && (
                <span className='absolute -end-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-md bg-primary-500 px-1 text-[9px] font-semibold tabular-nums text-white shadow-sm'>
                  {tasks.length > 99 ? '99+' : tasks.length}
                </span>
              )}
            </button>

            <div
              data-testid='sidebar-compact-work-task-list'
              className='flex w-full flex-col items-center gap-1'
            >
              {compactTasks.map(task => {
                const selected = currentTaskId === task.id;
                const status = workStatusPresentation[task.status];
                const taskTitle =
                  task.title ||
                  t('work.tasks.untitled', {
                    defaultValue: 'Untitled task',
                  });
                return (
                  <button
                    type='button'
                    key={task.id}
                    onClick={() => onSelectTask(task.id)}
                    data-testid='sidebar-compact-work-task'
                    aria-current={selected ? 'page' : undefined}
                    aria-label={taskTitle}
                    title={taskTitle}
                    className={cn(
                      'relative flex h-12 w-12 items-center justify-center rounded-xl outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary-500/30',
                      selected
                        ? 'bg-primary-500/10 text-primary-700 ring-1 ring-primary-500/10 dark:bg-primary-500/15 dark:text-primary-300 dark:ring-primary-400/10'
                        : 'text-gray-500 hover:bg-white/70 hover:text-gray-950 dark:text-dark-600 dark:hover:bg-dark-200 dark:hover:text-dark-950'
                    )}
                  >
                    {selected && (
                      <span
                        aria-hidden='true'
                        className='absolute -start-2 h-5 w-0.5 rounded-full bg-primary-500 shadow-[0_0_12px_rgb(var(--color-primary-500)/0.55)]'
                      />
                    )}
                    <span className='font-mono text-[11px] font-semibold tracking-[-0.03em]'>
                      {compactMonogram(taskTitle)}
                    </span>
                    <span
                      aria-hidden='true'
                      className={cn(
                        'absolute bottom-1.5 end-1.5 h-2 w-2 rounded-full border-2 border-gray-100 dark:border-dark-50',
                        status.animated && 'animate-pulse',
                        task.status === 'idle' &&
                          'ring-1 ring-black/20 dark:ring-white/20'
                      )}
                      style={{ backgroundColor: status.color }}
                    />
                  </button>
                );
              })}
            </div>
          </div>
        ) : loading && tasks.length === 0 ? (
          <div
            role='status'
            aria-live='polite'
            className='flex items-center justify-center py-10 text-gray-400 dark:text-dark-500'
          >
            <Loader2 aria-hidden='true' className='h-5 w-5 animate-spin' />
            <span className='sr-only'>
              {t('work.tasks.loading', {
                defaultValue: 'Loading Work tasks',
              })}
            </span>
          </div>
        ) : tasks.length === 0 ? (
          <div
            className={cn('py-8 text-center', sidebarCompact ? 'px-1' : 'px-2')}
          >
            <div
              className={cn(
                'mx-auto mb-3 flex items-center justify-center rounded-xl bg-white/70 ring-1 ring-black/[0.04] dark:bg-dark-200 dark:ring-white/[0.05]',
                sidebarCompact ? 'h-8 w-8' : 'h-12 w-12'
              )}
            >
              <Briefcase
                className={cn(
                  'text-gray-400 dark:text-gray-500',
                  sidebarCompact ? 'h-4 w-4' : 'h-5 w-5'
                )}
              />
            </div>
            {!sidebarCompact && (
              <>
                <p className='text-sm font-medium text-gray-600 dark:text-dark-600'>
                  {t('work.tasks.emptyTitle', {
                    defaultValue: 'No Work tasks yet',
                  })}
                </p>
                <p className='mt-1 text-xs text-gray-400 dark:text-dark-500'>
                  {t('work.tasks.empty', {
                    defaultValue:
                      'Your Work tasks will appear here after you send the first message.',
                  })}
                </p>
              </>
            )}
          </div>
        ) : (
          <div
            data-testid='sidebar-work-task-list'
            className={cn('space-y-0.5', sidebarCompact && 'space-y-1')}
          >
            {tasks.map(task => {
              const selected = currentTaskId === task.id;
              const status = workStatusPresentation[task.status];
              const statusLabel = t(status.labelKey, {
                defaultValue: status.label,
              });
              return (
                <div
                  key={task.id}
                  data-testid='sidebar-work-task-item'
                  data-task-id={task.id}
                  className={cn(
                    'group relative transition-colors duration-150 outline-none',
                    sidebarCompact
                      ? 'flex items-center justify-center rounded-xl p-1'
                      : 'rounded-xl px-3 py-2.5',
                    selected
                      ? 'bg-white ring-1 ring-black/[0.04] dark:bg-dark-200 dark:ring-white/[0.05]'
                      : 'hover:bg-white/60 dark:hover:bg-dark-200/60'
                  )}
                >
                  <button
                    type='button'
                    aria-current={selected ? 'page' : undefined}
                    className={cn(
                      'w-full text-start outline-none focus-visible:ring-2 focus-visible:ring-primary-500/30',
                      sidebarCompact
                        ? 'flex h-10 items-center justify-center'
                        : 'pe-8'
                    )}
                    title={
                      sidebarCompact
                        ? `${task.title} · ${task.model}`
                        : undefined
                    }
                    onClick={() => onSelectTask(task.id)}
                  >
                    {sidebarCompact ? (
                      <span
                        className={cn(
                          'relative flex h-9 w-9 items-center justify-center rounded-xl text-[11px] font-semibold uppercase transition-colors',
                          selected
                            ? 'bg-gray-950 text-white dark:bg-white dark:text-gray-950'
                            : 'bg-white/70 text-gray-500 ring-1 ring-black/[0.04] dark:bg-dark-200/70 dark:text-dark-600 dark:ring-white/[0.05]'
                        )}
                      >
                        {task.title.trim().charAt(0) || '•'}
                        <span
                          aria-hidden='true'
                          data-testid='sidebar-work-task-status'
                          data-status-label={statusLabel}
                          className={cn(
                            'absolute -bottom-0.5 -end-0.5 h-2.5 w-2.5 rounded-full border-2 border-gray-100 dark:border-dark-50',
                            status.animated && 'animate-pulse',
                            task.status === 'idle' &&
                              'ring-1 ring-black/20 dark:ring-white/20'
                          )}
                          style={{ backgroundColor: status.color }}
                        />
                      </span>
                    ) : (
                      <>
                        <span className='flex items-center gap-2'>
                          <span
                            aria-hidden='true'
                            data-testid='sidebar-work-task-status'
                            data-status-label={statusLabel}
                            className={cn(
                              'h-2 w-2 shrink-0 rounded-full',
                              status.animated && 'animate-pulse',
                              task.status === 'idle' &&
                                'ring-1 ring-black/20 dark:ring-white/20'
                            )}
                            style={{ backgroundColor: status.color }}
                          />
                          <span
                            dir='auto'
                            className='min-w-0 flex-1 truncate text-[13px] font-medium leading-tight text-gray-900 dark:text-dark-900'
                          >
                            {truncateText(
                              task.title ||
                                t('work.tasks.untitled', {
                                  defaultValue: 'Untitled task',
                                }),
                              32
                            )}
                          </span>
                        </span>
                        <span className='mt-1 flex items-center gap-1.5 ps-4 text-[11px] text-gray-400 dark:text-dark-500'>
                          <span className='tabular-nums'>
                            {formatTimestamp(task.updatedAt, i18n.language)}
                          </span>
                          <span className='text-gray-300 dark:text-dark-400'>
                            •
                          </span>
                          <span
                            dir='ltr'
                            className='min-w-0 truncate font-medium text-gray-600 dark:text-gray-400'
                            title={task.model}
                          >
                            {task.model}
                          </span>
                        </span>
                      </>
                    )}
                    <span className='sr-only'>
                      {t('work.tasks.status', {
                        defaultValue: 'Status: {{status}}',
                        status: statusLabel,
                      })}
                    </span>
                  </button>
                  {!sidebarCompact && (
                    <button
                      type='button'
                      data-testid='sidebar-work-task-delete'
                      disabled={actionLoading}
                      className={cn(
                        'absolute end-2 top-1/2 -translate-y-1/2 rounded-lg p-1.5 text-gray-400 transition-[color,background-color,opacity] hover:bg-error-500/10 hover:text-error-600 focus:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-error-500/30 disabled:cursor-not-allowed disabled:opacity-40 group-focus-within:opacity-100 group-hover:opacity-100 dark:text-dark-500',
                        selected ? 'opacity-100' : 'opacity-0'
                      )}
                      aria-label={t('work.tasks.deleteNamed', {
                        defaultValue: 'Delete {{title}}',
                        title:
                          task.title ||
                          t('work.tasks.untitled', {
                            defaultValue: 'Untitled task',
                          }),
                      })}
                      onClick={event => {
                        event.stopPropagation();
                        onDeleteTask(task);
                      }}
                    >
                      <Trash2 aria-hidden='true' className='h-3.5 w-3.5' />
                    </button>
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
