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
  Loader2,
  Monitor,
  Play,
  RefreshCw,
  Save,
  Square,
  TerminalSquare,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui';
import type {
  WorkFile,
  WorkFileEntry,
  WorkMessage,
  WorkTask,
} from '@/types/work';
import { cn } from '@/utils';
import {
  clearWorkDraft,
  loadWorkDraft,
  saveWorkDraft,
} from '@/utils/workDrafts';

type WorkspaceTab = 'files' | 'activity' | 'preview';

interface WorkspacePaneProps {
  task: WorkTask;
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

const toolName = (message: WorkMessage): string => {
  const value =
    message.metadata?.name ??
    message.metadata?.toolName ??
    message.metadata?.tool ??
    message.metadata?.command;
  return typeof value === 'string' && value ? value : message.kind;
};

export function WorkspacePane({
  task,
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
  const { t } = useTranslation();
  const [tab, setTab] = useState<WorkspaceTab>('files');
  const [currentPath, setCurrentPath] = useState('');
  const [editorContent, setEditorContent] = useState('');
  const [editorBaseUpdatedAt, setEditorBaseUpdatedAt] = useState<
    number | undefined
  >();
  const [previewCommand, setPreviewCommand] = useState('');
  const previewUrl = safePreviewUrl(task.previewUrl);
  const activity = useMemo(
    () =>
      (task.messages || []).filter(
        message => message.role === 'tool' || message.kind !== 'message'
      ),
    [task.messages]
  );
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

  useEffect(() => {
    editorContentRef.current = editorContent;
    editorBaseUpdatedAtRef.current = editorBaseUpdatedAt;
    selectedFileRef.current = selectedFile;
    taskIdRef.current = task.id;
  }, [editorBaseUpdatedAt, editorContent, selectedFile, task.id]);

  useEffect(() => {
    onLoadFilesRef.current = onLoadFiles;
    onLoadFileRef.current = onLoadFile;
  }, [onLoadFile, onLoadFiles]);

  useEffect(
    () => () => {
      onDirtyChange(false);
    },
    [onDirtyChange]
  );

  useEffect(() => {
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
              generation !== openFileGeneration.current ||
              file.path !== selectedPath ||
              editorContentRef.current !== editorContentAtLoad ||
              editorBaseUpdatedAtRef.current !== editorBaseAtLoad
            ) {
              return;
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
  }, [currentPath, dirty, selectedFile, taskActive]);

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
    setCurrentPath(path);
    await onLoadFiles(path).catch(() => undefined);
  };

  const openFile = async (path: string) => {
    if (!confirmDiscard()) return;
    const generation = ++openFileGeneration.current;
    discardCurrentDraft();
    const file = await onLoadFile(path).catch(() => undefined);
    if (!file || generation !== openFileGeneration.current) return;
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
      result === false ||
      submittedGeneration !== openFileGeneration.current ||
      taskIdRef.current !== submittedTaskId ||
      selectedFileRef.current?.path !== submittedPath
    )
      return;

    const updatedAt = result.updatedAt ?? result.modifiedAt;
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

  return (
    <section className='flex h-full min-h-0 flex-col bg-surface-raised'>
      <div className='flex h-12 shrink-0 items-center border-b border-line px-2'>
        {tabs.map(item => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              type='button'
              data-testid={item.testId}
              onClick={() => setTab(item.id)}
              className={cn(
                'flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium transition-colors',
                tab === item.id
                  ? 'bg-surface-subtle text-ink'
                  : 'text-ink-muted hover:text-ink'
              )}
            >
              <Icon className='h-3.5 w-3.5' />
              {item.label}
              {item.id === 'activity' && activity.length > 0 && (
                <span className='rounded-full bg-surface px-1.5 text-[10px] text-ink-muted'>
                  {activity.length}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {tab === 'files' && (
        <div className='flex min-h-0 flex-1'>
          <div
            className={cn(
              'flex min-h-0 w-full flex-col border-e border-line',
              selectedFile ? 'hidden sm:flex sm:w-52 xl:w-60' : 'flex'
            )}
          >
            <div className='flex h-10 shrink-0 items-center gap-1 border-b border-line px-2'>
              <button
                type='button'
                disabled={!currentPath}
                onClick={() => void openDirectory(parentPath(currentPath))}
                className='rounded-lg p-1.5 text-ink-muted hover:bg-surface-subtle hover:text-ink disabled:opacity-30'
                aria-label={t('work.files.up', {
                  defaultValue: 'Parent folder',
                })}
              >
                <ArrowLeft className='h-3.5 w-3.5' />
              </button>
              <span className='min-w-0 flex-1 truncate font-mono text-[11px] text-ink-muted'>
                /workspace{currentPath ? `/${currentPath}` : ''}
              </span>
              <button
                type='button'
                onClick={() =>
                  void onLoadFiles(currentPath).catch(() => undefined)
                }
                className='rounded-lg p-1.5 text-ink-muted hover:bg-surface-subtle hover:text-ink'
                aria-label={t('common.refresh', { defaultValue: 'Refresh' })}
              >
                <RefreshCw
                  className={cn('h-3.5 w-3.5', loadingFiles && 'animate-spin')}
                />
              </button>
            </div>
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
                      <span className='truncate'>{entry.name}</span>
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
            {selectedFile ? (
              <>
                <div className='flex h-10 shrink-0 items-center gap-2 border-b border-line px-2.5'>
                  <button
                    type='button'
                    className='rounded-lg p-1.5 text-ink-muted hover:bg-surface-subtle sm:hidden'
                    onClick={closeFile}
                    aria-label={t('work.files.back', {
                      defaultValue: 'Back to files',
                    })}
                  >
                    <ArrowLeft className='h-3.5 w-3.5' />
                  </button>
                  <span className='min-w-0 flex-1 truncate font-mono text-[11px] text-ink'>
                    {selectedFile.path}
                    {dirty && ' •'}
                  </span>
                  <Button
                    data-testid='work-save-file-button'
                    size='sm'
                    variant='secondary'
                    className='h-7 rounded-lg px-2 text-xs'
                    loading={actionLoading}
                    disabled={!dirty || taskActive}
                    onClick={() => void saveFile()}
                  >
                    <Save className='h-3.5 w-3.5' />
                    {t('common.save')}
                  </Button>
                </div>
                <textarea
                  data-testid='work-file-editor'
                  value={editorContent}
                  onChange={event => {
                    const content = event.target.value;
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
                  }}
                  disabled={taskActive}
                  spellCheck={false}
                  className='min-h-0 flex-1 resize-none bg-surface p-4 font-mono text-xs leading-relaxed text-ink outline-none disabled:cursor-not-allowed disabled:opacity-60'
                />
              </>
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
        <div className='min-h-0 flex-1 overflow-y-auto p-3'>
          {activity.length === 0 ? (
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
                    <span className='truncate font-mono text-xs font-medium text-ink'>
                      {toolName(message)}
                    </span>
                    <span className='shrink-0 text-[10px] uppercase tracking-wide text-ink-subtle'>
                      {message.kind.replace('_', ' ')}
                    </span>
                  </div>
                  {message.content && (
                    <pre className='mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-ink-muted'>
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
        <div className='flex min-h-0 flex-1 flex-col'>
          <div className='flex flex-wrap items-center gap-2 border-b border-line p-2.5'>
            <input
              value={previewCommand}
              onChange={event => setPreviewCommand(event.target.value)}
              placeholder={t('work.preview.command', {
                defaultValue: 'Optional start command',
              })}
              className='h-8 min-w-40 flex-1 rounded-lg border border-line bg-surface px-2.5 font-mono text-xs text-ink outline-none focus:border-primary-500'
            />
            {task.previewStatus === 'running' ||
            task.previewStatus === 'starting' ? (
              <Button
                data-testid='work-stop-preview-button'
                variant='danger'
                size='sm'
                className='h-8 rounded-lg'
                loading={actionLoading}
                onClick={() => void onStopPreview()}
              >
                <Square className='h-3.5 w-3.5 fill-current' />
                {t('work.preview.stop', { defaultValue: 'Stop preview' })}
              </Button>
            ) : (
              <Button
                data-testid='work-start-preview-button'
                size='sm'
                className='h-8 rounded-lg'
                loading={actionLoading}
                disabled={!task.networkEnabled}
                title={
                  task.networkEnabled
                    ? undefined
                    : t('work.preview.networkRequired', {
                        defaultValue:
                          'Enable network access to start a preview.',
                      })
                }
                onClick={() =>
                  void onStartPreview(previewCommand.trim() || undefined)
                }
              >
                <Play className='h-3.5 w-3.5 fill-current' />
                {t('work.preview.start', { defaultValue: 'Start preview' })}
              </Button>
            )}
            {previewUrl && (
              <a
                href={previewUrl}
                target='_blank'
                rel='noopener noreferrer'
                className='inline-flex h-8 items-center gap-1.5 rounded-lg border border-line px-2.5 text-xs font-medium text-ink-muted hover:bg-surface-subtle hover:text-ink'
              >
                <ExternalLink className='h-3.5 w-3.5' />
                {t('work.preview.open', { defaultValue: 'Open' })}
              </a>
            )}
          </div>

          {!task.networkEnabled ? (
            <div className='m-auto max-w-sm px-6 text-center text-xs leading-relaxed text-ink-muted'>
              <Monitor className='mx-auto mb-3 h-8 w-8 text-ink-subtle' />
              {t('work.preview.enableNetwork', {
                defaultValue:
                  'Preview is off. Enable network access for this task only when you are ready to expose its local development server.',
              })}
            </div>
          ) : task.previewStatus === 'starting' ? (
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
