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

import { create } from 'zustand';
import type {
  CreateWorkTaskRequest,
  StartWorkRunRequest,
  UpdateWorkTaskRequest,
  WorkCapabilities,
  WorkFile,
  WorkFileEntry,
  WorkLiveRun,
  WorkRunConnectionState,
  WorkRunEvent,
  WorkMessage,
  WorkTask,
  WorkTaskSummary,
} from '@/types/work';
import { workApi } from '@/utils/api';
import {
  applyWorkRunEvent as reduceWorkRunEvent,
  createWorkLiveRun,
} from '@/utils/workEvents';

const responseError = (
  fallback: string,
  response?: { error?: string; message?: string }
): Error => new Error(response?.error || response?.message || fallback);

const thrownError = (error: unknown, fallback: string): string => {
  if (typeof error === 'object' && error !== null && 'response' in error) {
    const response = (
      error as {
        response?: { data?: { error?: string; message?: string } };
      }
    ).response;
    const apiMessage = response?.data?.error || response?.data?.message;
    if (apiMessage) return apiMessage;
  }
  if (error instanceof Error && error.message) return error.message;
  return fallback;
};

/**
 * A 409 from a workspace read means the sandbox is momentarily unservable —
 * typically the durable worker holds the runtime lease while it is still
 * creating the container at run start. That resolves by itself within
 * seconds, so it is retried quietly instead of surfacing an error banner.
 */
const isWorkspaceBusyConflict = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'response' in error &&
  (error as { response?: { status?: number } }).response?.status === 409;

const FILE_CONFLICT_RETRY_DELAY_MS = 2_500;
const FILE_CONFLICT_RETRY_LIMIT = 24; // ~1 minute of quiet retries
const fileConflictRetries = new Map<string, number>();

const sortTasks = (tasks: WorkTaskSummary[]): WorkTaskSummary[] =>
  [...tasks].sort(
    (a, b) =>
      b.updatedAt - a.updatedAt ||
      b.createdAt - a.createdAt ||
      a.id.localeCompare(b.id)
  );

const toSummary = ({
  messages: _messages,
  messageCursor: _messageCursor,
  hasMoreMessages: _hasMoreMessages,
  ...task
}: WorkTask): WorkTaskSummary => task;

const mergeMessages = (
  current: WorkMessage[],
  incoming: WorkMessage[]
): WorkMessage[] => {
  const messages = new Map(current.map(message => [message.id, message]));
  for (const message of incoming) messages.set(message.id, message);
  return [...messages.values()].sort(
    (a, b) =>
      a.messageIndex - b.messageIndex ||
      a.createdAt - b.createdAt ||
      a.id.localeCompare(b.id)
  );
};

const mergeTaskDetail = (
  current: WorkTask | null,
  incoming: WorkTask
): WorkTask => {
  if (!current || current.id !== incoming.id) {
    return incoming;
  }
  const metadata =
    current.updatedAt > incoming.updatedAt
      ? { ...incoming, ...current }
      : { ...current, ...incoming };
  if (current.messages.length === 0) {
    return {
      ...metadata,
      messages: incoming.messages,
      messageCursor: incoming.messageCursor,
      hasMoreMessages: incoming.hasMoreMessages,
    };
  }
  const currentLastIndex = Math.max(
    ...current.messages.map(message => message.messageIndex)
  );
  const incomingFirstIndex = Math.min(
    ...incoming.messages.map(message => message.messageIndex)
  );
  const hasMessageGap =
    incoming.messages.length > 0 && currentLastIndex + 1 < incomingFirstIndex;
  return {
    ...metadata,
    messages: mergeMessages(current.messages, incoming.messages),
    messageCursor: hasMessageGap
      ? incoming.messageCursor
      : current.messageCursor,
    hasMoreMessages: hasMessageGap
      ? incoming.hasMoreMessages
      : current.hasMoreMessages,
  };
};

const upsertTask = (
  tasks: WorkTaskSummary[],
  task: WorkTask
): WorkTaskSummary[] => {
  const current = tasks.find(item => item.id === task.id);
  if (current && current.updatedAt > task.updatedAt) return tasks;
  const summary = toSummary(task);
  const currentIndex = tasks.findIndex(item => item.id === task.id);
  if (currentIndex === -1) return [summary, ...tasks];
  const nextTasks = [...tasks];
  nextTasks[currentIndex] = summary;
  return nextTasks;
};

const mergeTaskList = (
  currentTasks: WorkTaskSummary[],
  incomingTasks: WorkTaskSummary[]
): WorkTaskSummary[] => {
  const incomingById = new Map(
    incomingTasks.map(task => [task.id, task] as const)
  );
  const currentIds = new Set(currentTasks.map(task => task.id));
  const newTasks = sortTasks(
    incomingTasks.filter(task => !currentIds.has(task.id))
  );
  const existingTasks = currentTasks.flatMap(current => {
    const incoming = incomingById.get(current.id);
    if (!incoming) return [];
    return [current.updatedAt > incoming.updatedAt ? current : incoming];
  });
  return [...newTasks, ...existingTasks];
};

interface WorkState {
  capabilities: WorkCapabilities | null;
  tasks: WorkTaskSummary[];
  selectedTaskId: string | null;
  selectedTask: WorkTask | null;
  files: WorkFileEntry[];
  selectedFile: WorkFile | null;
  liveRuns: Record<string, WorkLiveRun>;
  loadingTasks: boolean;
  loadingTask: boolean;
  loadingOlderMessages: boolean;
  loadingFiles: boolean;
  actionLoading: boolean;
  error: string | null;
  loadCapabilities: () => Promise<void>;
  loadTasks: (silent?: boolean) => Promise<void>;
  selectTask: (taskId: string | null) => void;
  loadTask: (taskId: string, silent?: boolean) => Promise<WorkTask>;
  loadOlderMessages: (taskId: string) => Promise<WorkMessage[]>;
  createTask: (payload: CreateWorkTaskRequest) => Promise<WorkTask>;
  updateTask: (
    taskId: string,
    payload: UpdateWorkTaskRequest
  ) => Promise<WorkTask>;
  deleteTask: (taskId: string) => Promise<void>;
  startRun: (taskId: string, payload: StartWorkRunRequest) => Promise<WorkTask>;
  cancelRun: (taskId: string) => Promise<WorkTask>;
  beginLiveRun: (taskId: string, runId: string, startedAt?: number) => void;
  applyRunEvent: (event: WorkRunEvent) => void;
  applyRunEvents: (events: WorkRunEvent[]) => void;
  setLiveRunConnection: (
    taskId: string,
    runId: string,
    connection: WorkRunConnectionState,
    error?: string
  ) => void;
  clearLiveRun: (taskId: string, runId?: string) => void;
  loadFiles: (taskId: string, path?: string) => Promise<WorkFileEntry[]>;
  loadFile: (taskId: string, path: string) => Promise<WorkFile>;
  clearSelectedFile: () => void;
  saveFile: (
    taskId: string,
    path: string,
    content: string,
    expectedUpdatedAt?: number
  ) => Promise<WorkFile>;
  startPreview: (taskId: string, command?: string) => Promise<WorkTask>;
  stopPreview: (taskId: string) => Promise<WorkTask>;
  clearError: () => void;
  clearAllState: () => void;
}

export const useWorkStore = create<WorkState>((set, get) => {
  let stateEpoch = 0;
  let taskListRequestSequence = 0;
  let latestStartedVisibleTaskListRequest = 0;
  let latestCommittedTaskListRequest = 0;
  let taskMutationRevision = 0;
  let taskListError: {
    requestId: number;
    message: string;
  } | null = null;
  let workspaceRequestSequence = 0;
  let latestFileListRequest = 0;
  let latestFileRequest = 0;
  let latestFileTarget: string | null = null;
  let actionRequestSequence = 0;
  const visibleTaskListRequests = new Set<number>();
  const activeWorkspaceRequests = new Set<number>();
  const activeActionRequests = new Map<number, string | null>();
  const fileTarget = (taskId: string, path: string): string =>
    `${taskId}\u0000${path}`;
  const isCurrentEpoch = (epoch: number): boolean => epoch === stateEpoch;
  const assertCurrentEpoch = (epoch: number): void => {
    if (!isCurrentEpoch(epoch)) {
      throw new Error('Work session changed.');
    }
  };
  const invalidateWorkspaceRequests = (): void => {
    latestFileListRequest += 1;
    latestFileRequest += 1;
    latestFileTarget = null;
    activeWorkspaceRequests.clear();
  };
  const beginWorkspaceRequest = (): number => {
    const token = ++workspaceRequestSequence;
    activeWorkspaceRequests.add(token);
    set({ loadingFiles: true });
    return token;
  };
  const finishWorkspaceRequest = (
    token: number,
    epoch: number,
    taskId: string
  ): void => {
    activeWorkspaceRequests.delete(token);
    if (isCurrentEpoch(epoch) && get().selectedTaskId === taskId) {
      set({ loadingFiles: activeWorkspaceRequests.size > 0 });
    }
  };
  const actionAppliesToSelection = (taskId: string | null): boolean =>
    get().selectedTaskId === taskId;
  const beginActionRequest = (taskId: string | null): number => {
    const token = ++actionRequestSequence;
    activeActionRequests.set(token, taskId);
    if (actionAppliesToSelection(taskId)) {
      set({ actionLoading: true, error: null });
    }
    return token;
  };
  const finishActionRequest = (token: number, epoch: number): void => {
    activeActionRequests.delete(token);
    if (!isCurrentEpoch(epoch)) return;
    const selectedTaskId = get().selectedTaskId;
    set({
      actionLoading: [...activeActionRequests.values()].some(
        taskId => taskId === selectedTaskId
      ),
    });
  };
  const commitActionError = (
    taskId: string | null,
    epoch: number,
    message: string
  ): void => {
    if (isCurrentEpoch(epoch) && actionAppliesToSelection(taskId)) {
      set({ error: message });
    }
  };

  const commitTask = (
    task: WorkTask,
    epoch = stateEpoch,
    mutation = false
  ): void => {
    if (!isCurrentEpoch(epoch)) return;
    if (mutation) taskMutationRevision += 1;
    set(state => ({
      tasks: upsertTask(state.tasks, task),
      selectedTask:
        state.selectedTaskId === task.id
          ? mergeTaskDetail(state.selectedTask, task)
          : state.selectedTask,
    }));
  };

  const runTaskAction = async (
    action: () => Promise<{
      success: boolean;
      data?: WorkTask;
      error?: string;
      message?: string;
    }>,
    fallback: string,
    taskId: string | null
  ): Promise<WorkTask> => {
    const requestEpoch = stateEpoch;
    const actionToken = beginActionRequest(taskId);
    try {
      const response = await action();
      assertCurrentEpoch(requestEpoch);
      if (!response.success || !response.data) {
        throw responseError(fallback, response);
      }
      commitTask(response.data, requestEpoch, true);
      return response.data;
    } catch (error) {
      const message = thrownError(error, fallback);
      commitActionError(taskId, requestEpoch, message);
      throw new Error(message);
    } finally {
      finishActionRequest(actionToken, requestEpoch);
    }
  };

  return {
    capabilities: null,
    tasks: [],
    selectedTaskId: null,
    selectedTask: null,
    files: [],
    selectedFile: null,
    liveRuns: {},
    loadingTasks: false,
    loadingTask: false,
    loadingOlderMessages: false,
    loadingFiles: false,
    actionLoading: false,
    error: null,

    loadCapabilities: async () => {
      const requestEpoch = stateEpoch;
      try {
        const response = await workApi.capabilities();
        assertCurrentEpoch(requestEpoch);
        if (!response.success || !response.data) {
          throw responseError('Could not inspect the Work runtime.', response);
        }
        set({ capabilities: response.data });
      } catch (error) {
        if (isCurrentEpoch(requestEpoch)) {
          set({
            capabilities: {
              available: false,
              runtime: 'docker',
              image: '',
              reason: thrownError(error, 'The Work runtime is unavailable.'),
            },
          });
        }
      }
    },

    loadTasks: async (silent = false) => {
      const requestEpoch = stateEpoch;
      const requestId = ++taskListRequestSequence;
      const requestRevision = taskMutationRevision;
      if (!silent) {
        latestStartedVisibleTaskListRequest = requestId;
        visibleTaskListRequests.add(requestId);
        set({ loadingTasks: true, error: null });
      }
      try {
        const response = await workApi.listTasks();
        assertCurrentEpoch(requestEpoch);
        if (!response.success || !response.data) {
          throw responseError('Could not load Work tasks.', response);
        }
        const tasks = sortTasks(response.data);
        if (
          requestId <= latestCommittedTaskListRequest ||
          requestRevision !== taskMutationRevision
        ) {
          return;
        }
        latestCommittedTaskListRequest = requestId;
        set(state => {
          const mergedTasks = mergeTaskList(state.tasks, tasks);
          const summary = state.selectedTaskId
            ? mergedTasks.find(task => task.id === state.selectedTaskId)
            : undefined;
          const selectedTask =
            summary && state.selectedTask
              ? {
                  ...state.selectedTask,
                  ...summary,
                  messages: state.selectedTask.messages,
                  messageCursor: state.selectedTask.messageCursor,
                  hasMoreMessages: state.selectedTask.hasMoreMessages,
                }
              : state.selectedTask;
          const listError = taskListError;
          const clearListError =
            listError !== null && requestId > listError.requestId;
          if (clearListError) taskListError = null;
          return {
            tasks: mergedTasks,
            selectedTask,
            ...(clearListError && state.error === listError.message
              ? { error: null }
              : {}),
          };
        });
      } catch (error) {
        const message = thrownError(error, 'Could not load Work tasks.');
        if (
          !silent &&
          isCurrentEpoch(requestEpoch) &&
          requestId === latestStartedVisibleTaskListRequest &&
          requestId > latestCommittedTaskListRequest &&
          requestRevision === taskMutationRevision
        ) {
          taskListError = { requestId, message };
          set({ error: message });
        }
      } finally {
        visibleTaskListRequests.delete(requestId);
        if (!silent && isCurrentEpoch(requestEpoch)) {
          set({ loadingTasks: visibleTaskListRequests.size > 0 });
        }
      }
    },

    selectTask: taskId => {
      invalidateWorkspaceRequests();
      set(state => ({
        selectedTaskId: taskId,
        selectedTask:
          taskId && state.selectedTask?.id === taskId
            ? state.selectedTask
            : null,
        files: [],
        selectedFile: null,
        loadingFiles: false,
        loadingOlderMessages: false,
        actionLoading: [...activeActionRequests.values()].some(
          activeTaskId => activeTaskId === taskId
        ),
        error: null,
      }));
    },

    loadTask: async (taskId, silent = false) => {
      const requestEpoch = stateEpoch;
      if (!silent) set({ loadingTask: true, error: null });
      try {
        const response = await workApi.getTask(taskId);
        assertCurrentEpoch(requestEpoch);
        if (!response.success || !response.data) {
          throw responseError('Could not load this Work task.', response);
        }
        commitTask(response.data, requestEpoch);
        return response.data;
      } catch (error) {
        const message = thrownError(error, 'Could not load this Work task.');
        if (!silent && isCurrentEpoch(requestEpoch)) set({ error: message });
        throw new Error(message);
      } finally {
        if (!silent && isCurrentEpoch(requestEpoch)) {
          set({ loadingTask: false });
        }
      }
    },

    loadOlderMessages: async taskId => {
      const requestEpoch = stateEpoch;
      const selectedTask = get().selectedTask;
      const before =
        selectedTask?.id === taskId ? selectedTask.messageCursor : undefined;
      if (
        !selectedTask ||
        selectedTask.id !== taskId ||
        !selectedTask.hasMoreMessages ||
        before === undefined
      ) {
        return [];
      }
      set({ loadingOlderMessages: true, error: null });
      try {
        const response = await workApi.getMessages(taskId, before);
        assertCurrentEpoch(requestEpoch);
        if (!response.success || !response.data) {
          throw responseError('Could not load older Work messages.', response);
        }
        const page = response.data;
        set(state => {
          if (state.selectedTask?.id !== taskId) return {};
          const cursorUnchanged = state.selectedTask.messageCursor === before;
          return {
            selectedTask: {
              ...state.selectedTask,
              messages: mergeMessages(
                state.selectedTask.messages,
                page.messages
              ),
              messageCursor: cursorUnchanged
                ? page.cursor
                : state.selectedTask.messageCursor,
              hasMoreMessages: cursorUnchanged
                ? page.hasMore
                : state.selectedTask.hasMoreMessages,
            },
          };
        });
        return page.messages;
      } catch (error) {
        const message = thrownError(
          error,
          'Could not load older Work messages.'
        );
        if (isCurrentEpoch(requestEpoch) && get().selectedTaskId === taskId) {
          set({ error: message });
        }
        throw new Error(message);
      } finally {
        if (isCurrentEpoch(requestEpoch) && get().selectedTaskId === taskId) {
          set({ loadingOlderMessages: false });
        }
      }
    },

    createTask: payload =>
      runTaskAction(
        () => workApi.createTask(payload),
        'Could not create the Work task.',
        null
      ),

    updateTask: (taskId, payload) =>
      runTaskAction(
        () => workApi.updateTask(taskId, payload),
        'Could not update the Work task.',
        taskId
      ),

    deleteTask: async taskId => {
      const requestEpoch = stateEpoch;
      const actionToken = beginActionRequest(taskId);
      try {
        const response = await workApi.deleteTask(taskId);
        assertCurrentEpoch(requestEpoch);
        if (!response.success) {
          throw responseError('Could not delete the Work task.', response);
        }
        if (get().selectedTaskId === taskId) {
          invalidateWorkspaceRequests();
        }
        taskMutationRevision += 1;
        set(state => ({
          tasks: state.tasks.filter(task => task.id !== taskId),
          selectedTaskId:
            state.selectedTaskId === taskId ? null : state.selectedTaskId,
          selectedTask:
            state.selectedTaskId === taskId ? null : state.selectedTask,
          files: state.selectedTaskId === taskId ? [] : state.files,
          selectedFile:
            state.selectedTaskId === taskId ? null : state.selectedFile,
          liveRuns: Object.fromEntries(
            Object.entries(state.liveRuns).filter(([id]) => id !== taskId)
          ),
        }));
      } catch (error) {
        const message = thrownError(error, 'Could not delete the Work task.');
        commitActionError(taskId, requestEpoch, message);
        throw new Error(message);
      } finally {
        finishActionRequest(actionToken, requestEpoch);
      }
    },

    startRun: async (taskId, payload) => {
      const requestEpoch = stateEpoch;
      const actionToken = beginActionRequest(taskId);
      try {
        const response = await workApi.startRun(taskId, payload);
        assertCurrentEpoch(requestEpoch);
        if (!response.success || !response.data) {
          throw responseError('Could not start the Work run.', response);
        }
        commitTask(response.data, requestEpoch, true);
        return response.data;
      } catch (error) {
        const message = thrownError(error, 'Could not start the Work run.');
        commitActionError(taskId, requestEpoch, message);
        throw new Error(message);
      } finally {
        finishActionRequest(actionToken, requestEpoch);
      }
    },

    cancelRun: async taskId => {
      const requestEpoch = stateEpoch;
      const actionToken = beginActionRequest(taskId);
      try {
        const response = await workApi.cancelRun(taskId);
        assertCurrentEpoch(requestEpoch);
        if (!response.success) {
          throw responseError('Could not cancel the Work run.', response);
        }
        if (!response.data) {
          taskMutationRevision += 1;
          return await get().loadTask(taskId, true);
        }
        commitTask(response.data, requestEpoch, true);
        return response.data;
      } catch (error) {
        const message = thrownError(error, 'Could not cancel the Work run.');
        commitActionError(taskId, requestEpoch, message);
        throw new Error(message);
      } finally {
        finishActionRequest(actionToken, requestEpoch);
      }
    },

    beginLiveRun: (taskId, runId, startedAt) => {
      set(state => {
        const existing = state.liveRuns[taskId];
        return {
          liveRuns: {
            ...state.liveRuns,
            [taskId]:
              existing?.runId === runId
                ? {
                    ...existing,
                    startedAt: existing.startedAt ?? startedAt,
                  }
                : createWorkLiveRun(taskId, runId, startedAt),
          },
        };
      });
    },

    applyRunEvent: event => {
      get().applyRunEvents([event]);
    },

    applyRunEvents: events => {
      if (events.length === 0) return;
      set(state => {
        const liveRuns = { ...state.liveRuns };
        let tasks = state.tasks;
        let selectedTask = state.selectedTask;
        for (const event of events) {
          liveRuns[event.taskId] = reduceWorkRunEvent(
            liveRuns[event.taskId],
            event
          );
          const snapshot =
            event.type === 'snapshot'
              ? (event.data.task ?? event.data.detail)
              : undefined;
          const snapshotTask =
            snapshot &&
            typeof snapshot === 'object' &&
            !Array.isArray(snapshot) &&
            (snapshot as { id?: unknown }).id === event.taskId &&
            Array.isArray((snapshot as { messages?: unknown }).messages)
              ? (snapshot as WorkTask)
              : undefined;
          if (snapshotTask) {
            tasks = upsertTask(tasks, snapshotTask);
            if (state.selectedTaskId === snapshotTask.id) {
              selectedTask = mergeTaskDetail(selectedTask, snapshotTask);
            }
          }
        }
        return {
          liveRuns,
          tasks,
          selectedTask,
        };
      });
    },

    setLiveRunConnection: (taskId, runId, connection, connectionError) => {
      set(state => {
        const current = state.liveRuns[taskId];
        if (!current || current.runId !== runId) return {};
        return {
          liveRuns: {
            ...state.liveRuns,
            [taskId]: {
              ...current,
              connection,
              connectionError,
            },
          },
        };
      });
    },

    clearLiveRun: (taskId, runId) => {
      set(state => {
        if (runId && state.liveRuns[taskId]?.runId !== runId) return {};
        const liveRuns = { ...state.liveRuns };
        delete liveRuns[taskId];
        return { liveRuns };
      });
    },

    loadFiles: async (taskId, path = '') => {
      const requestEpoch = stateEpoch;
      const requestId = ++latestFileListRequest;
      const loadingToken = beginWorkspaceRequest();
      try {
        const response = await workApi.listFiles(taskId, path);
        assertCurrentEpoch(requestEpoch);
        if (!response.success || !response.data) {
          throw responseError('Could not load workspace files.', response);
        }
        if (
          requestId === latestFileListRequest &&
          get().selectedTaskId === taskId
        ) {
          fileConflictRetries.delete(taskId);
          set({ files: response.data });
        }
        return response.data;
      } catch (error) {
        const stillCurrent =
          requestId === latestFileListRequest &&
          isCurrentEpoch(requestEpoch) &&
          get().selectedTaskId === taskId;
        if (isWorkspaceBusyConflict(error)) {
          // The sandbox is being prepared by the run; retry quietly instead
          // of showing a replica-conflict banner for a self-resolving state.
          const attempts = fileConflictRetries.get(taskId) ?? 0;
          if (stillCurrent && attempts < FILE_CONFLICT_RETRY_LIMIT) {
            fileConflictRetries.set(taskId, attempts + 1);
            setTimeout(() => {
              if (
                requestId === latestFileListRequest &&
                isCurrentEpoch(requestEpoch) &&
                get().selectedTaskId === taskId
              ) {
                void get()
                  .loadFiles(taskId, path)
                  .catch(() => undefined);
              }
            }, FILE_CONFLICT_RETRY_DELAY_MS);
          }
          return get().files;
        }
        const message = thrownError(error, 'Could not load workspace files.');
        if (stillCurrent) {
          set({ error: message });
        }
        throw new Error(message);
      } finally {
        finishWorkspaceRequest(loadingToken, requestEpoch, taskId);
      }
    },

    loadFile: async (taskId, path) => {
      const requestEpoch = stateEpoch;
      const requestId = ++latestFileRequest;
      const requestTarget = fileTarget(taskId, path);
      latestFileTarget = requestTarget;
      const loadingToken = beginWorkspaceRequest();
      try {
        const response = await workApi.getFile(taskId, path);
        assertCurrentEpoch(requestEpoch);
        if (!response.success || !response.data) {
          throw responseError('Could not open this workspace file.', response);
        }
        if (
          requestId !== latestFileRequest ||
          latestFileTarget !== requestTarget ||
          !isCurrentEpoch(requestEpoch) ||
          get().selectedTaskId !== taskId
        ) {
          throw new Error('Work file request was superseded.');
        }
        set({ selectedFile: response.data });
        return response.data;
      } catch (error) {
        const message = thrownError(error, 'Could not open this file.');
        if (
          requestId === latestFileRequest &&
          isCurrentEpoch(requestEpoch) &&
          get().selectedTaskId === taskId
        ) {
          set({ error: message });
        }
        throw new Error(message);
      } finally {
        finishWorkspaceRequest(loadingToken, requestEpoch, taskId);
      }
    },

    clearSelectedFile: () => {
      latestFileRequest += 1;
      latestFileTarget = null;
      set({ selectedFile: null });
    },

    saveFile: async (taskId, path, content, expectedUpdatedAt) => {
      const requestEpoch = stateEpoch;
      const actionToken = beginActionRequest(taskId);
      const saveTarget = fileTarget(taskId, path);
      if (latestFileTarget === saveTarget) {
        latestFileRequest += 1;
        latestFileTarget = null;
      }
      try {
        const response = await workApi.saveFile(
          taskId,
          path,
          content,
          expectedUpdatedAt
        );
        assertCurrentEpoch(requestEpoch);
        if (!response.success || !response.data) {
          throw responseError('Could not save this workspace file.', response);
        }
        if (
          get().selectedTaskId === taskId &&
          get().selectedFile?.path === path
        ) {
          if (latestFileTarget === saveTarget) {
            latestFileRequest += 1;
            latestFileTarget = null;
          }
          set({ selectedFile: response.data });
        }
        return response.data;
      } catch (error) {
        const message = thrownError(error, 'Could not save this file.');
        commitActionError(taskId, requestEpoch, message);
        throw new Error(message);
      } finally {
        finishActionRequest(actionToken, requestEpoch);
      }
    },

    startPreview: (taskId, command) =>
      runTaskAction(
        () => workApi.startPreview(taskId, command),
        'Could not start the workspace preview.',
        taskId
      ),

    stopPreview: taskId =>
      runTaskAction(
        () => workApi.stopPreview(taskId),
        'Could not stop the workspace preview.',
        taskId
      ),

    clearError: () => set({ error: null }),

    clearAllState: () => {
      stateEpoch += 1;
      latestStartedVisibleTaskListRequest = ++taskListRequestSequence;
      latestCommittedTaskListRequest = latestStartedVisibleTaskListRequest;
      taskMutationRevision += 1;
      taskListError = null;
      visibleTaskListRequests.clear();
      activeActionRequests.clear();
      invalidateWorkspaceRequests();
      set({
        capabilities: null,
        tasks: [],
        selectedTaskId: null,
        selectedTask: null,
        files: [],
        selectedFile: null,
        liveRuns: {},
        loadingTasks: false,
        loadingTask: false,
        loadingOlderMessages: false,
        loadingFiles: false,
        actionLoading: false,
        error: null,
      });
    },
  };
});
