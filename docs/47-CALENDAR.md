---
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

## API

All endpoints require authentication and operate only on the caller's own
events.

| Method   | Path                             | Purpose                                |
| -------- | -------------------------------- | -------------------------------------- |
| `GET`    | `/api/calendar/events?from=&to=` | Events in a range, recurrence expanded |
| `POST`   | `/api/calendar/events`           | Create an event                        |
| `PUT`    | `/api/calendar/events/:eventId`  | Update an event                        |
| `DELETE` | `/api/calendar/events/:eventId`  | Delete an event                        |

Range queries take epoch-millisecond `from`/`to` bounds and span at most 13
months per request. A user may store up to 2000 events; titles are limited to
200 characters and notes to 10,000.
