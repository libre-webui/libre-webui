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
import type { CalendarDisplayEvent } from './EventChip';
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
  events: CalendarDisplayEvent[];
  onDayClick: (day: Date) => void;
  onEventClick: (event: CalendarDisplayEvent) => void;
  /** Opens a single-day view so hidden events can be read in full. */
  onShowDay?: (day: Date) => void;
}

export function MonthGrid({
  year,
  monthIndex,
  events,
  onDayClick,
  onEventClick,
  onShowDay,
}: MonthGridProps) {
  const { t, i18n } = useTranslation();
  const days = useMemo(
    () => gridDaysForMonth(year, monthIndex),
    [year, monthIndex]
  );
  const today = new Date();

  const eventsByDay = useMemo(() => {
    const map = new Map<string, CalendarDisplayEvent[]>();
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
  const dateFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(i18n.language, {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
        year: 'numeric',
      }),
    [i18n.language]
  );

  return (
    <div
      className='flex min-h-0 flex-1 flex-col'
      data-testid='calendar-month-grid'
    >
      <div className='grid grid-cols-7 border-b border-black/6 dark:border-white/[0.07]'>
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
                'flex min-h-0 cursor-pointer flex-col gap-0.5 border-b border-e border-black/4 p-1 transition-colors hover:bg-black/2 dark:border-white/4 dark:hover:bg-white/3',
                !inMonth && 'opacity-40'
              )}
            >
              {/* A real button makes the cell keyboard reachable; its click
                  bubbles to the cell handler, so there is one code path. */}
              <button
                type='button'
                aria-label={t('calendar.newEventOn', {
                  date: dateFormatter.format(day),
                })}
                aria-current={isToday ? 'date' : undefined}
                className={cn(
                  'flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[12px]',
                  isToday
                    ? 'bg-ink font-semibold text-ink-inverse'
                    : 'text-ink-muted'
                )}
              >
                {day.getDate()}
              </button>
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
                  <button
                    type='button'
                    onClick={event => {
                      event.stopPropagation();
                      onShowDay?.(day);
                    }}
                    title={t('calendar.showDay', {
                      date: dateFormatter.format(day),
                    })}
                    className='rounded-sm px-1 text-start text-[10px] text-ink-muted hover:text-ink'
                  >
                    {t('calendar.more', { n: overflow })}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
