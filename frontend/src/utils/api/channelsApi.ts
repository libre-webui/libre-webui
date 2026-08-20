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

import type {
  ApiResponse,
  Channel,
  ChannelMember,
  ChannelMessage,
  ChannelSummary,
} from '@/types';
import { isDemoMode } from '@/utils/demoMode';
import { api, createDemoResponse } from './client';

export interface PostChannelMessageInput {
  id?: string;
  content: string;
  parentId?: string;
  attachmentIds?: string[];
  mentionModel?: string;
  mentionProviderType?: string;
  mentionProviderId?: string;
}

export const channelsApi = {
  listMine: (): Promise<ApiResponse<ChannelSummary[]>> => {
    if (isDemoMode()) return createDemoResponse([]);
    return api.get('/channels').then(res => res.data);
  },

  listPublic: (): Promise<ApiResponse<ChannelSummary[]>> => {
    if (isDemoMode()) return createDemoResponse([]);
    return api.get('/channels/public').then(res => res.data);
  },

  create: (input: {
    type: 'public' | 'private';
    name: string;
    description?: string;
    memberIds?: string[];
  }): Promise<ApiResponse<Channel>> =>
    api.post('/channels', input).then(res => res.data),

  openDm: (userId: string): Promise<ApiResponse<Channel>> =>
    api.post('/channels/dm', { userId }).then(res => res.data),

  get: (channelId: string): Promise<ApiResponse<ChannelSummary>> =>
    api.get(`/channels/${channelId}`).then(res => res.data),

  update: (
    channelId: string,
    updates: { name?: string; description?: string; archived?: boolean }
  ): Promise<ApiResponse<Channel>> =>
    api.patch(`/channels/${channelId}`, updates).then(res => res.data),

  delete: (channelId: string): Promise<ApiResponse> =>
    api.delete(`/channels/${channelId}`).then(res => res.data),

  join: (channelId: string): Promise<ApiResponse> =>
    api.post(`/channels/${channelId}/join`).then(res => res.data),

  listMembers: (channelId: string): Promise<ApiResponse<ChannelMember[]>> =>
    api.get(`/channels/${channelId}/members`).then(res => res.data),

  addMember: (
    channelId: string,
    userId: string
  ): Promise<ApiResponse<ChannelMember>> =>
    api
      .post(`/channels/${channelId}/members`, { userId })
      .then(res => res.data),

  removeMember: (channelId: string, userId: string): Promise<ApiResponse> =>
    api
      .delete(`/channels/${channelId}/members/${encodeURIComponent(userId)}`)
      .then(res => res.data),

  listMessages: (
    channelId: string,
    options: { before?: string; after?: string; limit?: number } = {}
  ): Promise<ApiResponse<ChannelMessage[]>> => {
    const query = new URLSearchParams();
    if (options.before) query.set('before', options.before);
    if (options.after) query.set('after', options.after);
    if (options.limit) query.set('limit', String(options.limit));
    const suffix = query.size > 0 ? `?${query.toString()}` : '';
    return api
      .get(`/channels/${channelId}/messages${suffix}`)
      .then(res => res.data);
  },

  postMessage: (
    channelId: string,
    input: PostChannelMessageInput
  ): Promise<ApiResponse<ChannelMessage>> =>
    api.post(`/channels/${channelId}/messages`, input).then(res => res.data),

  listPins: (channelId: string): Promise<ApiResponse<ChannelMessage[]>> =>
    api.get(`/channels/${channelId}/pins`).then(res => res.data),

  markRead: (channelId: string): Promise<ApiResponse> =>
    api.post(`/channels/${channelId}/read`, {}).then(res => res.data),

  thread: (messageId: string): Promise<ApiResponse<ChannelMessage[]>> =>
    api.get(`/channels/messages/${messageId}/thread`).then(res => res.data),

  editMessage: (
    messageId: string,
    content: string
  ): Promise<ApiResponse<ChannelMessage>> =>
    api
      .patch(`/channels/messages/${messageId}`, { content })
      .then(res => res.data),

  deleteMessage: (messageId: string): Promise<ApiResponse> =>
    api.delete(`/channels/messages/${messageId}`).then(res => res.data),

  setPinned: (
    messageId: string,
    pinned: boolean
  ): Promise<ApiResponse<ChannelMessage>> =>
    api
      .post(`/channels/messages/${messageId}/pin`, { pinned })
      .then(res => res.data),

  addReaction: (messageId: string, emoji: string): Promise<ApiResponse> =>
    api
      .post(`/channels/messages/${messageId}/reactions`, { emoji })
      .then(res => res.data),

  removeReaction: (messageId: string, emoji: string): Promise<ApiResponse> =>
    api
      .delete(
        `/channels/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`
      )
      .then(res => res.data),

  uploadAttachment: (
    channelId: string,
    file: File
  ): Promise<
    ApiResponse<{
      id: string;
      filename: string;
      contentType: string;
      size: number;
    }>
  > => {
    const form = new FormData();
    form.append('attachment', file);
    return api
      .post(`/channels/${channelId}/attachments`, form, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      .then(res => res.data);
  },

  downloadAttachment: (attachmentId: string): Promise<Blob> =>
    api
      .get(`/channels/attachments/${attachmentId}`, { responseType: 'blob' })
      .then(res => res.data),
};
