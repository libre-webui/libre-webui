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

import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-hot-toast';
import { Download, Loader2, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui';
import {
  costsApi,
  type BudgetMode,
  type BudgetPeriod,
  type BudgetPrincipalType,
  type CostAnalytics,
  type ModelTariff,
  type UsageBudget,
} from '@/utils/api/costsApi';

const usd = (value: number): string =>
  new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: value < 1 ? 4 : 2,
  }).format(value);

const inputClass =
  'w-full rounded-lg border border-gray-300 bg-white px-2 py-1.5 text-sm dark:border-dark-300 dark:bg-dark-50';

/**
 * Cost and budget governance (ADMIN-01): versioned tariffs price the usage
 * ledger, budgets watch or cap the spend, and the ledger exports as CSV.
 */
export const CostGovernancePanel: React.FC<{ days: number }> = ({ days }) => {
  const { t } = useTranslation();
  const [analytics, setAnalytics] = useState<CostAnalytics | null>(null);
  const [tariffs, setTariffs] = useState<ModelTariff[]>([]);
  const [budgets, setBudgets] = useState<UsageBudget[]>([]);
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);

  const [tariffForm, setTariffForm] = useState({
    pluginId: '',
    model: '',
    inputPerMillion: '',
    outputPerMillion: '',
    unitPrice: '',
  });
  const [budgetForm, setBudgetForm] = useState({
    name: '',
    principalType: 'instance' as BudgetPrincipalType,
    principalId: '',
    period: 'monthly' as BudgetPeriod,
    amountUsd: '',
    mode: 'soft' as BudgetMode,
  });

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      costsApi.getAnalytics(days),
      costsApi.listTariffs(),
      costsApi.listBudgets(),
    ])
      .then(([analyticsResponse, tariffsResponse, budgetsResponse]) => {
        if (cancelled) return;
        if (analyticsResponse.success && analyticsResponse.data) {
          setAnalytics(analyticsResponse.data);
        }
        if (tariffsResponse.success && tariffsResponse.data) {
          setTariffs(tariffsResponse.data);
        }
        if (budgetsResponse.success && budgetsResponse.data) {
          setBudgets(budgetsResponse.data);
        }
      })
      .catch(() => toast.error(t('costs.loadFailed')))
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [days, refresh, t]);

  const numberOrUndefined = (value: string): number | undefined => {
    if (!value.trim()) return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  };

  const handleCreateTariff = async () => {
    try {
      const response = await costsApi.createTariff({
        pluginId: tariffForm.pluginId.trim(),
        model: tariffForm.model.trim() || undefined,
        inputPerMillion: numberOrUndefined(tariffForm.inputPerMillion),
        outputPerMillion: numberOrUndefined(tariffForm.outputPerMillion),
        unitPrice: numberOrUndefined(tariffForm.unitPrice),
      });
      if (!response.success) throw new Error(response.message);
      toast.success(t('costs.tariffSaved'));
      setTariffForm({
        pluginId: '',
        model: '',
        inputPerMillion: '',
        outputPerMillion: '',
        unitPrice: '',
      });
      setRefresh(value => value + 1);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : t('costs.saveFailed')
      );
    }
  };

  const handleCreateBudget = async () => {
    try {
      const response = await costsApi.createBudget({
        name: budgetForm.name.trim(),
        principalType: budgetForm.principalType,
        principalId:
          budgetForm.principalType === 'instance'
            ? undefined
            : budgetForm.principalId.trim(),
        period: budgetForm.period,
        amountUsd: Number(budgetForm.amountUsd),
        mode: budgetForm.mode,
      });
      if (!response.success) throw new Error(response.message);
      toast.success(t('costs.budgetSaved'));
      setBudgetForm({
        name: '',
        principalType: 'instance',
        principalId: '',
        period: 'monthly',
        amountUsd: '',
        mode: 'soft',
      });
      setRefresh(value => value + 1);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : t('costs.saveFailed')
      );
    }
  };

  const handleExport = async () => {
    try {
      const blob = await costsApi.exportCsv(days);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'libre-webui-costs.csv';
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch {
      toast.error(t('costs.exportFailed'));
    }
  };

  if (loading && !analytics) {
    return (
      <div className='flex justify-center rounded-lg border border-gray-200 bg-white p-6 dark:border-dark-300 dark:bg-dark-100'>
        <Loader2 className='h-5 w-5 animate-spin text-gray-400' />
      </div>
    );
  }

  return (
    <div
      className='space-y-4 rounded-lg border border-gray-200 bg-white p-4 dark:border-dark-300 dark:bg-dark-100'
      data-testid='cost-governance-panel'
    >
      <div className='flex flex-wrap items-center justify-between gap-3'>
        <div>
          <h3 className='text-sm font-semibold text-gray-900 dark:text-gray-100'>
            {t('costs.title')}
          </h3>
          <p className='text-xs text-gray-500 dark:text-gray-400'>
            {t('costs.description')}
          </p>
        </div>
        <Button size='sm' variant='outline' onClick={() => void handleExport()}>
          <Download className='mr-1 h-3.5 w-3.5' />
          {t('costs.exportCsv')}
        </Button>
      </div>

      {analytics && (
        <div className='grid grid-cols-2 gap-3 sm:grid-cols-4'>
          <div className='rounded-lg bg-gray-50 p-3 dark:bg-dark-50'>
            <p className='text-xs text-gray-500'>{t('costs.totalSpend')}</p>
            <p className='text-lg font-semibold'>{usd(analytics.totalUsd)}</p>
          </div>
          <div className='rounded-lg bg-gray-50 p-3 dark:bg-dark-50'>
            <p className='text-xs text-gray-500'>{t('costs.meteredEvents')}</p>
            <p className='text-lg font-semibold'>{analytics.meteredEvents}</p>
          </div>
          <div className='rounded-lg bg-gray-50 p-3 dark:bg-dark-50'>
            <p className='text-xs text-gray-500'>
              {t('costs.unmeteredEvents')}
            </p>
            <p className='text-lg font-semibold'>{analytics.unmeteredEvents}</p>
          </div>
          <div className='rounded-lg bg-gray-50 p-3 dark:bg-dark-50'>
            <p className='text-xs text-gray-500'>{t('costs.topModel')}</p>
            <p className='truncate text-sm font-medium'>
              {analytics.byModel[0]
                ? `${analytics.byModel[0].model} (${usd(analytics.byModel[0].usd)})`
                : '—'}
            </p>
          </div>
        </div>
      )}

      <div>
        <h4 className='mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500'>
          {t('costs.budgets')}
        </h4>
        <div className='space-y-2'>
          {analytics?.budgets.map(budget => {
            const ratio = Math.min(1, budget.spentUsd / budget.amountUsd);
            return (
              <div
                key={budget.id}
                className='rounded-lg border border-gray-200 p-2 dark:border-dark-300'
              >
                <div className='flex items-center justify-between gap-2 text-sm'>
                  <span className='min-w-0 truncate font-medium'>
                    {budget.name}
                    <span className='ml-2 text-xs font-normal text-gray-500'>
                      {t(`costs.mode.${budget.mode}`)} ·{' '}
                      {t(`costs.period.${budget.period}`)} ·{' '}
                      {budget.principalType === 'instance'
                        ? t('costs.scope.instance')
                        : `${t(`costs.scope.${budget.principalType}`)}: ${budget.principalId}`}
                    </span>
                  </span>
                  <span className='shrink-0 text-xs text-gray-600 dark:text-gray-300'>
                    {usd(budget.spentUsd)} / {usd(budget.amountUsd)}
                  </span>
                  <button
                    onClick={() => {
                      void costsApi
                        .deleteBudget(budget.id)
                        .then(() => setRefresh(value => value + 1))
                        .catch(() => toast.error(t('costs.saveFailed')));
                    }}
                    className='shrink-0 rounded p-1 text-red-500 hover:bg-red-50 dark:hover:bg-red-950/30'
                    aria-label={t('costs.deleteBudget')}
                  >
                    <Trash2 className='h-3.5 w-3.5' />
                  </button>
                </div>
                <div className='mt-1 h-1.5 overflow-hidden rounded bg-gray-200 dark:bg-dark-300'>
                  <div
                    className={
                      ratio >= 1
                        ? 'h-full bg-red-500'
                        : ratio >= 0.8
                          ? 'h-full bg-amber-500'
                          : 'h-full bg-emerald-500'
                    }
                    style={{ width: `${Math.round(ratio * 100)}%` }}
                  />
                </div>
              </div>
            );
          })}
          {budgets.length === 0 && (
            <p className='text-xs text-gray-500'>{t('costs.noBudgets')}</p>
          )}
        </div>
        <div className='mt-2 grid grid-cols-2 gap-2 sm:grid-cols-6'>
          <input
            className={inputClass}
            placeholder={t('costs.budgetName')}
            value={budgetForm.name}
            onChange={event =>
              setBudgetForm({ ...budgetForm, name: event.target.value })
            }
          />
          <select
            className={inputClass}
            value={budgetForm.principalType}
            onChange={event =>
              setBudgetForm({
                ...budgetForm,
                principalType: event.target.value as BudgetPrincipalType,
              })
            }
          >
            <option value='instance'>{t('costs.scope.instance')}</option>
            <option value='user'>{t('costs.scope.user')}</option>
            <option value='group'>{t('costs.scope.group')}</option>
          </select>
          <input
            className={inputClass}
            placeholder={t('costs.principalId')}
            value={budgetForm.principalId}
            disabled={budgetForm.principalType === 'instance'}
            onChange={event =>
              setBudgetForm({ ...budgetForm, principalId: event.target.value })
            }
          />
          <select
            className={inputClass}
            value={budgetForm.period}
            onChange={event =>
              setBudgetForm({
                ...budgetForm,
                period: event.target.value as BudgetPeriod,
              })
            }
          >
            <option value='daily'>{t('costs.period.daily')}</option>
            <option value='weekly'>{t('costs.period.weekly')}</option>
            <option value='monthly'>{t('costs.period.monthly')}</option>
          </select>
          <div className='flex gap-2'>
            <input
              className={inputClass}
              placeholder='USD'
              inputMode='decimal'
              value={budgetForm.amountUsd}
              onChange={event =>
                setBudgetForm({ ...budgetForm, amountUsd: event.target.value })
              }
            />
            <select
              className={inputClass}
              value={budgetForm.mode}
              onChange={event =>
                setBudgetForm({
                  ...budgetForm,
                  mode: event.target.value as BudgetMode,
                })
              }
            >
              <option value='observe'>{t('costs.mode.observe')}</option>
              <option value='soft'>{t('costs.mode.soft')}</option>
              <option value='hard'>{t('costs.mode.hard')}</option>
            </select>
          </div>
          <Button size='sm' onClick={() => void handleCreateBudget()}>
            <Plus className='mr-1 h-3.5 w-3.5' />
            {t('costs.addBudget')}
          </Button>
        </div>
      </div>

      <div>
        <h4 className='mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500'>
          {t('costs.tariffs')}
        </h4>
        <div className='overflow-x-auto'>
          <table className='w-full text-left text-xs'>
            <thead className='text-gray-500'>
              <tr>
                <th className='py-1 pr-2'>{t('costs.plugin')}</th>
                <th className='py-1 pr-2'>{t('costs.model')}</th>
                <th className='py-1 pr-2'>{t('costs.inputPerMillion')}</th>
                <th className='py-1 pr-2'>{t('costs.outputPerMillion')}</th>
                <th className='py-1 pr-2'>{t('costs.unitPrice')}</th>
                <th className='py-1 pr-2'>{t('costs.effectiveFrom')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {tariffs.map(tariff => (
                <tr
                  key={tariff.id}
                  className='border-t border-gray-100 dark:border-dark-300'
                >
                  <td className='py-1 pr-2'>{tariff.plugin_id}</td>
                  <td className='py-1 pr-2'>
                    {tariff.model ?? t('costs.allModels')}
                  </td>
                  <td className='py-1 pr-2'>
                    {tariff.input_per_million !== null
                      ? usd(tariff.input_per_million)
                      : '—'}
                  </td>
                  <td className='py-1 pr-2'>
                    {tariff.output_per_million !== null
                      ? usd(tariff.output_per_million)
                      : '—'}
                  </td>
                  <td className='py-1 pr-2'>
                    {tariff.unit_price !== null ? usd(tariff.unit_price) : '—'}
                  </td>
                  <td className='py-1 pr-2'>
                    {new Intl.DateTimeFormat(undefined, {
                      dateStyle: 'medium',
                    }).format(tariff.effective_from)}
                  </td>
                  <td className='py-1'>
                    <button
                      onClick={() => {
                        void costsApi
                          .deleteTariff(tariff.id)
                          .then(() => setRefresh(value => value + 1))
                          .catch(() => toast.error(t('costs.saveFailed')));
                      }}
                      className='rounded p-1 text-red-500 hover:bg-red-50 dark:hover:bg-red-950/30'
                      aria-label={t('costs.deleteTariff')}
                    >
                      <Trash2 className='h-3.5 w-3.5' />
                    </button>
                  </td>
                </tr>
              ))}
              {tariffs.length === 0 && (
                <tr>
                  <td colSpan={7} className='py-2 text-gray-500'>
                    {t('costs.noTariffs')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className='mt-2 grid grid-cols-2 gap-2 sm:grid-cols-6'>
          <input
            className={inputClass}
            placeholder={t('costs.plugin')}
            value={tariffForm.pluginId}
            onChange={event =>
              setTariffForm({ ...tariffForm, pluginId: event.target.value })
            }
          />
          <input
            className={inputClass}
            placeholder={t('costs.modelOptional')}
            value={tariffForm.model}
            onChange={event =>
              setTariffForm({ ...tariffForm, model: event.target.value })
            }
          />
          <input
            className={inputClass}
            placeholder={t('costs.inputPerMillion')}
            inputMode='decimal'
            value={tariffForm.inputPerMillion}
            onChange={event =>
              setTariffForm({
                ...tariffForm,
                inputPerMillion: event.target.value,
              })
            }
          />
          <input
            className={inputClass}
            placeholder={t('costs.outputPerMillion')}
            inputMode='decimal'
            value={tariffForm.outputPerMillion}
            onChange={event =>
              setTariffForm({
                ...tariffForm,
                outputPerMillion: event.target.value,
              })
            }
          />
          <input
            className={inputClass}
            placeholder={t('costs.unitPrice')}
            inputMode='decimal'
            value={tariffForm.unitPrice}
            onChange={event =>
              setTariffForm({ ...tariffForm, unitPrice: event.target.value })
            }
          />
          <Button size='sm' onClick={() => void handleCreateTariff()}>
            <Plus className='mr-1 h-3.5 w-3.5' />
            {t('costs.addTariff')}
          </Button>
        </div>
      </div>
    </div>
  );
};

export default CostGovernancePanel;
