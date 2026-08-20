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
 * Minimal, dependency-free iCalendar (RFC 5545) support for calendar
 * import/export. The exporter emits UTC timestamps and maps the native
 * recurrence union onto basic RRULEs; the importer accepts the common
 * subset (UTC or floating DTSTART/DTEND, DATE values, simple FREQ rules)
 * and reports what it skipped rather than guessing. Interval, COUNT,
 * UNTIL, and EXDATE are deliberately out of scope for now.
 */

import type { AutomationTrigger, CalendarEvent } from '../types/index.js';

const pad = (value: number, width = 2): string =>
  String(value).padStart(width, '0');

const toUtcStamp = (epochMs: number): string => {
  const date = new Date(epochMs);
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}` +
    `${pad(date.getUTCDate())}T${pad(date.getUTCHours())}` +
    `${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
  );
};

const toDateStamp = (epochMs: number): string => {
  const date = new Date(epochMs);
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
};

const escapeText = (value: string): string =>
  value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');

const unescapeText = (value: string): string =>
  value
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');

/** RFC 5545 line folding at 75 octets. */
const foldLine = (line: string): string => {
  if (Buffer.byteLength(line, 'utf8') <= 75) return line;
  const parts: string[] = [];
  let current = '';
  for (const character of line) {
    if (Buffer.byteLength(current + character, 'utf8') > 74) {
      parts.push(current);
      current = character;
    } else {
      current += character;
    }
  }
  if (current) parts.push(current);
  return parts.join('\r\n ');
};

const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const;

const recurrenceToRrule = (
  recurrence: AutomationTrigger
): string | undefined => {
  switch (recurrence.kind) {
    case 'once':
      return undefined;
    case 'hourly':
      return 'FREQ=HOURLY';
    case 'daily':
      return 'FREQ=DAILY';
    case 'weekly':
      return `FREQ=WEEKLY;BYDAY=${WEEKDAYS[recurrence.dayOfWeek] ?? 'MO'}`;
    case 'monthly':
      return `FREQ=MONTHLY;BYMONTHDAY=${recurrence.dayOfMonth}`;
    case 'yearly':
      return (
        `FREQ=YEARLY;BYMONTH=${recurrence.month + 1};` +
        `BYMONTHDAY=${recurrence.dayOfMonth}`
      );
  }
};

/**
 * Maps a simple RRULE back onto the native recurrence union using the
 * event's own start for the time-of-day fields. Unsupported rules return
 * undefined so the caller can import the event without recurrence.
 */
const rruleToRecurrence = (
  rrule: string,
  startAt: number
): AutomationTrigger | undefined => {
  const fields = new Map<string, string>();
  for (const part of rrule.split(';')) {
    const separator = part.indexOf('=');
    if (separator > 0) {
      fields.set(
        part.slice(0, separator).toUpperCase(),
        part.slice(separator + 1).toUpperCase()
      );
    }
  }
  // Interval/count/until change occurrence math; refuse rather than drift.
  if (
    (fields.has('INTERVAL') && fields.get('INTERVAL') !== '1') ||
    fields.has('COUNT') ||
    fields.has('UNTIL')
  ) {
    return undefined;
  }
  const start = new Date(startAt);
  const hour = start.getHours();
  const minute = start.getMinutes();
  switch (fields.get('FREQ')) {
    case 'HOURLY':
      return { kind: 'hourly', minute };
    case 'DAILY':
      return { kind: 'daily', hour, minute };
    case 'WEEKLY': {
      const byDay = fields.get('BYDAY');
      const dayOfWeek = byDay
        ? WEEKDAYS.indexOf(byDay.slice(0, 2) as (typeof WEEKDAYS)[number])
        : start.getDay();
      if (byDay && (byDay.includes(',') || dayOfWeek === -1)) return undefined;
      return {
        kind: 'weekly',
        dayOfWeek: dayOfWeek === -1 ? start.getDay() : dayOfWeek,
        hour,
        minute,
      };
    }
    case 'MONTHLY': {
      const dayOfMonth = Number(fields.get('BYMONTHDAY') ?? start.getDate());
      if (!Number.isSafeInteger(dayOfMonth) || dayOfMonth < 1) {
        return undefined;
      }
      return { kind: 'monthly', dayOfMonth, hour, minute };
    }
    case 'YEARLY': {
      const month = fields.has('BYMONTH')
        ? Number(fields.get('BYMONTH')) - 1
        : start.getMonth();
      const dayOfMonth = Number(fields.get('BYMONTHDAY') ?? start.getDate());
      if (
        !Number.isSafeInteger(month) ||
        month < 0 ||
        month > 11 ||
        !Number.isSafeInteger(dayOfMonth) ||
        dayOfMonth < 1
      ) {
        return undefined;
      }
      return { kind: 'yearly', month, dayOfMonth, hour, minute };
    }
    default:
      return undefined;
  }
};

export const serializeCalendarToIcs = (
  calendarName: string,
  events: readonly CalendarEvent[]
): string => {
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Libre WebUI//Calendar//EN',
    `X-WR-CALNAME:${escapeText(calendarName)}`,
  ];
  for (const event of events) {
    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${escapeText(event.id)}@libre-webui`);
    lines.push(`DTSTAMP:${toUtcStamp(event.updatedAt)}`);
    if (event.allDay) {
      lines.push(`DTSTART;VALUE=DATE:${toDateStamp(event.startAt)}`);
      if (event.endAt !== undefined) {
        lines.push(`DTEND;VALUE=DATE:${toDateStamp(event.endAt)}`);
      }
    } else {
      lines.push(`DTSTART:${toUtcStamp(event.startAt)}`);
      if (event.endAt !== undefined) {
        lines.push(`DTEND:${toUtcStamp(event.endAt)}`);
      }
    }
    lines.push(`SUMMARY:${escapeText(event.title)}`);
    if (event.notes) {
      lines.push(`DESCRIPTION:${escapeText(event.notes)}`);
    }
    if (event.recurrence) {
      const rrule = recurrenceToRrule(event.recurrence);
      if (rrule) lines.push(`RRULE:${rrule}`);
    }
    if (event.reminderMinutes !== undefined) {
      lines.push('BEGIN:VALARM');
      lines.push('ACTION:DISPLAY');
      lines.push(`TRIGGER:-PT${event.reminderMinutes}M`);
      lines.push('END:VALARM');
    }
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(foldLine).join('\r\n') + '\r\n';
};

export interface ParsedIcsEvent {
  title: string;
  notes?: string;
  startAt: number;
  endAt?: number;
  allDay: boolean;
  recurrence?: AutomationTrigger;
  reminderMinutes?: number;
  /** Property names the parser understood but could not preserve. */
  dropped: string[];
}

export interface IcsParseResult {
  events: ParsedIcsEvent[];
  skipped: number;
}

const parseStamp = (
  raw: string,
  parameters: string
): { epochMs: number; allDay: boolean } | undefined => {
  const isDate = /VALUE=DATE(?:;|$)/i.test(parameters) || /^\d{8}$/.test(raw);
  if (isDate) {
    const match = /^(\d{4})(\d{2})(\d{2})$/.exec(raw);
    if (!match) return undefined;
    return {
      epochMs: new Date(
        Number(match[1]),
        Number(match[2]) - 1,
        Number(match[3])
      ).getTime(),
      allDay: true,
    };
  }
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(raw);
  if (!match) return undefined;
  const [, year, month, day, hour, minute, second, zulu] = match;
  const epochMs = zulu
    ? Date.UTC(
        Number(year),
        Number(month) - 1,
        Number(day),
        Number(hour),
        Number(minute),
        Number(second)
      )
    : new Date(
        Number(year),
        Number(month) - 1,
        Number(day),
        Number(hour),
        Number(minute),
        Number(second)
      ).getTime();
  return { epochMs, allDay: false };
};

const parseAlarmMinutes = (block: string[]): number | undefined => {
  for (const line of block) {
    const match = /^TRIGGER[^:]*:-PT(?:(\d+)H)?(?:(\d+)M)?/i.exec(line);
    if (match) {
      const hours = Number(match[1] ?? 0);
      const minutes = Number(match[2] ?? 0);
      const total = hours * 60 + minutes;
      if (total > 0) return total;
    }
  }
  return undefined;
};

/** Unfold RFC 5545 continuation lines and split into logical lines. */
const logicalLines = (source: string): string[] =>
  source
    .replace(/\r\n[ \t]/g, '')
    .replace(/\n[ \t]/g, '')
    .split(/\r?\n/)
    .filter(Boolean);

export const parseIcsCalendar = (
  source: string,
  maximumEvents: number
): IcsParseResult => {
  const lines = logicalLines(source);
  const events: ParsedIcsEvent[] = [];
  let skipped = 0;
  let index = 0;
  while (index < lines.length) {
    if (lines[index].toUpperCase() !== 'BEGIN:VEVENT') {
      index += 1;
      continue;
    }
    const block: string[] = [];
    index += 1;
    while (
      index < lines.length &&
      lines[index].toUpperCase() !== 'END:VEVENT'
    ) {
      block.push(lines[index]);
      index += 1;
    }
    index += 1;
    if (events.length >= maximumEvents) {
      skipped += 1;
      continue;
    }

    const properties = new Map<string, { parameters: string; value: string }>();
    const alarm: string[] = [];
    let inAlarm = false;
    for (const line of block) {
      const upper = line.toUpperCase();
      if (upper === 'BEGIN:VALARM') {
        inAlarm = true;
        continue;
      }
      if (upper === 'END:VALARM') {
        inAlarm = false;
        continue;
      }
      if (inAlarm) {
        alarm.push(line);
        continue;
      }
      const separator = line.indexOf(':');
      if (separator <= 0) continue;
      const nameAndParameters = line.slice(0, separator);
      const parameterSplit = nameAndParameters.indexOf(';');
      const name = (
        parameterSplit === -1
          ? nameAndParameters
          : nameAndParameters.slice(0, parameterSplit)
      ).toUpperCase();
      const parameters =
        parameterSplit === -1
          ? ''
          : nameAndParameters.slice(parameterSplit + 1);
      if (!properties.has(name)) {
        properties.set(name, { parameters, value: line.slice(separator + 1) });
      }
    }

    const start = properties.get('DTSTART');
    const parsedStart = start
      ? parseStamp(start.value, start.parameters)
      : undefined;
    if (!parsedStart) {
      skipped += 1;
      continue;
    }
    const end = properties.get('DTEND');
    const parsedEnd = end ? parseStamp(end.value, end.parameters) : undefined;
    const dropped: string[] = [];
    let recurrence: AutomationTrigger | undefined;
    const rrule = properties.get('RRULE');
    if (rrule) {
      recurrence = rruleToRecurrence(rrule.value, parsedStart.epochMs);
      if (!recurrence) dropped.push('RRULE');
    }
    if (properties.has('EXDATE')) dropped.push('EXDATE');
    const reminderMinutes = parseAlarmMinutes(alarm);
    events.push({
      title: unescapeText(properties.get('SUMMARY')?.value ?? 'Untitled event'),
      ...(properties.get('DESCRIPTION')
        ? { notes: unescapeText(properties.get('DESCRIPTION')!.value) }
        : {}),
      startAt: parsedStart.epochMs,
      ...(parsedEnd ? { endAt: parsedEnd.epochMs } : {}),
      allDay: parsedStart.allDay,
      ...(recurrence ? { recurrence } : {}),
      ...(reminderMinutes !== undefined ? { reminderMinutes } : {}),
      dropped,
    });
  }
  return { events, skipped };
};
