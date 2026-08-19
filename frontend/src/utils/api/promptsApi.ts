/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at:
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
import { isDemoMode } from '@/utils/demoMode';
import { api, createDemoResponse } from './client';

export type PromptVariableType = 'text' | 'number' | 'select' | 'boolean';

export interface PromptVariable {
  name: string;
  type: PromptVariableType;
  label?: string;
  required?: boolean;
  default?: string;
  options?: string[];
}

export interface Prompt {
  id: string;
  slug: string;
  title: string;
  description?: string;
  content: string;
  variables: PromptVariable[];
  tags: string[];
  version: number;
  createdAt: number;
  updatedAt: number;
  ownerUserId: string;
}

export interface PromptInput {
  slug: string;
  title: string;
  description?: string;
  content: string;
  variables?: PromptVariable[];
  tags?: string[];
}

export interface PromptRevision {
  version: number;
  content: string;
  variables: PromptVariable[];
  createdAt: number;
}

/** Portable prompt document; the shape `POST /prompts/import` accepts back. */
export interface PromptExport {
  slug: string;
  title: string;
  description?: string;
  content: string;
  variables: PromptVariable[];
  tags: string[];
  version: number;
  exportedAt: number;
  format: string;
}

export const promptsApi = {
  list: (): Promise<ApiResponse<Prompt[]>> => {
    if (isDemoMode()) return createDemoResponse([]);
    return api.get('/prompts').then(res => res.data);
  },

  get: (promptId: string): Promise<ApiResponse<Prompt>> =>
    api.get(`/prompts/${promptId}`).then(res => res.data),

  create: (input: PromptInput): Promise<ApiResponse<Prompt>> =>
    api.post('/prompts', input).then(res => res.data),

  update: (
    promptId: string,
    input: PromptInput
  ): Promise<ApiResponse<Prompt>> =>
    api.put(`/prompts/${promptId}`, input).then(res => res.data),

  remove: (promptId: string): Promise<ApiResponse> =>
    api.delete(`/prompts/${promptId}`).then(res => res.data),

  versions: (promptId: string): Promise<ApiResponse<PromptRevision[]>> =>
    api.get(`/prompts/${promptId}/versions`).then(res => res.data),

  rollback: (promptId: string, version: number): Promise<ApiResponse<Prompt>> =>
    api
      .post(`/prompts/${promptId}/rollback`, { version })
      .then(res => res.data),

  export: (promptId: string): Promise<ApiResponse<PromptExport>> =>
    api.get(`/prompts/${promptId}/export`).then(res => res.data),

  import: (
    payload: unknown,
    options?: { overwriteSlug?: boolean }
  ): Promise<ApiResponse<Prompt>> =>
    api
      .post('/prompts/import', {
        prompt: payload,
        overwriteSlug: options?.overwriteSlug === true,
      })
      .then(res => res.data),
};
