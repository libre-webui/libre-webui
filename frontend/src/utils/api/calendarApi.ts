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

import type {
  ApiResponse,
  AutomationTrigger,
  Calendar,
  CalendarEvent,
} from '@/types';
import { isDemoMode } from '@/utils/demoMode';
import { api, createDemoResponse } from './client';

export interface CalendarEventInput {
  title?: string;
  notes?: string;
  startAt?: number;
  endAt?: number | null;
  allDay?: boolean;
  recurrence?: AutomationTrigger | null;
  calendarId?: string | null;
  reminderMinutes?: number | null;
}

export const calendarApi = {
  getEvents: (
    from: number,
    to: number
  ): Promise<ApiResponse<CalendarEvent[]>> => {
    if (isDemoMode()) return createDemoResponse([]);
    return api
      .get(`/calendar/events?from=${from}&to=${to}`)
      .then(res => res.data);
  },

  createEvent: (
    event: CalendarEventInput
  ): Promise<ApiResponse<CalendarEvent>> =>
    api.post('/calendar/events', event).then(res => res.data),

  updateEvent: (
    eventId: string,
    updates: CalendarEventInput
  ): Promise<ApiResponse<CalendarEvent>> =>
    api.put(`/calendar/events/${eventId}`, updates).then(res => res.data),

  deleteEvent: (eventId: string): Promise<ApiResponse> =>
    api.delete(`/calendar/events/${eventId}`).then(res => res.data),

  getCalendars: (): Promise<ApiResponse<Calendar[]>> => {
    if (isDemoMode()) return createDemoResponse([]);
    return api.get('/calendar/calendars').then(res => res.data);
  },

  createCalendar: (input: {
    name: string;
    color?: string;
  }): Promise<ApiResponse<Calendar>> =>
    api.post('/calendar/calendars', input).then(res => res.data),

  updateCalendar: (
    calendarId: string,
    input: { name: string; color?: string }
  ): Promise<ApiResponse<Calendar>> =>
    api.put(`/calendar/calendars/${calendarId}`, input).then(res => res.data),

  deleteCalendar: (calendarId: string): Promise<ApiResponse> =>
    api.delete(`/calendar/calendars/${calendarId}`).then(res => res.data),

  exportIcs: (calendarId?: string): Promise<Blob> =>
    api
      .get(
        calendarId
          ? `/calendar/export?calendarId=${encodeURIComponent(calendarId)}`
          : '/calendar/export',
        { responseType: 'blob' }
      )
      .then(res => res.data),

  importIcs: (
    ics: string,
    calendarId?: string
  ): Promise<
    ApiResponse<{ imported: number; skipped: number; droppedRules: number }>
  > =>
    api
      .post('/calendar/import', {
        ics,
        ...(calendarId ? { calendarId } : {}),
      })
      .then(res => res.data),
};
