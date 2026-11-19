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
import type { DecisionReplyMetadata } from '@/types';
import { cn } from '@/utils';
import { formatDecisionPercent, viewDecisionAnswer } from './decisionQuestions';

const Bar: React.FC<{ value: number; strong?: boolean }> = ({
  value,
  strong,
}) => (
  <div
    aria-hidden='true'
    className='h-1.5 w-full overflow-hidden rounded-full bg-gray-100 dark:bg-dark-200'
  >
    <div
      className={cn(
        'h-full rounded-full',
        strong
          ? 'bg-primary-500 dark:bg-primary-400'
          : 'bg-gray-300 dark:bg-dark-400'
      )}
      style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%` }}
    />
  </div>
);

/**
 * A decision model's answers: each question with the answer it leans to,
 * that answer's probability, and the full distribution underneath.
 */
export const DecisionResultCard: React.FC<{
  metadata: DecisionReplyMetadata;
}> = ({ metadata }) => {
  const { t } = useTranslation();

  if (metadata.kind !== 'answers') {
    return (
      <p data-testid='decision-result-note' className='text-sm text-ink-muted'>
        {metadata.kind === 'state'
          ? t('chat.decision.result.stateSaved')
          : t('chat.decision.result.cleared')}
      </p>
    );
  }

  const inputTokens = metadata.usage?.inputTokens;
  return (
    <div data-testid='decision-result' className='space-y-3'>
      {Object.entries(metadata.questions).map(([name, question]) => {
        const view = viewDecisionAnswer(question, metadata.answers[name]);
        const answerLabel =
          view.kind === 'refusal'
            ? t('chat.decision.result.declined')
            : view.kind === 'yes'
              ? t('chat.decision.result.yes')
              : view.kind === 'no'
                ? t('chat.decision.result.no')
                : view.label;
        return (
          <section
            key={name}
            className='rounded-xl border border-line px-3 py-2.5'
          >
            <div className='flex items-baseline justify-between gap-3'>
              <p dir='auto' className='min-w-0 text-sm text-ink'>
                {question.instructions}
              </p>
              <span className='shrink-0 text-[11px] text-ink-muted'>
                {t(`chat.decision.types.${question.type}`)}
              </span>
            </div>
            <div className='mt-1.5 flex items-baseline gap-2'>
              <span
                dir='auto'
                data-testid='decision-answer'
                className='text-base font-semibold text-ink'
              >
                {answerLabel}
              </span>
              {view.probability !== undefined && (
                <span className='text-sm tabular-nums text-primary-700 dark:text-primary-300'>
                  {formatDecisionPercent(view.probability)}
                </span>
              )}
              {view.score && (
                <span className='text-xs tabular-nums text-ink-muted'>
                  {t('chat.decision.result.score', {
                    value: view.score.value.toFixed(2),
                    max: view.score.max,
                  })}
                </span>
              )}
            </div>
            {view.kind !== 'refusal' &&
              view.kind !== 'yes' &&
              view.kind !== 'no' &&
              view.distribution.length > 1 && (
                <ul className='mt-2 space-y-1'>
                  {view.distribution.map(entry => (
                    <li
                      key={entry.label}
                      className='grid grid-cols-[minmax(0,10rem)_1fr_3.5rem] items-center gap-2 text-xs'
                    >
                      <span dir='auto' className='truncate text-ink-muted'>
                        {entry.label}
                      </span>
                      <Bar
                        value={entry.probability}
                        strong={entry.label === view.label}
                      />
                      <span className='text-end tabular-nums text-ink-muted'>
                        {formatDecisionPercent(entry.probability)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            {(view.kind === 'yes' || view.kind === 'no') &&
              view.probability !== undefined && (
                <div className='mt-2'>
                  <Bar value={view.probability} strong />
                </div>
              )}
          </section>
        );
      })}
      <p className='text-[11px] text-ink-subtle'>
        {t('chat.decision.result.via', {
          model: metadata.model,
          provider: metadata.provider,
        })}
        {inputTokens !== undefined &&
          ` · ${t('chat.decision.result.inputTokens', { tokens: inputTokens })}`}
      </p>
    </div>
  );
};

export default DecisionResultCard;
