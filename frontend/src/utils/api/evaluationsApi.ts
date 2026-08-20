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

export interface FeedbackView {
  id: string;
  userId: string;
  sessionId: string;
  messageId: string;
  rating: number;
  tags: string[];
  comment: string | null;
  model: string | null;
  pluginId: string | null;
  snapshot: { user: string; assistant: string } | null;
  createdAt: number;
  updatedAt: number;
}

export interface EvalItem {
  id: string;
  prompt: string;
}

export interface EvalSetView {
  id: string;
  name: string;
  description: string | null;
  items: EvalItem[];
  createdAt: number;
  updatedAt: number;
}

export interface EvalRunItemResult {
  itemId: string;
  prompt: string;
  output: string;
  error: string | null;
  durationMs: number;
}

export interface EvalRunView {
  id: string;
  setId: string;
  label: string | null;
  pluginId: string | null;
  model: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  results: EvalRunItemResult[] | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

export interface ArenaCandidate {
  key: 'a' | 'b';
  model: string;
  output: string;
}

export interface ArenaMatch {
  compareGroup: string;
  candidates: ArenaCandidate[];
}

export interface ArenaLeaderboardRow {
  model: string;
  rating: number;
  wins: number;
  losses: number;
  ties: number;
  votes: number;
}

export const evaluationsApi = {
  upsertFeedback: (input: {
    sessionId: string;
    messageId: string;
    rating: 1 | -1;
    tags?: string[];
    comment?: string;
  }): Promise<ApiResponse<FeedbackView>> => {
    if (isDemoMode()) {
      return Promise.resolve(
        createDemoResponse(undefined as unknown as FeedbackView)
      );
    }
    return api
      .post('/evaluations/feedback', input)
      .then(response => response.data);
  },

  deleteFeedback: (messageId: string): Promise<void> =>
    api
      .delete(`/evaluations/feedback/${encodeURIComponent(messageId)}`)
      .then(() => undefined),

  listFeedback: (all = false): Promise<ApiResponse<FeedbackView[]>> =>
    api
      .get(all ? '/evaluations/feedback/all' : '/evaluations/feedback')
      .then(response => response.data),

  runArenaMatch: (input: {
    prompt: string;
    modelA: string;
    modelB: string;
    providerIdA?: string;
    providerIdB?: string;
  }): Promise<ApiResponse<ArenaMatch>> =>
    api
      .post('/evaluations/arena/matches', input)
      .then(response => response.data),

  voteArena: (input: {
    compareGroup: string;
    modelA: string;
    modelB: string;
    winner: 'a' | 'b' | 'tie' | 'both-bad';
  }): Promise<ApiResponse<{ recorded: boolean }>> =>
    api.post('/evaluations/arena/votes', input).then(response => response.data),

  leaderboard: (): Promise<ApiResponse<ArenaLeaderboardRow[]>> =>
    api.get('/evaluations/arena/leaderboard').then(response => response.data),

  listSets: (): Promise<ApiResponse<EvalSetView[]>> =>
    api.get('/evaluations/sets').then(response => response.data),

  saveSet: (input: {
    id?: string;
    name: string;
    description?: string;
    items: Array<{ id?: string; prompt: string }>;
  }): Promise<ApiResponse<EvalSetView>> =>
    (input.id
      ? api.put(`/evaluations/sets/${encodeURIComponent(input.id)}`, input)
      : api.post('/evaluations/sets', input)
    ).then(response => response.data),

  deleteSet: (setId: string): Promise<void> =>
    api
      .delete(`/evaluations/sets/${encodeURIComponent(setId)}`)
      .then(() => undefined),

  listRuns: (setId?: string): Promise<ApiResponse<EvalRunView[]>> =>
    api
      .get('/evaluations/runs', { params: setId ? { setId } : {} })
      .then(response => response.data),

  startRun: (input: {
    setId: string;
    model: string;
    pluginId?: string;
    label?: string;
  }): Promise<ApiResponse<EvalRunView>> =>
    api.post('/evaluations/runs', input).then(response => response.data),

  getRun: (runId: string): Promise<ApiResponse<EvalRunView>> =>
    api
      .get(`/evaluations/runs/${encodeURIComponent(runId)}`)
      .then(response => response.data),

  cancelRun: (runId: string): Promise<void> =>
    api
      .post(`/evaluations/runs/${encodeURIComponent(runId)}/cancel`)
      .then(() => undefined),

  exportRun: (runId: string): Promise<Blob> =>
    api
      .get(`/evaluations/runs/${encodeURIComponent(runId)}/export`, {
        responseType: 'blob',
      })
      .then(response => response.data),
};

export default evaluationsApi;
