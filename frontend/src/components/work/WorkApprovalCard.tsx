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

import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ShieldQuestion } from 'lucide-react';
import { Button } from '@/components/ui';
import type { WorkLiveApproval } from '@/types/work';
import { cn } from '@/utils';
import { workApi } from '@/utils/api/workApi';
import toast from 'react-hot-toast';

type SummaryField =
  'command' | 'path' | 'from' | 'to' | 'actions' | 'recursive';

interface SummaryRow {
  field: SummaryField;
  value: string;
}

/** The summary rows worth showing for each gated tool. */
const summaryRows = (approval: WorkLiveApproval): SummaryRow[] => {
  const summary = approval.summary ?? {};
  const rows: SummaryRow[] = [];
  for (const field of ['command', 'path', 'from', 'to', 'actions'] as const) {
    const value = summary[field];
    if (typeof value === 'string' && value) rows.push({ field, value });
  }
  if (typeof summary.actionCount === 'number') {
    rows.push({ field: 'actions', value: String(summary.actionCount) });
  }
  if (summary.recursive === true) {
    rows.push({ field: 'recursive', value: '' });
  }
  return rows;
};

/**
 * In-conversation decision card for a Work run paused on a side-effecting
 * action. Mirrors the chat tool-approval card; "Always allow" persists a
 * per-agent rule (command-scoped for run_command, tool-wide otherwise).
 */
export const WorkApprovalCard: React.FC<{
  taskId: string;
  approval: WorkLiveApproval;
  className?: string;
}> = ({ taskId, approval, className }) => {
  const { t } = useTranslation();
  const [deciding, setDeciding] = useState(false);
  const titleId = useId();
  const rows = summaryRows(approval);

  const decide = async (approve: boolean, scope: 'once' | 'always') => {
    setDeciding(true);
    try {
      await workApi.decideApproval(taskId, approval.approvalId, approve, scope);
    } catch {
      setDeciding(false);
      toast.error(t('work.approval.failed'));
    }
  };

  return (
    <div
      role='group'
      aria-labelledby={titleId}
      data-testid='work-approval-card'
      className={cn(
        'rounded-lg border border-primary-300/70 bg-primary-50 p-3 text-sm dark:border-primary-700/60 dark:bg-primary-900/20',
        className
      )}
    >
      {/* role=alert announces the request when it appears without stealing
          focus from the composer. */}
      <div
        id={titleId}
        role='alert'
        className='flex items-center gap-2 font-medium text-primary-800 dark:text-primary-200'
      >
        <ShieldQuestion aria-hidden='true' className='h-4 w-4 shrink-0' />
        {t('work.approval.title')}
      </div>
      <p className='mt-1 text-primary-800/90 dark:text-primary-100/80'>
        {t('work.approval.description', { tool: approval.name })}
      </p>
      <div
        role='region'
        tabIndex={0}
        aria-label={t('work.approval.details')}
        className='mt-2 max-h-32 overflow-auto whitespace-pre-wrap rounded bg-white/70 p-2 font-mono text-xs text-gray-700 dark:bg-dark-100 dark:text-gray-300'
      >
        {rows.length === 0 ? (
          <bdi dir='ltr'>{approval.name}</bdi>
        ) : (
          rows.map((row, index) => (
            <div key={`${row.field}-${index}`}>
              <span>{t(`work.approval.fields.${row.field}`)}</span>
              {row.field === 'recursive' ? (
                <> {t('common.yes')}</>
              ) : (
                <>
                  {': '}
                  <bdi dir='ltr'>{row.value}</bdi>
                </>
              )}
            </div>
          ))
        )}
      </div>
      <div className='mt-3 flex flex-wrap gap-2'>
        <Button
          size='sm'
          disabled={deciding}
          data-testid='work-approval-allow-once'
          onClick={() => void decide(true, 'once')}
        >
          {t('work.approval.allowOnce')}
        </Button>
        <Button
          size='sm'
          variant='secondary'
          disabled={deciding}
          data-testid='work-approval-allow-always'
          onClick={() => void decide(true, 'always')}
        >
          {t('work.approval.allowAlways')}
        </Button>
        <Button
          size='sm'
          variant='ghost'
          disabled={deciding}
          data-testid='work-approval-deny'
          onClick={() => void decide(false, 'once')}
        >
          {t('work.approval.deny')}
        </Button>
      </div>
    </div>
  );
};
