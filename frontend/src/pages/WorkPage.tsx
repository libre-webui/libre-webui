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
  MessageSquare,
  Monitor,
  MoreHorizontal,
  ShieldCheck,
  Trash2,
  Wrench,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { useBlocker, useLocation, useNavigate, useParams } from 'react-router';
import { WorkComposer } from '@/components/work/WorkComposer';
import { WorkConversation } from '@/components/work/WorkConversation';
import { WorkSplitPane } from '@/components/work/WorkSplitPane';
import { WorkspacePane } from '@/components/work/WorkspacePane';
import { useAppStore } from '@/store/appStore';
import { useAuthStore } from '@/store/authStore';
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
import { preferencesApi } from '@/utils/api';
import { clearWorkDraft, clearWorkTaskDrafts } from '@/utils/workDrafts';
import { workStatusPresentation } from '@/utils/workStatus';

type MobileSurface = 'conversation' | 'workspace';

const workModel = (name: string): boolean => {
  const normalized = name.trim().toLowerCase();
  return Boolean(normalized) && !normalized.includes('embed');
};

const errorMessage = (error: unknown, fallback: string): string =>
  error instanceof Error && error.message ? error.message : fallback;

export default function WorkPage() {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const { taskId } = useParams<{ taskId: string }>();
  const preferences = useAppStore(state => state.preferences);
  const setPreferences = useAppStore(state => state.setPreferences);
  const authenticatedUserId = useAuthStore(state => state.user?.id ?? null);
  const [remoteDisclosureSaving, setRemoteDisclosureSaving] = useState(false);
  const chatModels = useChatStore(state => state.models);
  const chatSelectedModel = useChatStore(state => state.selectedModel);
  const {
    capabilities,
    tasks,
    selectedTask,
    files,
    selectedFile,
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
  const [mobileSurfaceState, setMobileSurfaceState] = useState<{
    locationKey: string;
    value: MobileSurface;
  }>({
    locationKey: location.key,
    value: 'conversation',
  });
  const mobileSurface =
    mobileSurfaceState.locationKey === location.key
      ? mobileSurfaceState.value
      : 'conversation';
  const setMobileSurface = (value: MobileSurface) =>
    setMobileSurfaceState({ locationKey: location.key, value });
  const [workspaceDirty, setWorkspaceDirty] = useState(false);
  const [taskActionsState, setTaskActionsState] = useState<{
    taskId: string | null;
    open: boolean;
  }>({ taskId: null, open: false });
  const taskActionsOpen =
    taskActionsState.open && taskActionsState.taskId === selectedTask?.id;
  const taskActionsRef = useRef<HTMLDivElement>(null);
  const taskActionsButtonRef = useRef<HTMLButtonElement>(null);
  const taskActionsMenuRef = useRef<HTMLDivElement>(null);
  const closeTaskActions = useCallback((restoreFocus = false) => {
    setTaskActionsState(current => ({ ...current, open: false }));
    if (restoreFocus) {
      window.requestAnimationFrame(() => taskActionsButtonRef.current?.focus());
    }
  }, []);

  useEffect(() => {
    if (!taskActionsOpen) return;
    const focusFrame = window.requestAnimationFrame(() => {
      taskActionsMenuRef.current
        ?.querySelector<HTMLButtonElement>('[role="menuitem"]')
        ?.focus();
    });
    const closeOnPointerDown = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !taskActionsRef.current?.contains(event.target)
      ) {
        closeTaskActions();
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeTaskActions(true);
      }
    };
    document.addEventListener('pointerdown', closeOnPointerDown);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener('pointerdown', closeOnPointerDown);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [closeTaskActions, taskActionsOpen]);

  const handleTaskActionsKeyDown = (
    event: ReactKeyboardEvent<HTMLDivElement>
  ) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeTaskActions(true);
      return;
    }
    if (
      event.key !== 'ArrowDown' &&
      event.key !== 'ArrowUp' &&
      event.key !== 'Home' &&
      event.key !== 'End'
    ) {
      return;
    }

    const items = [
      ...(taskActionsMenuRef.current?.querySelectorAll<HTMLButtonElement>(
        '[role="menuitem"]:not(:disabled)'
      ) ?? []),
    ];
    if (items.length === 0) return;
    event.preventDefault();
    const currentIndex = items.indexOf(
      document.activeElement as HTMLButtonElement
    );
    const nextIndex =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? items.length - 1
          : event.key === 'ArrowUp'
            ? (currentIndex - 1 + items.length) % items.length
            : (currentIndex + 1) % items.length;
    items[nextIndex]?.focus();
  };

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

  const navigationBlocker = useBlocker(({ currentLocation, nextLocation }) => {
    const navigationState = nextLocation.state as {
      deletedWorkTaskId?: unknown;
    } | null;
    return (
      workspaceDirty &&
      navigationState?.deletedWorkTaskId !== taskId &&
      `${currentLocation.pathname}${currentLocation.search}${currentLocation.hash}` !==
        `${nextLocation.pathname}${nextLocation.search}${nextLocation.hash}`
    );
  });

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
        if (!freshModel) {
          throw new Error(
            t('work.composer.noModelSelected', {
              defaultValue: 'No Work-compatible model is selected.',
            })
          );
        }
        const task = await createTask({
          message,
          model: freshModel.model,
          providerType: freshModel.providerType,
          providerId: freshModel.providerId,
          networkEnabled: true,
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
      toast.error(
        errorMessage(
          updateError,
          t('work.toasts.renameFailed', {
            defaultValue: 'Could not rename this task.',
          })
        )
      );
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
    const initiatingTaskId = selectedTask.id;
    try {
      const file = await saveFile(
        initiatingTaskId,
        path,
        content,
        expectedUpdatedAt
      );
      if (useWorkStore.getState().selectedTaskId === initiatingTaskId) {
        toast.success(t('work.toasts.saved', { defaultValue: 'File saved.' }));
      }
      return file;
    } catch (actionError) {
      if (useWorkStore.getState().selectedTaskId === initiatingTaskId) {
        toast.error(
          errorMessage(
            actionError,
            t('work.toasts.saveFailed', {
              defaultValue: 'Could not save this file.',
            })
          )
        );
      }
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
        defaultValue: 'Docker ready',
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
  const status = workStatusPresentation[selectedTask?.status ?? 'idle'];
  const statusLabel = t(status.labelKey, {
    defaultValue: status.label,
  });

  const dismissRemoteDisclosure = async () => {
    if (
      preferences.workRemoteProviderDisclosureDismissed ||
      remoteDisclosureSaving
    ) {
      return false;
    }

    const initiatingUserId = authenticatedUserId;
    setRemoteDisclosureSaving(true);
    try {
      const response = await preferencesApi.updatePreferences({
        workRemoteProviderDisclosureDismissed: true,
      });

      if (!response.success) {
        throw new Error(
          response.error ||
            t('work.composer.remoteDismissFailed', {
              defaultValue: 'Could not save the remote provider preference.',
            })
        );
      }

      if ((useAuthStore.getState().user?.id ?? null) !== initiatingUserId) {
        return false;
      }

      setPreferences({ workRemoteProviderDisclosureDismissed: true });
      return true;
    } catch {
      toast.error(
        t('work.composer.remoteDismissFailed', {
          defaultValue: 'Could not save the remote provider preference.',
        })
      );
      return false;
    } finally {
      setRemoteDisclosureSaving(false);
    }
  };

  return (
    <div
      data-testid='work-page'
      className='relative flex h-full min-h-0 overflow-hidden bg-surface'
    >
      <main className='flex min-h-0 min-w-0 flex-1 flex-col'>
        <header className='flex h-16 shrink-0 items-center gap-3 border-b border-line bg-surface-raised px-3 md:px-4'>
          {selectedTask ? (
            <input
              key={`${selectedTask.id}:${selectedTask.title}`}
              data-testid='work-task-title'
              dir='auto'
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

          {selectedTask && (
            <span
              data-testid='work-compact-status'
              className='inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border border-line bg-surface px-2 text-[11px] font-medium text-ink-muted xl:hidden'
              aria-label={t('work.tasks.status', {
                status: statusLabel,
                defaultValue: 'Status: {{status}}',
              })}
              title={t('work.tasks.status', {
                status: statusLabel,
                defaultValue: 'Status: {{status}}',
              })}
            >
              <span
                aria-hidden='true'
                data-testid='work-compact-status-indicator'
                className={cn(
                  'h-1.5 w-1.5 rounded-full',
                  status.animated && 'animate-pulse',
                  selectedTask.status === 'idle' &&
                    'ring-1 ring-black/20 dark:ring-white/20'
                )}
                style={{ backgroundColor: status.color }}
              />
              <span className='hidden md:inline'>{statusLabel}</span>
            </span>
          )}

          {selectedTask && (
            <div
              className='ms-auto inline-flex h-9 shrink-0 items-center rounded-xl border border-line bg-surface-subtle p-1 shadow-subtle xl:hidden'
              role='group'
              aria-label={t('work.mobile.surface', {
                defaultValue: 'Task surface',
              })}
            >
              <button
                type='button'
                onClick={() => setMobileSurface('conversation')}
                aria-label={t('work.mobile.conversation', {
                  defaultValue: 'Conversation',
                })}
                aria-pressed={mobileSurface === 'conversation'}
                className={cn(
                  'inline-flex h-7 items-center justify-center gap-1.5 rounded-lg px-2 text-[11px] font-medium transition-[background-color,color,box-shadow] sm:px-2.5',
                  mobileSurface === 'conversation'
                    ? 'bg-surface-raised text-ink shadow-subtle'
                    : 'text-ink-muted hover:bg-surface-raised/70 hover:text-ink'
                )}
              >
                <MessageSquare className='h-3.5 w-3.5 shrink-0' />
                <span className='hidden sm:inline'>
                  {t('work.mobile.conversation', {
                    defaultValue: 'Conversation',
                  })}
                </span>
              </button>
              <button
                type='button'
                onClick={() => setMobileSurface('workspace')}
                aria-label={t('work.mobile.workspace', {
                  defaultValue: 'Workspace',
                })}
                aria-pressed={mobileSurface === 'workspace'}
                className={cn(
                  'inline-flex h-7 items-center justify-center gap-1.5 rounded-lg px-2 text-[11px] font-medium transition-[background-color,color,box-shadow] sm:px-2.5',
                  mobileSurface === 'workspace'
                    ? 'bg-surface-raised text-ink shadow-subtle'
                    : 'text-ink-muted hover:bg-surface-raised/70 hover:text-ink'
                )}
              >
                <Monitor className='h-3.5 w-3.5 shrink-0' />
                <span className='hidden sm:inline'>
                  {t('work.mobile.workspace', {
                    defaultValue: 'Workspace',
                  })}
                </span>
              </button>
            </div>
          )}

          <div
            className={cn(
              'ms-auto hidden min-w-0 items-center gap-2',
              selectedTask ? 'xl:flex' : 'sm:flex'
            )}
          >
            {selectedTask && (
              <span
                data-testid='work-status'
                className='inline-flex h-7 items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 text-[11px] font-medium text-ink-muted'
              >
                <span
                  aria-hidden='true'
                  data-testid='work-status-indicator'
                  className={cn(
                    'h-1.5 w-1.5 rounded-full',
                    status.animated && 'animate-pulse',
                    selectedTask.status === 'idle' &&
                      'ring-1 ring-black/20 dark:ring-white/20'
                  )}
                  style={{ backgroundColor: status.color }}
                />
                {statusLabel}
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
              <span className='hidden h-7 max-w-44 items-center gap-1.5 truncate rounded-full border border-line bg-surface px-2.5 text-[11px] font-medium text-ink-muted md:inline-flex'>
                <HardDrive className='h-3.5 w-3.5 shrink-0' />
                <span dir='ltr' className='truncate'>
                  {selectedTask.model}
                </span>
              </span>
            )}
          </div>

          {selectedTask && (
            <div ref={taskActionsRef} className='relative shrink-0'>
              <button
                ref={taskActionsButtonRef}
                id='work-task-actions-trigger'
                type='button'
                data-testid='work-task-actions-button'
                onClick={() =>
                  setTaskActionsState(current => ({
                    taskId: selectedTask.id,
                    open:
                      current.taskId === selectedTask.id ? !current.open : true,
                  }))
                }
                onKeyDown={event => {
                  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') {
                    return;
                  }
                  event.preventDefault();
                  setTaskActionsState({
                    taskId: selectedTask.id,
                    open: true,
                  });
                }}
                className='inline-flex h-9 w-9 items-center justify-center rounded-lg text-ink-muted transition-colors hover:bg-surface-subtle hover:text-ink'
                aria-label={t('work.tasks.actions', {
                  defaultValue: 'Task actions',
                })}
                aria-haspopup='menu'
                aria-expanded={taskActionsOpen}
                aria-controls={
                  taskActionsOpen ? 'work-task-actions-menu' : undefined
                }
              >
                <MoreHorizontal className='h-4 w-4' />
              </button>
              {taskActionsOpen && (
                <div
                  ref={taskActionsMenuRef}
                  id='work-task-actions-menu'
                  role='menu'
                  aria-labelledby='work-task-actions-trigger'
                  onKeyDown={handleTaskActionsKeyDown}
                  className='absolute end-0 top-10 z-40 min-w-44 rounded-xl border border-line bg-surface-overlay p-1.5 shadow-overlay'
                >
                  <button
                    type='button'
                    role='menuitem'
                    data-testid='work-delete-task-button'
                    onClick={() => {
                      closeTaskActions(true);
                      void removeTask(selectedTask.id);
                    }}
                    className='flex h-9 w-full items-center gap-2 rounded-lg px-2.5 text-start text-xs font-medium text-error-600 transition-colors hover:bg-error-500/10'
                  >
                    <Trash2 className='h-3.5 w-3.5' />
                    {t('work.tasks.delete', {
                      defaultValue: 'Delete task',
                    })}
                  </button>
                </div>
              )}
            </div>
          )}
        </header>

        {(runtimeUnavailable || error) && (
          <div
            className={cn(
              'flex shrink-0 items-center gap-2 border-b px-4 py-2 text-xs',
              runtimeUnavailable
                ? 'border-error-500/20 bg-error-500/10 text-error-700'
                : 'border-amber-500/20 bg-amber-500/10 text-ink'
            )}
          >
            <CircleAlert className='h-4 w-4 shrink-0' />
            <span dir='auto' className='min-w-0 flex-1'>
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
                          'The runtime and task files stay isolated from the host.',
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
              running={false}
              loading={actionLoading}
              disabled={runtimeUnavailable}
              remoteDisclosureDismissed={
                preferences.workRemoteProviderDisclosureDismissed
              }
              remoteDisclosureSaving={remoteDisclosureSaving}
              onModelChange={changeModel}
              onDismissRemoteDisclosure={dismissRemoteDisclosure}
              onSubmit={submitMessage}
              onCancel={stopRun}
            />
          </>
        ) : selectedTask ? (
          <WorkSplitPane
            userId={authenticatedUserId}
            mobileSurface={mobileSurface}
            conversation={
              <>
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
                  running={activeTask}
                  loading={actionLoading}
                  disabled={runtimeUnavailable}
                  remoteDisclosureDismissed={
                    preferences.workRemoteProviderDisclosureDismissed
                  }
                  remoteDisclosureSaving={remoteDisclosureSaving}
                  onModelChange={changeModel}
                  onDismissRemoteDisclosure={dismissRemoteDisclosure}
                  onSubmit={submitMessage}
                  onCancel={stopRun}
                />
              </>
            }
            workspace={
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
            }
          />
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
                  <ChevronLeft className='h-4 w-4 rtl:rotate-180' />
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
