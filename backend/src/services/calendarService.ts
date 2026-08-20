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

/**
 * Named calendars with sharing, ICS portability, and reminders (CAL-01).
 *
 * Events remain owned by the calendar owner even when a write-granted
 * collaborator creates them, so quotas, deletion, and the portable
 * archive stay owner-scoped. Access to a shared calendar's events is
 * decided per request through the common grant model; revocation applies
 * on the next read.
 */

import { randomUUID } from 'node:crypto';
import storageService from '../storage.js';
import { encryptionService } from './encryptionService.js';
import { getPersistence } from '../persistence/index.js';
import {
  grantedResourceIdsFor,
  sharedMetaFor,
  type SharedResourceMeta,
} from './sharedResourceAccess.js';
import { deleteGrantsForResource } from './resourceGrantService.js';
import type { AuthzActor } from './authorizationService.js';
import {
  occurrencesBetween,
  validateTriggers,
} from '../utils/automationSchedule.js';
import {
  parseIcsCalendar,
  serializeCalendarToIcs,
} from '../utils/icsCalendar.js';
import {
  MAX_CALENDAR_REMINDER_MINUTES,
  MAX_ICS_IMPORT_BYTES,
  MAX_ICS_IMPORT_EVENTS,
  ResourcePolicyError,
} from '../utils/resourceLimits.js';
import { createLogger } from '../utils/logger.js';
import type { Calendar, CalendarEvent } from '../types/index.js';

const logger = createLogger('calendar');

/** How long after an occurrence's reminder time it may still fire. */
const REMINDER_GRACE_MS = 10 * 60 * 1000;

export interface CalendarEventWithAccess extends CalendarEvent {
  /** Present on events from a calendar shared with the actor. */
  shared?: SharedResourceMeta;
}

const archiveOwnerOf = (calendarId: string): Promise<string | null> =>
  getPersistence(encryptionService).repositories.resources.archive.ownerOf(
    'calendar',
    calendarId
  );

class CalendarService {
  /** Own calendars followed by calendars shared with the actor. */
  async listCalendars(actor: AuthzActor): Promise<Calendar[]> {
    const own = (await storageService.getCalendars(actor.userId)).map(
      ({ ownerUserId: _ownerUserId, ...calendar }) => calendar
    );
    const sharedIds = await grantedResourceIdsFor(
      actor,
      'calendar',
      new Set(own.map(calendar => calendar.id))
    );
    const shared: Calendar[] = [];
    for (const calendarId of sharedIds) {
      const calendar = await storageService.getCalendarById(calendarId);
      if (!calendar || calendar.ownerUserId === actor.userId) continue;
      const meta = await sharedMetaFor(
        actor,
        'calendar',
        calendarId,
        calendar.ownerUserId
      );
      if (!meta) continue;
      const { ownerUserId: _ownerUserId, ...view } = calendar;
      shared.push({ ...view, shared: meta });
    }
    return [...own, ...shared];
  }

  async saveCalendar(
    actor: AuthzActor,
    input: { id?: string; name: string; color?: string }
  ): Promise<Calendar> {
    const now = Date.now();
    const existing = input.id
      ? await storageService.getCalendarById(input.id)
      : undefined;
    if (existing && existing.ownerUserId !== actor.userId) {
      throw new ResourcePolicyError('Calendar not found', 404);
    }
    const calendar: Calendar = {
      id: existing?.id ?? input.id ?? randomUUID(),
      name: input.name,
      ...(input.color ? { color: input.color } : {}),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    await storageService.saveCalendar(calendar, actor.userId);
    return calendar;
  }

  async deleteCalendar(
    actor: AuthzActor,
    calendarId: string
  ): Promise<boolean> {
    const deleted = await storageService.deleteCalendar(
      calendarId,
      actor.userId
    );
    if (deleted) {
      await deleteGrantsForResource('calendar', calendarId).catch(error => {
        logger.warn('Calendar grant cleanup failed', { error });
      });
    }
    return deleted;
  }

  /**
   * Write access to a calendar scope: the owner, or a write grant on a
   * shared calendar. Returns the owning user so events stay owner-scoped.
   */
  private async requireCalendarWrite(
    actor: AuthzActor,
    calendarId: string
  ): Promise<{ ownerUserId: string; shared?: SharedResourceMeta }> {
    const calendar = await storageService.getCalendarById(calendarId);
    if (!calendar) {
      throw new ResourcePolicyError('Calendar not found', 404);
    }
    if (calendar.ownerUserId === actor.userId) {
      return { ownerUserId: calendar.ownerUserId };
    }
    const meta = await sharedMetaFor(
      actor,
      'calendar',
      calendarId,
      calendar.ownerUserId,
      'write'
    );
    if (!meta || meta.permission !== 'write') {
      throw new ResourcePolicyError('Calendar not found', 404);
    }
    return { ownerUserId: calendar.ownerUserId, shared: meta };
  }

  /** Calendars shared with the actor, with their access metadata. */
  private async sharedCalendars(
    actor: AuthzActor
  ): Promise<Array<{ calendarId: string; meta: SharedResourceMeta }>> {
    const own = new Set(
      (await storageService.getCalendars(actor.userId)).map(
        calendar => calendar.id
      )
    );
    const sharedIds = await grantedResourceIdsFor(actor, 'calendar', own);
    const result: Array<{ calendarId: string; meta: SharedResourceMeta }> = [];
    for (const calendarId of sharedIds) {
      const ownerUserId = await archiveOwnerOf(calendarId);
      if (!ownerUserId || ownerUserId === actor.userId) continue;
      const meta = await sharedMetaFor(
        actor,
        'calendar',
        calendarId,
        ownerUserId
      );
      if (meta) result.push({ calendarId, meta });
    }
    return result;
  }

  /**
   * The actor's own events plus events from calendars shared with them,
   * shared entries tagged with their access metadata.
   */
  async listEventsForActor(
    actor: AuthzActor,
    range: { from: number; to: number }
  ): Promise<{
    events: CalendarEventWithAccess[];
    recurring: CalendarEventWithAccess[];
  }> {
    const [ownInRange, ownRecurring, shared] = await Promise.all([
      storageService.getCalendarEventsBetween(
        range.from,
        range.to,
        actor.userId
      ),
      storageService.getRecurringCalendarEvents(actor.userId),
      this.sharedCalendars(actor),
    ]);
    const events: CalendarEventWithAccess[] = [...ownInRange];
    const recurring: CalendarEventWithAccess[] = [...ownRecurring];
    if (shared.length > 0) {
      const metaByCalendar = new Map(
        shared.map(entry => [entry.calendarId, entry.meta] as const)
      );
      const calendarIds = shared.map(entry => entry.calendarId);
      const [sharedInRange, sharedRecurring] = await Promise.all([
        storageService.getCalendarEventsForCalendarsBetween(
          calendarIds,
          range.from,
          range.to
        ),
        storageService.getRecurringEventsForCalendars(calendarIds),
      ]);
      const tag = (event: CalendarEvent): CalendarEventWithAccess => ({
        ...event,
        ...(event.calendarId && metaByCalendar.has(event.calendarId)
          ? { shared: metaByCalendar.get(event.calendarId) }
          : {}),
      });
      const seen = new Set(events.map(event => event.id));
      for (const event of sharedInRange.map(tag)) {
        if (!seen.has(event.id)) events.push(event);
      }
      const seenRecurring = new Set(recurring.map(event => event.id));
      for (const event of sharedRecurring.map(tag)) {
        if (!seenRecurring.has(event.id)) recurring.push(event);
      }
    }
    return { events, recurring };
  }

  private validateReminder(value: unknown): number | undefined {
    if (value === undefined || value === null) return undefined;
    const minutes = Number(value);
    if (
      !Number.isSafeInteger(minutes) ||
      minutes < 0 ||
      minutes > MAX_CALENDAR_REMINDER_MINUTES
    ) {
      throw new ResourcePolicyError('Invalid reminder offset', 400);
    }
    return minutes === 0 ? undefined : minutes;
  }

  /**
   * Persists an event into a calendar scope the actor may write:
   * their own default scope, their own calendar, or a shared calendar
   * with a write grant. The stored owner is always the calendar owner.
   */
  async saveEventForActor(
    actor: AuthzActor,
    event: CalendarEvent,
    calendarId: string | undefined
  ): Promise<{ event: CalendarEvent; ownerUserId: string }> {
    let ownerUserId = actor.userId;
    if (calendarId) {
      ({ ownerUserId } = await this.requireCalendarWrite(actor, calendarId));
    }
    const next: CalendarEvent = {
      ...event,
      ...(calendarId ? { calendarId } : {}),
      reminderMinutes: this.validateReminder(event.reminderMinutes),
    };
    if (next.reminderMinutes === undefined) delete next.reminderMinutes;
    await storageService.saveCalendarEvent(next, ownerUserId);
    return { event: next, ownerUserId };
  }

  /**
   * Resolves an existing event the actor may modify: their own, or one
   * living in a shared calendar with a write grant.
   */
  async requireWritableEvent(
    actor: AuthzActor,
    eventId: string
  ): Promise<{ event: CalendarEvent; ownerUserId: string }> {
    const own = await storageService.getCalendarEvent(eventId, actor.userId);
    if (own) return { event: own, ownerUserId: actor.userId };
    const found = await storageService.getCalendarEventById(eventId);
    if (!found || !found.event.calendarId) {
      throw new ResourcePolicyError('Calendar event not found', 404);
    }
    const access = await this.requireCalendarWrite(
      actor,
      found.event.calendarId
    );
    if (access.ownerUserId !== found.ownerUserId) {
      throw new ResourcePolicyError('Calendar event not found', 404);
    }
    return found;
  }

  async deleteEventForActor(
    actor: AuthzActor,
    eventId: string
  ): Promise<boolean> {
    const own = await storageService.deleteCalendarEvent(eventId, actor.userId);
    if (own) return true;
    try {
      const { ownerUserId } = await this.requireWritableEvent(actor, eventId);
      return storageService.deleteCalendarEvent(eventId, ownerUserId);
    } catch {
      return false;
    }
  }

  /** ICS export of one calendar scope (or the default scope). */
  async exportIcs(
    actor: AuthzActor,
    calendarId: string | undefined
  ): Promise<{ filename: string; content: string }> {
    let name = 'calendar';
    let events: CalendarEvent[];
    const horizonFrom = 0;
    const horizonTo = Number.MAX_SAFE_INTEGER;
    if (calendarId) {
      const calendar = await storageService.getCalendarById(calendarId);
      if (!calendar) throw new ResourcePolicyError('Calendar not found', 404);
      if (calendar.ownerUserId !== actor.userId) {
        const meta = await sharedMetaFor(
          actor,
          'calendar',
          calendarId,
          calendar.ownerUserId
        );
        if (!meta) throw new ResourcePolicyError('Calendar not found', 404);
      }
      name = calendar.name;
      events = await storageService.getCalendarEventsForCalendarsBetween(
        [calendarId],
        horizonFrom,
        horizonTo
      );
    } else {
      events = (
        await storageService.getCalendarEventsBetween(
          horizonFrom,
          horizonTo,
          actor.userId
        )
      ).filter(event => !event.calendarId);
      name = 'My calendar';
    }
    return {
      filename: `${name.replace(/[^\w-]+/g, '-').toLowerCase() || 'calendar'}.ics`,
      content: serializeCalendarToIcs(name, events),
    };
  }

  /** ICS import into a writable calendar scope. */
  async importIcs(
    actor: AuthzActor,
    calendarId: string | undefined,
    source: string
  ): Promise<{ imported: number; skipped: number; droppedRules: number }> {
    if (Buffer.byteLength(source, 'utf8') > MAX_ICS_IMPORT_BYTES) {
      throw new ResourcePolicyError('The ICS file is too large', 400);
    }
    let ownerUserId = actor.userId;
    if (calendarId) {
      ({ ownerUserId } = await this.requireCalendarWrite(actor, calendarId));
    }
    const parsed = parseIcsCalendar(source, MAX_ICS_IMPORT_EVENTS);
    let imported = 0;
    let droppedRules = 0;
    const now = Date.now();
    for (const entry of parsed.events) {
      if (entry.recurrence) {
        try {
          validateTriggers([entry.recurrence], 1);
        } catch {
          delete entry.recurrence;
          entry.dropped.push('RRULE');
        }
      }
      if (entry.dropped.length > 0) droppedRules += 1;
      const event: CalendarEvent = {
        id: randomUUID(),
        title: entry.title,
        ...(entry.notes ? { notes: entry.notes } : {}),
        startAt: entry.startAt,
        ...(entry.endAt !== undefined ? { endAt: entry.endAt } : {}),
        allDay: entry.allDay,
        ...(entry.recurrence ? { recurrence: entry.recurrence } : {}),
        ...(calendarId ? { calendarId } : {}),
        ...(entry.reminderMinutes !== undefined
          ? { reminderMinutes: this.validateReminder(entry.reminderMinutes) }
          : {}),
        createdAt: now,
        updatedAt: now,
      };
      await storageService.saveCalendarEvent(event, ownerUserId);
      imported += 1;
    }
    return { imported, skipped: parsed.skipped, droppedRules };
  }

  /**
   * Fires due reminders exactly once per occurrence. Runs inside the
   * scheduler's coordination lease, and the per-event compare-and-set on
   * `last_reminded_occurrence` keeps concurrent sweeps single-fire.
   */
  async sweepReminders(now = Date.now()): Promise<number> {
    const rows = await storageService.listCalendarEventsWithReminders();
    let fired = 0;
    for (const { event, ownerUserId } of rows) {
      const reminderMs = (event.reminderMinutes ?? 0) * 60 * 1000;
      if (reminderMs <= 0) continue;
      let occurrence: number | undefined;
      if (event.recurrence) {
        const candidates = occurrencesBetween(
          [event.recurrence],
          Math.max(now - REMINDER_GRACE_MS, event.startAt - 1),
          now + reminderMs + 1
        );
        occurrence = candidates.find(
          candidate =>
            candidate - reminderMs <= now &&
            now < candidate + REMINDER_GRACE_MS &&
            (event.lastRemindedOccurrence ?? 0) < candidate
        );
      } else if (
        event.startAt - reminderMs <= now &&
        now < event.startAt + REMINDER_GRACE_MS &&
        (event.lastRemindedOccurrence ?? 0) < event.startAt
      ) {
        occurrence = event.startAt;
      }
      if (occurrence === undefined) continue;
      const claimed = await storageService.markCalendarEventReminded(
        event.id,
        occurrence
      );
      if (!claimed) continue;
      fired += 1;
      try {
        const { notificationService } =
          await import('./notificationService.js');
        const when = new Date(occurrence);
        await notificationService.publish({
          userId: ownerUserId,
          type: 'calendar-reminder',
          title: `Upcoming: ${event.title}`,
          body: `Starts ${when.toLocaleString()}`,
          href: '/calendar',
          sourceKey: `cal-reminder:${event.id}:${occurrence}`,
        });
      } catch (error) {
        logger.warn('Calendar reminder notification failed', { error });
      }
    }
    return fired;
  }
}

export const calendarService = new CalendarService();
