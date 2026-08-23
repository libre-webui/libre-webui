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
  WorkAccess,
  WorkAccessMode,
  WorkAdminOverview,
  WorkCapabilities,
  WorkFile,
  WorkFileEntry,
  WorkGitDiff,
  WorkGitStatus,
  WorkMessagePage,
  WorkComputerSetupStatus,
  WorkPolicy,
  WorkPolicyInput,
  WorkTask,
  WorkTaskSummary,
} from '@/types/work';
import { api } from './client';
import {
  streamWorkRunEvents,
  type WorkRunEventStreamOptions,
} from './workEventStream';

const taskPath = (taskId: string): string =>
  `/work/tasks/${encodeURIComponent(taskId)}`;

export const workApi = {
  access: (): Promise<ApiResponse<WorkAccess>> =>
    api.get('/work/access').then(response => response.data),

  setAccess: (
    mode: WorkAccessMode
  ): Promise<ApiResponse<{ mode: WorkAccessMode }>> =>
    api.put('/work/access', { mode }).then(response => response.data),

  adminOverview: (): Promise<ApiResponse<WorkAdminOverview>> =>
    api.get('/work/admin/overview').then(response => response.data),

  listPolicies: (): Promise<ApiResponse<WorkPolicy[]>> =>
    api.get('/work/policies').then(response => response.data),

  sendRunMessage: (
    taskId: string,
    message: string
  ): Promise<ApiResponse<unknown>> =>
    api
      .post(`/work/tasks/${encodeURIComponent(taskId)}/messages`, { message })
      .then(response => response.data),

  getComputerSetup: (): Promise<ApiResponse<WorkComputerSetupStatus>> =>
    api.get('/work/computer/setup').then(response => response.data),

  startComputerSetup: (): Promise<ApiResponse<WorkComputerSetupStatus>> =>
    api.post('/work/computer/setup').then(response => response.data),

  createPolicy: (input: WorkPolicyInput): Promise<ApiResponse<WorkPolicy>> =>
    api.post('/work/policies', input).then(response => response.data),

  updatePolicy: (
    policyId: string,
    input: WorkPolicyInput
  ): Promise<ApiResponse<WorkPolicy>> =>
    api
      .put(`/work/policies/${encodeURIComponent(policyId)}`, input)
      .then(response => response.data),

  deletePolicy: (
    policyId: string
  ): Promise<ApiResponse<{ id: string; deleted: true }>> =>
    api
      .delete(`/work/policies/${encodeURIComponent(policyId)}`)
      .then(response => response.data),

  capabilities: (): Promise<ApiResponse<WorkCapabilities>> =>
    api.get('/work/capabilities').then(response => response.data),

  markTaskSeen: (taskId: string): Promise<ApiResponse<{ seen: true }>> =>
    api
      .post(`/work/tasks/${encodeURIComponent(taskId)}/seen`)
      .then(res => res.data),

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

  streamRunEvents: (options: WorkRunEventStreamOptions): Promise<void> =>
    streamWorkRunEvents(options),

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

  getGitStatus: (taskId: string): Promise<ApiResponse<WorkGitStatus>> =>
    api.get(`${taskPath(taskId)}/git`).then(response => response.data),

  getGitDiff: (
    taskId: string,
    path?: string
  ): Promise<ApiResponse<WorkGitDiff>> =>
    api
      .get(`${taskPath(taskId)}/git/diff`, {
        params: path ? { path } : undefined,
      })
      .then(response => response.data),

  initializeGit: (taskId: string): Promise<ApiResponse<WorkGitStatus>> =>
    api.post(`${taskPath(taskId)}/git/init`).then(response => response.data),

  stageGitPaths: (
    taskId: string,
    paths: string[]
  ): Promise<ApiResponse<WorkGitStatus>> =>
    api
      .post(`${taskPath(taskId)}/git/stage`, { paths })
      .then(response => response.data),

  commitGit: (
    taskId: string,
    message: string
  ): Promise<ApiResponse<WorkGitStatus>> =>
    api
      .post(`${taskPath(taskId)}/git/commit`, { message })
      .then(response => response.data),

  createGitBranch: (
    taskId: string,
    name: string
  ): Promise<ApiResponse<WorkGitStatus>> =>
    api
      .post(`${taskPath(taskId)}/git/branches`, { name })
      .then(response => response.data),

  switchGitBranch: (
    taskId: string,
    name: string
  ): Promise<ApiResponse<WorkGitStatus>> =>
    api
      .post(`${taskPath(taskId)}/git/switch`, { name })
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
