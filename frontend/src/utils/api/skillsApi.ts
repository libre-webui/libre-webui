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

export interface Skill {
  id: string;
  slug: string;
  name: string;
  description: string;
  instructions: string;
  enabled: boolean;
  version: number;
  createdAt: number;
  updatedAt: number;
  ownerUserId: string;
}

export interface SkillInput {
  slug: string;
  name: string;
  description: string;
  instructions: string;
  enabled?: boolean;
}

export interface SkillRevision {
  version: number;
  instructions: string;
  createdAt: number;
}

/** Portable skill document; the shape `POST /skills/import` accepts back. */
export interface SkillExport {
  slug: string;
  name: string;
  description: string;
  instructions: string;
  enabled: boolean;
  version: number;
  exportedAt: number;
  format: string;
  /** The SKILL.md interchange form of this skill. */
  markdown?: string;
}

export const skillsApi = {
  list: (): Promise<ApiResponse<Skill[]>> => {
    if (isDemoMode()) return createDemoResponse([]);
    return api.get('/skills').then(res => res.data);
  },

  get: (skillId: string): Promise<ApiResponse<Skill>> =>
    api.get(`/skills/${skillId}`).then(res => res.data),

  create: (input: SkillInput): Promise<ApiResponse<Skill>> =>
    api.post('/skills', input).then(res => res.data),

  update: (
    skillId: string,
    input: Partial<SkillInput>
  ): Promise<ApiResponse<Skill>> =>
    api.put(`/skills/${skillId}`, input).then(res => res.data),

  remove: (skillId: string): Promise<ApiResponse> =>
    api.delete(`/skills/${skillId}`).then(res => res.data),

  versions: (skillId: string): Promise<ApiResponse<SkillRevision[]>> =>
    api.get(`/skills/${skillId}/versions`).then(res => res.data),

  rollback: (skillId: string, version: number): Promise<ApiResponse<Skill>> =>
    api.post(`/skills/${skillId}/rollback`, { version }).then(res => res.data),

  export: (skillId: string): Promise<ApiResponse<SkillExport>> =>
    api.get(`/skills/${skillId}/export`).then(res => res.data),

  importFromUrl: (
    source: string,
    options?: { overwriteSlug?: boolean }
  ): Promise<ApiResponse<Skill>> =>
    api
      .post('/skills/import-url', {
        source,
        overwriteSlug: options?.overwriteSlug === true,
      })
      .then(res => res.data),

  import: (
    payload: unknown,
    options?: { overwriteSlug?: boolean }
  ): Promise<ApiResponse<Skill>> =>
    api
      .post('/skills/import', {
        skill: payload,
        overwriteSlug: options?.overwriteSlug === true,
      })
      .then(res => res.data),
};
