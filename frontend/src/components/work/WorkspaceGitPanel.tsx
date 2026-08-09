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
  ArrowLeft,
  Check,
  FileDiff,
  GitBranch,
  History,
  Loader2,
  Plus,
  RefreshCw,
  Search,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui';
import { WorkspaceDiffTable } from '@/components/work/WorkspaceDiffView';
import type { ApiResponse } from '@/types';
import type { WorkGitChange, WorkGitStatus } from '@/types/work';
import { cn } from '@/utils';
import { workApi } from '@/utils/api/workApi';
import { diffWorkLines, type WorkDiffLine } from '@/utils/workDiff';
import {
  parseUnifiedGitDiff,
  workGitDiffTotals,
  type WorkGitFileDiff,
  type WorkGitFileStatus,
} from '@/utils/workGitDiff';

interface WorkspaceGitPanelProps {
  taskId: string;
  mutationsDisabled?: boolean;
  disabledReason?: string;
}

interface SelectedDiff {
  path: string;
  status: WorkGitFileStatus;
  lines: WorkDiffLine[];
  binary: boolean;
  truncated: boolean;
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

const isUntracked = (change: WorkGitChange): boolean =>
  change.indexStatus === '?';

// One letter per file, the way IDE source-control views badge changes.
const changeLetter = (change: WorkGitChange): string => {
  if (isUntracked(change)) return 'U';
  if (change.workingTreeStatus !== '.') return change.workingTreeStatus;
  return change.indexStatus;
};

const statusLetter = (status: WorkGitFileStatus): string =>
  ({ modified: 'M', added: 'A', deleted: 'D', renamed: 'R' })[status];

const letterClass = (letter: string): string => {
  if (letter === 'A' || letter === 'U') return 'text-[rgb(46,164,79)]';
  if (letter === 'D') return 'text-[rgb(255,61,129)]';
  if (letter === 'R' || letter === 'C') return 'text-sky-600 dark:text-sky-400';
  return 'text-amber-600 dark:text-amber-500';
};

const splitPath = (path: string): { name: string; directory: string } => {
  const separator = path.lastIndexOf('/');
  if (separator === -1) return { name: path, directory: '' };
  return {
    name: path.slice(separator + 1),
    directory: path.slice(0, separator),
  };
};

function DiffStatsBadge({
  added,
  removed,
  muted = false,
}: {
  added: number;
  removed: number;
  muted?: boolean;
}) {
  return (
    <span dir='ltr' className='shrink-0 font-mono text-[10px] tabular-nums'>
      <span className={muted ? 'text-ink-subtle' : 'text-[rgb(46,164,79)]'}>
        +{added}
      </span>{' '}
      <span className={muted ? 'text-ink-subtle' : 'text-[rgb(255,61,129)]'}>
        −{removed}
      </span>
    </span>
  );
}

function FileDiffHeader({
  letter,
  path,
  oldPath,
  added,
  removed,
}: {
  letter: string;
  path: string;
  oldPath?: string;
  added: number;
  removed: number;
}) {
  return (
    <div className='sticky top-0 z-10 flex items-center gap-2 border-b border-line bg-surface-raised/95 px-3 py-1.5 backdrop-blur'>
      <span
        aria-hidden='true'
        className={cn(
          'w-4 shrink-0 text-center font-mono text-[11px] font-semibold',
          letterClass(letter)
        )}
      >
        {letter}
      </span>
      <span
        dir='ltr'
        className='min-w-0 flex-1 truncate text-start font-mono text-[11px] text-ink'
        title={oldPath ? `${oldPath} → ${path}` : path}
      >
        {oldPath ? `${oldPath} → ${path}` : path}
      </span>
      <DiffStatsBadge added={added} removed={removed} />
    </div>
  );
}

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
  const [fileFilter, setFileFilter] = useState('');
  const [selected, setSelected] = useState<SelectedDiff | null>(null);
  const [selectedLoading, setSelectedLoading] = useState(false);
  const [fullDiff, setFullDiff] = useState<{
    files: WorkGitFileDiff[];
    truncated: boolean;
  } | null>(null);
  const [fullDiffLoading, setFullDiffLoading] = useState(false);
  const generation = useRef(0);
  const selectionGeneration = useRef(0);

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

  // The full working-tree diff feeds the review view, the per-file counts,
  // and the toolbar totals. Untracked files never appear in `git diff HEAD`,
  // so an all-untracked tree skips the request entirely.
  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      if (!status?.initialized) {
        setFullDiff(null);
        return;
      }
      if (!status.changes.some(change => !isUntracked(change))) {
        setFullDiff(
          status.changes.length > 0 ? { files: [], truncated: false } : null
        );
        return;
      }
      setFullDiffLoading(true);
      try {
        const response = await workApi.getGitDiff(taskId);
        if (cancelled || !response.success || !response.data) return;
        setFullDiff({
          files: parseUnifiedGitDiff(response.data.patch),
          truncated: response.data.truncated,
        });
      } catch {
        // The review view degrades to the changes list; row clicks still work.
      } finally {
        if (!cancelled) setFullDiffLoading(false);
      }
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [status, taskId]);

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
      selectionGeneration.current += 1;
      setStatus(next);
      setSelectedPaths([]);
      setSelected(null);
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

  const openDiff = async (change: WorkGitChange) => {
    const request = ++selectionGeneration.current;
    setSelectedLoading(true);
    setError(null);
    try {
      if (isUntracked(change)) {
        // Untracked files have no patch until staged; reading the file and
        // diffing against nothing shows them as fully added, IDE-style.
        const file = responseData(
          await workApi.getFile(taskId, change.path),
          t('work.git.diffFailed', {
            defaultValue: 'Could not load this diff.',
          })
        );
        if (request !== selectionGeneration.current) return;
        setSelected({
          path: change.path,
          status: 'added',
          lines: diffWorkLines('', file.content),
          binary: false,
          truncated: false,
        });
      } else {
        const diff = responseData(
          await workApi.getGitDiff(taskId, change.path),
          t('work.git.diffFailed', {
            defaultValue: 'Could not load this diff.',
          })
        );
        if (request !== selectionGeneration.current) return;
        const parsed = parseUnifiedGitDiff(diff.patch)[0];
        setSelected({
          path: change.path,
          status: parsed?.status ?? 'modified',
          lines: parsed?.lines ?? [],
          binary: parsed?.binary ?? false,
          truncated: diff.truncated,
        });
      }
    } catch (diffError) {
      if (request !== selectionGeneration.current) return;
      setError(
        errorMessage(
          diffError,
          t('work.git.diffFailed', {
            defaultValue: 'Could not load this diff.',
          })
        )
      );
    } finally {
      if (request === selectionGeneration.current) setSelectedLoading(false);
    }
  };

  const statsByPath = useMemo(() => {
    const map = new Map<string, WorkGitFileDiff>();
    for (const file of fullDiff?.files ?? []) map.set(file.path, file);
    return map;
  }, [fullDiff]);

  const totals = useMemo(
    () => workGitDiffTotals(fullDiff?.files ?? []),
    [fullDiff]
  );

  const normalizedFilter = fileFilter.trim().toLowerCase();
  const visibleChanges = useMemo(() => {
    const changes = status?.changes ?? [];
    if (!normalizedFilter) return changes;
    return changes.filter(change =>
      change.path.toLowerCase().includes(normalizedFilter)
    );
  }, [normalizedFilter, status]);

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
  const untrackedChanges = visibleChanges.filter(isUntracked);
  const reviewFiles = normalizedFilter
    ? (fullDiff?.files ?? []).filter(file =>
        file.path.toLowerCase().includes(normalizedFilter)
      )
    : (fullDiff?.files ?? []);

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
        {fullDiff && (totals.added > 0 || totals.removed > 0) && (
          <span
            data-testid='work-git-total-stats'
            dir='ltr'
            className='font-mono text-[11px] font-medium tabular-nums'
          >
            <span className='text-[rgb(46,164,79)]'>+{totals.added}</span>{' '}
            <span className='text-[rgb(255,61,129)]'>−{totals.removed}</span>
          </span>
        )}
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

      <div className='grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(15rem,0.75fr)_minmax(0,2.25fr)]'>
        <section className='flex min-h-0 flex-col border-b border-line lg:border-b-0 lg:border-e'>
          <div className='flex items-center justify-between gap-2 px-3 py-2'>
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
          {status.changes.length > 0 && (
            <div className='relative px-2 pb-1.5'>
              <Search className='pointer-events-none absolute start-4 top-1/2 h-3 w-3 -translate-y-[calc(50%+3px)] text-ink-subtle' />
              <input
                data-testid='work-git-filter'
                value={fileFilter}
                maxLength={500}
                onChange={event => setFileFilter(event.target.value)}
                placeholder={t('work.git.filterFiles', {
                  defaultValue: 'Filter changed files',
                })}
                aria-label={t('work.git.filterFiles', {
                  defaultValue: 'Filter changed files',
                })}
                className='h-7 w-full rounded-lg border border-line bg-surface pe-2 ps-7 text-[11px] text-ink outline-none placeholder:text-ink-subtle focus:border-primary-500'
              />
            </div>
          )}
          <div className='min-h-32 flex-1 overflow-y-auto px-2 pb-2'>
            {status.changes.length === 0 ? (
              <p className='px-2 py-8 text-center text-xs text-ink-muted'>
                {t('work.git.clean', {
                  defaultValue: 'Working tree is clean.',
                })}
              </p>
            ) : visibleChanges.length === 0 ? (
              <p className='px-2 py-8 text-center text-xs text-ink-muted'>
                {t('work.git.noFilterMatches', {
                  defaultValue: 'No changed files match this filter.',
                })}
              </p>
            ) : (
              visibleChanges.map(change => {
                const letter = changeLetter(change);
                const { name, directory } = splitPath(change.path);
                const fileStats = statsByPath.get(change.path);
                return (
                  <div
                    key={`${change.path}:${change.originalPath || ''}`}
                    className={cn(
                      'flex items-center gap-1 rounded-lg hover:bg-surface-subtle',
                      selected?.path === change.path && 'bg-surface-subtle'
                    )}
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
                      onClick={() => void openDiff(change)}
                      className='flex min-w-0 flex-1 items-center gap-2 px-1.5 py-2 text-start'
                      title={change.path}
                    >
                      <span
                        aria-hidden='true'
                        className={cn(
                          'w-3.5 shrink-0 text-center font-mono text-[10px] font-semibold',
                          letterClass(letter),
                          change.staged && 'underline underline-offset-2'
                        )}
                      >
                        {letter}
                      </span>
                      <span
                        dir='ltr'
                        className='min-w-0 flex-1 truncate text-start font-mono text-[11px]'
                      >
                        <span className='text-ink'>{name}</span>
                        {directory && (
                          <span className='text-ink-subtle'> {directory}</span>
                        )}
                      </span>
                      {fileStats &&
                        (fileStats.stats.added > 0 ||
                          fileStats.stats.removed > 0) && (
                          <DiffStatsBadge
                            added={fileStats.stats.added}
                            removed={fileStats.stats.removed}
                          />
                        )}
                    </button>
                  </div>
                );
              })
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
          <div className='max-h-56 shrink-0 overflow-y-auto border-t border-line p-3'>
            <div className='mb-2 flex items-center gap-2 text-xs font-medium text-ink'>
              <History className='h-3.5 w-3.5' />
              {t('work.git.history', { defaultValue: 'Local history' })}
            </div>
            {status.commits.length === 0 ? (
              <p className='py-3 text-center text-xs text-ink-muted'>
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
            <p className='mt-3 border-t border-line pt-2 text-[10px] leading-relaxed text-ink-subtle'>
              {t('work.git.localOnly', {
                defaultValue:
                  'Local Git only. Push, pull, and pull requests require a separate trusted credential broker.',
              })}
            </p>
          </div>
        </section>

        <section className='flex min-h-48 min-w-0 flex-col'>
          {selected || selectedLoading ? (
            <>
              <div className='flex items-center gap-1.5 border-b border-line px-2 py-1.5'>
                <button
                  type='button'
                  data-testid='work-git-all-changes-button'
                  onClick={() => {
                    selectionGeneration.current += 1;
                    setSelected(null);
                    setSelectedLoading(false);
                  }}
                  className='inline-flex h-6 shrink-0 items-center gap-1 rounded-lg px-1.5 text-[11px] text-ink-muted hover:bg-surface-subtle hover:text-ink'
                >
                  <ArrowLeft className='h-3 w-3 rtl:rotate-180' />
                  {t('work.git.allChanges', { defaultValue: 'All changes' })}
                </button>
                {selected && (
                  <>
                    <span
                      aria-hidden='true'
                      className={cn(
                        'w-4 shrink-0 text-center font-mono text-[11px] font-semibold',
                        letterClass(statusLetter(selected.status))
                      )}
                    >
                      {statusLetter(selected.status)}
                    </span>
                    <span
                      dir='ltr'
                      className='min-w-0 flex-1 truncate font-mono text-[11px] text-ink'
                      title={selected.path}
                    >
                      {selected.path}
                    </span>
                    {!selected.binary && (
                      <DiffStatsBadge
                        added={
                          selected.lines.filter(line => line.type === 'added')
                            .length
                        }
                        removed={
                          selected.lines.filter(line => line.type === 'removed')
                            .length
                        }
                      />
                    )}
                  </>
                )}
              </div>
              {selectedLoading ? (
                <Loader2 className='m-auto h-5 w-5 animate-spin text-ink-muted' />
              ) : selected ? (
                <div
                  data-testid='work-git-diff'
                  dir='ltr'
                  className='min-h-0 flex-1 overflow-auto bg-surface font-mono text-[12px] leading-5'
                >
                  {selected.truncated && (
                    <p className='border-b border-line bg-surface-subtle/70 px-3 py-1.5 text-center font-sans text-[11px] text-ink-subtle'>
                      {t('work.git.diffTruncated', {
                        defaultValue: 'This diff is truncated.',
                      })}
                    </p>
                  )}
                  {selected.binary ? (
                    <p className='px-5 py-10 text-center font-sans text-xs text-ink-muted'>
                      {t('work.git.binaryFile', {
                        defaultValue: 'Binary file, no text diff.',
                      })}
                    </p>
                  ) : selected.lines.length === 0 ? (
                    <p className='px-5 py-10 text-center font-sans text-xs text-ink-muted'>
                      {t('work.git.noDiff', {
                        defaultValue:
                          'No textual diff is available yet. Untracked files appear after staging.',
                      })}
                    </p>
                  ) : (
                    <WorkspaceDiffTable lines={selected.lines} />
                  )}
                </div>
              ) : null}
            </>
          ) : status.changes.length === 0 ? (
            <p className='m-auto px-5 text-center text-xs text-ink-muted'>
              {t('work.git.clean', { defaultValue: 'Working tree is clean.' })}
            </p>
          ) : fullDiffLoading && !fullDiff ? (
            <Loader2 className='m-auto h-5 w-5 animate-spin text-ink-muted' />
          ) : (
            <div
              data-testid='work-git-review'
              dir='ltr'
              className='min-h-0 flex-1 overflow-auto bg-surface font-mono text-[12px] leading-5'
            >
              {fullDiff?.truncated && (
                <p className='border-b border-line bg-surface-subtle/70 px-3 py-1.5 text-center font-sans text-[11px] text-ink-subtle'>
                  {t('work.git.diffTruncated', {
                    defaultValue: 'This diff is truncated.',
                  })}
                </p>
              )}
              {reviewFiles.map(file => (
                <div key={file.path} data-testid='work-git-review-file'>
                  <FileDiffHeader
                    letter={statusLetter(file.status)}
                    path={file.path}
                    oldPath={file.oldPath}
                    added={file.stats.added}
                    removed={file.stats.removed}
                  />
                  {file.binary ? (
                    <p className='px-5 py-6 text-center font-sans text-xs text-ink-muted'>
                      {t('work.git.binaryFile', {
                        defaultValue: 'Binary file, no text diff.',
                      })}
                    </p>
                  ) : (
                    <WorkspaceDiffTable lines={file.lines} />
                  )}
                </div>
              ))}
              {untrackedChanges.map(change => (
                <div key={change.path} data-testid='work-git-review-file'>
                  <button
                    type='button'
                    onClick={() => void openDiff(change)}
                    title={change.path}
                    className='flex w-full items-center gap-2 border-b border-line px-3 py-1.5 text-start hover:bg-surface-subtle'
                  >
                    <span
                      aria-hidden='true'
                      className='w-4 shrink-0 text-center font-mono text-[11px] font-semibold text-[rgb(46,164,79)]'
                    >
                      U
                    </span>
                    <span
                      dir='ltr'
                      className='min-w-0 flex-1 truncate font-mono text-[11px] text-ink'
                    >
                      {change.path}
                    </span>
                    <FileDiff className='h-3 w-3 shrink-0 text-ink-subtle' />
                  </button>
                </div>
              ))}
              {reviewFiles.length === 0 && untrackedChanges.length === 0 && (
                <p className='px-5 py-10 text-center font-sans text-xs text-ink-muted'>
                  {normalizedFilter
                    ? t('work.git.noFilterMatches', {
                        defaultValue: 'No changed files match this filter.',
                      })
                    : t('work.git.selectChange', {
                        defaultValue:
                          'Select a changed file to inspect its diff.',
                      })}
                </p>
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
