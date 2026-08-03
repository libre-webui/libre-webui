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

import type { ApiResponse, Note } from '@/types';
import { isDemoMode } from '@/utils/demoMode';
import { api, createDemoResponse } from './client';

export const notesApi = {
  getNotes: (): Promise<ApiResponse<Note[]>> => {
    if (isDemoMode()) return createDemoResponse([]);
    return api.get('/notes').then(res => res.data);
  },

  createNote: (title: string, content: string): Promise<ApiResponse<Note>> =>
    api.post('/notes', { title, content }).then(res => res.data),

  updateNote: (
    noteId: string,
    updates: { title?: string; content?: string }
  ): Promise<ApiResponse<Note>> =>
    api.put(`/notes/${noteId}`, updates).then(res => res.data),

  deleteNote: (noteId: string): Promise<ApiResponse> =>
    api.delete(`/notes/${noteId}`).then(res => res.data),
};
