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

import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { calendarService } from '../services/calendarService.js';
import { ApiResponse, Calendar, CalendarEvent } from '../types/index.js';
import { authenticate, AuthenticatedRequest } from '../middleware/auth.js';
import {
  MAX_CALENDAR_EVENT_NOTES_LENGTH,
  MAX_CALENDAR_EVENT_TITLE_LENGTH,
  ResourcePolicyError,
} from '../utils/resourceLimits.js';
import {
  InvalidTriggerError,
  occurrencesBetween,
  validateTriggers,
} from '../utils/automationSchedule.js';

const router = express.Router();
router.use(authenticate);

const userIdOf = (req: AuthenticatedRequest): string =>
  req.user?.userId || 'default';

/** A calendar range query may span at most 13 months. */
const MAX_RANGE_MS = 13 * 32 * 24 * 60 * 60 * 1000;

function sendCalendarError(
  res: express.Response,
  error: unknown,
  fallback: string
) {
  if (
    error instanceof ResourcePolicyError ||
    error instanceof InvalidTriggerError
  ) {
    const statusCode =
      error instanceof ResourcePolicyError ? error.statusCode : 400;
    res.status(statusCode).json({ success: false, error: error.message });
    return;
  }
  res.status(500).json({
    success: false,
    error: error instanceof Error ? error.message : fallback,
  } as ApiResponse);
}

function readTextField(
  value: unknown,
  field: 'title' | 'notes',
  maximum: number,
  required: boolean
): string | undefined {
  if (value === undefined || value === null || value === '') {
    if (required) {
      throw new ResourcePolicyError(`${field} is required`, 400);
    }
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new ResourcePolicyError(`${field} must be a string`, 400);
  }
  if (value.length > maximum) {
    throw new ResourcePolicyError(
      `${field} exceeds the maximum length of ${maximum} characters`,
      400
    );
  }
  return value;
}

function readEpoch(value: unknown, field: string): number {
  const parsed = typeof value === 'string' ? Number(value) : value;
  if (
    typeof parsed !== 'number' ||
    !Number.isSafeInteger(parsed) ||
    parsed < 0
  ) {
    throw new ResourcePolicyError(`${field} must be an epoch-ms integer`, 400);
  }
  return parsed;
}

function readRange(req: AuthenticatedRequest): { from: number; to: number } {
  const from = readEpoch(req.query.from, 'from');
  const to = readEpoch(req.query.to, 'to');
  if (to <= from || to - from > MAX_RANGE_MS) {
    throw new ResourcePolicyError(
      'The requested range must be positive and span at most 13 months',
      400
    );
  }
  return { from, to };
}

function readEventBody(
  body: Record<string, unknown>,
  existing?: CalendarEvent
): Omit<CalendarEvent, 'id' | 'createdAt' | 'updatedAt'> {
  const calendarId =
    body.calendarId !== undefined
      ? body.calendarId === null
        ? undefined
        : String(body.calendarId)
      : existing?.calendarId;
  const reminderMinutes =
    body.reminderMinutes !== undefined
      ? body.reminderMinutes === null
        ? undefined
        : readEpoch(body.reminderMinutes, 'reminderMinutes')
      : existing?.reminderMinutes;
  const title =
    readTextField(
      body.title,
      'title',
      MAX_CALENDAR_EVENT_TITLE_LENGTH,
      existing === undefined
    ) ??
    existing?.title ??
    '';
  const notes =
    body.notes !== undefined
      ? readTextField(
          body.notes,
          'notes',
          MAX_CALENDAR_EVENT_NOTES_LENGTH,
          false
        )
      : existing?.notes;
  const startAt =
    body.startAt !== undefined
      ? readEpoch(body.startAt, 'startAt')
      : existing?.startAt;
  if (startAt === undefined) {
    throw new ResourcePolicyError('startAt is required', 400);
  }
  const endAt =
    body.endAt !== undefined && body.endAt !== null
      ? readEpoch(body.endAt, 'endAt')
      : body.endAt === null
        ? undefined
        : existing?.endAt;
  if (endAt !== undefined && endAt < startAt) {
    throw new ResourcePolicyError('endAt must not precede startAt', 400);
  }
  const allDay =
    body.allDay !== undefined
      ? body.allDay === true
      : (existing?.allDay ?? false);
  const recurrence =
    body.recurrence !== undefined
      ? body.recurrence === null
        ? undefined
        : validateTriggers([body.recurrence], 1)[0]
      : existing?.recurrence;
  return {
    title,
    ...(notes !== undefined ? { notes } : {}),
    startAt,
    ...(endAt !== undefined ? { endAt } : {}),
    allDay,
    ...(recurrence !== undefined ? { recurrence } : {}),
    ...(calendarId !== undefined ? { calendarId } : {}),
    ...(reminderMinutes !== undefined ? { reminderMinutes } : {}),
  };
}

/** Project a recurring event's occurrences into [from, to). */
function expandRecurring(
  event: CalendarEvent,
  from: number,
  to: number
): CalendarEvent[] {
  if (!event.recurrence) return [];
  const duration = event.endAt !== undefined ? event.endAt - event.startAt : 0;
  const effectiveFrom = Math.max(from, event.startAt);
  if (effectiveFrom >= to) return [];
  return occurrencesBetween([event.recurrence], effectiveFrom, to)
    .filter(occurrence => occurrence !== event.startAt)
    .map(occurrence => ({
      ...event,
      id: `${event.id}:${occurrence}`,
      baseEventId: event.id,
      startAt: occurrence,
      ...(event.endAt !== undefined ? { endAt: occurrence + duration } : {}),
    }));
}

router.get('/events', async (req: AuthenticatedRequest, res) => {
  try {
    const userId = userIdOf(req);
    const { from, to } = readRange(req);
    const { events: inRange, recurring } =
      await calendarService.listEventsForActor(
        { userId, role: req.user?.role },
        { from, to }
      );
    const scoped = inRange.filter(
      event => event.startAt >= from && event.startAt < to
    );
    const seen = new Set(scoped.map(event => event.id));
    const expanded = recurring.flatMap(event =>
      expandRecurring(event, from, to)
        .filter(occurrence => !seen.has(occurrence.id))
        .map(occurrence =>
          event.shared ? { ...occurrence, shared: event.shared } : occurrence
        )
    );
    const events = [...scoped, ...expanded].sort(
      (left, right) => left.startAt - right.startAt
    );
    res.json({ success: true, data: events } as ApiResponse<CalendarEvent[]>);
  } catch (error) {
    sendCalendarError(res, error, 'Failed to load calendar events');
  }
});

// Named calendars: own plus shared, colors, and lifecycle.
router.get('/calendars', async (req: AuthenticatedRequest, res) => {
  try {
    const calendars = await calendarService.listCalendars({
      userId: userIdOf(req),
      role: req.user?.role,
    });
    res.json({ success: true, data: calendars } as ApiResponse<Calendar[]>);
  } catch (error) {
    sendCalendarError(res, error, 'Failed to load calendars');
  }
});

router.post('/calendars', async (req: AuthenticatedRequest, res) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const calendar = await calendarService.saveCalendar(
      { userId: userIdOf(req), role: req.user?.role },
      {
        name: typeof body.name === 'string' ? body.name : '',
        ...(typeof body.color === 'string' && body.color
          ? { color: body.color }
          : {}),
      }
    );
    res.status(201).json({ success: true, data: calendar } as ApiResponse);
  } catch (error) {
    sendCalendarError(res, error, 'Failed to create calendar');
  }
});

router.put('/calendars/:calendarId', async (req: AuthenticatedRequest, res) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const calendar = await calendarService.saveCalendar(
      { userId: userIdOf(req), role: req.user?.role },
      {
        id: req.params.calendarId as string,
        name: typeof body.name === 'string' ? body.name : '',
        ...(typeof body.color === 'string' && body.color
          ? { color: body.color }
          : {}),
      }
    );
    res.json({ success: true, data: calendar } as ApiResponse);
  } catch (error) {
    sendCalendarError(res, error, 'Failed to update calendar');
  }
});

router.delete(
  '/calendars/:calendarId',
  async (req: AuthenticatedRequest, res) => {
    try {
      const deleted = await calendarService.deleteCalendar(
        { userId: userIdOf(req), role: req.user?.role },
        req.params.calendarId as string
      );
      if (!deleted) {
        res
          .status(404)
          .json({ success: false, error: 'Calendar not found' } as ApiResponse);
        return;
      }
      res.json({ success: true } as ApiResponse);
    } catch (error) {
      sendCalendarError(res, error, 'Failed to delete calendar');
    }
  }
);

// ICS portability.
router.get('/export', async (req: AuthenticatedRequest, res) => {
  try {
    const calendarId =
      typeof req.query.calendarId === 'string' && req.query.calendarId
        ? req.query.calendarId
        : undefined;
    const exported = await calendarService.exportIcs(
      { userId: userIdOf(req), role: req.user?.role },
      calendarId
    );
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${exported.filename}"`
    );
    res.send(exported.content);
  } catch (error) {
    sendCalendarError(res, error, 'Failed to export the calendar');
  }
});

router.post('/import', async (req: AuthenticatedRequest, res) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.ics !== 'string' || !body.ics.trim()) {
      res
        .status(400)
        .json({ success: false, error: 'ics content is required' });
      return;
    }
    const result = await calendarService.importIcs(
      { userId: userIdOf(req), role: req.user?.role },
      typeof body.calendarId === 'string' && body.calendarId
        ? body.calendarId
        : undefined,
      body.ics
    );
    res.json({ success: true, data: result } as ApiResponse);
  } catch (error) {
    sendCalendarError(res, error, 'Failed to import the calendar');
  }
});

router.post('/events', async (req: AuthenticatedRequest, res) => {
  try {
    const now = Date.now();
    const event: CalendarEvent = {
      id: uuidv4(),
      ...readEventBody((req.body ?? {}) as Record<string, unknown>),
      createdAt: now,
      updatedAt: now,
    };
    const saved = await calendarService.saveEventForActor(
      { userId: userIdOf(req), role: req.user?.role },
      event,
      event.calendarId
    );
    res.json({
      success: true,
      data: saved.event,
    } as ApiResponse<CalendarEvent>);
  } catch (error) {
    sendCalendarError(res, error, 'Failed to create calendar event');
  }
});

router.put('/events/:eventId', async (req: AuthenticatedRequest, res) => {
  try {
    const actor = { userId: userIdOf(req), role: req.user?.role };
    const { event: existing } = await calendarService.requireWritableEvent(
      actor,
      req.params.eventId as string
    );
    const event: CalendarEvent = {
      ...existing,
      ...readEventBody((req.body ?? {}) as Record<string, unknown>, existing),
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: Date.now(),
    };
    const saved = await calendarService.saveEventForActor(
      actor,
      event,
      event.calendarId
    );
    res.json({
      success: true,
      data: saved.event,
    } as ApiResponse<CalendarEvent>);
  } catch (error) {
    sendCalendarError(res, error, 'Failed to update calendar event');
  }
});

router.delete('/events/:eventId', async (req: AuthenticatedRequest, res) => {
  try {
    const deleted = await calendarService.deleteEventForActor(
      { userId: userIdOf(req), role: req.user?.role },
      req.params.eventId as string
    );
    if (!deleted) {
      res.status(404).json({
        success: false,
        error: 'Calendar event not found',
      } as ApiResponse);
      return;
    }
    res.json({
      success: true,
      message: 'Calendar event deleted',
    } as ApiResponse);
  } catch (error) {
    sendCalendarError(res, error, 'Failed to delete calendar event');
  }
});

export default router;
