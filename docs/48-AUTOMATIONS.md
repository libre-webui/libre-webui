---
sidebar_position: 48
title: 'Automations'
description: 'Scheduled AI tasks whose runs land in normal chat sessions.'
slug: /AUTOMATIONS
keywords: [automations, scheduled tasks, triggers, recurring, runs, digest]
---

# Automations

Automations run an instruction on a schedule and deliver the result as a
normal chat session. A daily news digest, a weekly review, a monthly report:
each run executes headlessly on the server, lands in your chat list, and can
be opened and continued like any other conversation.

## Anatomy

An automation has a name, free-text instructions, one or more triggers, an
optional model (empty means Auto: your default chat model at run time), and a
notification preference (in-app or off). Names and instructions are encrypted
at rest. Every automation belongs to the user who created it.

Triggers reuse the calendar's shared model — `once`, `hourly`, `daily`,
`weekly`, `monthly`, `yearly` — and an automation may hold up to five. The
next run is always the earliest upcoming occurrence across its triggers,
computed in the server's local timezone.

## Execution

A scheduler tick runs every minute behind a coordination lease, so exactly
one replica advances schedules. When an automation is due, the tick records a
run, enqueues a durable `automation.run.v1` job, and advances `next_run_at`
with a compare-and-set so each occurrence fires at most once. The job creates
a chat session titled after the automation, then queues the instruction
through the same durable chat-generation pipeline every conversation uses —
provider routing, persona defaults, and persistence included.

If the server was down when an occurrence passed, the next tick fires that
occurrence once and skips any older missed slots. Pausing an automation
clears its schedule; resuming or editing recomputes it from now. Deleting an
automation removes its run history through a foreign-key cascade.

Runs settle from the durable job ledger: succeeded when the chat generation
finished, failed when either job dead-lettered, and failed as `stalled` when
a queued run never started within 30 minutes.

## API

All endpoints require authentication and operate only on the caller's own
automations.

| Method   | Path                                     | Purpose                       |
| -------- | ---------------------------------------- | ----------------------------- |
| `GET`    | `/api/automations`                       | List automations              |
| `POST`   | `/api/automations`                       | Create an automation          |
| `GET`    | `/api/automations/occurrences?from=&to=` | Upcoming computed occurrences |
| `GET`    | `/api/automations/runs`                  | Run history (filterable)      |
| `GET`    | `/api/automations/runs/summary`          | Unseen count + 30-day buckets |
| `POST`   | `/api/automations/runs/seen`             | Mark finished runs as seen    |
| `GET`    | `/api/automations/:automationId`         | Read one automation           |
| `PUT`    | `/api/automations/:automationId`         | Update an automation          |
| `DELETE` | `/api/automations/:automationId`         | Delete an automation          |
| `POST`   | `/api/automations/:automationId/pause`   | Pause the schedule            |
| `POST`   | `/api/automations/:automationId/resume`  | Resume the schedule           |
| `POST`   | `/api/automations/:automationId/run`     | Run now (202 with a run id)   |

A user may keep up to 50 automations; names are limited to 200 characters and
instructions to 20,000.
