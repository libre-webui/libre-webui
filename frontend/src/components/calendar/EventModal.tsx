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
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Trash2, X } from 'lucide-react';
import type { AutomationTrigger, CalendarEvent } from '@/types';
import {
  fromInputValues,
  toDateInputValue,
  toTimeInputValue,
} from '@/utils/calendarDates';

type RepeatChoice = 'none' | 'daily' | 'weekly' | 'monthly' | 'yearly';

export interface EventModalResult {
  title: string;
  notes?: string;
  startAt: number;
  endAt?: number | null;
  allDay: boolean;
  recurrence: AutomationTrigger | null;
}

interface EventModalProps {
  open: boolean;
  /** Existing event to edit; null creates a new one. */
  event: CalendarEvent | null;
  /** Prefill for new events (the clicked day). */
  initialStartAt: number;
  saving: boolean;
  onClose: () => void;
  onSave: (result: EventModalResult) => void;
  onDelete?: () => void;
}

const repeatOf = (recurrence?: AutomationTrigger): RepeatChoice => {
  if (!recurrence) return 'none';
  if (recurrence.kind === 'once' || recurrence.kind === 'hourly') return 'none';
  return recurrence.kind;
};

const triggerFor = (
  repeat: RepeatChoice,
  startAt: number
): AutomationTrigger | null => {
  const start = new Date(startAt);
  const hour = start.getHours();
  const minute = start.getMinutes();
  switch (repeat) {
    case 'daily':
      return { kind: 'daily', hour, minute };
    case 'weekly':
      return { kind: 'weekly', dayOfWeek: start.getDay(), hour, minute };
    case 'monthly':
      return { kind: 'monthly', dayOfMonth: start.getDate(), hour, minute };
    case 'yearly':
      return {
        kind: 'yearly',
        month: start.getMonth() + 1,
        dayOfMonth: start.getDate(),
        hour,
        minute,
      };
    default:
      return null;
  }
};

const fieldClass =
  'w-full rounded-lg border border-black/[0.08] bg-white px-2.5 py-1.5 text-[13px] text-gray-900 focus:border-primary-500/40 focus:outline-none dark:border-white/[0.08] dark:bg-dark-100 dark:text-dark-900';
const labelClass =
  'mb-1 block text-[11px] font-medium uppercase tracking-wide text-gray-400 dark:text-dark-500';

export function EventModal({
  open,
  event,
  initialStartAt,
  saving,
  onClose,
  onSave,
  onDelete,
}: EventModalProps) {
  if (!open) return null;
  // Remount the form per target so state initializes fresh each time the
  // modal opens, without a state-resetting effect.
  return (
    <EventModalForm
      key={`${event?.id ?? 'new'}:${initialStartAt}`}
      event={event}
      initialStartAt={initialStartAt}
      saving={saving}
      onClose={onClose}
      onSave={onSave}
      onDelete={onDelete}
    />
  );
}

function EventModalForm({
  event,
  initialStartAt,
  saving,
  onClose,
  onSave,
  onDelete,
}: Omit<EventModalProps, 'open'>) {
  const { t } = useTranslation();
  const startSeed = event?.startAt ?? initialStartAt;
  const [title, setTitle] = useState(event?.title ?? '');
  const [notes, setNotes] = useState(event?.notes ?? '');
  const [dateValue, setDateValue] = useState(toDateInputValue(startSeed));
  const [timeValue, setTimeValue] = useState(
    event ? toTimeInputValue(startSeed) : '09:00'
  );
  const [endTimeValue, setEndTimeValue] = useState(
    event?.endAt !== undefined ? toTimeInputValue(event.endAt) : ''
  );
  const [allDay, setAllDay] = useState(event?.allDay ?? false);
  const [repeat, setRepeat] = useState<RepeatChoice>(
    repeatOf(event?.recurrence)
  );

  const handleSave = () => {
    if (!title.trim() || !dateValue) return;
    const startAt = fromInputValues(dateValue, allDay ? '' : timeValue);
    const endAt =
      !allDay && endTimeValue ? fromInputValues(dateValue, endTimeValue) : null;
    onSave({
      title: title.trim(),
      notes: notes.trim() ? notes.trim() : undefined,
      startAt,
      endAt: endAt !== null && endAt > startAt ? endAt : null,
      allDay,
      recurrence: triggerFor(repeat, startAt),
    });
  };

  const repeatChoices: Array<{ value: RepeatChoice; label: string }> = [
    { value: 'none', label: t('calendar.repeatNone') },
    { value: 'daily', label: t('calendar.repeatDaily') },
    { value: 'weekly', label: t('calendar.repeatWeekly') },
    { value: 'monthly', label: t('calendar.repeatMonthly') },
    { value: 'yearly', label: t('calendar.repeatYearly') },
  ];

  return createPortal(
    <div
      className='fixed inset-0 z-[2147483647] flex items-center justify-center bg-gray-950/55 p-4 backdrop-blur-md'
      onClick={onClose}
    >
      <div
        role='dialog'
        aria-modal='true'
        aria-labelledby='calendar-event-modal-title'
        data-testid='calendar-event-modal'
        className='w-full max-w-md rounded-3xl border border-black/[0.07] bg-white p-6 shadow-[0_24px_80px_rgba(0,0,0,0.24)] animate-scale-in dark:border-white/[0.08] dark:bg-dark-25'
        onClick={e => e.stopPropagation()}
      >
        <div className='mb-4 flex items-center justify-between'>
          <h3
            id='calendar-event-modal-title'
            className='text-lg font-medium tracking-[-0.02em] text-gray-950 dark:text-dark-950'
          >
            {event ? t('calendar.editEvent') : t('calendar.newEvent')}
          </h3>
          <button
            onClick={onClose}
            aria-label={t('common.close')}
            className='rounded-xl p-2 transition-colors hover:bg-gray-100 dark:hover:bg-dark-200'
          >
            <X size={20} className='text-gray-500' />
          </button>
        </div>

        <div className='space-y-3'>
          <div>
            <label htmlFor='calendar-event-title' className={labelClass}>
              {t('calendar.eventTitle')}
            </label>
            <input
              id='calendar-event-title'
              data-testid='calendar-event-title'
              type='text'
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder={t('calendar.titlePlaceholder')}
              className={fieldClass}
              maxLength={200}
              autoFocus
            />
          </div>

          <div className='grid grid-cols-2 gap-3'>
            <div>
              <label htmlFor='calendar-event-date' className={labelClass}>
                {t('calendar.date')}
              </label>
              <input
                id='calendar-event-date'
                type='date'
                value={dateValue}
                onChange={e => setDateValue(e.target.value)}
                className={fieldClass}
              />
            </div>
            <div className='flex items-end pb-1.5'>
              <label className='flex items-center gap-2 text-[13px] text-gray-700 dark:text-dark-700'>
                <input
                  type='checkbox'
                  checked={allDay}
                  onChange={e => setAllDay(e.target.checked)}
                  className='h-4 w-4 rounded accent-primary-500'
                />
                {t('calendar.allDay')}
              </label>
            </div>
          </div>

          {!allDay && (
            <div className='grid grid-cols-2 gap-3'>
              <div>
                <label htmlFor='calendar-event-start' className={labelClass}>
                  {t('calendar.start')}
                </label>
                <input
                  id='calendar-event-start'
                  type='time'
                  value={timeValue}
                  onChange={e => setTimeValue(e.target.value)}
                  className={fieldClass}
                />
              </div>
              <div>
                <label htmlFor='calendar-event-end' className={labelClass}>
                  {t('calendar.end')}
                </label>
                <input
                  id='calendar-event-end'
                  type='time'
                  value={endTimeValue}
                  onChange={e => setEndTimeValue(e.target.value)}
                  className={fieldClass}
                />
              </div>
            </div>
          )}

          <div>
            <label htmlFor='calendar-event-repeat' className={labelClass}>
              {t('calendar.repeat')}
            </label>
            <select
              id='calendar-event-repeat'
              value={repeat}
              onChange={e => setRepeat(e.target.value as RepeatChoice)}
              className={fieldClass}
            >
              {repeatChoices.map(choice => (
                <option key={choice.value} value={choice.value}>
                  {choice.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor='calendar-event-notes' className={labelClass}>
              {t('calendar.notes')}
            </label>
            <textarea
              id='calendar-event-notes'
              value={notes}
              onChange={e => setNotes(e.target.value)}
              rows={3}
              className={fieldClass}
              maxLength={10_000}
            />
          </div>

          <div className='flex items-center justify-between gap-3 border-t border-gray-200 pt-4 dark:border-dark-300'>
            {event && onDelete ? (
              <button
                onClick={onDelete}
                data-testid='calendar-event-delete'
                className='flex items-center gap-1.5 rounded-xl px-3 py-2 text-sm font-medium text-red-600 transition-colors hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-900/20'
              >
                <Trash2 className='h-4 w-4' />
                {t('common.delete')}
              </button>
            ) : (
              <span />
            )}
            <div className='flex gap-3'>
              <button
                onClick={onClose}
                className='rounded-xl px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-100 dark:text-dark-700 dark:hover:bg-dark-200'
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={handleSave}
                disabled={saving || !title.trim()}
                data-testid='calendar-event-save'
                className='rounded-xl bg-gray-950 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-white dark:text-gray-950 dark:hover:bg-gray-100'
              >
                {saving ? t('common.saving') : t('common.save')}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
