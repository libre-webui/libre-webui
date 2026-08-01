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
  Activity,
  ArrowLeft,
  ExternalLink,
  File,
  Files as FilesIcon,
  Folder,
  GitCompareArrows,
  Loader2,
  Monitor,
  Play,
  RefreshCw,
  Save,
  Square,
  TerminalSquare,
  WandSparkles,
} from 'lucide-react';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui';
import { WorkLiveRunSurface } from '@/components/work/WorkLiveRunSurface';
import { WorkspaceCodeEditor } from '@/components/work/WorkspaceCodeEditor';
import { WorkspaceDiffView } from '@/components/work/WorkspaceDiffView';
import { isRTL } from '@/i18n';
import type {
  WorkFile,
  WorkFileEntry,
  WorkLiveRun,
  WorkMessage,
  WorkTask,
} from '@/types/work';
import { cn } from '@/utils';
import {
  clearWorkDraft,
  loadWorkDraft,
  saveWorkDraft,
} from '@/utils/workDrafts';
import {
  canFormatWorkFile,
  formatWorkCode,
  isWorkCodeFormatSizeSupported,
} from '@/utils/workCode';
import { diffWorkLines, workDiffStats } from '@/utils/workDiff';

type WorkspaceTab = 'files' | 'activity' | 'preview';

interface WorkspacePaneProps {
  task: WorkTask;
  liveRun?: WorkLiveRun;
  files: WorkFileEntry[];
  selectedFile: WorkFile | null;
  loadingFiles: boolean;
  actionLoading: boolean;
  onLoadFiles: (path?: string) => Promise<unknown>;
  onLoadFile: (path: string) => Promise<WorkFile>;
  onClearSelectedFile: () => void;
  onSaveFile: (
    path: string,
    content: string,
    expectedUpdatedAt?: number
  ) => Promise<WorkFile | false>;
  onStartPreview: (command?: string) => Promise<unknown>;
  onStopPreview: () => Promise<unknown>;
  onDirtyChange: (dirty: boolean) => void;
}

const safePreviewUrl = (value?: string | null): string | null => {
  if (!value) return null;
  try {
    const url = new URL(value);
    const loopback =
      url.hostname === 'localhost' ||
      url.hostname === '127.0.0.1' ||
      url.hostname === '[::1]';
    return loopback && (url.protocol === 'http:' || url.protocol === 'https:')
      ? url.toString()
      : null;
  } catch {
    return null;
  }
};

const parentPath = (path: string): string => {
  const parts = path.split('/').filter(Boolean);
  parts.pop();
  return parts.join('/');
};

const toolName = (message: WorkMessage, fallback: string): string => {
  const value =
    message.metadata?.name ??
    message.metadata?.toolName ??
    message.metadata?.tool ??
    message.metadata?.command;
  return typeof value === 'string' && value ? value : fallback;
};

export function WorkspacePane({
  task,
  liveRun,
  files,
  selectedFile,
  loadingFiles,
  actionLoading,
  onLoadFiles,
  onLoadFile,
  onClearSelectedFile,
  onSaveFile,
  onStartPreview,
  onStopPreview,
  onDirtyChange,
}: WorkspacePaneProps) {
  const { t, i18n } = useTranslation();
  const rtl = isRTL(i18n.language);
  const [tab, setTab] = useState<WorkspaceTab>('files');
  const [currentPath, setCurrentPath] = useState('');
  const [editorContent, setEditorContent] = useState('');
  const [editorBaseUpdatedAt, setEditorBaseUpdatedAt] = useState<
    number | undefined
  >();
  const [previewCommand, setPreviewCommand] = useState('');
  const [formatting, setFormatting] = useState(false);
  const [showDiff, setShowDiff] = useState(false);
  // Server-side content the client has seen, and its frozen copy from the
  // moment the current/most recent model turn started.
  const knownContentsRef = useRef(new Map<string, string>());
  const [turnBaseline, setTurnBaseline] = useState(
    () => new Map<string, string>()
  );
  const previewUrl = safePreviewUrl(task.previewUrl);
  const liveRunId = liveRun?.runId;
  const liveRunError = liveRun?.error;
  const liveTools = liveRun?.tools;
  const activity = useMemo(() => {
    const liveToolIds = new Set(liveTools?.map(tool => tool.id) || []);
    return (task.messages || []).filter(message => {
      if (
        message.kind === 'reasoning' ||
        (message.role !== 'tool' && message.kind === 'message')
      ) {
        return false;
      }
      if (!liveRunId || message.runId !== liveRunId) return true;
      if (message.kind === 'error' && liveRunError) return false;
      const toolCallId = message.metadata?.toolCallId;
      return typeof toolCallId !== 'string' || !liveToolIds.has(toolCallId);
    });
  }, [liveRunError, liveRunId, liveTools, task.messages]);
  const activityCount = activity.length + (liveTools?.length || 0);
  const dirty =
    Boolean(selectedFile) && editorContent !== (selectedFile?.content ?? '');
  const taskActive = task.status === 'preparing' || task.status === 'running';
  const wasTaskActive = useRef(taskActive);
  const openFileGeneration = useRef(0);
  const editorContentRef = useRef(editorContent);
  const editorBaseUpdatedAtRef = useRef(editorBaseUpdatedAt);
  const selectedFileRef = useRef(selectedFile);
  const taskIdRef = useRef(task.id);
  const onLoadFilesRef = useRef(onLoadFiles);
  const onLoadFileRef = useRef(onLoadFile);
  const onDirtyChangeRef = useRef(onDirtyChange);
  const aliveRef = useRef(true);
  const diffBaseline = selectedFile
    ? turnBaseline.get(selectedFile.path)
    : undefined;
  const diffLines = useMemo(
    () =>
      selectedFile &&
      diffBaseline !== undefined &&
      diffBaseline !== selectedFile.content
        ? diffWorkLines(diffBaseline, selectedFile.content)
        : null,
    [diffBaseline, selectedFile]
  );
  const diffStats = useMemo(
    () => (diffLines ? workDiffStats(diffLines) : null),
    [diffLines]
  );
  const diffAvailable = Boolean(
    diffStats && (diffStats.added > 0 || diffStats.removed > 0)
  );
  const formatTypeSupported = selectedFile
    ? canFormatWorkFile(selectedFile.path)
    : false;
  const formatSizeSupported =
    !selectedFile || isWorkCodeFormatSizeSupported(editorContent);
  const formatSupported = formatTypeSupported && formatSizeSupported;

  useEffect(() => {
    editorContentRef.current = editorContent;
    editorBaseUpdatedAtRef.current = editorBaseUpdatedAt;
    selectedFileRef.current = selectedFile;
    taskIdRef.current = task.id;
    onDirtyChangeRef.current = onDirtyChange;
  }, [
    editorBaseUpdatedAt,
    editorContent,
    onDirtyChange,
    selectedFile,
    task.id,
  ]);

  useEffect(() => {
    onLoadFilesRef.current = onLoadFiles;
    onLoadFileRef.current = onLoadFile;
  }, [onLoadFile, onLoadFiles]);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      openFileGeneration.current += 1;
      onDirtyChangeRef.current(false);
    };
  }, []);

  // WorkPage mounts one WorkspacePane per task (keyed by task id), so the
  // content maps below start fresh for every workspace.
  useEffect(() => {
    if (!wasTaskActive.current && taskActive) {
      setTurnBaseline(new Map(knownContentsRef.current));
    }
    if (wasTaskActive.current && !taskActive) {
      void onLoadFilesRef.current(currentPath);
      if (selectedFile && !dirty) {
        const generation = ++openFileGeneration.current;
        const selectedPath = selectedFile.path;
        const editorContentAtLoad = editorContentRef.current;
        const editorBaseAtLoad = editorBaseUpdatedAtRef.current;
        void onLoadFileRef
          .current(selectedPath)
          .then(file => {
            if (
              !aliveRef.current ||
              generation !== openFileGeneration.current ||
              file.path !== selectedPath ||
              editorContentRef.current !== editorContentAtLoad ||
              editorBaseUpdatedAtRef.current !== editorBaseAtLoad
            ) {
              return;
            }
            knownContentsRef.current.set(file.path, file.content);
            const baseline = turnBaseline.get(file.path);
            if (baseline !== undefined && baseline !== file.content) {
              setShowDiff(true);
            }
            editorContentRef.current = file.content;
            editorBaseUpdatedAtRef.current = file.updatedAt ?? file.modifiedAt;
            setEditorContent(file.content);
            setEditorBaseUpdatedAt(file.updatedAt ?? file.modifiedAt);
          })
          .catch(() => undefined);
      }
    }
    wasTaskActive.current = taskActive;
  }, [currentPath, dirty, selectedFile, taskActive, turnBaseline]);

  const confirmDiscard = (): boolean =>
    !dirty ||
    window.confirm(
      t('work.files.discard', {
        defaultValue: 'Discard unsaved file changes?',
      })
    );

  const discardCurrentDraft = () => {
    if (selectedFile) clearWorkDraft(task.id, selectedFile.path);
  };

  const openDirectory = async (path: string) => {
    if (!confirmDiscard()) return;
    openFileGeneration.current += 1;
    discardCurrentDraft();
    onClearSelectedFile();
    onDirtyChange(false);
    setShowDiff(false);
    setCurrentPath(path);
    await onLoadFiles(path).catch(() => undefined);
  };

  const openFile = async (path: string) => {
    if (!confirmDiscard()) return;
    const generation = ++openFileGeneration.current;
    discardCurrentDraft();
    const file = await onLoadFile(path).catch(() => undefined);
    if (!aliveRef.current || !file || generation !== openFileGeneration.current)
      return;
    knownContentsRef.current.set(file.path, file.content);
    const baseline = turnBaseline.get(file.path);
    setShowDiff(baseline !== undefined && baseline !== file.content);
    const draft = loadWorkDraft(task.id, file.path);
    const content = draft?.content ?? file.content;
    const baseUpdatedAt =
      draft?.baseUpdatedAt ?? file.updatedAt ?? file.modifiedAt;
    editorContentRef.current = content;
    editorBaseUpdatedAtRef.current = baseUpdatedAt;
    setEditorContent(content);
    setEditorBaseUpdatedAt(baseUpdatedAt);
    onDirtyChange(draft !== null && draft.content !== file.content);
  };

  const closeFile = () => {
    if (!confirmDiscard()) return;
    openFileGeneration.current += 1;
    discardCurrentDraft();
    onClearSelectedFile();
    onDirtyChange(false);
    setShowDiff(false);
  };

  const updateEditorContent = (content: string) => {
    if (!selectedFile) return;
    editorContentRef.current = content;
    setEditorContent(content);
    if (content === selectedFile.content) {
      clearWorkDraft(task.id, selectedFile.path);
    } else {
      saveWorkDraft(task.id, selectedFile.path, {
        content,
        baseUpdatedAt:
          editorBaseUpdatedAt ??
          selectedFile.updatedAt ??
          selectedFile.modifiedAt,
      });
    }
    onDirtyChange(content !== selectedFile.content);
  };

  const saveFile = async () => {
    if (!selectedFile) return;
    const submittedTaskId = task.id;
    const submittedPath = selectedFile.path;
    const submittedContent = editorContent;
    const submittedGeneration = openFileGeneration.current;
    const result = await onSaveFile(
      submittedPath,
      submittedContent,
      editorBaseUpdatedAt
    ).catch((): false => false);
    if (
      !aliveRef.current ||
      result === false ||
      submittedGeneration !== openFileGeneration.current ||
      taskIdRef.current !== submittedTaskId ||
      selectedFileRef.current?.path !== submittedPath
    )
      return;

    const updatedAt = result.updatedAt ?? result.modifiedAt;
    knownContentsRef.current.set(
      submittedPath,
      typeof result.content === 'string' ? result.content : submittedContent
    );
    editorBaseUpdatedAtRef.current = updatedAt;
    setEditorBaseUpdatedAt(updatedAt);
    const currentContent = editorContentRef.current;
    if (currentContent === submittedContent) {
      clearWorkDraft(submittedTaskId, submittedPath);
      onDirtyChange(false);
      return;
    }

    saveWorkDraft(submittedTaskId, submittedPath, {
      content: currentContent,
      baseUpdatedAt: updatedAt,
    });
    onDirtyChange(true);
  };

  const formatCurrentFile = async () => {
    if (!selectedFile || taskActive || formatting || !formatSupported) {
      return;
    }

    setFormatting(true);
    const submittedGeneration = openFileGeneration.current;
    const submittedPath = selectedFile.path;
    const submittedContent = editorContentRef.current;
    try {
      const formatted = await formatWorkCode(submittedPath, submittedContent);
      if (
        !aliveRef.current ||
        submittedGeneration !== openFileGeneration.current ||
        selectedFileRef.current?.path !== submittedPath ||
        editorContentRef.current !== submittedContent
      ) {
        return;
      }
      updateEditorContent(formatted);
      toast.success(
        t('work.files.formatted', {
          defaultValue: 'Code formatted.',
        })
      );
    } catch (error) {
      if (
        !aliveRef.current ||
        submittedGeneration !== openFileGeneration.current ||
        selectedFileRef.current?.path !== submittedPath ||
        editorContentRef.current !== submittedContent
      ) {
        return;
      }
      toast.error(
        error instanceof Error
          ? error.message
          : t('work.files.formatFailed', {
              defaultValue: 'Could not format this file.',
            })
      );
    } finally {
      if (aliveRef.current) setFormatting(false);
    }
  };

  const tabs: Array<{
    id: WorkspaceTab;
    label: string;
    icon: typeof FilesIcon;
    testId: string;
  }> = [
    {
      id: 'files',
      label: t('work.workspace.files', { defaultValue: 'Files' }),
      icon: FilesIcon,
      testId: 'work-files-tab',
    },
    {
      id: 'activity',
      label: t('work.workspace.activity', { defaultValue: 'Activity' }),
      icon: Activity,
      testId: 'work-activity-tab',
    },
    {
      id: 'preview',
      label: t('work.workspace.preview', { defaultValue: 'Preview' }),
      icon: Monitor,
      testId: 'work-preview-tab',
    },
  ];

  const handleTabKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    index: number
  ) => {
    let nextIndex: number | null = null;
    if (event.key === 'ArrowRight') {
      nextIndex = (index + (rtl ? -1 : 1) + tabs.length) % tabs.length;
    }
    if (event.key === 'ArrowLeft') {
      nextIndex = (index + (rtl ? 1 : -1) + tabs.length) % tabs.length;
    }
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = tabs.length - 1;
    if (nextIndex === null) return;

    event.preventDefault();
    const nextTab = tabs[nextIndex];
    setTab(nextTab.id);
    event.currentTarget.parentElement
      ?.querySelector<HTMLButtonElement>(`#work-workspace-tab-${nextTab.id}`)
      ?.focus();
  };

  return (
    <section className='flex h-full min-h-0 flex-col bg-surface-raised'>
      <div
        data-testid='work-workspace-toolbar'
        className='flex h-12 shrink-0 items-center gap-2 border-b border-line bg-surface-raised px-2'
      >
        <div
          role='tablist'
          aria-orientation='horizontal'
          aria-label={t('work.workspace.label', {
            defaultValue: 'Workspace views',
          })}
          className='flex shrink-0 items-center rounded-xl border border-line bg-surface-subtle p-0.5'
        >
          {tabs.map((item, index) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                type='button'
                role='tab'
                id={`work-workspace-tab-${item.id}`}
                aria-selected={tab === item.id}
                aria-controls={
                  tab === item.id
                    ? `work-workspace-panel-${item.id}`
                    : undefined
                }
                aria-label={item.label}
                tabIndex={tab === item.id ? 0 : -1}
                title={item.label}
                data-testid={item.testId}
                onClick={() => setTab(item.id)}
                onKeyDown={event => handleTabKeyDown(event, index)}
                className={cn(
                  'flex h-7 items-center gap-1.5 rounded-lg px-2 text-[11px] font-medium transition-[background-color,color,box-shadow]',
                  tab === item.id
                    ? 'bg-surface-raised text-ink shadow-subtle'
                    : 'text-ink-muted hover:text-ink'
                )}
              >
                <Icon className='h-3.5 w-3.5 shrink-0' />
                <span className='hidden xs:inline'>{item.label}</span>
                {item.id === 'activity' && activityCount > 0 && (
                  <span className='rounded-full bg-surface px-1.5 text-[10px] text-ink-muted'>
                    {activityCount}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {tab === 'files' && (
          <>
            <div className='flex min-w-0 flex-1 items-center gap-1.5'>
              {selectedFile && (
                <button
                  type='button'
                  className='inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-ink-muted hover:bg-surface-subtle hover:text-ink sm:hidden'
                  onClick={closeFile}
                  aria-label={t('work.files.back', {
                    defaultValue: 'Back to files',
                  })}
                >
                  <ArrowLeft className='h-3.5 w-3.5 rtl:rotate-180' />
                </button>
              )}
              <span
                dir='ltr'
                className='min-w-0 flex-1 truncate font-mono text-[11px] text-ink-muted'
                title={
                  selectedFile?.path ??
                  `/workspace${currentPath ? `/${currentPath}` : ''}`
                }
              >
                {selectedFile?.path ??
                  `/workspace${currentPath ? `/${currentPath}` : ''}`}
                {dirty && ' •'}
              </span>
            </div>

            <div className='flex shrink-0 items-center gap-1'>
              <button
                type='button'
                disabled={!currentPath}
                onClick={() => void openDirectory(parentPath(currentPath))}
                className={cn(
                  'hidden h-8 w-8 items-center justify-center rounded-lg border border-transparent text-ink-muted hover:border-line hover:bg-surface-subtle hover:text-ink disabled:opacity-30 sm:inline-flex',
                  !selectedFile && 'inline-flex'
                )}
                aria-label={t('work.files.up', {
                  defaultValue: 'Parent folder',
                })}
                title={t('work.files.up', {
                  defaultValue: 'Parent folder',
                })}
              >
                <ArrowLeft className='h-3.5 w-3.5 rtl:rotate-180' />
              </button>
              <button
                type='button'
                data-testid='work-refresh-files-button'
                onClick={() =>
                  void onLoadFiles(currentPath).catch(() => undefined)
                }
                className='inline-flex h-8 w-8 items-center justify-center rounded-lg border border-transparent text-ink-muted hover:border-line hover:bg-surface-subtle hover:text-ink'
                aria-label={t('common.refresh', { defaultValue: 'Refresh' })}
                title={t('common.refresh', { defaultValue: 'Refresh' })}
              >
                <RefreshCw
                  className={cn('h-3.5 w-3.5', loadingFiles && 'animate-spin')}
                />
              </button>
              {selectedFile && diffAvailable && diffStats && (
                <button
                  type='button'
                  data-testid='work-diff-toggle-button'
                  aria-pressed={showDiff}
                  onClick={() => setShowDiff(current => !current)}
                  title={t('work.files.changesSince', {
                    defaultValue: 'What changed since the last turn',
                  })}
                  className={cn(
                    'inline-flex h-8 items-center gap-1.5 rounded-lg border px-2 text-[11px] font-medium transition-colors',
                    showDiff
                      ? 'border-transparent bg-ink text-ink-inverse'
                      : 'border-line text-ink-muted hover:bg-surface-subtle hover:text-ink'
                  )}
                >
                  <GitCompareArrows className='h-3.5 w-3.5 shrink-0' />
                  <span className='hidden sm:inline'>
                    {t('work.files.changes', { defaultValue: 'Changes' })}
                  </span>
                  <span dir='ltr' className='tabular-nums'>
                    <span
                      className={showDiff ? undefined : 'text-[rgb(46,164,79)]'}
                    >
                      +{diffStats.added}
                    </span>{' '}
                    <span
                      className={
                        showDiff ? undefined : 'text-[rgb(255,61,129)]'
                      }
                    >
                      −{diffStats.removed}
                    </span>
                  </span>
                </button>
              )}
              {selectedFile && !showDiff && (
                <>
                  <Button
                    data-testid='work-format-file-button'
                    size='sm'
                    variant='ghost'
                    className='h-8 w-8 rounded-lg px-0 sm:w-auto sm:px-2.5'
                    disabled={taskActive || formatting || !formatSupported}
                    onClick={() => void formatCurrentFile()}
                    aria-busy={formatting || undefined}
                    title={
                      formatSupported
                        ? t('work.files.formatShortcut', {
                            defaultValue: 'Format (Shift+Alt+F)',
                          })
                        : formatTypeSupported
                          ? t('work.files.formatTooLarge', {
                              defaultValue:
                                'Formatting is limited to files under 100,000 characters and 4,000 lines.',
                            })
                          : t('work.files.formatUnsupported', {
                              defaultValue:
                                'Formatting is not available for this file type.',
                            })
                    }
                    aria-label={t('work.files.format', {
                      defaultValue: 'Format file',
                    })}
                  >
                    {formatting ? (
                      <Loader2 className='h-3.5 w-3.5 animate-spin' />
                    ) : (
                      <WandSparkles className='h-3.5 w-3.5' />
                    )}
                    <span className='hidden 2xl:inline'>
                      {t('work.files.format', { defaultValue: 'Format' })}
                    </span>
                  </Button>
                  <Button
                    data-testid='work-save-file-button'
                    size='sm'
                    className='h-8 w-8 rounded-lg bg-[#ff7b52] px-0 text-[#3d120c] hover:bg-[#ff7b52]/90 sm:w-auto sm:px-2.5'
                    disabled={
                      !dirty || taskActive || formatting || actionLoading
                    }
                    onClick={() => void saveFile()}
                    aria-busy={actionLoading || undefined}
                    title={t('work.files.saveShortcut', {
                      defaultValue: 'Save (⌘/Ctrl+S)',
                    })}
                    aria-label={t('common.save')}
                  >
                    {actionLoading ? (
                      <Loader2 className='h-3.5 w-3.5 animate-spin' />
                    ) : (
                      <Save className='h-3.5 w-3.5' />
                    )}
                    <span className='hidden 2xl:inline'>
                      {t('common.save')}
                    </span>
                  </Button>
                </>
              )}
            </div>
          </>
        )}

        {tab === 'activity' && <div className='min-w-0 flex-1' />}

        {tab === 'preview' && (
          <>
            <input
              dir='auto'
              value={previewCommand}
              onChange={event => setPreviewCommand(event.target.value)}
              placeholder={t('work.preview.command', {
                defaultValue: 'Optional start command',
              })}
              aria-label={t('work.preview.command', {
                defaultValue: 'Optional start command',
              })}
              className='h-8 min-w-0 flex-1 rounded-lg border border-line bg-surface px-2.5 font-mono text-[11px] text-ink outline-none placeholder:text-ink-subtle focus:border-primary-500'
            />
            <div className='flex shrink-0 items-center gap-1'>
              {task.previewStatus === 'running' ||
              task.previewStatus === 'starting' ? (
                <Button
                  data-testid='work-stop-preview-button'
                  variant='danger'
                  size='sm'
                  className='h-8 w-8 rounded-lg px-0 sm:w-auto sm:px-2.5'
                  disabled={actionLoading}
                  onClick={() => void onStopPreview()}
                  aria-busy={actionLoading || undefined}
                  aria-label={t('work.preview.stop', {
                    defaultValue: 'Stop preview',
                  })}
                >
                  {actionLoading ? (
                    <Loader2 className='h-3.5 w-3.5 animate-spin' />
                  ) : (
                    <Square className='h-3.5 w-3.5 fill-current' />
                  )}
                  <span className='hidden 2xl:inline'>
                    {t('work.preview.stop', { defaultValue: 'Stop preview' })}
                  </span>
                </Button>
              ) : (
                <Button
                  data-testid='work-start-preview-button'
                  size='sm'
                  className='h-8 w-8 rounded-lg bg-[#ff7b52] px-0 text-[#3d120c] hover:bg-[#ff7b52]/90 sm:w-auto sm:px-2.5'
                  disabled={actionLoading}
                  onClick={() =>
                    void onStartPreview(previewCommand.trim() || undefined)
                  }
                  aria-busy={actionLoading || undefined}
                  aria-label={t('work.preview.start', {
                    defaultValue: 'Start preview',
                  })}
                >
                  {actionLoading ? (
                    <Loader2 className='h-3.5 w-3.5 animate-spin' />
                  ) : (
                    <Play className='h-3.5 w-3.5 fill-current' />
                  )}
                  <span className='hidden 2xl:inline'>
                    {t('work.preview.start', {
                      defaultValue: 'Start preview',
                    })}
                  </span>
                </Button>
              )}
              {previewUrl && (
                <a
                  href={previewUrl}
                  target='_blank'
                  rel='noopener noreferrer'
                  aria-label={t('work.preview.open', { defaultValue: 'Open' })}
                  title={t('work.preview.open', { defaultValue: 'Open' })}
                  className='inline-flex h-8 w-8 items-center justify-center rounded-lg border border-line text-ink-muted hover:bg-surface-subtle hover:text-ink'
                >
                  <ExternalLink className='h-3.5 w-3.5' />
                </a>
              )}
            </div>
          </>
        )}
      </div>

      {tab === 'files' && (
        <div
          id='work-workspace-panel-files'
          role='tabpanel'
          aria-labelledby='work-workspace-tab-files'
          className='flex min-h-0 flex-1'
        >
          <div
            className={cn(
              'flex min-h-0 w-full flex-col border-e border-line bg-surface-raised',
              selectedFile ? 'hidden sm:flex sm:w-52 xl:w-60' : 'flex'
            )}
          >
            <div className='min-h-0 flex-1 overflow-y-auto p-1.5'>
              {loadingFiles && files.length === 0 ? (
                <div className='flex justify-center py-8 text-ink-muted'>
                  <Loader2 className='h-5 w-5 animate-spin' />
                </div>
              ) : files.length === 0 ? (
                <p className='px-3 py-8 text-center text-xs text-ink-muted'>
                  {t('work.files.empty', {
                    defaultValue: 'No files in this folder yet.',
                  })}
                </p>
              ) : (
                [...files]
                  .sort((a, b) => {
                    if (a.type !== b.type)
                      return a.type === 'directory' ? -1 : 1;
                    return a.name.localeCompare(b.name);
                  })
                  .map(entry => (
                    <button
                      key={entry.path}
                      type='button'
                      data-testid='work-file-item'
                      data-path={entry.path}
                      onClick={() => {
                        if (entry.type === 'directory') {
                          void openDirectory(entry.path);
                        } else {
                          void openFile(entry.path);
                        }
                      }}
                      className={cn(
                        'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-start text-xs hover:bg-surface-subtle',
                        selectedFile?.path === entry.path
                          ? 'bg-surface-subtle text-ink'
                          : 'text-ink-muted'
                      )}
                    >
                      {entry.type === 'directory' ? (
                        <Folder className='h-3.5 w-3.5 shrink-0 text-amber-500' />
                      ) : (
                        <File className='h-3.5 w-3.5 shrink-0' />
                      )}
                      <span dir='auto' className='truncate'>
                        {entry.name}
                      </span>
                    </button>
                  ))
              )}
            </div>
          </div>

          <div
            className={cn(
              'min-h-0 min-w-0 flex-1 flex-col',
              selectedFile ? 'flex' : 'hidden sm:flex'
            )}
          >
            {selectedFile && showDiff && diffLines ? (
              <WorkspaceDiffView
                lines={diffLines}
                ariaLabel={t('work.files.diffLabel', {
                  path: selectedFile.path,
                  defaultValue: 'Changes since the last turn: {{path}}',
                })}
              />
            ) : selectedFile ? (
              <WorkspaceCodeEditor
                path={selectedFile.path}
                value={editorContent}
                ariaLabel={t('work.files.editorLabel', {
                  path: selectedFile.path,
                  defaultValue: 'File editor: {{path}}',
                })}
                onChange={updateEditorContent}
                onSaveShortcut={() => {
                  if (dirty && !taskActive && !actionLoading && !formatting) {
                    void saveFile();
                  }
                }}
                onFormatShortcut={() => void formatCurrentFile()}
                disabled={taskActive || formatting}
              />
            ) : (
              <div className='m-auto px-6 text-center text-xs text-ink-muted'>
                <File className='mx-auto mb-3 h-7 w-7 text-ink-subtle' />
                {t('work.files.select', {
                  defaultValue: 'Select a file to inspect and edit it.',
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {tab === 'activity' && (
        <div
          id='work-workspace-panel-activity'
          role='tabpanel'
          aria-labelledby='work-workspace-tab-activity'
          className='min-h-0 flex-1 overflow-y-auto p-3'
        >
          {liveRun && (
            <div className='mb-3'>
              <WorkLiveRunSurface run={liveRun} variant='activity' />
            </div>
          )}
          {activity.length === 0 && !liveRun ? (
            <div className='flex h-full flex-col items-center justify-center px-6 text-center text-xs text-ink-muted'>
              <TerminalSquare className='mb-3 h-7 w-7 text-ink-subtle' />
              {t('work.activity.empty', {
                defaultValue:
                  'Commands, file operations, and tool results will appear here.',
              })}
            </div>
          ) : (
            <div className='space-y-2'>
              {activity.map(message => (
                <div
                  key={message.id}
                  className='rounded-xl border border-line bg-surface p-3'
                >
                  <div className='flex items-center justify-between gap-2'>
                    <span
                      dir='auto'
                      className='truncate font-mono text-xs font-medium text-ink'
                    >
                      {toolName(
                        message,
                        t('work.activity.toolActivity', {
                          defaultValue: 'Tool activity',
                        })
                      )}
                    </span>
                    <span className='shrink-0 text-[10px] uppercase tracking-wide text-ink-subtle rtl:tracking-normal'>
                      {
                        {
                          message: t('work.activity.kinds.message', {
                            defaultValue: 'Message',
                          }),
                          reasoning: t('libreClaw.metrics.reasoning', {
                            defaultValue: 'Reasoning',
                          }),
                          tool_call: t('work.activity.kinds.toolCall', {
                            defaultValue: 'Tool call',
                          }),
                          tool_result: t('work.activity.kinds.toolResult', {
                            defaultValue: 'Tool result',
                          }),
                          error: t('work.activity.kinds.error', {
                            defaultValue: 'Error',
                          }),
                        }[message.kind]
                      }
                    </span>
                  </div>
                  {message.content && (
                    <pre
                      dir='ltr'
                      className='mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-words text-left font-mono text-[11px] leading-relaxed text-ink-muted'
                    >
                      {message.content}
                    </pre>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === 'preview' && (
        <div
          id='work-workspace-panel-preview'
          role='tabpanel'
          aria-labelledby='work-workspace-tab-preview'
          className='flex min-h-0 flex-1 flex-col'
        >
          {task.previewStatus === 'starting' ? (
            <div className='m-auto flex items-center gap-2 text-xs text-ink-muted'>
              <Loader2 className='h-4 w-4 animate-spin' />
              {t('work.preview.starting', {
                defaultValue: 'Starting preview…',
              })}
            </div>
          ) : previewUrl && task.previewStatus === 'running' ? (
            <iframe
              data-testid='work-preview-frame'
              title={t('work.preview.frameTitle', {
                defaultValue: 'Workspace preview',
              })}
              src={previewUrl}
              sandbox='allow-scripts allow-forms allow-modals allow-downloads'
              referrerPolicy='no-referrer'
              className='min-h-0 flex-1 border-0 bg-white'
            />
          ) : (
            <div className='m-auto max-w-sm px-6 text-center text-xs leading-relaxed text-ink-muted'>
              <Monitor className='mx-auto mb-3 h-8 w-8 text-ink-subtle' />
              {task.previewStatus === 'failed'
                ? t('work.preview.failed', {
                    defaultValue:
                      'The preview could not start. Check Activity, then try another command.',
                  })
                : t('work.preview.empty', {
                    defaultValue:
                      'Start the app inside this workspace to inspect it here.',
                  })}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
