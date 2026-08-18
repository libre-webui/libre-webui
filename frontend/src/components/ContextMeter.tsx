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
import { useTranslation } from 'react-i18next';
import { cn } from '@/utils';
import { formatTokenCount, type ContextUsage } from '@/utils/contextUsage';

interface ContextMeterProps {
  usage: ContextUsage;
  /**
   * The window the model was trained for, when the one it runs with is
   * smaller. A capped window is the honest number to measure against, but on
   * its own it reads as the wrong one.
   */
  trainedBudget?: number;
}

/** Ring geometry, in the same units as the SVG viewBox. */
const RADIUS = 7;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/**
 * How full the model's context is, as a ring beside the model name.
 *
 * A conversation runs out of room quietly: replies slow down, and then the
 * oldest turns are summarized away. The ring puts that in front of the person
 * writing instead of leaving it in a log, and the numbers behind it are one
 * hover away rather than a click into settings.
 */
/** Isolate a numeric run so RTL text cannot visually reorder it. */
const bidiIsolate = (text: string): string => `⁨${text}⁩`;

export const ContextMeter: React.FC<ContextMeterProps> = ({
  usage,
  trainedBudget,
}) => {
  const { t, i18n } = useTranslation();
  // The panel is mounted only while it is being read. Kept in the document and
  // merely faded out, it stays a tooltip to anything reading the page, which is
  // both wrong for a screen reader and indistinguishable from a real one.
  const [visible, setVisible] = useState(false);
  const hasBudget = typeof usage.budget === 'number' && usage.budget > 0;
  const ratio = usage.ratio ?? 0;
  const percent = Math.round(ratio * 100);
  const approx = usage.measured ? '' : '~';
  const locale = i18n.language;
  const used = `${approx}${formatTokenCount(usage.used, locale)}`;

  const tokenLine = hasBudget
    ? t('chat.context.tokensUsed', {
        used: bidiIsolate(used),
        budget: bidiIsolate(formatTokenCount(usage.budget as number, locale)),
      })
    : t('chat.context.tokensUsedNoBudget', { used: bidiIsolate(used) });
  const cappedLine =
    trainedBudget !== undefined
      ? t('chat.context.capped', {
          trained: bidiIsolate(formatTokenCount(trainedBudget, locale)),
        })
      : undefined;
  const label = [
    t('chat.context.title'),
    hasBudget ? t('chat.context.full', { percent }) : undefined,
    tokenLine,
    cappedLine,
  ]
    .filter(Boolean)
    .join(' ');

  // The arc caps at full; the color and the percentage keep going, so an
  // over-budget conversation reads as one instead of as exactly full.
  const arcRatio = Math.min(ratio, 1);

  return (
    <div
      className='relative flex-shrink-0'
      onMouseEnter={() => setVisible(true)}
      onMouseLeave={() => setVisible(false)}
      onFocus={() => setVisible(true)}
      onBlur={() => setVisible(false)}
      onKeyDown={event => {
        if (event.key === 'Escape') setVisible(false);
      }}
    >
      <span
        role={hasBudget ? 'meter' : 'img'}
        tabIndex={0}
        aria-label={label}
        {...(hasBudget
          ? {
              'aria-valuemin': 0,
              'aria-valuemax': 100,
              'aria-valuenow': Math.min(percent, 100),
              'aria-valuetext': label,
            }
          : {})}
        className={cn(
          'flex h-9 w-9 items-center justify-center rounded-full text-gray-400 outline-none sm:h-10 sm:w-10',
          'transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-primary-500/40',
          'dark:text-dark-500',
          // Past four fifths the summarizer is close enough to warn about;
          // at the window the conversation is losing history.
          ratio >= 0.8 && ratio < 1 && 'text-amber-600 dark:text-amber-400',
          ratio >= 1 && 'text-red-600 dark:text-red-400'
        )}
      >
        <svg viewBox='0 0 18 18' className='h-4 w-4 -rotate-90'>
          <circle
            cx='9'
            cy='9'
            r={RADIUS}
            fill='none'
            stroke='currentColor'
            strokeWidth='2'
            className='opacity-30'
            // An unknown window is not an empty one: the track goes dashed
            // instead of rendering the same ring as a fresh conversation.
            {...(hasBudget ? {} : { strokeDasharray: '2 2' })}
          />
          {hasBudget && arcRatio > 0 && (
            <circle
              cx='9'
              cy='9'
              r={RADIUS}
              fill='none'
              stroke='currentColor'
              strokeWidth='2'
              strokeLinecap='round'
              strokeDasharray={CIRCUMFERENCE}
              strokeDashoffset={CIRCUMFERENCE * (1 - arcRatio)}
            />
          )}
        </svg>
      </span>

      {visible && (
        <div
          role='tooltip'
          className={cn(
            'pointer-events-none absolute bottom-full left-1/2 z-30 mb-2 -translate-x-1/2',
            'whitespace-nowrap rounded-2xl bg-surface/95 px-4 py-3 text-center shadow-lv3 backdrop-blur-xl',
            'border border-black/[0.06] dark:border-white/[0.08] dark:bg-dark-100/95',
            'animate-scale-in'
          )}
        >
          <p className='text-[13px] text-gray-500 dark:text-dark-600'>
            {t('chat.context.title')}
          </p>
          {hasBudget && (
            <p className='text-[13px] text-gray-500 dark:text-dark-600'>
              {t('chat.context.full', { percent })}
            </p>
          )}
          <p className='text-[13px] tabular-nums text-gray-900 dark:text-dark-900'>
            {tokenLine}
          </p>
          {cappedLine && (
            <p className='mt-1 text-[11px] text-gray-400 dark:text-dark-500'>
              {cappedLine}
            </p>
          )}
        </div>
      )}
    </div>
  );
};
