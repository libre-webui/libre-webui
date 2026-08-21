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

export interface RecoveryDrill {
  id: string;
  status: 'running' | 'passed' | 'failed';
  origin: 'scheduled' | 'manual';
  startedAt: number;
  finishedAt: number | null;
  snapshotBytes: number | null;
  rpoSeconds: number | null;
  restoreMs: number | null;
  error: string | null;
  report: {
    snapshotMs: number;
    archiveBytes: number;
    verifyMs: number;
    restoreMs: number;
    restoreVerifyMs: number;
  } | null;
}

export interface RecoveryDrillOverview {
  supported: boolean;
  intervalHours: number | null;
  drills: RecoveryDrill[];
}

export const recoveryApi = {
  getDrills: (): Promise<ApiResponse<RecoveryDrillOverview>> =>
    api.get('/recovery/drills').then(res => res.data),

  runDrill: (): Promise<ApiResponse<RecoveryDrill>> =>
    api.post('/recovery/drills/run').then(res => res.data),
};
