---
sidebar_position: 54
title: 'Channels'
description: 'Team channels with threads, reactions, files, and @model replies.'
slug: /CHANNELS
keywords: [channels, team chat, threads, reactions, mentions, direct messages]
---

# Channels

Channels bring team conversations into Libre WebUI: public and private
rooms plus direct messages, with threads, reactions, pins, unread
tracking, file attachments, and `@model` replies — all on the same
durable, encrypted foundations as chat.

## Channel types and membership

| Type      | Who can see it            | Who joins                                    |
| --------- | ------------------------- | -------------------------------------------- |
| `public`  | Everyone can browse it    | Anyone joins themselves                      |
| `private` | Members only              | The owner invites members                    |
| `dm`      | The two participants only | Opened automatically; always exactly two     |

Membership is the only authority over channel content: every read and
write — including attachment downloads and live event delivery — checks
the caller's membership first, and non-members receive a non-enumerating
404. The global administrator role deliberately confers no access to
channel content.

The creator of a public or private channel is its owner. Owners rename,
archive, invite (private), remove members, moderate messages, and delete
the channel; an owner leaves by deleting the channel, never by abandoning
it. Direct messages are deduplicated per pair: opening a DM with the same
person always lands in the same conversation.

## The timeline

Messages form a persistent, ordered timeline that is read with keyset
cursors (`created_at` plus message id) in either direction, so paging
never skips or duplicates entries.

- **Idempotent posts.** The client supplies the message identity; a
  retried request lands on the same timeline entry exactly once.
- **Tombstoned deletion.** Deleting a message clears its content but keeps
  the timeline entry, so threads never dangle and ordering never shifts.
  Authors delete their own messages; channel owners may moderate any.
- **Edits** are author-only and carry an `editedAt` marker.
- **Threads are one level deep.** Any root message can host a thread;
  replies to replies are rejected. Root messages carry live reply counts.
- **Reactions** are per-user per-emoji, counted without duplicates.
- **Pins** are member-curated and listed per channel.

Channel names, descriptions, and message content are encrypted at rest
with the same boundary as chat messages.

## Unread state

Each membership carries a monotonic read cursor. Unread counts are
computed server-side per channel (your own messages are never unread) and
`POST /api/channels/:channelId/read` advances the cursor — it never moves
backwards, so a stale client cannot resurrect read messages.

## Real-time delivery

Every timeline mutation is appended to the durable event stream
`channel:<id>` and fans out over
`GET /api/channels/:channelId/events` (SSE). Membership is re-checked
before every delivery, so removing a member fails their live stream
closed. The SQL timeline remains authoritative: a subscriber that missed
events simply re-reads the timeline — the ledger is delivery, not truth.

## Attachments

Files upload first (`POST /api/channels/:channelId/attachments`), park
briefly in a shared claim cache, and attach when the message posts; an
upload claim is single-use and expires unclaimed after 15 minutes. Blob
bytes belong to the uploader (their quota), and downloads re-check channel
membership on every request.

## `@model` replies

The composer can direct a message at a model. The reply appears
immediately as a pending model-authored message and completes through a
durable job that runs **strictly under the invoking member's identity**:
their model access, their provider credentials, their routing — never the
channel owner's or another member's. A member who is removed while a
mention is queued cannot keep it alive: the job re-checks membership
before generating and records a visible failure instead. Model failures
surface on the reply itself rather than disappearing into a queue.

Model replies use the recent channel conversation (up to 30 messages) as
context. They run as one-shot completions: chat tools, knowledge
retrieval, and web search are not wired into channel mentions yet.

## Limits

| Limit                    | Value  |
| ------------------------ | ------ |
| Channels created per user | 50     |
| Members per channel       | 200    |
| Messages per channel      | 50,000 |
| Message length            | 8,000 characters |
| Attachments per message   | 5 × 10 MB |
| Reactions per message     | 200    |

## Boundaries

- Presence indicators and typing state are not implemented.
- Channel content export and retention policies follow the instance
  backup story; there is no per-channel export yet.
- Mentions notify through the in-app notification service; there is no
  per-channel notification preference yet beyond leaving the channel.
