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
import { isSameDay, timeLabel, weekDays } from '@/utils/calendarDates';
import { EventChip } from './EventChip';

const HOUR_HEIGHT_PX = 48;

interface WeekGridProps {
  anchor: Date;
  events: CalendarEvent[];
  onDayClick: (day: Date, hour: number) => void;
  onEventClick: (event: CalendarEvent) => void;
}

export function WeekGrid({
  anchor,
  events,
  onDayClick,
  onEventClick,
}: WeekGridProps) {
  const { i18n } = useTranslation();
  const days = useMemo(() => weekDays(anchor), [anchor]);
  const today = new Date();
  const hourFormatter = useMemo(
    () => new Intl.DateTimeFormat(i18n.language, { hour: 'numeric' }),
    [i18n.language]
  );
  const dayFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(i18n.language, {
        weekday: 'short',
        day: 'numeric',
      }),
    [i18n.language]
  );

  const allDayByDay = (day: Date) =>
    events.filter(
      event => event.allDay && isSameDay(new Date(event.startAt), day)
    );
  const timedByDay = (day: Date) =>
    events.filter(
      event => !event.allDay && isSameDay(new Date(event.startAt), day)
    );

  return (
    <div
      className='scroll-region min-h-0 flex-1 overflow-y-auto scrollbar-thin'
      data-testid='calendar-week-grid'
    >
      <div className='grid grid-cols-[3.5rem_repeat(7,1fr)]'>
        {/* Day headers + all-day row */}
        <div className='sticky top-0 z-10 border-b border-black/[0.06] bg-surface dark:border-white/[0.07]' />
        {days.map(day => (
          <div
            key={day.toISOString()}
            className='sticky top-0 z-10 border-b border-e border-black/[0.06] bg-surface px-1 py-1.5 dark:border-white/[0.07]'
          >
            <span
              className={cn(
                'block truncate text-center text-[11px] font-medium',
                isSameDay(day, today)
                  ? 'text-primary-600 dark:text-primary-400'
                  : 'text-gray-500 dark:text-dark-500'
              )}
            >
              {dayFormatter.format(day)}
            </span>
            <div className='mt-0.5 space-y-0.5'>
              {allDayByDay(day).map(event => (
                <EventChip
                  key={event.id}
                  event={event}
                  label={event.title}
                  onClick={() => onEventClick(event)}
                />
              ))}
            </div>
          </div>
        ))}

        {/* Hour rows */}
        {Array.from({ length: 24 }, (_, hour) => (
          <React.Fragment key={hour}>
            <div className='relative border-b border-black/[0.04] pe-1.5 text-end text-[10px] text-gray-400 dark:border-white/[0.04] dark:text-dark-500'>
              <span className='relative -top-1.5'>
                {hour > 0
                  ? hourFormatter.format(new Date(2024, 0, 1, hour))
                  : ''}
              </span>
            </div>
            {days.map(day => {
              const slotEvents = timedByDay(day).filter(
                event => new Date(event.startAt).getHours() === hour
              );
              return (
                <div
                  key={`${day.toISOString()}-${hour}`}
                  onClick={() => onDayClick(day, hour)}
                  style={{ height: HOUR_HEIGHT_PX }}
                  className='cursor-pointer space-y-0.5 overflow-hidden border-b border-e border-black/[0.04] p-0.5 transition-colors hover:bg-black/[0.02] dark:border-white/[0.04] dark:hover:bg-white/[0.03]'
                >
                  {slotEvents.map(event => (
                    <EventChip
                      key={event.id}
                      event={event}
                      label={`${timeLabel(event.startAt, i18n.language)} ${event.title}`}
                      onClick={() => onEventClick(event)}
                    />
                  ))}
                </div>
              );
            })}
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}
