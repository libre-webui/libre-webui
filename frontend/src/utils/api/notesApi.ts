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

import type { ApiResponse, Note, NoteAttachment, NoteRevision } from '@/types';
import { isDemoMode } from '@/utils/demoMode';
import { api, createDemoResponse } from './client';

export const notesApi = {
  getNotes: (): Promise<ApiResponse<Note[]>> => {
    if (isDemoMode()) return createDemoResponse([]);
    return api.get('/notes').then(res => res.data);
  },

  getNote: (noteId: string): Promise<ApiResponse<Note>> =>
    api.get(`/notes/${noteId}`).then(res => res.data),

  createNote: (title: string, content: string): Promise<ApiResponse<Note>> =>
    api.post('/notes', { title, content }).then(res => res.data),

  updateNote: (
    noteId: string,
    updates: { title?: string; content?: string; pinned?: boolean }
  ): Promise<ApiResponse<Note>> =>
    api.put(`/notes/${noteId}`, updates).then(res => res.data),

  deleteNote: (noteId: string): Promise<ApiResponse> =>
    api.delete(`/notes/${noteId}`).then(res => res.data),

  getRevisions: (noteId: string): Promise<ApiResponse<NoteRevision[]>> =>
    api.get(`/notes/${noteId}/revisions`).then(res => res.data),

  restoreRevision: (
    noteId: string,
    revisionId: string
  ): Promise<ApiResponse<Note>> =>
    api
      .post(`/notes/${noteId}/revisions/${revisionId}/restore`)
      .then(res => res.data),

  getAttachments: (noteId: string): Promise<ApiResponse<NoteAttachment[]>> =>
    api.get(`/notes/${noteId}/attachments`).then(res => res.data),

  uploadAttachment: (
    noteId: string,
    file: File
  ): Promise<ApiResponse<NoteAttachment>> => {
    const form = new FormData();
    form.append('attachment', file);
    return api
      .post(`/notes/${noteId}/attachments`, form, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      .then(res => res.data);
  },

  downloadAttachment: (noteId: string, attachmentId: string): Promise<Blob> =>
    api
      .get(`/notes/${noteId}/attachments/${attachmentId}`, {
        responseType: 'blob',
      })
      .then(res => res.data),

  deleteAttachment: (
    noteId: string,
    attachmentId: string
  ): Promise<ApiResponse> =>
    api
      .delete(`/notes/${noteId}/attachments/${attachmentId}`)
      .then(res => res.data),

  assist: (
    noteId: string,
    input: {
      instruction: string;
      model: string;
      providerType?: string | null;
      providerId?: string | null;
    }
  ): Promise<ApiResponse<{ content: string }>> =>
    api.post(`/notes/${noteId}/assist`, input).then(res => res.data),
};
