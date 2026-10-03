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

import React, { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { CalendarDisplayEvent } from './EventChip';
import { cn } from '@/utils';
import { isSameDay, timeLabel, weekDays } from '@/utils/calendarDates';
import { EventChip } from './EventChip';

const HOUR_HEIGHT_PX = 48;

interface WeekGridProps {
  anchor: Date;
  events: CalendarDisplayEvent[];
  /** 7 renders the anchor's week; 1 renders only the anchor's day. */
  dayCount?: 1 | 7;
  onDayClick: (day: Date, hour: number) => void;
  onEventClick: (event: CalendarDisplayEvent) => void;
}

export function WeekGrid({
  anchor,
  events,
  dayCount = 7,
  onDayClick,
  onEventClick,
}: WeekGridProps) {
  const { t, i18n } = useTranslation();
  const days = useMemo(
    () =>
      dayCount === 1
        ? [new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate())]
        : weekDays(anchor),
    [anchor, dayCount]
  );
  const today = new Date();
  const hourFormatter = useMemo(
    () => new Intl.DateTimeFormat(i18n.language, { hour: 'numeric' }),
    [i18n.language]
  );
  const slotFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(i18n.language, {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
        hour: 'numeric',
      }),
    [i18n.language]
  );
  const gridRef = useRef<HTMLDivElement>(null);
  // One tab stop for the whole hour grid; arrow keys move between slots.
  const [activeSlot, setActiveSlot] = useState('0-9');
  const moveSlot = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    dayIndex: number,
    hour: number
  ) => {
    const rtl = i18n.dir() === 'rtl';
    const horizontal = rtl ? -1 : 1;
    const delta: Record<string, [number, number]> = {
      ArrowRight: [horizontal, 0],
      ArrowLeft: [-horizontal, 0],
      ArrowDown: [0, 1],
      ArrowUp: [0, -1],
    };
    const step = delta[event.key];
    if (!step) return;
    const nextDay = Math.min(days.length - 1, Math.max(0, dayIndex + step[0]));
    const nextHour = Math.min(23, Math.max(0, hour + step[1]));
    event.preventDefault();
    const key = `${nextDay}-${nextHour}`;
    setActiveSlot(key);
    gridRef.current
      ?.querySelector<HTMLElement>(`[data-slot="${key}"]`)
      ?.focus();
  };
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
      <div ref={gridRef} className='grid grid-cols-[3.5rem_repeat(7,1fr)]'>
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
            {days.map((day, dayIndex) => {
              const slotKey = `${dayIndex}-${hour}`;
              const slotEvents = timedByDay(day).filter(
                event => new Date(event.startAt).getHours() === hour
              );
              return (
                <div
                  key={`${day.toISOString()}-${hour}`}
                  onClick={() => onDayClick(day, hour)}
                  style={{ height: HOUR_HEIGHT_PX }}
                  className='relative cursor-pointer space-y-0.5 overflow-hidden border-b border-e border-black/[0.04] p-0.5 transition-colors hover:bg-black/[0.02] dark:border-white/[0.04] dark:hover:bg-white/[0.03]'
                >
                  {/* The click bubbles to the slot handler above. */}
                  <button
                    type='button'
                    data-slot={slotKey}
                    tabIndex={activeSlot === slotKey ? 0 : -1}
                    aria-label={t('calendar.newEventOn', {
                      date: slotFormatter.format(
                        new Date(
                          day.getFullYear(),
                          day.getMonth(),
                          day.getDate(),
                          hour
                        )
                      ),
                    })}
                    onFocus={() => setActiveSlot(slotKey)}
                    onKeyDown={event => moveSlot(event, dayIndex, hour)}
                    className='absolute inset-0 focus-visible:outline-offset-[-2px]'
                  />
                  {slotEvents.map(event => (
                    <div key={event.id} className='relative'>
                      <EventChip
                        event={event}
                        label={`${timeLabel(event.startAt, i18n.language)} ${event.title}`}
                        onClick={() => onEventClick(event)}
                      />
                    </div>
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
