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
 * Recurrence math for calendar events and automations. All computation uses
 * the server's local timezone; wall-clock trigger times stay stable across
 * DST because candidates are built from local date components, which the
 * Date constructor renormalizes.
 */

import type { AutomationTrigger } from '../types/index.js';

const DAY_MS = 24 * 60 * 60 * 1000;

const TRIGGER_KINDS = [
  'once',
  'hourly',
  'daily',
  'weekly',
  'monthly',
  'yearly',
] as const;

const isInt = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' &&
  Number.isSafeInteger(value) &&
  value >= min &&
  value <= max;

export class InvalidTriggerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidTriggerError';
  }
}

/** Validate untrusted input into a well-formed trigger list. */
export function validateTriggers(
  value: unknown,
  maximum = 5
): AutomationTrigger[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new InvalidTriggerError('At least one trigger is required');
  }
  if (value.length > maximum) {
    throw new InvalidTriggerError(`At most ${maximum} triggers are allowed`);
  }
  return value.map(item => {
    if (typeof item !== 'object' || item === null) {
      throw new InvalidTriggerError('Each trigger must be an object');
    }
    const trigger = item as Record<string, unknown>;
    switch (trigger.kind) {
      case 'once': {
        if (!isInt(trigger.at, 0, 8.64e15)) {
          throw new InvalidTriggerError(
            'A once trigger needs an epoch-ms "at" time'
          );
        }
        return { kind: 'once', at: trigger.at };
      }
      case 'hourly': {
        if (!isInt(trigger.minute, 0, 59)) {
          throw new InvalidTriggerError(
            'An hourly trigger needs a minute between 0 and 59'
          );
        }
        const bounds: { startHour?: number; endHour?: number } = {};
        if (trigger.startHour !== undefined) {
          if (!isInt(trigger.startHour, 0, 23)) {
            throw new InvalidTriggerError('startHour must be 0-23');
          }
          bounds.startHour = trigger.startHour;
        }
        if (trigger.endHour !== undefined) {
          if (!isInt(trigger.endHour, 0, 23)) {
            throw new InvalidTriggerError('endHour must be 0-23');
          }
          bounds.endHour = trigger.endHour;
        }
        if (
          bounds.startHour !== undefined &&
          bounds.endHour !== undefined &&
          bounds.endHour < bounds.startHour
        ) {
          throw new InvalidTriggerError('endHour must not precede startHour');
        }
        return { kind: 'hourly', minute: trigger.minute, ...bounds };
      }
      case 'daily': {
        if (!isInt(trigger.hour, 0, 23) || !isInt(trigger.minute, 0, 59)) {
          throw new InvalidTriggerError(
            'A daily trigger needs an hour (0-23) and minute (0-59)'
          );
        }
        return { kind: 'daily', hour: trigger.hour, minute: trigger.minute };
      }
      case 'weekly': {
        if (
          !isInt(trigger.dayOfWeek, 0, 6) ||
          !isInt(trigger.hour, 0, 23) ||
          !isInt(trigger.minute, 0, 59)
        ) {
          throw new InvalidTriggerError(
            'A weekly trigger needs dayOfWeek (0-6), hour, and minute'
          );
        }
        return {
          kind: 'weekly',
          dayOfWeek: trigger.dayOfWeek,
          hour: trigger.hour,
          minute: trigger.minute,
        };
      }
      case 'monthly': {
        if (
          !isInt(trigger.dayOfMonth, 1, 31) ||
          !isInt(trigger.hour, 0, 23) ||
          !isInt(trigger.minute, 0, 59)
        ) {
          throw new InvalidTriggerError(
            'A monthly trigger needs dayOfMonth (1-31), hour, and minute'
          );
        }
        return {
          kind: 'monthly',
          dayOfMonth: trigger.dayOfMonth,
          hour: trigger.hour,
          minute: trigger.minute,
        };
      }
      case 'yearly': {
        if (
          !isInt(trigger.month, 1, 12) ||
          !isInt(trigger.dayOfMonth, 1, 31) ||
          !isInt(trigger.hour, 0, 23) ||
          !isInt(trigger.minute, 0, 59)
        ) {
          throw new InvalidTriggerError(
            'A yearly trigger needs month (1-12), dayOfMonth, hour, and minute'
          );
        }
        return {
          kind: 'yearly',
          month: trigger.month,
          dayOfMonth: trigger.dayOfMonth,
          hour: trigger.hour,
          minute: trigger.minute,
        };
      }
      default:
        throw new InvalidTriggerError(
          `Unknown trigger kind; expected one of ${TRIGGER_KINDS.join(', ')}`
        );
    }
  });
}

const daysInMonth = (year: number, monthIndex: number): number =>
  new Date(year, monthIndex + 1, 0).getDate();

const atLocalTime = (
  base: Date,
  dayOffset: number,
  hour: number,
  minute: number
): number =>
  new Date(
    base.getFullYear(),
    base.getMonth(),
    base.getDate() + dayOffset,
    hour,
    minute,
    0,
    0
  ).getTime();

/**
 * The first occurrence of a trigger strictly after `after`, or null when the
 * trigger is exhausted. The strictly-after invariant is what prevents a fired
 * occurrence from firing again.
 */
export function nextOccurrence(
  trigger: AutomationTrigger,
  after: number
): number | null {
  const base = new Date(after);
  switch (trigger.kind) {
    case 'once':
      return trigger.at > after ? trigger.at : null;
    case 'hourly': {
      const start = trigger.startHour ?? 0;
      const end = trigger.endHour ?? 23;
      for (let offset = 0; offset <= 1; offset += 1) {
        const day = new Date(after + offset * DAY_MS);
        const firstHour = offset === 0 ? 0 : start;
        for (let hour = firstHour; hour <= 23; hour += 1) {
          if (hour < start || hour > end) continue;
          const candidate = atLocalTime(day, 0, hour, trigger.minute);
          if (candidate > after) return candidate;
        }
      }
      return null;
    }
    case 'daily': {
      for (let offset = 0; offset <= 1; offset += 1) {
        const candidate = atLocalTime(
          base,
          offset,
          trigger.hour,
          trigger.minute
        );
        if (candidate > after) return candidate;
      }
      return null;
    }
    case 'weekly': {
      const todayDow = base.getDay();
      let offset = (trigger.dayOfWeek - todayDow + 7) % 7;
      let candidate = atLocalTime(base, offset, trigger.hour, trigger.minute);
      if (candidate <= after) {
        offset += 7;
        candidate = atLocalTime(base, offset, trigger.hour, trigger.minute);
      }
      return candidate;
    }
    case 'monthly': {
      for (let monthOffset = 0; monthOffset <= 1; monthOffset += 1) {
        const year = base.getFullYear();
        const month = base.getMonth() + monthOffset;
        const day = Math.min(trigger.dayOfMonth, daysInMonth(year, month));
        const candidate = new Date(
          year,
          month,
          day,
          trigger.hour,
          trigger.minute,
          0,
          0
        ).getTime();
        if (candidate > after) return candidate;
      }
      return null;
    }
    case 'yearly': {
      for (let yearOffset = 0; yearOffset <= 1; yearOffset += 1) {
        const year = base.getFullYear() + yearOffset;
        const monthIndex = trigger.month - 1;
        const day = Math.min(trigger.dayOfMonth, daysInMonth(year, monthIndex));
        const candidate = new Date(
          year,
          monthIndex,
          day,
          trigger.hour,
          trigger.minute,
          0,
          0
        ).getTime();
        if (candidate > after) return candidate;
      }
      return null;
    }
  }
}

/** The earliest next occurrence across all triggers, or null when exhausted. */
export function nextRunAt(
  triggers: readonly AutomationTrigger[],
  after: number
): number | null {
  let earliest: number | null = null;
  for (const trigger of triggers) {
    const candidate = nextOccurrence(trigger, after);
    if (candidate !== null && (earliest === null || candidate < earliest)) {
      earliest = candidate;
    }
  }
  return earliest;
}

/**
 * Every occurrence in [from, to), ascending, capped. Used to project
 * recurring calendar events and upcoming automation runs onto a date range.
 */
export function occurrencesBetween(
  triggers: readonly AutomationTrigger[],
  from: number,
  to: number,
  cap = 500
): number[] {
  const occurrences = new Set<number>();
  for (const trigger of triggers) {
    let cursor = from - 1;
    while (occurrences.size < cap) {
      const candidate = nextOccurrence(trigger, cursor);
      if (candidate === null || candidate >= to) break;
      occurrences.add(candidate);
      cursor = candidate;
    }
  }
  return [...occurrences].sort((left, right) => left - right);
}
