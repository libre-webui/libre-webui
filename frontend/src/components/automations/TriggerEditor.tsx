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
import { Clock, Trash2 } from 'lucide-react';
import type { AutomationTrigger } from '@/types';
import {
  fromInputValues,
  toDateInputValue,
  toTimeInputValue,
  weekdayLabels,
} from '@/utils/calendarDates';

const KINDS = [
  'once',
  'hourly',
  'daily',
  'weekly',
  'monthly',
  'yearly',
] as const;

const fieldClass =
  'rounded-lg border border-black/[0.08] bg-white px-2 py-1 text-[13px] text-gray-900 focus:border-primary-500/40 focus:outline-none dark:border-white/[0.08] dark:bg-dark-100 dark:text-dark-900';

const timeValueOf = (hour: number, minute: number): string =>
  `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;

const defaultFor = (kind: AutomationTrigger['kind']): AutomationTrigger => {
  switch (kind) {
    case 'once': {
      const at = new Date();
      at.setHours(at.getHours() + 1, 0, 0, 0);
      return { kind: 'once', at: at.getTime() };
    }
    case 'hourly':
      return { kind: 'hourly', minute: 0 };
    case 'daily':
      return { kind: 'daily', hour: 8, minute: 0 };
    case 'weekly':
      return { kind: 'weekly', dayOfWeek: 1, hour: 9, minute: 0 };
    case 'monthly':
      return { kind: 'monthly', dayOfMonth: 1, hour: 9, minute: 0 };
    case 'yearly':
      return { kind: 'yearly', month: 1, dayOfMonth: 1, hour: 9, minute: 0 };
  }
};

interface TriggerEditorProps {
  trigger: AutomationTrigger;
  onChange: (trigger: AutomationTrigger) => void;
  onRemove?: () => void;
}

/** One trigger row: a kind select plus the fields that kind needs. */
export function TriggerEditor({
  trigger,
  onChange,
  onRemove,
}: TriggerEditorProps) {
  const { t, i18n } = useTranslation();
  const weekdays = weekdayLabels(i18n.language, 'short');
  const monthFormatter = new Intl.DateTimeFormat(i18n.language, {
    month: 'long',
  });

  const setTime = (value: string) => {
    const [hour, minute] = (value || '00:00').split(':').map(Number);
    if (trigger.kind === 'hourly' || trigger.kind === 'once') return;
    onChange({ ...trigger, hour, minute });
  };

  const timeInput =
    trigger.kind !== 'once' && trigger.kind !== 'hourly' ? (
      <input
        type='time'
        aria-label={t('automations.form.time')}
        value={timeValueOf(trigger.hour, trigger.minute)}
        onChange={e => setTime(e.target.value)}
        className={fieldClass}
      />
    ) : null;

  return (
    <div
      className='flex flex-wrap items-center gap-2 rounded-xl border border-black/[0.06] bg-black/[0.02] px-2.5 py-2 dark:border-white/[0.06] dark:bg-white/[0.03]'
      data-testid='automation-trigger'
    >
      <Clock className='h-3.5 w-3.5 shrink-0 text-gray-400 dark:text-dark-500' />
      <select
        aria-label={t('automations.form.frequency')}
        value={trigger.kind}
        onChange={e =>
          onChange(defaultFor(e.target.value as AutomationTrigger['kind']))
        }
        className={fieldClass}
        data-testid='automation-trigger-kind'
      >
        {KINDS.map(kind => (
          <option key={kind} value={kind}>
            {t(`automations.kind.${kind}`)}
          </option>
        ))}
      </select>

      {trigger.kind === 'once' && (
        <>
          <input
            type='date'
            aria-label={t('calendar.date')}
            value={toDateInputValue(trigger.at)}
            onChange={e =>
              onChange({
                ...trigger,
                at: fromInputValues(
                  e.target.value,
                  toTimeInputValue(trigger.at)
                ),
              })
            }
            className={fieldClass}
          />
          <input
            type='time'
            aria-label={t('automations.form.time')}
            value={toTimeInputValue(trigger.at)}
            onChange={e =>
              onChange({
                ...trigger,
                at: fromInputValues(
                  toDateInputValue(trigger.at),
                  e.target.value
                ),
              })
            }
            className={fieldClass}
          />
        </>
      )}

      {trigger.kind === 'hourly' && (
        <>
          <label className='flex items-center gap-1 text-[12px] text-gray-500 dark:text-dark-500'>
            {t('automations.form.minute')}
            <input
              type='number'
              min={0}
              max={59}
              value={trigger.minute}
              onChange={e =>
                onChange({
                  ...trigger,
                  minute: Math.min(59, Math.max(0, Number(e.target.value))),
                })
              }
              className={`${fieldClass} w-16`}
            />
          </label>
          <label className='flex items-center gap-1 text-[12px] text-gray-500 dark:text-dark-500'>
            {t('automations.form.fromHour')}
            <input
              type='number'
              min={0}
              max={23}
              value={trigger.startHour ?? 0}
              onChange={e =>
                onChange({
                  ...trigger,
                  startHour: Math.min(23, Math.max(0, Number(e.target.value))),
                })
              }
              className={`${fieldClass} w-16`}
            />
          </label>
          <label className='flex items-center gap-1 text-[12px] text-gray-500 dark:text-dark-500'>
            {t('automations.form.toHour')}
            <input
              type='number'
              min={0}
              max={23}
              value={trigger.endHour ?? 23}
              onChange={e =>
                onChange({
                  ...trigger,
                  endHour: Math.min(23, Math.max(0, Number(e.target.value))),
                })
              }
              className={`${fieldClass} w-16`}
            />
          </label>
        </>
      )}

      {trigger.kind === 'weekly' && (
        <select
          aria-label={t('automations.form.weekday')}
          value={trigger.dayOfWeek}
          onChange={e =>
            onChange({ ...trigger, dayOfWeek: Number(e.target.value) })
          }
          className={fieldClass}
        >
          {weekdays.map((label, index) => (
            <option key={label} value={index}>
              {label}
            </option>
          ))}
        </select>
      )}

      {(trigger.kind === 'monthly' || trigger.kind === 'yearly') && (
        <label className='flex items-center gap-1 text-[12px] text-gray-500 dark:text-dark-500'>
          {t('automations.form.dayOfMonth')}
          <input
            type='number'
            min={1}
            max={31}
            value={trigger.dayOfMonth}
            onChange={e =>
              onChange({
                ...trigger,
                dayOfMonth: Math.min(31, Math.max(1, Number(e.target.value))),
              })
            }
            className={`${fieldClass} w-16`}
          />
        </label>
      )}

      {trigger.kind === 'yearly' && (
        <select
          aria-label={t('automations.form.month')}
          value={trigger.month}
          onChange={e =>
            onChange({ ...trigger, month: Number(e.target.value) })
          }
          className={fieldClass}
        >
          {Array.from({ length: 12 }, (_, index) => (
            <option key={index + 1} value={index + 1}>
              {monthFormatter.format(new Date(2024, index, 1))}
            </option>
          ))}
        </select>
      )}

      {timeInput}

      {onRemove && (
        <button
          type='button'
          onClick={onRemove}
          aria-label={t('common.delete')}
          className='ms-auto rounded-md p-1 text-red-500 transition-colors hover:bg-red-50 dark:hover:bg-red-900/20'
        >
          <Trash2 className='h-3.5 w-3.5' />
        </button>
      )}
    </div>
  );
}
