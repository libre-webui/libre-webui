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

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui';
import { MonthGrid } from '@/components/calendar/MonthGrid';
import { WeekGrid } from '@/components/calendar/WeekGrid';
import { EventModal, EventModalResult } from '@/components/calendar/EventModal';
import type { CalendarDisplayEvent } from '@/components/calendar/EventChip';
import { automationsApi, calendarApi } from '@/utils/api';
import { cn } from '@/utils';
import { createLogger } from '@/utils/logger';
import { addDays, monthLabel, startOfWeek } from '@/utils/calendarDates';
import type { CalendarEvent } from '@/types';

const logger = createLogger('pages:calendar');

type CalendarView = 'month' | 'week';

const CalendarPage: React.FC = () => {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const [view, setView] = useState<CalendarView>('month');
  const [anchor, setAnchor] = useState(() => new Date());
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [automationItems, setAutomationItems] = useState<
    CalendarDisplayEvent[]
  >([]);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingEvent, setEditingEvent] = useState<CalendarEvent | null>(null);
  const [modalStartAt, setModalStartAt] = useState(() => Date.now());
  const [saving, setSaving] = useState(false);

  const range = useMemo(() => {
    if (view === 'month') {
      const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
      const gridStart = startOfWeek(first);
      return {
        from: gridStart.getTime(),
        to: addDays(gridStart, 42).getTime(),
      };
    }
    const weekStart = startOfWeek(anchor);
    return { from: weekStart.getTime(), to: addDays(weekStart, 7).getTime() };
  }, [anchor, view]);

  const [refreshCounter, setRefreshCounter] = useState(0);
  const refreshEvents = useCallback(
    () => setRefreshCounter(counter => counter + 1),
    []
  );

  useEffect(() => {
    let cancelled = false;
    calendarApi
      .getEvents(range.from, range.to)
      .then(response => {
        if (cancelled) return;
        if (response.success && response.data) {
          setEvents(response.data);
        }
      })
      .catch(error => {
        if (cancelled) return;
        logger.error('Failed to load calendar events:', error);
        toast.error(t('calendar.loadFailed'));
      });
    // Automations project onto the calendar: upcoming occurrences plus the
    // outcome of finished runs. Their absence never blocks the event grid.
    Promise.all([
      automationsApi.getOccurrences(range.from, range.to),
      automationsApi.getRuns({ from: range.from, to: range.to }),
      automationsApi.getAutomations(),
    ])
      .then(([occurrences, runs, automations]) => {
        if (cancelled) return;
        const now = Date.now();
        const nameOf = (automationId: string) =>
          automations.data?.find(item => item.id === automationId)?.name ??
          t('automations.deletedAutomation');
        const items: CalendarDisplayEvent[] = [];
        for (const occurrence of occurrences.data ?? []) {
          if (occurrence.at <= now) continue;
          items.push({
            id: `automation:${occurrence.automationId}:${occurrence.at}`,
            title: occurrence.name,
            startAt: occurrence.at,
            allDay: false,
            createdAt: occurrence.at,
            updatedAt: occurrence.at,
            variant: 'automation',
          });
        }
        for (const run of runs.data ?? []) {
          if (run.status !== 'succeeded' && run.status !== 'failed') continue;
          items.push({
            id: `run:${run.id}`,
            title: nameOf(run.automationId),
            startAt: run.scheduledFor,
            allDay: false,
            createdAt: run.createdAt,
            updatedAt: run.createdAt,
            variant: run.status === 'succeeded' ? 'runSucceeded' : 'runFailed',
            ...(run.sessionId ? { sessionId: run.sessionId } : {}),
          });
        }
        setAutomationItems(items);
      })
      .catch(error => {
        if (cancelled) return;
        logger.error('Failed to project automations onto the calendar:', error);
      });
    return () => {
      cancelled = true;
    };
  }, [range.from, range.to, refreshCounter, t]);

  const displayEvents = useMemo<CalendarDisplayEvent[]>(
    () =>
      [...events, ...automationItems].sort(
        (left, right) => left.startAt - right.startAt
      ),
    [events, automationItems]
  );

  const step = (direction: 1 | -1) => {
    setAnchor(current =>
      view === 'month'
        ? new Date(current.getFullYear(), current.getMonth() + direction, 1)
        : addDays(current, direction * 7)
    );
  };

  const openCreate = (day: Date, hour = 9) => {
    setEditingEvent(null);
    setModalStartAt(
      new Date(
        day.getFullYear(),
        day.getMonth(),
        day.getDate(),
        hour,
        0
      ).getTime()
    );
    setModalOpen(true);
  };

  const openEdit = (event: CalendarDisplayEvent) => {
    // Automation projections navigate instead of opening the editor: a
    // finished run opens its chat, an upcoming occurrence its automation.
    if (event.variant === 'runSucceeded' || event.variant === 'runFailed') {
      if (event.sessionId) navigate(`/c/${event.sessionId}`);
      else navigate('/automations');
      return;
    }
    if (event.variant === 'automation') {
      navigate('/automations');
      return;
    }
    // Occurrences edit their source event.
    if (event.baseEventId) {
      const source = events.find(item => item.id === event.baseEventId);
      setEditingEvent(source ?? event);
    } else {
      setEditingEvent(event);
    }
    setModalOpen(true);
  };

  const handleSave = async (result: EventModalResult) => {
    setSaving(true);
    try {
      const response = editingEvent
        ? await calendarApi.updateEvent(editingEvent.id, result)
        : await calendarApi.createEvent(result);
      if (response.success) {
        setModalOpen(false);
        refreshEvents();
      } else {
        toast.error(response.error || t('calendar.saveFailed'));
      }
    } catch (error) {
      logger.error('Failed to save calendar event:', error);
      toast.error(t('calendar.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!editingEvent) return;
    setSaving(true);
    try {
      const response = await calendarApi.deleteEvent(editingEvent.id);
      if (response.success) {
        setModalOpen(false);
        refreshEvents();
      } else {
        toast.error(response.error || t('calendar.deleteFailed'));
      }
    } catch (error) {
      logger.error('Failed to delete calendar event:', error);
      toast.error(t('calendar.deleteFailed'));
    } finally {
      setSaving(false);
    }
  };

  const title =
    view === 'month'
      ? monthLabel(anchor.getFullYear(), anchor.getMonth(), i18n.language)
      : new Intl.DateTimeFormat(i18n.language, {
          month: 'long',
          day: 'numeric',
          year: 'numeric',
        }).format(startOfWeek(anchor));

  return (
    <div
      className='flex h-full min-h-0 flex-col overflow-hidden'
      data-testid='calendar-page'
    >
      <div className='flex flex-wrap items-center justify-between gap-2 border-b border-black/[0.06] px-4 py-3 dark:border-white/[0.07]'>
        <div className='flex items-center gap-2'>
          <h1 className='text-sm font-semibold text-gray-900 dark:text-dark-900'>
            {t('calendar.title')}
          </h1>
          <span
            className='text-sm text-gray-500 dark:text-dark-500'
            data-testid='calendar-range-label'
          >
            {title}
          </span>
        </div>
        <div className='flex items-center gap-2'>
          <div className='flex items-center rounded-xl bg-black/[0.04] p-0.5 dark:bg-white/[0.06]'>
            {(['month', 'week'] as const).map(choice => (
              <button
                key={choice}
                onClick={() => setView(choice)}
                data-testid={`calendar-view-${choice}`}
                className={cn(
                  'rounded-[10px] px-2.5 py-1 text-[12px] font-medium transition-colors',
                  view === choice
                    ? 'bg-white text-gray-900 shadow-sm dark:bg-dark-200 dark:text-dark-900'
                    : 'text-gray-500 hover:text-gray-800 dark:text-dark-500 dark:hover:text-dark-800'
                )}
              >
                {t(`calendar.${choice}`)}
              </button>
            ))}
          </div>
          <div className='flex items-center gap-0.5'>
            <Button
              size='sm'
              variant='ghost'
              onClick={() => step(-1)}
              className='h-7 w-7 p-0'
              title={t('calendar.previous')}
            >
              <ChevronLeft className='h-4 w-4' />
            </Button>
            <Button
              size='sm'
              variant='ghost'
              onClick={() => setAnchor(new Date())}
              className='h-7 px-2 text-[12px]'
            >
              {t('calendar.today')}
            </Button>
            <Button
              size='sm'
              variant='ghost'
              onClick={() => step(1)}
              className='h-7 w-7 p-0'
              title={t('calendar.next')}
            >
              <ChevronRight className='h-4 w-4' />
            </Button>
          </div>
          <Button
            size='sm'
            onClick={() => openCreate(anchor)}
            data-testid='calendar-new-event'
            className='h-7 gap-1 px-2.5 text-[12px]'
          >
            <Plus className='h-3.5 w-3.5' />
            {t('calendar.newEvent')}
          </Button>
        </div>
      </div>

      {view === 'month' ? (
        <MonthGrid
          year={anchor.getFullYear()}
          monthIndex={anchor.getMonth()}
          events={displayEvents}
          onDayClick={day => openCreate(day)}
          onEventClick={openEdit}
        />
      ) : (
        <WeekGrid
          anchor={anchor}
          events={displayEvents}
          onDayClick={(day, hour) => openCreate(day, hour)}
          onEventClick={openEdit}
        />
      )}

      <EventModal
        open={modalOpen}
        event={editingEvent}
        initialStartAt={modalStartAt}
        saving={saving}
        onClose={() => setModalOpen(false)}
        onSave={result => void handleSave(result)}
        onDelete={() => void handleDelete()}
      />
    </div>
  );
};

export default CalendarPage;
