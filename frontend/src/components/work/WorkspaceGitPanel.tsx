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

import {
  Check,
  FileDiff,
  GitBranch,
  History,
  Loader2,
  Plus,
  RefreshCw,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui';
import type { ApiResponse } from '@/types';
import type { WorkGitDiff, WorkGitStatus } from '@/types/work';
import { cn } from '@/utils';
import { workApi } from '@/utils/api/workApi';

interface WorkspaceGitPanelProps {
  taskId: string;
  mutationsDisabled?: boolean;
  disabledReason?: string;
}

const responseData = <T,>(response: ApiResponse<T>, fallback: string): T => {
  if (response.success && response.data) return response.data;
  throw new Error(response.error || fallback);
};

const errorMessage = (error: unknown, fallback: string): string => {
  const responseError = (error as { response?: { data?: { error?: unknown } } })
    ?.response?.data?.error;
  if (typeof responseError === 'string' && responseError) return responseError;
  return error instanceof Error && error.message ? error.message : fallback;
};

export function WorkspaceGitPanel({
  taskId,
  mutationsDisabled = false,
  disabledReason,
}: WorkspaceGitPanelProps) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<WorkGitStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const [commitMessage, setCommitMessage] = useState('');
  const [branchName, setBranchName] = useState('');
  const [diff, setDiff] = useState<WorkGitDiff | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const generation = useRef(0);

  const loadStatus = useCallback(async () => {
    const request = ++generation.current;
    setLoading(true);
    setError(null);
    try {
      const next = responseData(
        await workApi.getGitStatus(taskId),
        t('work.git.loadFailed', {
          defaultValue: 'Could not load Git status.',
        })
      );
      if (request !== generation.current) return;
      setStatus(next);
      setSelectedPaths([]);
    } catch (requestError) {
      if (request !== generation.current) return;
      setError(
        errorMessage(
          requestError,
          t('work.git.loadFailed', {
            defaultValue: 'Could not load Git status.',
          })
        )
      );
    } finally {
      if (request === generation.current) setLoading(false);
    }
  }, [t, taskId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadStatus(), 0);
    return () => {
      window.clearTimeout(timer);
      generation.current += 1;
    };
  }, [loadStatus]);

  const runMutation = async (
    action: () => Promise<ApiResponse<WorkGitStatus>>,
    successMessage: string
  ): Promise<boolean> => {
    if (mutationsDisabled || busy) return false;
    setBusy(true);
    setError(null);
    try {
      const next = responseData(
        await action(),
        t('work.git.actionFailed', { defaultValue: 'Git action failed.' })
      );
      setStatus(next);
      setSelectedPaths([]);
      setDiff(null);
      toast.success(successMessage);
      return true;
    } catch (actionError) {
      const message = errorMessage(
        actionError,
        t('work.git.actionFailed', { defaultValue: 'Git action failed.' })
      );
      setError(message);
      toast.error(message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const openDiff = async (path: string) => {
    setDiffLoading(true);
    setError(null);
    try {
      setDiff(
        responseData(
          await workApi.getGitDiff(taskId, path),
          t('work.git.diffFailed', {
            defaultValue: 'Could not load this diff.',
          })
        )
      );
    } catch (diffError) {
      setError(
        errorMessage(
          diffError,
          t('work.git.diffFailed', {
            defaultValue: 'Could not load this diff.',
          })
        )
      );
    } finally {
      setDiffLoading(false);
    }
  };

  if (loading && !status) {
    return (
      <div className='flex h-full items-center justify-center text-ink-muted'>
        <Loader2 className='h-5 w-5 animate-spin' />
      </div>
    );
  }

  if (!status) {
    return (
      <div className='flex h-full flex-col items-center justify-center px-6 text-center'>
        <GitBranch className='mb-3 h-8 w-8 text-error-500' />
        <p className='max-w-sm text-xs leading-relaxed text-error-600'>
          {error ||
            t('work.git.loadFailed', {
              defaultValue: 'Could not load Git status.',
            })}
        </p>
        <Button
          size='sm'
          variant='secondary'
          className='mt-4'
          onClick={() => void loadStatus()}
        >
          <RefreshCw className='h-3.5 w-3.5' />
          {t('common.retry', { defaultValue: 'Retry' })}
        </Button>
      </div>
    );
  }

  if (!status.initialized) {
    return (
      <div className='flex h-full flex-col items-center justify-center px-6 text-center'>
        <GitBranch className='mb-3 h-8 w-8 text-ink-subtle' />
        <h3 className='text-sm font-medium text-ink'>
          {t('work.git.notInitialized', {
            defaultValue: 'Git is not initialized',
          })}
        </h3>
        <p className='mt-1 max-w-sm text-xs leading-relaxed text-ink-muted'>
          {t('work.git.initializeDescription', {
            defaultValue:
              'Create a local repository for status, diffs, branches, and commits. No remote credentials are connected.',
          })}
        </p>
        {error && <p className='mt-3 text-xs text-error-600'>{error}</p>}
        <Button
          data-testid='work-git-init-button'
          size='sm'
          className='mt-4 bg-[#ff7b52] text-[#3d120c] hover:bg-[#ff7b52]/90'
          disabled={mutationsDisabled || busy}
          onClick={() =>
            void runMutation(
              () => workApi.initializeGit(taskId),
              t('work.git.initialized', {
                defaultValue: 'Git repository initialized.',
              })
            )
          }
        >
          {busy ? (
            <Loader2 className='me-2 h-3.5 w-3.5 animate-spin' />
          ) : (
            <Plus className='me-2 h-3.5 w-3.5' />
          )}
          {t('work.git.initialize', { defaultValue: 'Initialize Git' })}
        </Button>
        {mutationsDisabled && disabledReason && (
          <p className='mt-2 text-[11px] text-ink-subtle'>{disabledReason}</p>
        )}
      </div>
    );
  }

  const stagedCount = status.changes.filter(change => change.staged).length;
  const dirty = status.changes.length > 0;

  return (
    <div className='flex h-full min-h-0 flex-col' data-testid='work-git-panel'>
      <div className='flex flex-wrap items-center gap-2 border-b border-line px-3 py-2'>
        <span className='inline-flex min-w-0 items-center gap-1.5 rounded-lg bg-surface-subtle px-2 py-1 font-mono text-[11px] text-ink'>
          <GitBranch className='h-3.5 w-3.5 shrink-0' />
          <span className='truncate'>
            {status.detached
              ? t('work.git.detached', { defaultValue: 'detached HEAD' })
              : status.branch || 'main'}
          </span>
        </span>
        {(status.ahead > 0 || status.behind > 0) && (
          <span className='text-[10px] text-ink-muted'>
            ↑{status.ahead} ↓{status.behind}
          </span>
        )}
        <select
          data-testid='work-git-branch-select'
          aria-label={t('work.git.switchBranch', {
            defaultValue: 'Switch local branch',
          })}
          value={status.branch || ''}
          disabled={mutationsDisabled || busy || dirty}
          onChange={event => {
            const name = event.target.value;
            if (!name || name === status.branch) return;
            void runMutation(
              () => workApi.switchGitBranch(taskId, name),
              t('work.git.branchSwitched', {
                name,
                defaultValue: 'Switched to {{name}}.',
              })
            );
          }}
          className='h-7 max-w-44 rounded-lg border border-line bg-surface px-2 text-[11px] text-ink outline-none disabled:opacity-50'
        >
          {status.detached && (
            <option value='' disabled>
              {t('work.git.detached', { defaultValue: 'detached HEAD' })}
            </option>
          )}
          {status.branches.map(branch => (
            <option key={branch} value={branch}>
              {branch}
            </option>
          ))}
        </select>
        <div className='flex min-w-44 flex-1 items-center gap-1'>
          <input
            data-testid='work-git-branch-input'
            value={branchName}
            maxLength={200}
            onChange={event => setBranchName(event.target.value)}
            placeholder={t('work.git.newBranch', {
              defaultValue: 'New local branch',
            })}
            className='h-7 min-w-0 flex-1 rounded-lg border border-line bg-surface px-2 font-mono text-[11px] text-ink outline-none placeholder:text-ink-subtle focus:border-primary-500'
          />
          <Button
            data-testid='work-git-create-branch-button'
            size='sm'
            variant='ghost'
            className='h-7 px-2'
            disabled={
              mutationsDisabled || busy || !status.head || !branchName.trim()
            }
            onClick={() => {
              const name = branchName.trim();
              void runMutation(
                () => workApi.createGitBranch(taskId, name),
                t('work.git.branchCreated', {
                  name,
                  defaultValue: 'Created {{name}}.',
                })
              ).then(success => {
                if (success) setBranchName('');
              });
            }}
          >
            <Plus className='h-3.5 w-3.5' />
            <span className='hidden sm:inline'>
              {t('work.git.createBranch', { defaultValue: 'Create' })}
            </span>
          </Button>
        </div>
        <button
          type='button'
          onClick={() => void loadStatus()}
          disabled={loading || busy}
          aria-label={t('common.refresh', { defaultValue: 'Refresh' })}
          className='inline-flex h-7 w-7 items-center justify-center rounded-lg text-ink-muted hover:bg-surface-subtle hover:text-ink disabled:opacity-50'
        >
          <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
        </button>
      </div>

      {error && (
        <div className='border-b border-error-200 bg-error-50 px-3 py-2 text-xs text-error-700 dark:border-error-900/60 dark:bg-error-900/30 dark:text-error-300'>
          {error}
        </div>
      )}
      {mutationsDisabled && disabledReason && (
        <div className='border-b border-line px-3 py-1.5 text-[11px] text-ink-subtle'>
          {disabledReason}
        </div>
      )}

      <div className='grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(14rem,0.8fr)_minmax(18rem,1.2fr)_minmax(13rem,0.8fr)]'>
        <section className='flex min-h-0 flex-col border-b border-line lg:border-b-0 lg:border-e'>
          <div className='flex items-center justify-between px-3 py-2'>
            <h3 className='text-xs font-medium text-ink'>
              {t('work.git.changes', { defaultValue: 'Changes' })}{' '}
              <span className='text-ink-subtle'>{status.changes.length}</span>
            </h3>
            <Button
              data-testid='work-git-stage-button'
              size='sm'
              variant='ghost'
              className='h-7 px-2 text-[11px]'
              disabled={
                mutationsDisabled ||
                busy ||
                (selectedPaths.length === 0 && status.changes.length === 0)
              }
              onClick={() => {
                const paths =
                  selectedPaths.length > 0
                    ? selectedPaths
                    : status.changes.map(change => change.path);
                void runMutation(
                  () => workApi.stageGitPaths(taskId, paths),
                  t('work.git.staged', { defaultValue: 'Changes staged.' })
                );
              }}
            >
              <Check className='h-3.5 w-3.5' />
              {selectedPaths.length > 0
                ? t('work.git.stageSelected', {
                    count: selectedPaths.length,
                    defaultValue: 'Stage {{count}}',
                  })
                : t('work.git.stageAll', { defaultValue: 'Stage all' })}
            </Button>
          </div>
          <div className='min-h-32 flex-1 overflow-y-auto px-2 pb-2'>
            {status.changes.length === 0 ? (
              <p className='px-2 py-8 text-center text-xs text-ink-muted'>
                {t('work.git.clean', {
                  defaultValue: 'Working tree is clean.',
                })}
              </p>
            ) : (
              status.changes.map(change => (
                <div
                  key={`${change.path}:${change.originalPath || ''}`}
                  className='flex items-center gap-1 rounded-lg hover:bg-surface-subtle'
                >
                  <input
                    type='checkbox'
                    aria-label={t('work.git.selectPath', {
                      path: change.path,
                      defaultValue: 'Select {{path}}',
                    })}
                    checked={selectedPaths.includes(change.path)}
                    onChange={event =>
                      setSelectedPaths(current =>
                        event.target.checked
                          ? [...current, change.path]
                          : current.filter(path => path !== change.path)
                      )
                    }
                    className='ms-2 h-3.5 w-3.5 accent-[#ff7b52]'
                  />
                  <button
                    type='button'
                    data-testid='work-git-change'
                    onClick={() => void openDiff(change.path)}
                    className='flex min-w-0 flex-1 items-center gap-2 px-1.5 py-2 text-start'
                  >
                    <span
                      dir='ltr'
                      className={cn(
                        'w-5 shrink-0 font-mono text-[10px] font-semibold',
                        change.staged ? 'text-emerald-600' : 'text-amber-600'
                      )}
                    >
                      {change.indexStatus}
                      {change.workingTreeStatus}
                    </span>
                    <span
                      dir='ltr'
                      className='min-w-0 flex-1 truncate font-mono text-[11px] text-ink'
                      title={change.path}
                    >
                      {change.path}
                    </span>
                  </button>
                </div>
              ))
            )}
          </div>
          <div className='border-t border-line p-2'>
            <textarea
              data-testid='work-git-commit-input'
              value={commitMessage}
              maxLength={4000}
              rows={2}
              onChange={event => setCommitMessage(event.target.value)}
              placeholder={t('work.git.commitMessage', {
                defaultValue: 'Commit message',
              })}
              className='w-full resize-none rounded-lg border border-line bg-surface px-2.5 py-2 text-xs text-ink outline-none placeholder:text-ink-subtle focus:border-primary-500'
            />
            <Button
              data-testid='work-git-commit-button'
              size='sm'
              className='mt-1.5 w-full bg-[#ff7b52] text-[#3d120c] hover:bg-[#ff7b52]/90'
              disabled={
                mutationsDisabled ||
                busy ||
                stagedCount === 0 ||
                !commitMessage.trim()
              }
              onClick={() => {
                const message = commitMessage.trim();
                void runMutation(
                  () => workApi.commitGit(taskId, message),
                  t('work.git.committed', {
                    defaultValue: 'Commit created.',
                  })
                ).then(success => {
                  if (success) setCommitMessage('');
                });
              }}
            >
              {busy && <Loader2 className='h-3.5 w-3.5 animate-spin' />}
              {t('work.git.commit', { defaultValue: 'Commit staged changes' })}
            </Button>
          </div>
        </section>

        <section className='flex min-h-48 min-w-0 flex-col border-b border-line lg:border-b-0 lg:border-e'>
          <div className='flex items-center gap-2 px-3 py-2 text-xs font-medium text-ink'>
            <FileDiff className='h-3.5 w-3.5' />
            {diff?.path || t('work.git.diff', { defaultValue: 'Diff preview' })}
          </div>
          {diffLoading ? (
            <Loader2 className='m-auto h-5 w-5 animate-spin text-ink-muted' />
          ) : diff ? (
            diff.patch ? (
              <pre
                data-testid='work-git-diff'
                dir='ltr'
                className='min-h-0 flex-1 overflow-auto whitespace-pre p-3 text-left font-mono text-[11px] leading-relaxed text-ink'
              >
                {diff.patch}
                {diff.truncated && '\n… diff truncated …'}
              </pre>
            ) : (
              <p className='m-auto px-5 text-center text-xs text-ink-muted'>
                {t('work.git.noDiff', {
                  defaultValue:
                    'No textual diff is available yet. Untracked files appear after staging.',
                })}
              </p>
            )
          ) : (
            <p className='m-auto px-5 text-center text-xs text-ink-muted'>
              {t('work.git.selectChange', {
                defaultValue: 'Select a changed file to inspect its diff.',
              })}
            </p>
          )}
        </section>

        <section className='min-h-36 overflow-y-auto p-3'>
          <div className='mb-2 flex items-center gap-2 text-xs font-medium text-ink'>
            <History className='h-3.5 w-3.5' />
            {t('work.git.history', { defaultValue: 'Local history' })}
          </div>
          {status.commits.length === 0 ? (
            <p className='py-6 text-center text-xs text-ink-muted'>
              {t('work.git.noCommits', { defaultValue: 'No commits yet.' })}
            </p>
          ) : (
            <ol className='space-y-2'>
              {status.commits.map(commit => (
                <li
                  key={commit.hash}
                  className='rounded-lg border border-line bg-surface px-2.5 py-2'
                >
                  <p dir='auto' className='text-xs text-ink'>
                    {commit.subject}
                  </p>
                  <p className='mt-1 flex flex-wrap gap-x-2 text-[10px] text-ink-subtle'>
                    <span dir='ltr' className='font-mono'>
                      {commit.shortHash}
                    </span>
                    <span dir='auto'>{commit.author}</span>
                    <time dateTime={commit.authoredAt}>
                      {new Date(commit.authoredAt).toLocaleDateString()}
                    </time>
                  </p>
                </li>
              ))}
            </ol>
          )}
          <p className='mt-4 border-t border-line pt-3 text-[10px] leading-relaxed text-ink-subtle'>
            {t('work.git.localOnly', {
              defaultValue:
                'Local Git only. Push, pull, and pull requests require a separate trusted credential broker.',
            })}
          </p>
        </section>
      </div>
    </div>
  );
}
