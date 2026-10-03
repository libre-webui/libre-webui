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

import React, { useState } from 'react';
import { ChevronDown, ChevronRight, Info } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { GenerationStatistics } from '@/types';

interface GenerationStatsProps {
  statistics: GenerationStatistics;
  className?: string;
}

export const GenerationStats: React.FC<GenerationStatsProps> = ({
  statistics,
  className = '',
}) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const { t, i18n } = useTranslation();
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

  return (
    <div className={`text-xs text-ink-muted mt-2 ${className}`}>
      {/* Summary Stats */}
      <div className='flex items-center gap-4 mb-1'>
        <span className='flex items-center gap-1 text-gray-600 dark:text-dark-600'>
          <Info size={12} className='text-primary-500' />
          {t('generationStats.tokenCount', {
            tokens: generatedTokens.toLocaleString(i18n.language),
          })}
        </span>
        <span className='text-ink-muted'>{tokensPerSecond}</span>
        <span className='text-ink-muted'>{totalDuration}</span>
        {statistics.model && (
          <span
            className='text-ink-muted bg-gray-100 dark:bg-dark-200 px-2 py-0.5 rounded-full truncate max-w-32 sm:max-w-48'
            title={statistics.model}
          >
            {statistics.model}
          </span>
        )}
      </div>

      {/* Expandable Detailed Stats */}
      <button
        type='button'
        onClick={() => setIsExpanded(!isExpanded)}
        aria-expanded={isExpanded}
        className='flex items-center gap-1 text-ink-muted hover:text-ink transition-colors'
      >
        {isExpanded ? (
          <ChevronDown size={12} />
        ) : (
          <ChevronRight size={12} className='rtl:rotate-180' />
        )}
        <span>{t('generationStats.details')}</span>
      </button>

      {isExpanded && (
        <div className='mt-2 p-3 bg-gray-50 dark:bg-dark-100 border border-gray-200 dark:border-dark-300 rounded-lg text-xs space-y-2'>
          <div className='grid grid-cols-2 gap-x-4 gap-y-2'>
            <div className='text-gray-700 dark:text-dark-700'>
              <span className='font-medium text-gray-800 dark:text-dark-800'>
                {t('generationStats.promptTokens')}
              </span>{' '}
              {promptTokens}
            </div>
            <div className='text-gray-700 dark:text-dark-700'>
              <span className='font-medium text-gray-800 dark:text-dark-800'>
                {t('generationStats.generatedTokens')}
              </span>{' '}
              {generatedTokens}
            </div>
            <div className='text-gray-700 dark:text-dark-700'>
              <span className='font-medium text-gray-800 dark:text-dark-800'>
                {t('generationStats.totalTokens')}
              </span>{' '}
              {totalTokens}
            </div>
            <div className='text-gray-700 dark:text-dark-700'>
              <span className='font-medium text-gray-800 dark:text-dark-800'>
                {t('generationStats.speed')}
              </span>{' '}
              {tokensPerSecond}
            </div>
            <div className='text-gray-700 dark:text-dark-700'>
              <span className='font-medium text-gray-800 dark:text-dark-800'>
                {t('generationStats.promptEval')}
              </span>{' '}
              {formatDuration(statistics.prompt_eval_duration)}
            </div>
            <div className='text-gray-700 dark:text-dark-700'>
              <span className='font-medium text-gray-800 dark:text-dark-800'>
                {t('generationStats.generation')}
              </span>{' '}
              {formatDuration(statistics.eval_duration)}
            </div>
            <div className='text-gray-700 dark:text-dark-700'>
              <span className='font-medium text-gray-800 dark:text-dark-800'>
                {t('generationStats.modelLoad')}
              </span>{' '}
              {formatDuration(statistics.load_duration)}
            </div>
            <div className='text-gray-700 dark:text-dark-700'>
              <span className='font-medium text-gray-800 dark:text-dark-800'>
                {t('generationStats.totalTime')}
              </span>{' '}
              {totalDuration}
            </div>
          </div>

          {statistics.created_at && (
            <div className='pt-2 border-t border-gray-200 dark:border-dark-300 text-gray-600 dark:text-dark-600'>
              <span className='font-medium text-gray-800 dark:text-dark-800'>
                {t('generationStats.generatedAt')}
              </span>{' '}
              {new Date(statistics.created_at).toLocaleTimeString(
                i18n.language
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default GenerationStats;
