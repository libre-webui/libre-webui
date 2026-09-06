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
import {
  ChevronLeft,
  ChevronRight,
  Download,
  Plus,
  Share2,
  Upload,
  X,
} from 'lucide-react';
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
import type { Calendar, CalendarEvent } from '@/types';
import { ShareDialog } from '@/components/ShareDialog';

const logger = createLogger('pages:calendar');

type CalendarView = 'month' | 'week' | 'day';

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
  const [calendars, setCalendars] = useState<Calendar[]>([]);
  const [newCalendarName, setNewCalendarName] = useState('');
  const [creatingCalendar, setCreatingCalendar] = useState(false);
  const [shareCalendar, setShareCalendar] = useState<Calendar | null>(null);
  const importInputRef = React.useRef<HTMLInputElement>(null);

  const range = useMemo(() => {
    if (view === 'month') {
      const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
      const gridStart = startOfWeek(first);
      return {
        from: gridStart.getTime(),
        to: addDays(gridStart, 42).getTime(),
      };
    }
    if (view === 'day') {
      const dayStart = new Date(
        anchor.getFullYear(),
        anchor.getMonth(),
        anchor.getDate()
      );
      return { from: dayStart.getTime(), to: addDays(dayStart, 1).getTime() };
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
    calendarApi
      .getCalendars()
      .then(response => {
        if (response.success && response.data) setCalendars(response.data);
      })
      .catch(error => logger.error('Failed to load calendars:', error));
  }, [refreshCounter]);

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
        : addDays(current, direction * (view === 'day' ? 1 : 7))
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
    // Shared read-only events never open the editor.
    if (event.shared && event.shared.permission !== 'write') {
      toast(t('calendar.sharedReadOnly'));
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
        }).format(view === 'day' ? anchor : startOfWeek(anchor));

  const handleCreateCalendar = async () => {
    const name = newCalendarName.trim();
    if (!name || creatingCalendar) return;
    setCreatingCalendar(true);
    const response = await calendarApi
      .createCalendar({ name })
      .catch(() => undefined);
    setCreatingCalendar(false);
    if (response?.success) {
      setNewCalendarName('');
      refreshEvents();
    } else {
      toast.error(t('calendar.calendarSaveFailed'));
    }
  };

  const handleExport = async (calendarId?: string) => {
    try {
      const blob = await calendarApi.exportIcs(calendarId);
      const url = URL.createObjectURL(blob);
      const anchorElement = document.createElement('a');
      anchorElement.href = url;
      anchorElement.download = 'calendar.ics';
      anchorElement.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      logger.error('Failed to export the calendar:', error);
      toast.error(t('calendar.exportFailed'));
    }
  };

  const handleImportFile = async (file: File) => {
    try {
      const ics = await file.text();
      const response = await calendarApi.importIcs(ics);
      if (response.success && response.data) {
        toast.success(
          t('calendar.importResult', { total: response.data.imported })
        );
        refreshEvents();
      } else {
        toast.error(response.error || t('calendar.importFailed'));
      }
    } catch (error) {
      logger.error('Failed to import the calendar:', error);
      toast.error(t('calendar.importFailed'));
    }
  };

  return (
    <div
      className='flex h-full min-h-0 flex-col overflow-hidden'
      data-testid='calendar-page'
    >
      <div className='flex flex-wrap items-center justify-between gap-2 border-b border-black/[0.06] px-4 py-3 dark:border-white/[0.07]'>
        <div className='flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1'>
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
        <div className='flex w-full min-w-0 flex-wrap items-center gap-2 sm:w-auto'>
          <div className='flex items-center rounded-xl bg-black/[0.04] p-0.5 dark:bg-white/[0.06]'>
            {(['month', 'week', 'day'] as const).map(choice => (
              <button
                key={choice}
                type='button'
                onClick={() => setView(choice)}
                aria-pressed={view === choice}
                data-testid={`calendar-view-${choice}`}
                className={cn(
                  'rounded-[10px] px-2.5 py-1 text-[12px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 focus-visible:ring-offset-canvas',
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
              aria-label={t('calendar.previous')}
            >
              <ChevronLeft className='h-4 w-4 rtl:rotate-180' />
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
              aria-label={t('calendar.next')}
            >
              <ChevronRight className='h-4 w-4 rtl:rotate-180' />
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

      <div className='flex flex-wrap items-center gap-1.5 border-b border-black/[0.06] px-4 py-2 dark:border-white/[0.07]'>
        {calendars.map(calendar => (
          <span
            key={calendar.id}
            className='inline-flex max-w-full items-center gap-1.5 rounded-full border border-black/[0.08] px-2.5 py-1 text-xs text-gray-700 dark:border-white/[0.1] dark:text-dark-800'
            data-testid='calendar-chip'
          >
            <span
              className='h-2 w-2 shrink-0 rounded-full'
              style={{ backgroundColor: calendar.color ?? '#8b8b8b' }}
            />
            <span className='truncate' title={calendar.name}>
              {calendar.name}
            </span>
            {calendar.shared ? (
              <span className='text-[10px] uppercase text-gray-400 dark:text-dark-500'>
                {t('calendar.sharedBadge')}
              </span>
            ) : (
              <>
                <button
                  onClick={() => setShareCalendar(calendar)}
                  className='shrink-0 text-gray-400 hover:text-primary-500 dark:text-dark-500'
                  title={t('calendar.shareCalendar')}
                  data-testid='calendar-share'
                >
                  <Share2 className='h-3 w-3' />
                </button>
                <button
                  onClick={() =>
                    void calendarApi
                      .deleteCalendar(calendar.id)
                      .then(refreshEvents)
                  }
                  className='shrink-0 text-gray-400 hover:text-red-500 dark:text-dark-500'
                  title={t('common.delete')}
                >
                  <X className='h-3 w-3' />
                </button>
              </>
            )}
          </span>
        ))}
        <form
          className='flex min-w-0 max-w-full items-center gap-1'
          onSubmit={event => {
            event.preventDefault();
            void handleCreateCalendar();
          }}
        >
          <input
            type='text'
            value={newCalendarName}
            disabled={creatingCalendar}
            onChange={event => setNewCalendarName(event.target.value)}
            placeholder={t('calendar.newCalendarPlaceholder')}
            aria-label={t('calendar.newCalendarPlaceholder')}
            className='min-w-0 w-36 rounded-full border border-dashed border-black/[0.12] bg-transparent px-2.5 py-1 text-base text-gray-700 placeholder:text-gray-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 focus-visible:ring-offset-canvas dark:border-white/[0.16] dark:text-dark-800 sm:text-xs'
            data-testid='calendar-new-calendar'
          />
          <Button
            type='submit'
            size='sm'
            variant='ghost'
            disabled={!newCalendarName.trim()}
            loading={creatingCalendar}
            className='h-7 shrink-0 px-2 text-xs'
            data-testid='calendar-create-calendar'
          >
            {t('common.save')}
          </Button>
        </form>
        <div className='ms-auto flex items-center gap-1'>
          <input
            ref={importInputRef}
            type='file'
            accept='.ics,text/calendar'
            className='hidden'
            onChange={event => {
              const file = event.target.files?.[0];
              if (file) void handleImportFile(file);
              event.target.value = '';
            }}
          />
          <Button
            size='sm'
            variant='ghost'
            onClick={() => importInputRef.current?.click()}
            className='h-7 gap-1 px-2 text-[12px]'
            data-testid='calendar-import'
          >
            <Upload className='h-3.5 w-3.5' />
            {t('calendar.importIcs')}
          </Button>
          <Button
            size='sm'
            variant='ghost'
            onClick={() => void handleExport()}
            className='h-7 gap-1 px-2 text-[12px]'
            data-testid='calendar-export'
          >
            <Download className='h-3.5 w-3.5' />
            {t('calendar.exportIcs')}
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
          dayCount={view === 'day' ? 1 : 7}
          onDayClick={(day, hour) => openCreate(day, hour)}
          onEventClick={openEdit}
        />
      )}

      {shareCalendar && (
        <ShareDialog
          resourceType='calendar'
          resourceId={shareCalendar.id}
          resourceLabel={shareCalendar.name}
          onClose={() => setShareCalendar(null)}
        />
      )}
      <EventModal
        open={modalOpen}
        event={editingEvent}
        initialStartAt={modalStartAt}
        calendars={calendars.filter(
          calendar => !calendar.shared || calendar.shared.permission === 'write'
        )}
        saving={saving}
        onClose={() => setModalOpen(false)}
        onSave={result => void handleSave(result)}
        onDelete={() => void handleDelete()}
      />
    </div>
  );
};

export default CalendarPage;
