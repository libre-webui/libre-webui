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

  // Helper function to format duration from nanoseconds
  const formatDuration = (nanoseconds?: number): string => {
    if (nanoseconds == null) return 'N/A';

    const milliseconds = nanoseconds / 1e6;
    if (milliseconds < 1000) {
      return `${Math.round(milliseconds)}ms`;
    }

    const seconds = milliseconds / 1000;
    return `${seconds.toFixed(2)}s`;
  };

  // Helper function to format tokens per second
  const formatTokensPerSecond = (tokensPerSecond?: number): string => {
    if (!tokensPerSecond) return 'N/A';
    return `${tokensPerSecond.toFixed(1)} t/s`;
  };

  // Calculate some derived metrics
  const promptTokens = statistics.prompt_eval_count || 0;
  const generatedTokens = statistics.eval_count || 0;
  const totalTokens = promptTokens + generatedTokens;
  const totalDuration = formatDuration(statistics.total_duration);
  const tokensPerSecond = formatTokensPerSecond(statistics.tokens_per_second);

  return (
    <div
      className={`text-xs text-gray-500 dark:text-dark-500 mt-2 ${className}`}
    >
      {/* Summary Stats */}
      <div className='flex items-center gap-4 mb-1'>
        <span className='flex items-center gap-1 text-gray-600 dark:text-dark-600'>
          <Info size={12} className='text-primary-500' />
          {generatedTokens} tokens
        </span>
        <span className='text-gray-500 dark:text-dark-500'>
          {tokensPerSecond}
        </span>
        <span className='text-gray-500 dark:text-dark-500'>
          {totalDuration}
        </span>
        {statistics.model && (
          <span className='text-gray-400 dark:text-dark-400 bg-gray-100 dark:bg-dark-200 px-2 py-0.5 rounded-full'>
            {statistics.model}
          </span>
        )}
      </div>

      {/* Expandable Detailed Stats */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className='flex items-center gap-1 text-gray-400 dark:text-dark-400 hover:text-gray-600 dark:hover:text-dark-600 transition-colors'
      >
        {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span>Details</span>
      </button>

      {isExpanded && (
        <div className='mt-2 p-3 bg-gray-50 dark:bg-dark-100 border border-gray-200 dark:border-dark-300 rounded-lg text-xs space-y-2'>
          <div className='grid grid-cols-2 gap-x-4 gap-y-2'>
            <div className='text-gray-700 dark:text-dark-700'>
              <span className='font-medium text-gray-800 dark:text-dark-800'>
                Prompt tokens:
              </span>{' '}
              {promptTokens}
            </div>
            <div className='text-gray-700 dark:text-dark-700'>
              <span className='font-medium text-gray-800 dark:text-dark-800'>
                Generated tokens:
              </span>{' '}
              {generatedTokens}
            </div>
            <div className='text-gray-700 dark:text-dark-700'>
              <span className='font-medium text-gray-800 dark:text-dark-800'>
                Total tokens:
              </span>{' '}
              {totalTokens}
            </div>
            <div className='text-gray-700 dark:text-dark-700'>
              <span className='font-medium text-gray-800 dark:text-dark-800'>
                Speed:
              </span>{' '}
              {tokensPerSecond}
            </div>
            <div className='text-gray-700 dark:text-dark-700'>
              <span className='font-medium text-gray-800 dark:text-dark-800'>
                Prompt eval:
              </span>{' '}
              {formatDuration(statistics.prompt_eval_duration)}
            </div>
            <div className='text-gray-700 dark:text-dark-700'>
              <span className='font-medium text-gray-800 dark:text-dark-800'>
                Generation:
              </span>{' '}
              {formatDuration(statistics.eval_duration)}
            </div>
            <div className='text-gray-700 dark:text-dark-700'>
              <span className='font-medium text-gray-800 dark:text-dark-800'>
                Model load:
              </span>{' '}
              {formatDuration(statistics.load_duration)}
            </div>
            <div className='text-gray-700 dark:text-dark-700'>
              <span className='font-medium text-gray-800 dark:text-dark-800'>
                Total time:
              </span>{' '}
              {totalDuration}
            </div>
          </div>

          {statistics.created_at && (
            <div className='pt-2 border-t border-gray-200 dark:border-dark-300 text-gray-600 dark:text-dark-600'>
              <span className='font-medium text-gray-800 dark:text-dark-800'>
                Generated at:
              </span>{' '}
              {new Date(statistics.created_at).toLocaleTimeString()}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default GenerationStats;
