---
sidebar_position: 47
title: 'Calendar'
description: 'A personal calendar with one-off and recurring events.'
slug: /CALENDAR
keywords: [calendar, events, schedule, recurrence, month view, week view]
---

# Calendar

Libre WebUI includes a personal calendar. Every signed-in user gets their own
month and week views with one-off and recurring events, and scheduled
automations project their upcoming occurrences and run history onto the same
grid.

## Events

An event has a title, optional notes, a start time, an optional end time, an
all-day flag, and an optional recurrence rule. Titles and notes are encrypted
at rest with the same envelope used for chats and notes.

Recurrence uses the shared trigger model:

| Kind      | Fields                                  | Meaning                        |
| --------- | --------------------------------------- | ------------------------------ |
| `once`    | `at`                                    | A single occurrence            |
| `hourly`  | `minute`, `startHour?`, `endHour?`      | Every hour within a window     |
| `daily`   | `hour`, `minute`                        | Every day at a wall-clock time |
| `weekly`  | `dayOfWeek`, `hour`, `minute`           | Every week on a chosen day     |
| `monthly` | `dayOfMonth`, `hour`, `minute`          | Every month on a chosen day    |
| `yearly`  | `month`, `dayOfMonth`, `hour`, `minute` | Every year on a chosen date    |

Recurring events are stored once. Range queries expand them server-side:
each projected occurrence carries a `baseEventId` pointing back to its source
event, so editing the source updates every future occurrence. A `dayOfMonth`
past the end of a month clamps to that month's last day. All recurrence math
uses the server's local timezone.

## Named calendars and sharing

Beyond the default personal scope, a user can create up to 20 named
calendars, each with an optional display color. Events carry an optional
`calendarId`; events without one live in the default scope, which stays
private.

Enter a name in **New calendar…** and choose **Save**, or press Enter, to
create a named calendar. Calendar view and event controls wrap on narrow
screens so they remain reachable alongside the navigation rail.

Named calendars share through the common grant model: a `read` grant lets
the recipient see the calendar and its events alongside their own, and a
`write` grant additionally lets them create and edit events in it. Events
created by a collaborator are stored under the **calendar owner's**
account, so quotas, deletion, and the portable archive stay owner-scoped.
Access is re-authorized on every request; revoking a grant hides the
calendar on the next read. Deleting a calendar detaches its events back to
the owner's default scope and removes its grants.

## Reminders

An event can carry a reminder offset (`reminderMinutes`, up to 14 days).
The automation scheduler's leased tick sweeps due reminders and publishes
a `calendar-reminder` notification to the event owner's inbox; a
per-occurrence compare-and-set guarantees each occurrence never re-fires,
including for recurring events.

## ICS import and export

`GET /api/calendar/export?calendarId=` downloads a calendar (or the
default scope) as an RFC 5545 `.ics` file: UTC timestamps, escaped text,
basic `RRULE`s mapped from the native recurrence kinds, and `VALARM`
blocks for reminders. `POST /api/calendar/import` accepts an ICS payload
(up to 2 MB / 1,000 events) into a writable calendar scope. The importer
handles UTC and floating times, all-day `DATE` values, and simple `FREQ`
rules; rules it cannot represent faithfully (`INTERVAL`, `COUNT`,
`UNTIL`, `EXDATE`) import the event without recurrence and are counted in
the response as dropped rules rather than silently drifting.

## Model access

Three built-in chat tools give models calendar access under the invoking
user's identity: `list_calendar_events` (read-only),
`create_calendar_event`, and `delete_calendar_event` (both side-effecting
and therefore behind the standard tool-approval flow).

## API

All endpoints require authentication. Event reads cover the caller's own
events plus calendars shared with them; writes require ownership or a
write grant on the target calendar.

| Method   | Path                              | Purpose                                |
| -------- | --------------------------------- | -------------------------------------- |
| `GET`    | `/api/calendar/events?from=&to=`  | Events in a range, recurrence expanded |
| `POST`   | `/api/calendar/events`            | Create an event                        |
| `PUT`    | `/api/calendar/events/:eventId`   | Update an event                        |
| `DELETE` | `/api/calendar/events/:eventId`   | Delete an event                        |
| `GET`    | `/api/calendar/calendars`         | Own and shared named calendars         |
| `POST`   | `/api/calendar/calendars`         | Create a named calendar                |
| `PUT`    | `/api/calendar/calendars/:id`     | Rename or recolor a calendar           |
| `DELETE` | `/api/calendar/calendars/:id`     | Delete a calendar (events detach)      |
| `GET`    | `/api/calendar/export`            | ICS export                             |
| `POST`   | `/api/calendar/import`            | ICS import                             |

Range queries take epoch-millisecond `from`/`to` bounds and span at most 13
months per request. A user may store up to 2000 events; titles are limited to
200 characters and notes to 10,000.
