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

export interface ModelTariff {
  id: string;
  plugin_id: string;
  model: string | null;
  input_per_million: number | null;
  output_per_million: number | null;
  unit_price: number | null;
  currency: string;
  effective_from: number;
  created_at: number;
}

export type BudgetPeriod = 'daily' | 'weekly' | 'monthly';
export type BudgetMode = 'observe' | 'soft' | 'hard';
export type BudgetPrincipalType = 'instance' | 'user' | 'group';

export interface UsageBudget {
  id: string;
  name: string;
  principal_type: BudgetPrincipalType;
  principal_id: string | null;
  period: BudgetPeriod;
  amount_usd: number;
  mode: BudgetMode;
}

export interface CostAnalytics {
  from: number;
  to: number;
  totalUsd: number;
  meteredEvents: number;
  unmeteredEvents: number;
  byPlugin: Array<{ pluginId: string; usd: number; events: number }>;
  byModel: Array<{
    pluginId: string;
    model: string;
    usd: number;
    events: number;
  }>;
  byUser: Array<{ userId: string; usd: number; events: number }>;
  byDay: Array<{ day: string; usd: number }>;
  budgets: Array<{
    id: string;
    name: string;
    principalType: BudgetPrincipalType;
    principalId: string | null;
    period: BudgetPeriod;
    mode: BudgetMode;
    amountUsd: number;
    spentUsd: number;
  }>;
}

export const costsApi = {
  getAnalytics: (days: number): Promise<ApiResponse<CostAnalytics>> =>
    api
      .get('/costs/analytics', { params: { days } })
      .then(response => response.data),

  listTariffs: (): Promise<ApiResponse<ModelTariff[]>> =>
    api.get('/costs/tariffs').then(response => response.data),

  createTariff: (input: {
    pluginId: string;
    model?: string;
    inputPerMillion?: number;
    outputPerMillion?: number;
    unitPrice?: number;
  }): Promise<ApiResponse<ModelTariff>> =>
    api.post('/costs/tariffs', input).then(response => response.data),

  deleteTariff: (tariffId: string): Promise<void> =>
    api
      .delete(`/costs/tariffs/${encodeURIComponent(tariffId)}`)
      .then(() => undefined),

  listBudgets: (): Promise<ApiResponse<UsageBudget[]>> =>
    api.get('/costs/budgets').then(response => response.data),

  createBudget: (input: {
    name: string;
    principalType: BudgetPrincipalType;
    principalId?: string;
    period: BudgetPeriod;
    amountUsd: number;
    mode: BudgetMode;
  }): Promise<ApiResponse<UsageBudget>> =>
    api.post('/costs/budgets', input).then(response => response.data),

  deleteBudget: (budgetId: string): Promise<void> =>
    api
      .delete(`/costs/budgets/${encodeURIComponent(budgetId)}`)
      .then(() => undefined),

  exportUrl: (days: number): string => `/api/costs/export?days=${days}`,

  exportCsv: (days: number): Promise<Blob> =>
    api
      .get('/costs/export', { params: { days }, responseType: 'blob' })
      .then(response => response.data),
};

export default costsApi;
