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

import React, { useId } from 'react';
import { Info } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { GenerationStatistics } from '@/types';
import { cn } from '@/utils';

interface GenerationStatsProps {
  statistics: GenerationStatistics;
  /** Whether the detailed breakdown is open; the message row owns it. */
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  /** Leave the model out when the message header already names it. */
  hideModel?: boolean;
  className?: string;
}

/**
 * Generation statistics inline in a message's action row. The token count is
 * also the toggle for the detailed breakdown, which opens below the row.
 */
export const GenerationStats: React.FC<GenerationStatsProps> = ({
  statistics,
  expanded,
  onExpandedChange,
  hideModel = false,
  className,
}) => {
  const { t, i18n } = useTranslation();
  const detailsId = useId();
  const formatNumber = (value: number, digits: number): string =>
    value.toLocaleString(i18n.language, {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });

  // Helper function to format duration from nanoseconds
  const formatDuration = (nanoseconds?: number): string => {
    if (nanoseconds == null) return t('generationStats.notAvailable');

    const milliseconds = nanoseconds / 1e6;
    if (milliseconds < 1000) {
      return `${Math.round(milliseconds).toLocaleString(i18n.language)}ms`;
    }

    const seconds = milliseconds / 1000;
    return `${formatNumber(seconds, 2)}s`;
  };

  // Helper function to format tokens per second
  const formatTokensPerSecond = (tokensPerSecond?: number): string => {
    if (!tokensPerSecond) return t('generationStats.notAvailable');
    return t('generationStats.tokensPerSecond', {
      value: formatNumber(tokensPerSecond, 1),
    });
  };

  // Calculate some derived metrics
  const promptTokens = statistics.prompt_eval_count || 0;
  const generatedTokens = statistics.eval_count || 0;
  const totalTokens = promptTokens + generatedTokens;
  const totalDuration = formatDuration(statistics.total_duration);
  const tokensPerSecond = formatTokensPerSecond(statistics.tokens_per_second);

  const details: Array<[string, string | number]> = [
    [t('generationStats.promptTokens'), promptTokens],
    [t('generationStats.generatedTokens'), generatedTokens],
    [t('generationStats.totalTokens'), totalTokens],
    [t('generationStats.speed'), tokensPerSecond],
    [
      t('generationStats.promptEval'),
      formatDuration(statistics.prompt_eval_duration),
    ],
    [t('generationStats.generation'), formatDuration(statistics.eval_duration)],
    [t('generationStats.modelLoad'), formatDuration(statistics.load_duration)],
    [t('generationStats.totalTime'), totalDuration],
  ];

  return (
    <>
      <div
        data-testid='generation-stats'
        className={cn(
          'flex min-w-0 items-center gap-3 text-xs tabular-nums text-ink-subtle',
          className
        )}
      >
        <button
          type='button'
          onClick={() => onExpandedChange(!expanded)}
          aria-expanded={expanded}
          aria-controls={detailsId}
          title={t('generationStats.details')}
          className='flex items-center gap-1 rounded-md transition-colors hover:text-ink focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-primary-500/40'
        >
          <Info aria-hidden='true' className='h-3 w-3' />
          {t('generationStats.tokenCount', {
            tokens: generatedTokens.toLocaleString(i18n.language),
          })}
        </button>
        <span>{tokensPerSecond}</span>
        <span>{totalDuration}</span>
        {statistics.model && !hideModel && (
          <span
            dir='ltr'
            className='max-w-32 truncate sm:max-w-48'
            title={statistics.model}
          >
            {statistics.model}
          </span>
        )}
      </div>

      {expanded && (
        <div
          id={detailsId}
          className='mt-1.5 basis-full rounded-xl border border-line bg-surface-subtle p-3 text-xs'
        >
          <dl className='grid max-w-md grid-cols-2 gap-x-4 gap-y-1.5'>
            {details.map(([label, value]) => (
              <div key={label} className='flex gap-1 text-ink-muted'>
                <dt className='font-medium text-ink'>{label}</dt>
                <dd className='tabular-nums'>{value}</dd>
              </div>
            ))}
          </dl>
          {statistics.created_at && (
            <p className='mt-2 border-t border-line pt-2 text-ink-muted'>
              <span className='font-medium text-ink'>
                {t('generationStats.generatedAt')}
              </span>{' '}
              {new Date(statistics.created_at).toLocaleTimeString(
                i18n.language
              )}
            </p>
          )}
        </div>
      )}
    </>
  );
};

export default GenerationStats;
