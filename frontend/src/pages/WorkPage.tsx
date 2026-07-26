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
  Boxes,
  CheckCircle2,
  ChevronLeft,
  CircleAlert,
  HardDrive,
  Menu,
  MessageSquare,
  Monitor,
  ShieldCheck,
  Wifi,
  WifiOff,
  Wrench,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { useBlocker, useNavigate, useParams } from 'react-router';
import { WorkComposer } from '@/components/work/WorkComposer';
import { WorkConversation } from '@/components/work/WorkConversation';
import { WorkTaskRail } from '@/components/work/WorkTaskRail';
import { WorkspacePane } from '@/components/work/WorkspacePane';
import { useChatStore } from '@/store/chatStore';
import { useWorkStore } from '@/store/workStore';
import {
  isWorkTaskActive,
  workModelSelectionKey,
  type WorkFile,
  type WorkModelOption,
  type WorkTask,
} from '@/types/work';
import { cn } from '@/utils';
import { clearWorkDraft, clearWorkTaskDrafts } from '@/utils/workDrafts';

type MobileSurface = 'conversation' | 'workspace';

const taskStatusTone: Record<
  WorkTask['status'],
  { dot: string; text: string }
> = {
  idle: { dot: 'bg-gray-400', text: 'text-ink-muted' },
  preparing: { dot: 'bg-amber-500 animate-pulse', text: 'text-amber-700' },
  running: { dot: 'bg-primary-500 animate-pulse', text: 'text-primary-700' },
  completed: { dot: 'bg-emerald-500', text: 'text-emerald-700' },
  failed: { dot: 'bg-error-500', text: 'text-error-600' },
  cancelled: { dot: 'bg-gray-400', text: 'text-ink-muted' },
};

const workModel = (name: string): boolean => {
  const normalized = name.trim().toLowerCase();
  return Boolean(normalized) && !normalized.includes('embed');
};

const errorMessage = (error: unknown, fallback: string): string =>
  error instanceof Error && error.message ? error.message : fallback;

export default function WorkPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { taskId } = useParams<{ taskId: string }>();
  const chatModels = useChatStore(state => state.models);
  const chatSelectedModel = useChatStore(state => state.selectedModel);
  const {
    capabilities,
    tasks,
    selectedTask,
    files,
    selectedFile,
    loadingTasks,
    loadingTask,
    loadingOlderMessages,
    loadingFiles,
    actionLoading,
    error,
    loadCapabilities,
    loadTasks,
    selectTask,
    loadTask,
    loadOlderMessages,
    createTask,
    updateTask,
    deleteTask,
    startRun,
    cancelRun,
    loadFiles,
    loadFile,
    clearSelectedFile,
    saveFile,
    startPreview,
    stopPreview,
    clearError,
  } = useWorkStore();
  const models = useMemo(
    () => chatModels.filter(model => !model.isPersona && workModel(model.name)),
    [chatModels]
  );
  const modelOptions = useMemo<WorkModelOption[]>(
    () =>
      models.flatMap(model => {
        if (model.isPlugin && !model.pluginId) return [];
        const providerType = model.isPlugin ? 'plugin' : 'ollama';
        const providerId = model.isPlugin ? model.pluginId : undefined;
        const normalized = model.name.trim().toLowerCase();
        const selection = {
          model: model.name,
          providerType,
          providerId,
        } as const;
        return [
          {
            ...selection,
            key: workModelSelectionKey(selection),
            label:
              model.isPlugin && model.pluginName
                ? `${model.name} · ${model.pluginName}`
                : model.name,
            remote:
              model.isPlugin ||
              normalized.endsWith(':cloud') ||
              normalized.endsWith('-cloud'),
          },
        ];
      }),
    [models]
  );
  const [draftModelKey, setDraftModelKey] = useState('');
  const [draftNetwork, setDraftNetwork] = useState(false);
  const [mobileRailOpen, setMobileRailOpen] = useState(false);
  const [mobileSurface, setMobileSurface] =
    useState<MobileSurface>('conversation');
  const [workspaceDirty, setWorkspaceDirty] = useState(false);

  useEffect(() => {
    void loadCapabilities();
    void loadTasks();
  }, [loadCapabilities, loadTasks]);

  useEffect(() => {
    if (!taskId) {
      selectTask(null);
      return;
    }
    selectTask(taskId);
    void loadTask(taskId).catch(() => undefined);
    void loadFiles(taskId, '').catch(() => undefined);
  }, [taskId, loadFiles, loadTask, selectTask]);

  const freshModel =
    modelOptions.find(model => model.key === draftModelKey) ||
    modelOptions.find(
      model =>
        model.providerType === 'ollama' && model.model === chatSelectedModel
    ) ||
    modelOptions[0];

  const selectedTaskSummary = taskId
    ? tasks.find(task => task.id === taskId)
    : undefined;
  const selectedStatus = selectedTaskSummary?.status ?? selectedTask?.status;
  const summaryPollingActive =
    selectedStatus === 'preparing' || selectedStatus === 'running';
  const summaryPollingDelay = summaryPollingActive ? 1000 : 4000;

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;

    const poll = async () => {
      await loadTasks(true);
      if (!stopped) timer = setTimeout(poll, summaryPollingDelay);
    };

    timer = setTimeout(poll, summaryPollingDelay);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [loadTasks, summaryPollingDelay]);

  const previousStatusRef = useRef<{
    taskId: string;
    status: WorkTask['status'];
  } | null>(null);
  useEffect(() => {
    if (!taskId || !selectedStatus) {
      previousStatusRef.current = null;
      return;
    }
    const previous = previousStatusRef.current;
    previousStatusRef.current = { taskId, status: selectedStatus };
    if (
      previous?.taskId === taskId &&
      (previous.status === 'preparing' || previous.status === 'running') &&
      selectedStatus !== 'preparing' &&
      selectedStatus !== 'running'
    ) {
      void loadTask(taskId, true).catch(() => undefined);
      void loadFiles(taskId, '').catch(() => undefined);
    }
  }, [loadFiles, loadTask, selectedStatus, taskId]);

  useEffect(() => {
    if (!workspaceDirty) return;
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', warnBeforeUnload);
    return () => window.removeEventListener('beforeunload', warnBeforeUnload);
  }, [workspaceDirty]);

  const confirmWorkspaceDiscard = useCallback(
    (): boolean =>
      !workspaceDirty ||
      window.confirm(
        t('work.files.discard', {
          defaultValue: 'Discard unsaved file changes?',
        })
      ),
    [t, workspaceDirty]
  );
  const confirmWorkspaceNavigation = useCallback(
    (): boolean =>
      !workspaceDirty ||
      window.confirm(
        t('work.files.leaveWithDraft', {
          defaultValue:
            'Leave this file? Your unsaved edit will remain as a browser draft.',
        })
      ),
    [t, workspaceDirty]
  );

  const discardSelectedDraft = () => {
    if (selectedTask && selectedFile) {
      clearWorkDraft(selectedTask.id, selectedFile.path);
    }
  };

  const navigationBlocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      workspaceDirty &&
      `${currentLocation.pathname}${currentLocation.search}${currentLocation.hash}` !==
        `${nextLocation.pathname}${nextLocation.search}${nextLocation.hash}`
  );

  useEffect(() => {
    if (navigationBlocker.state !== 'blocked') return;
    if (!confirmWorkspaceNavigation()) {
      navigationBlocker.reset();
      return;
    }

    const proceed = navigationBlocker.proceed;
    const clearDirtyTimer = window.setTimeout(() => {
      setWorkspaceDirty(false);
      window.setTimeout(proceed, 0);
    }, 0);
    return () => window.clearTimeout(clearDirtyTimer);
  }, [confirmWorkspaceNavigation, navigationBlocker]);

  const goToNewTask = () => {
    clearError();
    setDraftNetwork(false);
    setMobileRailOpen(false);
    setMobileSurface('conversation');
    navigate('/work');
  };

  const submitMessage = async (message: string): Promise<boolean> => {
    if (selectedTask && !confirmWorkspaceDiscard()) return false;
    if (selectedTask && workspaceDirty) {
      discardSelectedDraft();
      clearSelectedFile();
      setWorkspaceDirty(false);
    }
    try {
      if (selectedTask) {
        await startRun(selectedTask.id, {
          message,
          model: selectedTask.model,
          providerType: selectedTask.providerType,
          providerId: selectedTask.providerId || undefined,
        });
      } else {
        if (!freshModel)
          throw new Error('No Work-compatible model is selected.');
        const task = await createTask({
          message,
          model: freshModel.model,
          providerType: freshModel.providerType,
          providerId: freshModel.providerId,
          networkEnabled: draftNetwork,
        });
        navigate(`/work/${task.id}`);
      }
      return true;
    } catch (submitError) {
      toast.error(
        errorMessage(
          submitError,
          t('work.toasts.runFailed', {
            defaultValue: 'Could not start the Work task.',
          })
        )
      );
      return false;
    }
  };

  const changeModel = async (modelKey: string) => {
    const model = effectiveModelOptions.find(option => option.key === modelKey);
    if (!model) return;
    if (!selectedTask) {
      setDraftModelKey(modelKey);
      return;
    }
    try {
      await updateTask(selectedTask.id, {
        model: model.model,
        providerType: model.providerType,
        providerId: model.providerId,
      });
    } catch (updateError) {
      toast.error(
        errorMessage(
          updateError,
          t('work.toasts.updateFailed', {
            defaultValue: 'Could not update this task.',
          })
        )
      );
    }
  };

  const changeNetwork = async (enabled: boolean) => {
    if (!selectedTask) {
      setDraftNetwork(enabled);
      return;
    }
    try {
      await updateTask(selectedTask.id, { networkEnabled: enabled });
    } catch (updateError) {
      toast.error(
        errorMessage(
          updateError,
          t('work.toasts.networkFailed', {
            defaultValue: 'Could not update network access.',
          })
        )
      );
    }
  };

  const stopRun = async () => {
    if (!selectedTask) return;
    try {
      await cancelRun(selectedTask.id);
      toast.success(
        t('work.toasts.cancelled', { defaultValue: 'Work run stopped.' })
      );
    } catch (cancelError) {
      toast.error(
        errorMessage(
          cancelError,
          t('work.toasts.cancelFailed', {
            defaultValue: 'Could not stop the Work run.',
          })
        )
      );
    }
  };

  const removeTask = async (id: string) => {
    const task = tasks.find(item => item.id === id);
    if (
      !window.confirm(
        t('work.tasks.deleteConfirm', {
          defaultValue: 'Delete “{{title}}” and its workspace permanently?',
          title:
            task?.title ||
            t('work.tasks.untitled', {
              defaultValue: 'Untitled task',
            }),
        })
      )
    ) {
      return;
    }
    const discardingCurrentDraft = taskId === id && workspaceDirty;
    if (discardingCurrentDraft) setWorkspaceDirty(false);
    try {
      await deleteTask(id);
      clearWorkTaskDrafts(id);
      if (taskId === id) {
        navigate('/work');
      }
    } catch (deleteError) {
      if (discardingCurrentDraft) setWorkspaceDirty(true);
      toast.error(
        errorMessage(
          deleteError,
          t('work.toasts.deleteFailed', {
            defaultValue: 'Could not delete this Work task.',
          })
        )
      );
    }
  };

  const commitTitle = async (value: string): Promise<boolean> => {
    if (!selectedTask) return false;
    const title = value.trim();
    if (!title || title === selectedTask.title) {
      return Boolean(title);
    }
    try {
      await updateTask(selectedTask.id, { title });
      return true;
    } catch (updateError) {
      toast.error(errorMessage(updateError, 'Could not rename this task.'));
      return false;
    }
  };

  const runWorkspaceAction = async (
    action: () => Promise<unknown>,
    fallback: string,
    success?: string
  ): Promise<boolean> => {
    try {
      await action();
      if (success) toast.success(success);
      return true;
    } catch (actionError) {
      toast.error(errorMessage(actionError, fallback));
      return false;
    }
  };

  const saveWorkspaceFile = async (
    path: string,
    content: string,
    expectedUpdatedAt?: number
  ): Promise<WorkFile | false> => {
    if (!selectedTask) return false;
    try {
      const file = await saveFile(
        selectedTask.id,
        path,
        content,
        expectedUpdatedAt
      );
      toast.success(t('work.toasts.saved', { defaultValue: 'File saved.' }));
      return file;
    } catch (actionError) {
      toast.error(
        errorMessage(
          actionError,
          t('work.toasts.saveFailed', {
            defaultValue: 'Could not save this file.',
          })
        )
      );
      return false;
    }
  };

  const runtimeUnavailable = capabilities?.available === false;
  const runtimeReadyLabel = capabilities?.pluginAvailable
    ? capabilities.ollamaAvailable
      ? t('work.runtime.readyHybrid', {
          defaultValue: 'Docker + models ready',
        })
      : t('work.runtime.readyPlugin', {
          defaultValue: 'Docker + plugin ready',
        })
    : t('work.runtime.readyOllama', {
        defaultValue: 'Docker + Ollama ready',
      });
  const activeTask = selectedTask ? isWorkTaskActive(selectedTask) : false;
  const taskModel = selectedTask
    ? {
        model: selectedTask.model,
        providerType: selectedTask.providerType,
        providerId: selectedTask.providerId || undefined,
      }
    : undefined;
  const selectedModelKey = taskModel
    ? workModelSelectionKey(taskModel)
    : freshModel?.key || '';
  const persistedModelOption =
    taskModel && !modelOptions.some(option => option.key === selectedModelKey)
      ? {
          ...taskModel,
          key: selectedModelKey,
          label: `${taskModel.model} · ${
            taskModel.providerType === 'plugin'
              ? taskModel.providerId || 'plugin'
              : 'Ollama'
          }`,
          remote:
            taskModel.providerType === 'plugin' ||
            taskModel.model.toLowerCase().endsWith(':cloud') ||
            taskModel.model.toLowerCase().endsWith('-cloud'),
        }
      : undefined;
  const effectiveModelOptions = persistedModelOption
    ? [persistedModelOption, ...modelOptions]
    : modelOptions;
  const networkEnabled = selectedTask?.networkEnabled ?? draftNetwork;
  const tone = selectedTask
    ? taskStatusTone[selectedTask.status]
    : taskStatusTone.idle;

  return (
    <div
      data-testid='work-page'
      className='relative flex h-full min-h-0 overflow-hidden bg-surface'
    >
      <WorkTaskRail
        tasks={tasks}
        selectedTaskId={taskId || null}
        loading={loadingTasks}
        mobileOpen={mobileRailOpen}
        onCloseMobile={() => setMobileRailOpen(false)}
        onNewTask={goToNewTask}
        onSelectTask={id => {
          setMobileRailOpen(false);
          setMobileSurface('conversation');
          navigate(`/work/${id}`);
        }}
        onDeleteTask={id => void removeTask(id)}
      />

      <main className='flex min-h-0 min-w-0 flex-1 flex-col'>
        <header className='flex h-16 shrink-0 items-center gap-3 border-b border-line bg-surface-raised px-3 md:px-4'>
          <button
            type='button'
            onClick={() => setMobileRailOpen(true)}
            className='rounded-lg p-2 text-ink-muted hover:bg-surface-subtle hover:text-ink lg:hidden'
            aria-label={t('work.tasks.open', {
              defaultValue: 'Open Work tasks',
            })}
          >
            <Menu className='h-5 w-5' />
          </button>

          {selectedTask ? (
            <input
              key={`${selectedTask.id}:${selectedTask.title}`}
              data-testid='work-task-title'
              defaultValue={selectedTask.title}
              onBlur={event => {
                const input = event.currentTarget;
                if (!input.value.trim()) {
                  input.value = selectedTask.title;
                  return;
                }
                void commitTitle(input.value).then(saved => {
                  if (!saved) input.value = selectedTask.title;
                });
              }}
              onKeyDown={event => {
                if (event.key === 'Enter') event.currentTarget.blur();
                if (event.key === 'Escape') {
                  event.currentTarget.value = selectedTask.title;
                  event.currentTarget.blur();
                }
              }}
              className='min-w-0 max-w-sm flex-1 truncate rounded-lg border border-transparent bg-transparent px-2 py-1 text-sm font-semibold text-ink outline-none hover:border-line focus:border-primary-500 focus:bg-surface'
              aria-label={t('work.tasks.rename', {
                defaultValue: 'Task title',
              })}
            />
          ) : (
            <div className='min-w-0 flex-1'>
              <h1 className='truncate text-sm font-semibold text-ink'>
                {t('work.title', { defaultValue: 'Work' })}
              </h1>
              <p className='truncate text-xs text-ink-muted'>
                {t('work.subtitle', {
                  defaultValue: 'Isolated model workspaces',
                })}
              </p>
            </div>
          )}

          <div className='ms-auto hidden min-w-0 items-center gap-2 sm:flex'>
            {selectedTask && (
              <span
                className={cn(
                  'inline-flex h-7 items-center gap-1.5 rounded-full border border-line px-2.5 text-[11px] font-medium capitalize',
                  tone.text
                )}
              >
                <span
                  aria-hidden='true'
                  className={cn('h-1.5 w-1.5 rounded-full', tone.dot)}
                />
                {selectedTask.status}
              </span>
            )}
            <span
              className={cn(
                'inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[11px] font-medium',
                runtimeUnavailable
                  ? 'border-error-500/30 bg-error-500/10 text-error-600'
                  : 'border-line bg-surface text-ink-muted'
              )}
              title={
                capabilities?.image
                  ? `${runtimeReadyLabel} · ${capabilities.image}`
                  : runtimeReadyLabel
              }
            >
              <Boxes className='h-3.5 w-3.5' />
              {runtimeUnavailable
                ? t('work.runtime.unavailable', {
                    defaultValue: 'Runtime unavailable',
                  })
                : runtimeReadyLabel}
            </span>
            {selectedTask && (
              <>
                <span className='hidden h-7 max-w-44 items-center gap-1.5 truncate rounded-full border border-line bg-surface px-2.5 text-[11px] font-medium text-ink-muted md:inline-flex'>
                  <HardDrive className='h-3.5 w-3.5 shrink-0' />
                  <span className='truncate'>{selectedTask.model}</span>
                </span>
                <span
                  className={cn(
                    'hidden h-7 items-center gap-1.5 rounded-full border px-2.5 text-[11px] font-medium md:inline-flex',
                    selectedTask.networkEnabled
                      ? 'border-amber-500/30 bg-amber-500/10 text-amber-700'
                      : 'border-line bg-surface text-ink-muted'
                  )}
                >
                  {selectedTask.networkEnabled ? (
                    <Wifi className='h-3.5 w-3.5' />
                  ) : (
                    <WifiOff className='h-3.5 w-3.5' />
                  )}
                  {selectedTask.networkEnabled
                    ? t('work.composer.networkOn', {
                        defaultValue: 'Network on',
                      })
                    : t('work.composer.networkOff', {
                        defaultValue: 'Network off',
                      })}
                </span>
              </>
            )}
          </div>
        </header>

        {(runtimeUnavailable || error) && (
          <div
            className={cn(
              'flex shrink-0 items-center gap-2 border-b px-4 py-2 text-xs',
              runtimeUnavailable
                ? 'border-error-500/20 bg-error-500/10 text-error-700'
                : 'border-amber-500/20 bg-amber-500/10 text-amber-800'
            )}
          >
            <CircleAlert className='h-4 w-4 shrink-0' />
            <span className='min-w-0 flex-1'>
              {runtimeUnavailable
                ? capabilities?.reason ||
                  t('work.runtime.reason', {
                    defaultValue:
                      'Docker and an available Ollama or plugin model provider are required.',
                  })
                : error}
            </span>
            {error && !runtimeUnavailable && (
              <button
                type='button'
                className='rounded-md p-1 hover:bg-black/5'
                onClick={clearError}
                aria-label={t('common.close')}
              >
                ×
              </button>
            )}
          </div>
        )}

        {!taskId ? (
          <>
            <div className='min-h-0 flex-1 overflow-y-auto'>
              <div className='mx-auto flex min-h-full max-w-3xl flex-col justify-center px-6 py-10'>
                <div className='max-w-2xl'>
                  <div className='mb-5 flex h-14 w-14 items-center justify-center rounded-2xl border border-line bg-surface-raised shadow-subtle'>
                    <Wrench className='h-7 w-7 text-primary-600' />
                  </div>
                  <h2 className='text-3xl font-semibold tracking-[-0.035em] text-ink md:text-4xl'>
                    {t('work.landing.title', {
                      defaultValue: 'Start a new Work task',
                    })}
                  </h2>
                  <p className='mt-3 max-w-xl text-sm leading-relaxed text-ink-muted md:text-base'>
                    {t('work.landing.description', {
                      defaultValue:
                        'Give a local model a durable, isolated workspace. It can inspect files, run tools, and continue where it left off when you return.',
                    })}
                  </p>
                </div>
                <div className='mt-8 grid gap-3 sm:grid-cols-3'>
                  {[
                    {
                      icon: Boxes,
                      title: t('work.landing.isolated', {
                        defaultValue: 'Isolated',
                      }),
                      body: t('work.landing.isolatedBody', {
                        defaultValue:
                          'Every task gets its own container and files.',
                      }),
                    },
                    {
                      icon: CheckCircle2,
                      title: t('work.landing.durable', {
                        defaultValue: 'Durable',
                      }),
                      body: t('work.landing.durableBody', {
                        defaultValue:
                          'Return to its conversation and workspace later.',
                      }),
                    },
                    {
                      icon: ShieldCheck,
                      title: t('work.landing.controlled', {
                        defaultValue: 'Controlled',
                      }),
                      body: t('work.landing.controlledBody', {
                        defaultValue:
                          'Network access stays off until you opt in.',
                      }),
                    },
                  ].map(item => {
                    const Icon = item.icon;
                    return (
                      <div
                        key={item.title}
                        className='rounded-2xl border border-line bg-surface-raised p-4'
                      >
                        <Icon className='h-5 w-5 text-ink-muted' />
                        <p className='mt-3 text-sm font-semibold text-ink'>
                          {item.title}
                        </p>
                        <p className='mt-1 text-xs leading-relaxed text-ink-muted'>
                          {item.body}
                        </p>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
            <WorkComposer
              models={modelOptions}
              modelKey={freshModel?.key || ''}
              networkEnabled={draftNetwork}
              running={false}
              loading={actionLoading}
              disabled={runtimeUnavailable}
              onModelChange={changeModel}
              onNetworkChange={changeNetwork}
              onSubmit={submitMessage}
              onCancel={stopRun}
            />
          </>
        ) : selectedTask ? (
          <>
            <div className='flex h-10 shrink-0 items-center justify-center gap-1 border-b border-line px-3 xl:hidden'>
              <button
                type='button'
                onClick={() => setMobileSurface('conversation')}
                className={cn(
                  'flex h-8 items-center gap-1.5 rounded-lg px-3 text-xs font-medium',
                  mobileSurface === 'conversation'
                    ? 'bg-surface-subtle text-ink'
                    : 'text-ink-muted'
                )}
              >
                <MessageSquare className='h-3.5 w-3.5' />
                {t('work.mobile.conversation', {
                  defaultValue: 'Conversation',
                })}
              </button>
              <button
                type='button'
                onClick={() => setMobileSurface('workspace')}
                className={cn(
                  'flex h-8 items-center gap-1.5 rounded-lg px-3 text-xs font-medium',
                  mobileSurface === 'workspace'
                    ? 'bg-surface-subtle text-ink'
                    : 'text-ink-muted'
                )}
              >
                <Monitor className='h-3.5 w-3.5' />
                {t('work.mobile.workspace', { defaultValue: 'Workspace' })}
              </button>
            </div>
            <div className='flex min-h-0 flex-1'>
              <section
                className={cn(
                  'min-h-0 min-w-0 flex-1 flex-col bg-surface xl:flex xl:basis-1/2',
                  mobileSurface === 'conversation' ? 'flex' : 'hidden'
                )}
              >
                <WorkConversation
                  task={selectedTask}
                  loading={loadingTask}
                  loadingOlder={loadingOlderMessages}
                  onLoadOlder={() => loadOlderMessages(selectedTask.id)}
                />
                <WorkComposer
                  key={selectedTask.id}
                  models={effectiveModelOptions}
                  modelKey={selectedModelKey}
                  networkEnabled={networkEnabled}
                  running={activeTask}
                  loading={actionLoading}
                  disabled={runtimeUnavailable}
                  onModelChange={changeModel}
                  onNetworkChange={changeNetwork}
                  onSubmit={submitMessage}
                  onCancel={stopRun}
                />
              </section>
              <section
                className={cn(
                  'min-h-0 min-w-0 flex-1 border-s border-line xl:flex xl:basis-1/2',
                  mobileSurface === 'workspace' ? 'flex' : 'hidden'
                )}
              >
                <div className='min-h-0 min-w-0 flex-1'>
                  <WorkspacePane
                    key={selectedTask.id}
                    task={selectedTask}
                    files={files}
                    selectedFile={selectedFile}
                    loadingFiles={loadingFiles}
                    actionLoading={actionLoading}
                    onLoadFiles={path => loadFiles(selectedTask.id, path)}
                    onLoadFile={path => loadFile(selectedTask.id, path)}
                    onClearSelectedFile={clearSelectedFile}
                    onSaveFile={saveWorkspaceFile}
                    onStartPreview={command =>
                      runWorkspaceAction(
                        () => startPreview(selectedTask.id, command),
                        t('work.toasts.previewFailed', {
                          defaultValue: 'Could not start the preview.',
                        })
                      )
                    }
                    onStopPreview={() =>
                      runWorkspaceAction(
                        () => stopPreview(selectedTask.id),
                        t('work.toasts.previewStopFailed', {
                          defaultValue: 'Could not stop the preview.',
                        })
                      )
                    }
                    onDirtyChange={setWorkspaceDirty}
                  />
                </div>
              </section>
            </div>
          </>
        ) : (
          <div className='flex min-h-0 flex-1 flex-col items-center justify-center px-6 text-center'>
            {loadingTask ? (
              <div className='text-sm text-ink-muted'>
                {t('work.tasks.loading', { defaultValue: 'Loading task…' })}
              </div>
            ) : (
              <>
                <CircleAlert className='mb-3 h-8 w-8 text-ink-subtle' />
                <h2 className='text-lg font-semibold text-ink'>
                  {t('work.tasks.notFound', {
                    defaultValue: 'This Work task is unavailable',
                  })}
                </h2>
                <button
                  type='button'
                  onClick={goToNewTask}
                  className='mt-4 inline-flex items-center gap-1.5 text-sm font-medium text-primary-600 hover:text-primary-700'
                >
                  <ChevronLeft className='h-4 w-4' />
                  {t('work.tasks.back', {
                    defaultValue: 'Start a new task',
                  })}
                </button>
              </>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
