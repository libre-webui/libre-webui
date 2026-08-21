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
import { api } from './client';

export interface PushSubscriptionSummary {
  id: string;
  userAgent: string | null;
  createdAt: number;
  lastUsedAt: number | null;
  current: boolean;
}

export const pushApi = {
  getPublicKey: (): Promise<ApiResponse<{ publicKey: string }>> =>
    api.get('/push/public-key').then(res => res.data),

  listSubscriptions: (): Promise<ApiResponse<PushSubscriptionSummary[]>> =>
    api.get('/push/subscriptions').then(res => res.data),

  subscribe: (subscription: unknown): Promise<ApiResponse<{ id: string }>> =>
    api.post('/push/subscriptions', subscription).then(res => res.data),

  unsubscribe: (endpoint: string): Promise<ApiResponse<{ removed: boolean }>> =>
    api
      .delete('/push/subscriptions', { data: { endpoint } })
      .then(res => res.data),
};
