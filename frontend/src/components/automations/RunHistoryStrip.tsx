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

import React from 'react';
import { useTranslation } from 'react-i18next';

interface RunHistoryStripProps {
  /** Thirty buckets, oldest first. */
  days: { succeeded: number; failed: number }[];
  locale: string;
}

/** The last 30 days of runs as a bar strip: green stacked over red. */
export function RunHistoryStrip({ days, locale }: RunHistoryStripProps) {
  const { t } = useTranslation();
  const succeeded = days.reduce((sum, day) => sum + day.succeeded, 0);
  const failed = days.reduce((sum, day) => sum + day.failed, 0);
  const peak = Math.max(1, ...days.map(day => day.succeeded + day.failed));
  const dayFormatter = new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
  });
  const now = new Date();
  const labelFor = (index: number) =>
    dayFormatter.format(
      new Date(now.getFullYear(), now.getMonth(), now.getDate() - 29 + index)
    );

  return (
    <div
      className='rounded-2xl border border-black/[0.06] bg-white/60 px-4 py-3 dark:border-white/[0.07] dark:bg-dark-100/60'
      data-testid='automation-run-strip'
    >
      <div className='mb-2 flex items-center justify-between'>
        <p className='text-[12px] font-medium text-gray-700 dark:text-dark-700'>
          {t('automations.runHistory')}
        </p>
        <p className='text-[11px] text-gray-400 dark:text-dark-500'>
          <span className='text-emerald-600 dark:text-emerald-400'>
            {succeeded} {t('automations.succeeded')}
          </span>
          {' · '}
          <span className='text-red-500 dark:text-red-400'>
            {failed} {t('automations.failed')}
          </span>
        </p>
      </div>
      <div className='flex h-12 items-end gap-[3px]'>
        {days.map((day, index) => {
          const total = day.succeeded + day.failed;
          if (total === 0) {
            return (
              <div
                key={index}
                title={labelFor(index)}
                className='h-[3px] flex-1 rounded-sm bg-black/[0.06] dark:bg-white/[0.08]'
              />
            );
          }
          const height = Math.max(6, Math.round((total / peak) * 48));
          const failedHeight = Math.round((day.failed / total) * height);
          return (
            <div
              key={index}
              title={`${labelFor(index)}: ${day.succeeded}✓ ${day.failed}✗`}
              className='flex flex-1 flex-col justify-end overflow-hidden rounded-sm'
              style={{ height }}
            >
              <div
                className='w-full bg-emerald-500/80'
                style={{ height: height - failedHeight }}
              />
              {failedHeight > 0 && (
                <div
                  className='w-full bg-red-500/80'
                  style={{ height: failedHeight }}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
