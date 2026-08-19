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

import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { CalendarEvent } from '@/types';
import { cn } from '@/utils';
import {
  gridDaysForMonth,
  isSameDay,
  timeLabel,
  weekdayLabels,
} from '@/utils/calendarDates';
import { EventChip } from './EventChip';

const MAX_CHIPS_PER_DAY = 3;

interface MonthGridProps {
  year: number;
  monthIndex: number;
  events: CalendarEvent[];
  onDayClick: (day: Date) => void;
  onEventClick: (event: CalendarEvent) => void;
}

export function MonthGrid({
  year,
  monthIndex,
  events,
  onDayClick,
  onEventClick,
}: MonthGridProps) {
  const { t, i18n } = useTranslation();
  const days = useMemo(
    () => gridDaysForMonth(year, monthIndex),
    [year, monthIndex]
  );
  const today = new Date();

  const eventsByDay = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>();
    for (const event of events) {
      const date = new Date(event.startAt);
      const key = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
      const bucket = map.get(key);
      if (bucket) bucket.push(event);
      else map.set(key, [event]);
    }
    return map;
  }, [events]);

  const labels = useMemo(() => weekdayLabels(i18n.language), [i18n.language]);

  return (
    <div
      className='flex min-h-0 flex-1 flex-col'
      data-testid='calendar-month-grid'
    >
      <div className='grid grid-cols-7 border-b border-black/[0.06] dark:border-white/[0.07]'>
        {labels.map(label => (
          <div
            key={label}
            className='px-2 py-1.5 text-center text-[11px] font-medium uppercase tracking-wide text-gray-400 dark:text-dark-500'
          >
            {label}
          </div>
        ))}
      </div>
      <div className='grid min-h-0 flex-1 grid-cols-7 grid-rows-6'>
        {days.map(day => {
          const inMonth = day.getMonth() === monthIndex;
          const isToday = isSameDay(day, today);
          const key = `${day.getFullYear()}-${day.getMonth()}-${day.getDate()}`;
          const dayEvents = eventsByDay.get(key) ?? [];
          const overflow = dayEvents.length - MAX_CHIPS_PER_DAY;
          return (
            <div
              key={key}
              role='gridcell'
              data-testid='calendar-day-cell'
              onClick={() => onDayClick(day)}
              className={cn(
                'flex min-h-0 cursor-pointer flex-col gap-0.5 border-b border-e border-black/[0.04] p-1 transition-colors hover:bg-black/[0.02] dark:border-white/[0.04] dark:hover:bg-white/[0.03]',
                !inMonth && 'opacity-40'
              )}
            >
              <span
                className={cn(
                  'flex h-6 w-6 items-center justify-center rounded-full text-[12px]',
                  isToday
                    ? 'bg-primary-500 font-semibold text-white'
                    : 'text-gray-600 dark:text-dark-600'
                )}
              >
                {day.getDate()}
              </span>
              <div className='flex min-h-0 flex-col gap-0.5 overflow-hidden'>
                {dayEvents.slice(0, MAX_CHIPS_PER_DAY).map(event => (
                  <EventChip
                    key={event.id}
                    event={event}
                    label={
                      event.allDay
                        ? event.title
                        : `${timeLabel(event.startAt, i18n.language)} ${event.title}`
                    }
                    onClick={() => onEventClick(event)}
                  />
                ))}
                {overflow > 0 && (
                  <span className='px-1 text-[10px] text-gray-400 dark:text-dark-500'>
                    {t('calendar.more', { n: overflow })}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
