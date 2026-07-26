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

import { Loader2, Plus, Trash2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { WorkTask, WorkTaskSummary } from '@/types/work';
import { cn } from '@/utils';

interface WorkTaskRailProps {
  tasks: WorkTaskSummary[];
  selectedTaskId: string | null;
  loading: boolean;
  mobileOpen: boolean;
  onCloseMobile: () => void;
  onNewTask: () => void;
  onSelectTask: (taskId: string) => void;
  onDeleteTask: (taskId: string) => void;
}

const statusTone: Record<WorkTask['status'], string> = {
  idle: 'bg-gray-400',
  preparing: 'bg-amber-500 animate-pulse',
  running: 'bg-primary-500 animate-pulse',
  completed: 'bg-emerald-500',
  failed: 'bg-error-500',
  cancelled: 'bg-gray-400',
};

const formatUpdatedAt = (timestamp: number): string => {
  if (!timestamp) return '';
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(timestamp));
};

export function WorkTaskRail({
  tasks,
  selectedTaskId,
  loading,
  mobileOpen,
  onCloseMobile,
  onNewTask,
  onSelectTask,
  onDeleteTask,
}: WorkTaskRailProps) {
  const { t } = useTranslation();

  return (
    <>
      {mobileOpen && (
        <button
          type='button'
          aria-label={t('work.tasks.close', {
            defaultValue: 'Close Work tasks',
          })}
          className='absolute inset-0 z-20 bg-black/25 backdrop-blur-[1px] lg:hidden'
          onClick={onCloseMobile}
        />
      )}
      <aside
        data-testid='work-task-rail'
        className={cn(
          'absolute inset-y-0 start-0 z-30 flex w-[17rem] shrink-0 flex-col border-e border-line bg-surface-raised transition-transform duration-200 lg:relative lg:ltr:translate-x-0 lg:rtl:translate-x-0',
          mobileOpen
            ? 'translate-x-0'
            : 'ltr:-translate-x-full rtl:translate-x-full'
        )}
      >
        <div className='flex h-16 items-center justify-between border-b border-line px-4'>
          <div>
            <p className='text-sm font-semibold text-ink'>
              {t('work.tasks.title', { defaultValue: 'Work tasks' })}
            </p>
            <p className='text-xs text-ink-muted'>
              {t('work.tasks.subtitle', {
                defaultValue: 'Persistent local workspaces',
              })}
            </p>
          </div>
          <button
            type='button'
            className='rounded-lg p-2 text-ink-muted hover:bg-surface-subtle hover:text-ink lg:hidden'
            onClick={onCloseMobile}
            aria-label={t('common.close')}
          >
            <X className='h-4 w-4' />
          </button>
        </div>

        <div className='p-3'>
          <button
            type='button'
            data-testid='work-new-task-button'
            onClick={onNewTask}
            className='flex h-10 w-full items-center justify-center gap-2 rounded-xl bg-ink px-3 text-sm font-medium text-ink-inverse transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500'
          >
            <Plus className='h-4 w-4' />
            {t('work.tasks.new', { defaultValue: 'New task' })}
          </button>
        </div>

        <div className='min-h-0 flex-1 overflow-y-auto px-2 pb-3'>
          {loading && tasks.length === 0 ? (
            <div className='flex items-center justify-center py-10 text-ink-muted'>
              <Loader2 className='h-5 w-5 animate-spin' />
            </div>
          ) : tasks.length === 0 ? (
            <p className='px-3 py-8 text-center text-xs leading-relaxed text-ink-muted'>
              {t('work.tasks.empty', {
                defaultValue:
                  'Your Work tasks will appear here after you send the first message.',
              })}
            </p>
          ) : (
            <div className='space-y-1'>
              {tasks.map(task => {
                const selected = selectedTaskId === task.id;
                return (
                  <div
                    key={task.id}
                    data-testid='work-task-item'
                    data-task-id={task.id}
                    className={cn(
                      'group relative rounded-xl border transition-colors',
                      selected
                        ? 'border-line-strong bg-surface-subtle'
                        : 'border-transparent hover:bg-surface-subtle'
                    )}
                  >
                    <button
                      type='button'
                      className='w-full px-3 py-2.5 pe-9 text-start'
                      onClick={() => onSelectTask(task.id)}
                    >
                      <span className='flex items-center gap-2'>
                        <span
                          aria-hidden='true'
                          className={cn(
                            'h-2 w-2 shrink-0 rounded-full',
                            statusTone[task.status]
                          )}
                        />
                        <span className='truncate text-sm font-medium text-ink'>
                          {task.title ||
                            t('work.tasks.untitled', {
                              defaultValue: 'Untitled task',
                            })}
                        </span>
                      </span>
                      <span className='mt-1 block truncate ps-4 text-[11px] text-ink-muted'>
                        {task.model} · {formatUpdatedAt(task.updatedAt)}
                      </span>
                    </button>
                    <button
                      type='button'
                      className='absolute end-2 top-2 rounded-lg p-1.5 text-ink-subtle opacity-0 transition-opacity hover:bg-error-500/10 hover:text-error-600 focus:opacity-100 group-hover:opacity-100'
                      aria-label={t('work.tasks.delete', {
                        defaultValue: 'Delete task',
                      })}
                      onClick={event => {
                        event.stopPropagation();
                        onDeleteTask(task.id);
                      }}
                    >
                      <Trash2 className='h-3.5 w-3.5' />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </aside>
    </>
  );
}
