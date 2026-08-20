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

import type { ApiResponse, AppNotification } from '@/types';
import { isDemoMode } from '@/utils/demoMode';
import { api, createDemoResponse } from './client';

export const notificationsApi = {
  list: (
    options: { before?: number; limit?: number } = {}
  ): Promise<ApiResponse<AppNotification[]>> => {
    if (isDemoMode()) return createDemoResponse([]);
    const query = new URLSearchParams();
    if (options.before) query.set('before', String(options.before));
    if (options.limit) query.set('limit', String(options.limit));
    const suffix = query.size > 0 ? `?${query.toString()}` : '';
    return api.get(`/notifications${suffix}`).then(res => res.data);
  },

  unreadCount: (): Promise<ApiResponse<{ count: number }>> => {
    if (isDemoMode()) return createDemoResponse({ count: 0 });
    return api.get('/notifications/unread-count').then(res => res.data);
  },

  markRead: (notificationId: string): Promise<ApiResponse> =>
    api.post(`/notifications/${notificationId}/read`).then(res => res.data),

  markAllRead: (): Promise<ApiResponse> =>
    api.post('/notifications/read-all').then(res => res.data),

  delete: (notificationId: string): Promise<ApiResponse> =>
    api.delete(`/notifications/${notificationId}`).then(res => res.data),
};
