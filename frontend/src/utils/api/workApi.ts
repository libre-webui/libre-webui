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

import type { ApiResponse } from '@/types';
import type {
  CreateWorkTaskRequest,
  StartWorkRunRequest,
  UpdateWorkTaskRequest,
  WorkCapabilities,
  WorkFile,
  WorkFileEntry,
  WorkMessagePage,
  WorkTask,
  WorkTaskSummary,
} from '@/types/work';
import { api } from './client';

const taskPath = (taskId: string): string =>
  `/work/tasks/${encodeURIComponent(taskId)}`;

export const workApi = {
  capabilities: (): Promise<ApiResponse<WorkCapabilities>> =>
    api.get('/work/capabilities').then(response => response.data),

  listTasks: (): Promise<ApiResponse<WorkTaskSummary[]>> =>
    api.get('/work/tasks').then(response => response.data),

  createTask: (
    payload: CreateWorkTaskRequest
  ): Promise<ApiResponse<WorkTask>> =>
    api.post('/work/tasks', payload).then(response => response.data),

  getTask: (taskId: string): Promise<ApiResponse<WorkTask>> =>
    api.get(taskPath(taskId)).then(response => response.data),

  getMessages: (
    taskId: string,
    before: number,
    limit = 200
  ): Promise<ApiResponse<WorkMessagePage>> =>
    api
      .get(`${taskPath(taskId)}/messages`, {
        params: { before, limit },
      })
      .then(response => response.data),

  updateTask: (
    taskId: string,
    payload: UpdateWorkTaskRequest
  ): Promise<ApiResponse<WorkTask>> =>
    api.patch(taskPath(taskId), payload).then(response => response.data),

  deleteTask: (
    taskId: string
  ): Promise<ApiResponse<{ id: string; deleted: true }>> =>
    api.delete(taskPath(taskId)).then(response => response.data),

  startRun: (
    taskId: string,
    payload: StartWorkRunRequest
  ): Promise<ApiResponse<WorkTask>> =>
    api
      .post(`${taskPath(taskId)}/runs`, payload)
      .then(response => response.data),

  cancelRun: (taskId: string): Promise<ApiResponse<WorkTask>> =>
    api.post(`${taskPath(taskId)}/cancel`).then(response => response.data),

  listFiles: (
    taskId: string,
    path = ''
  ): Promise<ApiResponse<WorkFileEntry[]>> =>
    api
      .get(`${taskPath(taskId)}/files`, { params: { path } })
      .then(response => {
        const envelope = response.data as ApiResponse<
          WorkFileEntry[] | { entries: WorkFileEntry[] }
        >;
        if (envelope.data && !Array.isArray(envelope.data)) {
          return { ...envelope, data: envelope.data.entries };
        }
        return envelope as ApiResponse<WorkFileEntry[]>;
      }),

  getFile: (taskId: string, path: string): Promise<ApiResponse<WorkFile>> =>
    api
      .get(`${taskPath(taskId)}/file`, { params: { path } })
      .then(response => response.data),

  saveFile: (
    taskId: string,
    path: string,
    content: string,
    expectedUpdatedAt?: number
  ): Promise<ApiResponse<WorkFile>> =>
    api
      .put(
        `${taskPath(taskId)}/file`,
        { content, expectedUpdatedAt },
        { params: { path } }
      )
      .then(response => response.data),

  startPreview: (
    taskId: string,
    command?: string
  ): Promise<ApiResponse<WorkTask>> =>
    api
      .post(`${taskPath(taskId)}/preview/start`, command ? { command } : {})
      .then(response => response.data),

  stopPreview: (taskId: string): Promise<ApiResponse<WorkTask>> =>
    api
      .post(`${taskPath(taskId)}/preview/stop`)
      .then(response => response.data),
};
