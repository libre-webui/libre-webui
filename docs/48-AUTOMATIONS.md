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
optional model (empty means Auto: your default chat model at run time), a
run target, and a notification preference (in-app or off). The target
decides what a run produces: **Chat session** (the default) queues the
instructions as a conversation, while **Work task** launches an isolated
[Work](./33-WORKSPACES.md) sandbox with the instructions as its opening message,
optionally under a named Work policy chosen in the form. With notifications on, a failed
run also lands in the [notification inbox](./55-NOTIFICATIONS.md), so
failures reach you even when the Automations page is closed. Names and
instructions are encrypted at rest. Every automation belongs to the user
who created it.

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

Work-target runs behave the same way with the Work lifecycle in place of the
chat job: the run records the task it created (the Runs tab links straight
to it), succeeds when the agent completes — or stops to ask for input — and
fails when the task fails or is cancelled. Work access is enforced when the
schedule fires, so revoking a user's Work access also silences their
Work-target automations; the run then fails as `work-access-denied` rather
than silently skipping. A selected policy is validated when the automation
is saved, and its network default and resource limits apply to every task
the automation launches. Only direct model providers run in Work, and the
model must support tools — the same rules as the Work composer.

### Agent routines

A Work-target automation can instead bind to an **existing** Work task via
`workTaskId` — the shape behind the Routines section on an
[agent's detail panel](./33-WORKSPACES.md). A bound routine does not create a
new task per fire: each occurrence starts a run inside that task's own
workspace and conversation, using the task's model, provider, and runtime
policy, so the automation-level model and policy fields do not apply and any
supplied policy is dropped at save time. The binding is validated when the
automation is saved (the task must exist and belong to the caller). At fire
time, a deleted task fails the run as `work-task-missing`, and a task that is
already running — or holding a live preview — fails the occurrence honestly
as `work-task-busy` instead of queueing behind it.

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
