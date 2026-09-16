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

import { FileText } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useWorkRuns } from '@/hooks/useWorkRuns';
import type { WorkRun } from '@/types/work';
import { cn, formatTimestamp } from '@/utils';
import { workStatusPresentation } from '@/utils/workStatus';

interface WorkRunHistoryProps {
  taskId: string;
  /** Only the visible surface spends a request on run history. */
  active: boolean;
  /** Refetches when it changes; the task status is the useful token. */
  refreshToken?: string | number;
  /** Opens a changed file in the workspace, like a conversation file chip. */
  onOpenFile?: (path: string) => void;
  className?: string;
}

type RunExitState = 'completed' | 'needs_input' | 'failed' | 'cancelled';

const EXIT_STATE_LABELS: Record<RunExitState, { key: string; value: string }> =
  {
    completed: { key: 'work.runs.exitStates.completed', value: 'Completed' },
    needs_input: {
      key: 'work.runs.exitStates.needsInput',
      value: 'Needs input',
    },
    failed: { key: 'work.runs.exitStates.failed', value: 'Failed' },
    cancelled: { key: 'work.runs.exitStates.cancelled', value: 'Cancelled' },
  };

/**
 * The run's terminal state. `exitState` carries an optional machine reason
 * after a colon (`failed:model-error`); the badge shows the state and keeps
 * the reason in the tooltip. Runs from before results were persisted fall
 * back to their run status.
 */
const exitStateOf = (run: WorkRun): RunExitState | null => {
  const candidate = (run.exitState || run.status).split(':')[0];
  return candidate in EXIT_STATE_LABELS ? (candidate as RunExitState) : null;
};

/** The summary is a whole reply; a history row shows only its first line. */
const firstLine = (summary: string | null | undefined): string => {
  if (!summary) return '';
  return (
    summary
      .split('\n')
      .map(line => line.trim())
      .find(line => line.length > 0) ?? ''
  );
};

export function WorkRunHistory({
  taskId,
  active,
  refreshToken,
  onOpenFile,
  className,
}: WorkRunHistoryProps) {
  const { t, i18n } = useTranslation();
  const { runs, loaded } = useWorkRuns(taskId, {
    enabled: active,
    refreshToken,
  });
  // A queued or running run belongs to the live surfaces, not to history.
  const finished = runs.filter(run => run.finishedAt);

  return (
    <section data-testid='work-run-history' className={className}>
      <h4 className='mb-2 text-[11px] font-medium uppercase tracking-wide text-ink-subtle'>
        {t('work.runs.title', { defaultValue: 'Runs' })}
      </h4>
      {finished.length === 0 ? (
        <p className='text-xs leading-relaxed text-ink-subtle'>
          {loaded
            ? t('work.runs.empty', {
                defaultValue:
                  'No finished runs yet. Each run keeps what it produced and the files it changed.',
              })
            : '…'}
        </p>
      ) : (
        <ul className='space-y-1'>
          {finished.map(run => {
            const state = exitStateOf(run);
            const label = state
              ? t(EXIT_STATE_LABELS[state].key, {
                  defaultValue: EXIT_STATE_LABELS[state].value,
                })
              : run.status;
            const color = state
              ? workStatusPresentation[state].color
              : 'rgb(255, 255, 255)';
            const summary = firstLine(run.summary);
            const files = run.changedFiles ?? [];
            return (
              <li
                key={run.id}
                data-testid='work-run-item'
                data-exit-state={run.exitState || run.status}
                className='rounded-xl border border-line bg-surface px-3 py-2'
              >
                <div className='flex items-center gap-2'>
                  <span
                    aria-hidden='true'
                    className='h-2 w-2 shrink-0 rounded-full'
                    style={{ backgroundColor: color }}
                  />
                  <span
                    data-testid='work-run-exit-state'
                    title={run.exitState || undefined}
                    className='text-[11px] font-medium text-ink'
                  >
                    {label}
                  </span>
                  <span className='ms-auto shrink-0 text-[11px] text-ink-subtle'>
                    {formatTimestamp(
                      run.finishedAt ?? run.createdAt,
                      i18n.language
                    )}
                  </span>
                </div>
                {summary && (
                  <p
                    dir='auto'
                    data-testid='work-run-summary'
                    className='mt-1 line-clamp-2 text-[13px] leading-5 text-ink-muted'
                  >
                    {summary}
                  </p>
                )}
                {files.length > 0 && (
                  <div className='mt-1.5 flex flex-wrap items-center gap-1.5'>
                    <span className='text-[11px] text-ink-subtle'>
                      {t('work.runs.fileCount', {
                        defaultValue: 'Files ({{total}})',
                        total: files.length,
                      })}
                    </span>
                    {files.map(path => {
                      const name =
                        path.split('/').filter(Boolean).pop() ?? path;
                      return (
                        <button
                          key={path}
                          type='button'
                          data-testid='work-run-file-chip'
                          data-path={path}
                          disabled={!onOpenFile}
                          onClick={() => onOpenFile?.(path)}
                          title={path}
                          aria-label={t('work.conversation.openFile', {
                            defaultValue: 'Open {{name}}',
                            name,
                          })}
                          className={cn(
                            'flex max-w-full items-center gap-1.5 rounded-lg border border-line bg-surface px-2 py-1 text-[11px] text-ink transition-colors',
                            onOpenFile &&
                              'hover:border-line-strong hover:bg-surface-subtle'
                          )}
                        >
                          <FileText className='h-3 w-3 shrink-0 text-ink-muted' />
                          <span className='truncate' dir='ltr'>
                            {name}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
