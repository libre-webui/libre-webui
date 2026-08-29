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

import { useTranslation } from 'react-i18next';
import type { WorkRunLoopStats } from '@/types/work';
import { cn } from '@/utils';

/**
 * How the run spent its budget, as a calm row of labeled counts. Zero
 * counts stay hidden: a run that never nudged or fenced should not carry
 * a row of zeros.
 */
export function WorkRunStats({
  stats,
  budgetReason,
  className,
}: {
  stats: WorkRunLoopStats;
  budgetReason?: string;
  className?: string;
}) {
  const { t } = useTranslation();
  const chips: Array<{ key: string; label: string; value: number }> = (
    [
      ['rounds', t('work.live.stats.rounds', { defaultValue: 'Rounds' })],
      [
        'toolCalls',
        t('work.live.stats.toolCalls', { defaultValue: 'Tool calls' }),
      ],
      [
        'screenshots',
        t('work.live.stats.screenshots', { defaultValue: 'Screenshots' }),
      ],
      ['fences', t('work.live.stats.fences', { defaultValue: 'Fences' })],
      [
        'expectationsPassed',
        t('work.live.stats.checksPassed', { defaultValue: 'Checks passed' }),
      ],
      [
        'expectationsPending',
        t('work.live.stats.checksPending', { defaultValue: 'Checks pending' }),
      ],
      [
        'stallNudges',
        t('work.live.stats.stallNudges', { defaultValue: 'Stall nudges' }),
      ],
      [
        'ambiguityNudges',
        t('work.live.stats.ambiguityNudges', {
          defaultValue: 'Re-grounding nudges',
        }),
      ],
    ] as const
  ).flatMap(([key, label]) => {
    const value = stats[key];
    return typeof value === 'number' && value > 0
      ? [{ key, label, value }]
      : [];
  });
  if (chips.length === 0 && !budgetReason) return null;
  return (
    <div
      data-testid='work-run-stats'
      className={cn(
        'flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-subtle',
        className
      )}
    >
      <span className='font-medium uppercase tracking-wide'>
        {t('work.live.stats.title', { defaultValue: 'Run summary' })}
      </span>
      {chips.map(chip => (
        <span key={chip.key} className='whitespace-nowrap'>
          {chip.label}{' '}
          <span className='font-medium text-ink-muted'>{chip.value}</span>
        </span>
      ))}
      {budgetReason && (
        <span className='whitespace-nowrap'>
          {t('work.live.stats.stoppedBy', { defaultValue: 'Stopped by' })}{' '}
          <span className='font-medium text-ink-muted'>{budgetReason}</span>
        </span>
      )}
    </div>
  );
}
