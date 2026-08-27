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

import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Briefcase,
  ExternalLink,
  Loader2,
  MoreHorizontal,
  Trash2,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui';
import { SidebarHoverCard } from './SidebarHoverCard';
import type { Persona } from '@/types';
import type { WorkTaskSummary } from '@/types/work';
import { cn, formatTimestamp, truncateText } from '@/utils';
import {
  getPersonaAvatarFallback,
  getPersonaAvatarSrc,
  setPersonaAvatarFallback,
} from '@/utils/personaAvatar';
import { workStatusPresentation } from '@/utils/workStatus';

interface SidebarWorkTasksProps {
  tasks: WorkTaskSummary[];
  personas: { [key: string]: Persona };
  currentTaskId: string | null;
  loading: boolean;
  actionLoading: boolean;
  sidebarCompact: boolean;
  onSelectTask: (taskId: string) => void;
  onDeleteTask: (task: WorkTaskSummary) => void;
  onExpandSidebar: () => void;
}

interface HoverPreviewState {
  task: WorkTaskSummary;
  top: number;
  left: number;
}

function hasUnreadAgentActivity(
  task: WorkTaskSummary,
  selected: boolean
): boolean {
  return (
    task.isAgent === true &&
    !selected &&
    typeof task.lastSeenAt === 'number' &&
    task.updatedAt > task.lastSeenAt &&
    (task.status === 'completed' ||
      task.status === 'needs_input' ||
      task.status === 'failed')
  );
}

function WorkTaskHoverPreview({ preview }: { preview: HoverPreviewState }) {
  const { t } = useTranslation();
  const { task } = preview;
  const status = workStatusPresentation[task.status];
  const statusLabel = t(status.labelKey, { defaultValue: status.label });

  return (
    <SidebarHoverCard
      top={preview.top}
      left={preview.left}
      title={
        task.title ||
        t('work.tasks.untitled', { defaultValue: 'Untitled task' })
      }
      timestamp={task.updatedAt}
    >
      <p className='flex items-center gap-1.5 text-[11px] leading-snug text-gray-600 dark:text-dark-700'>
        <span
          aria-hidden='true'
          className={cn(
            'h-2 w-2 shrink-0 rounded-full',
            status.animated && 'animate-pulse'
          )}
          style={{ backgroundColor: status.color }}
        />
        {statusLabel}
      </p>
      {task.statusBlurb && (
        <p
          dir='auto'
          className='mt-1.5 line-clamp-2 text-[11px] leading-snug text-gray-600 dark:text-dark-700'
        >
          {task.statusBlurb}
        </p>
      )}
      <p className='mt-1.5 truncate font-mono text-[10px] text-gray-400 dark:text-dark-500'>
        {task.model}
      </p>
      {task.hostPath && (
        <p
          className='mt-1 truncate font-mono text-[10px] text-gray-400 dark:text-dark-500'
          title={task.hostPath}
        >
          {task.hostPath}
        </p>
      )}
    </SidebarHoverCard>
  );
}

const TASK_MENU_WIDTH = 208;
const TASK_MENU_MAX_HEIGHT = 180;

export function SidebarWorkTasks({
  tasks,
  personas,
  currentTaskId,
  loading,
  actionLoading,
  sidebarCompact,
  onSelectTask,
  onDeleteTask,
  onExpandSidebar,
}: SidebarWorkTasksProps) {
  const { t, i18n } = useTranslation();
  // Hired agents stay pinned above ad-hoc tasks; each group preserves the
  // store's order so positions do not jump between polls.
  const agentTasks = tasks.filter(task => task.isAgent === true);
  const adhocTasks = tasks.filter(task => task.isAgent !== true);
  // The compact rail mirrors Chat by omitting ordinary history. Hired agents
  // remain pinned here because their persona identity is a durable shortcut,
  // not an unreadable abbreviation of a one-off task.
  const compactAgentTasks = agentTasks;

  const [hoverPreview, setHoverPreview] = useState<HoverPreviewState | null>(
    null
  );
  const hoverTimerRef = useRef<number | null>(null);
  const [mobileActionTaskId, setMobileActionTaskId] = useState<string | null>(
    null
  );
  const mobileActionTask = mobileActionTaskId
    ? (tasks.find(task => task.id === mobileActionTaskId) ?? null)
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

  const scheduleHoverPreview = (
    task: WorkTaskSummary,
    element: HTMLElement
  ) => {
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
        task,
        top: rect.top,
        left: rect.right + 10,
      });
    }, 500);
  };

  // Desktop "…" context menu, rendered through a portal so the scroll
  // region cannot clip it. Anchored to the button that opened it.
  const [taskMenu, setTaskMenu] = useState<{
    taskId: string;
    top: number;
    left: number;
  } | null>(null);
  const taskMenuTask = taskMenu
    ? (tasks.find(task => task.id === taskMenu.taskId) ?? null)
    : null;

  useEffect(() => {
    if (!taskMenu) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setTaskMenu(null);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [taskMenu]);

  const openTaskMenu = (
    task: WorkTaskSummary,
    event: React.MouseEvent<HTMLElement>
  ) => {
    event.stopPropagation();
    clearHoverPreview();
    if (taskMenu?.taskId === task.id) {
      setTaskMenu(null);
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    setTaskMenu({
      taskId: task.id,
      top: Math.max(
        8,
        Math.min(rect.bottom + 6, window.innerHeight - TASK_MENU_MAX_HEIGHT - 8)
      ),
      left: Math.max(
        8,
        Math.min(
          rect.right - TASK_MENU_WIDTH,
          window.innerWidth - TASK_MENU_WIDTH - 8
        )
      ),
    });
  };

  const openTaskInNewTab = (task: WorkTaskSummary) => {
    // Electron serves the app from file:// with hash routing.
    const isElectron = window.location.protocol === 'file:';
    const url = isElectron
      ? `${window.location.pathname}#/work/${task.id}`
      : `/work/${task.id}`;
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  const taskDisplayTitle = (task: WorkTaskSummary) =>
    task.title || t('work.tasks.untitled', { defaultValue: 'Untitled task' });

  const renderTaskRow = (task: WorkTaskSummary) => {
    const selected = currentTaskId === task.id;
    const status = workStatusPresentation[task.status];
    const statusLabel = t(status.labelKey, {
      defaultValue: status.label,
    });
    const menuOpenForRow = taskMenu?.taskId === task.id;
    const isAgentRow = task.isAgent === true;
    const persona =
      isAgentRow && task.personaId ? personas[task.personaId] : undefined;
    // Unread: a run reached a terminal state after the owner last opened
    // the task. Pre-migration rows (no marker) never light up.
    const unread = hasUnreadAgentActivity(task, selected);
    const rowControls = (
      <>
        {/* Relative time swaps for the row menu on hover. */}
        <span
          dir='auto'
          className={cn(
            'ms-2 shrink-0 text-xs leading-5 tabular-nums text-ink-subtle max-sm:hidden',
            'sm:group-hover:hidden sm:group-focus-within:hidden',
            menuOpenForRow && 'sm:hidden'
          )}
        >
          {formatTimestamp(task.updatedAt, i18n.language)}
        </span>

        <Button
          variant='ghost'
          size='sm'
          onClick={event => {
            event.stopPropagation();
            clearHoverPreview();
            setMobileActionTaskId(task.id);
          }}
          className='h-8 w-8 shrink-0 rounded-lg p-0 touch-manipulation sm:hidden'
          title={t('palette.actions')}
          aria-label={t('palette.actions')}
          data-testid='sidebar-work-task-actions-mobile'
        >
          <MoreHorizontal className='h-4 w-4' />
        </Button>

        <div
          className={cn(
            'hidden shrink-0',
            'sm:group-hover:block sm:group-focus-within:block',
            menuOpenForRow && 'sm:block'
          )}
        >
          <Button
            variant='ghost'
            size='sm'
            onClick={event => openTaskMenu(task, event)}
            className={cn(
              'h-6 w-6 rounded-md p-0 text-ink-subtle hover:text-ink hover:bg-transparent touch-manipulation',
              menuOpenForRow && 'text-ink'
            )}
            title={t('palette.actions')}
            aria-label={t('palette.actions')}
            aria-haspopup='menu'
            aria-expanded={menuOpenForRow}
            data-testid='sidebar-work-task-actions'
          >
            <MoreHorizontal className='h-4 w-4' />
          </Button>
        </div>
      </>
    );
    return (
      <div
        key={task.id}
        data-testid='sidebar-work-task-item'
        data-task-id={task.id}
        data-agent={isAgentRow ? 'true' : undefined}
        aria-current={selected ? 'page' : undefined}
        className={cn(
          'group relative cursor-pointer rounded-lg px-2 transition-colors duration-150 outline-none touch-manipulation',
          selected ? 'bg-interactive-active' : 'hover:bg-interactive-hover'
        )}
        onClick={() => {
          clearHoverPreview();
          onSelectTask(task.id);
        }}
        onMouseEnter={event => scheduleHoverPreview(task, event.currentTarget)}
        onMouseLeave={clearHoverPreview}
      >
        {isAgentRow ? (
          <div className='flex w-full items-center gap-2.5 py-1.5'>
            <span className='relative shrink-0'>
              <img
                src={
                  persona
                    ? getPersonaAvatarSrc(persona, 64)
                    : getPersonaAvatarFallback(taskDisplayTitle(task), 64)
                }
                alt=''
                aria-hidden='true'
                data-testid='sidebar-work-agent-avatar'
                onError={event =>
                  setPersonaAvatarFallback(
                    event.currentTarget,
                    persona?.name ?? taskDisplayTitle(task),
                    64
                  )
                }
                className='h-8 w-8 rounded-lg object-cover'
              />
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
            <div className='min-w-0 flex-1'>
              <div className='flex items-center'>
                <h3
                  dir='auto'
                  className={cn(
                    'min-w-0 flex-1 truncate text-sm leading-5 text-ink',
                    unread && 'font-medium'
                  )}
                  title={taskDisplayTitle(task)}
                >
                  {truncateText(taskDisplayTitle(task), 34)}
                  <span className='sr-only'>
                    {t('work.tasks.status', {
                      defaultValue: 'Status: {{status}}',
                      status: statusLabel,
                    })}
                  </span>
                </h3>
                {unread && (
                  <span
                    data-testid='sidebar-work-agent-unread'
                    aria-label={t('work.agent.unread', {
                      defaultValue: 'New activity',
                    })}
                    className='ms-2 h-2 w-2 shrink-0 rounded-full bg-primary-500 shadow-[0_0_8px_rgb(var(--color-primary-500)/0.6)]'
                  />
                )}
                {rowControls}
              </div>
              <p
                dir='auto'
                data-testid='sidebar-work-agent-blurb'
                className={cn(
                  'truncate text-[11px] leading-4',
                  unread ? 'text-ink-muted' : 'text-ink-subtle'
                )}
                title={task.statusBlurb || statusLabel}
              >
                {task.statusBlurb || statusLabel}
              </p>
            </div>
          </div>
        ) : (
          <div className='flex h-8 w-full items-center'>
            <span
              aria-hidden='true'
              data-testid='sidebar-work-task-status'
              data-status-label={statusLabel}
              className={cn(
                'me-2 h-2 w-2 shrink-0 rounded-full',
                status.animated && 'animate-pulse',
                task.status === 'idle' &&
                  'ring-1 ring-black/20 dark:ring-white/20'
              )}
              style={{ backgroundColor: status.color }}
            />
            <h3
              dir='auto'
              className='min-w-0 flex-1 truncate text-sm leading-5 text-ink'
              title={taskDisplayTitle(task)}
            >
              {truncateText(taskDisplayTitle(task), 40)}
              <span className='sr-only'>
                {t('work.tasks.status', {
                  defaultValue: 'Status: {{status}}',
                  status: statusLabel,
                })}
              </span>
            </h3>
            {rowControls}
          </div>
        )}
      </div>
    );
  };

  return (
    <div
      data-testid='sidebar-work-task-scroll-region'
      className='scroll-region min-h-0 flex-1 border-t border-black/[0.05] scrollbar-thin dark:border-white/[0.05]'
      style={{ willChange: 'scroll-position' }}
    >
      <div className={cn('px-3 py-3', sidebarCompact && 'px-2')}>
        {!sidebarCompact && tasks.length > 0 && (
          <div className='mb-2 flex items-center justify-between px-1'>
            <h3 className='text-xs font-medium text-ink-subtle'>
              {agentTasks.length > 0
                ? t('work.agents.title', { defaultValue: 'Agents' })
                : t('work.tasks.title', { defaultValue: 'Work tasks' })}
            </h3>
            <span className='text-[10px] font-medium tabular-nums text-gray-400 dark:text-dark-500'>
              {agentTasks.length > 0 ? agentTasks.length : tasks.length}
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
              data-testid='sidebar-compact-work-agent-list'
              className='flex w-full flex-col items-center gap-1'
            >
              {compactAgentTasks.map(task => {
                const selected = currentTaskId === task.id;
                const status = workStatusPresentation[task.status];
                const statusLabel = t(status.labelKey, {
                  defaultValue: status.label,
                });
                const taskTitle = taskDisplayTitle(task);
                const persona = task.personaId
                  ? personas[task.personaId]
                  : undefined;
                const unread = hasUnreadAgentActivity(task, selected);
                const accessibleLabel = [
                  taskTitle,
                  t('work.tasks.status', {
                    defaultValue: 'Status: {{status}}',
                    status: statusLabel,
                  }),
                  unread
                    ? t('work.agent.unread', { defaultValue: 'New activity' })
                    : null,
                ]
                  .filter(Boolean)
                  .join('. ');
                return (
                  <button
                    type='button'
                    key={task.id}
                    onClick={() => onSelectTask(task.id)}
                    data-testid='sidebar-compact-work-agent'
                    data-task-id={task.id}
                    data-agent='true'
                    aria-current={selected ? 'page' : undefined}
                    aria-label={accessibleLabel}
                    title={accessibleLabel}
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
                    <img
                      src={
                        persona
                          ? getPersonaAvatarSrc(persona, 64)
                          : getPersonaAvatarFallback(taskTitle, 64)
                      }
                      alt=''
                      aria-hidden='true'
                      data-testid='sidebar-compact-work-agent-avatar'
                      onError={event =>
                        setPersonaAvatarFallback(
                          event.currentTarget,
                          persona?.name ?? taskTitle,
                          64
                        )
                      }
                      className='h-9 w-9 rounded-lg object-cover'
                    />
                    {unread && (
                      <span
                        aria-hidden='true'
                        data-testid='sidebar-compact-work-agent-unread'
                        className='absolute end-1.5 top-1.5 h-2 w-2 rounded-full bg-primary-500 ring-2 ring-gray-100 dark:ring-dark-50'
                      />
                    )}
                    <span
                      aria-hidden='true'
                      data-testid='sidebar-compact-work-agent-status'
                      data-status={task.status}
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
          <div data-testid='sidebar-work-task-list' className='space-y-0.5'>
            {agentTasks.length > 0 ? (
              <>
                {agentTasks.map(renderTaskRow)}
                {adhocTasks.length > 0 && (
                  <div className='mb-1 mt-4 flex items-center justify-between px-1'>
                    <h3 className='text-xs font-medium text-ink-subtle'>
                      {t('work.tasks.title', { defaultValue: 'Work tasks' })}
                    </h3>
                    <span className='text-[10px] font-medium tabular-nums text-gray-400 dark:text-dark-500'>
                      {adhocTasks.length}
                    </span>
                  </div>
                )}
                {adhocTasks.map(renderTaskRow)}
              </>
            ) : (
              tasks.map(renderTaskRow)
            )}
          </div>
        )}
      </div>
      {hoverPreview && <WorkTaskHoverPreview preview={hoverPreview} />}
      {taskMenu &&
        taskMenuTask &&
        createPortal(
          <div className='fixed inset-0 z-[75] hidden sm:block'>
            <button
              type='button'
              tabIndex={-1}
              aria-label={t('common.close')}
              className='absolute inset-0 cursor-default'
              onClick={() => setTaskMenu(null)}
            />
            <div
              role='menu'
              aria-label={taskDisplayTitle(taskMenuTask)}
              data-testid='sidebar-work-task-menu'
              className='absolute overflow-y-auto rounded-xl border border-black/[0.04] bg-surface-overlay p-1 shadow-lv3 animate-scale-in dark:border-white/[0.06]'
              style={{
                top: taskMenu.top,
                left: taskMenu.left,
                width: TASK_MENU_WIDTH,
                maxHeight: TASK_MENU_MAX_HEIGHT,
              }}
            >
              <button
                type='button'
                role='menuitem'
                onClick={() => {
                  setTaskMenu(null);
                  openTaskInNewTab(taskMenuTask);
                }}
                className='flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-start text-[13px] text-ink hover:bg-interactive-hover'
              >
                <ExternalLink className='h-3.5 w-3.5 shrink-0' />
                {t('chat.session.openNewTab')}
              </button>
              <button
                type='button'
                role='menuitem'
                disabled={actionLoading}
                data-testid='sidebar-work-task-delete'
                onClick={() => {
                  setTaskMenu(null);
                  onDeleteTask(taskMenuTask);
                }}
                className='mt-1 flex w-full items-center gap-2.5 rounded-lg border-t border-black/[0.06] px-2.5 py-2 text-start text-[13px] text-red-500 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-white/[0.07] dark:hover:bg-red-900/20'
              >
                <Trash2 className='h-3.5 w-3.5 shrink-0' />
                {t('work.tasks.delete', { defaultValue: 'Delete task' })}
              </button>
            </div>
          </div>,
          document.body
        )}
      {mobileActionTask &&
        createPortal(
          <div className='fixed inset-0 z-[80] sm:hidden'>
            <button
              type='button'
              className='absolute inset-0 bg-black/35 backdrop-blur-[2px]'
              onClick={() => setMobileActionTaskId(null)}
              aria-label={t('common.close')}
            />
            <div
              role='dialog'
              aria-modal='true'
              aria-label={t('palette.actions')}
              className='absolute inset-x-3 bottom-3 rounded-2xl border border-black/[0.08] bg-surface p-2 shadow-[0_20px_70px_rgba(0,0,0,0.3)] dark:border-white/[0.09] dark:bg-dark-100'
              data-testid='sidebar-work-task-actions-sheet'
            >
              <div className='flex items-center justify-between gap-3 px-2 pb-2 pt-1'>
                <p className='min-w-0 truncate text-sm font-semibold text-gray-900 dark:text-dark-900'>
                  {taskDisplayTitle(mobileActionTask)}
                </p>
                <Button
                  variant='ghost'
                  size='sm'
                  onClick={() => setMobileActionTaskId(null)}
                  className='h-9 w-9 shrink-0 rounded-xl p-0'
                  title={t('common.close')}
                  aria-label={t('common.close')}
                >
                  <X className='h-4 w-4' />
                </Button>
              </div>

              <button
                type='button'
                onClick={() => {
                  setMobileActionTaskId(null);
                  openTaskInNewTab(mobileActionTask);
                }}
                className='flex w-full items-center gap-3 rounded-xl px-3 py-3 text-start text-sm text-ink hover:bg-interactive-hover'
              >
                <ExternalLink className='h-4 w-4 shrink-0' />
                {t('chat.session.openNewTab')}
              </button>
              <button
                type='button'
                disabled={actionLoading}
                onClick={() => {
                  setMobileActionTaskId(null);
                  onDeleteTask(mobileActionTask);
                }}
                className='flex w-full items-center gap-3 rounded-xl px-3 py-3 text-start text-sm text-red-500 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-40 dark:hover:bg-red-900/20'
              >
                <Trash2 className='h-4 w-4 shrink-0' />
                {t('work.tasks.delete', { defaultValue: 'Delete task' })}
              </button>
            </div>
          </div>,
          document.body
        )}
    </div>
  );
}
