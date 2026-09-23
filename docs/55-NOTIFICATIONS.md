---
sidebar_position: 55
title: 'Notifications'
description: 'A durable in-app notification inbox with live delivery and signed webhooks.'
slug: /NOTIFICATIONS
keywords: [notifications, inbox, webhooks, mentions, alerts]
---

# Notifications

Libre WebUI keeps a durable, per-user notification inbox so team activity
— mentions, direct messages, shares, automation failures, and calendar
reminders — reaches people even when the relevant page is closed.

## Status popups

Short status messages, such as a saved change or a completed Git operation,
appear near the top of the page. Use the **Close** button to clear a popup
with a pointer or keyboard. Hovering keeps the message visible so you can read
it; closing it dismisses the message while the underlying operation keeps its
current state.

## The inbox

Notifications are database rows first: encrypted title and body at rest,
capped at 500 per user (oldest pruned), and deduplicated by an optional
source key so a repeated publication collapses into one entry instead of
spamming the bell. The RESTful surface lists, counts unread, marks read
(one or all), and deletes.

Live delivery rides the per-user durable event stream `notify:<userId>`
over `GET /api/notifications/events` (SSE). The stream identity comes
from the authenticated session — never from client input — and the SQL
inbox remains the source of truth: a missed event is recovered by
reading the list, not replaying the stream.

## What produces notifications

| Type                 | Produced when                                                    |
| -------------------- | ---------------------------------------------------------------- |
| `channel-dm`         | Someone sends you a direct message                               |
| `channel-mention`    | Someone `@mentions` you in a channel, or replies to your message |
| `channel-invite`     | You are added to a channel                                       |
| `share`              | Someone shares a resource with you                               |
| `automation-failed`  | One of your automations fails (unless it opted out)              |
| `calendar-reminder`  | An event with a reminder offset reaches its reminder time        |
| `work-run-finished`  | One of your hired Work agents completes a run                    |
| `work-run-attention` | A hired agent stops for input or hits an error                   |
| `work-takeover`      | A Work agent asks you to take over its screen                    |
| `work-approval`      | A Work run is waiting for you to approve a side-effecting action |
| `system`             | Instance-level announcements                                     |

Notifications are always published to the affected user only; a mention
of a username that is not a member of the channel produces nothing.

Notifications can also fire automations: an
[automation](./48-AUTOMATIONS.md) with an `event` trigger runs whenever a
notification of the chosen type reaches its owner, bounded by a one-minute
per-automation cooldown.

## Outbound webhooks

Administrators can register webhook targets that receive team events.

- **Egress-guarded.** Targets pass the same destination policy as tool
  servers: exact URL, no redirects, and no private or link-local
  addresses unless the administrator explicitly allowlists a host via
  `TOOLS_PRIVATE_NETWORK_ALLOWLIST`. Hostnames are re-resolved and
  re-checked on every delivery.
- **Signed.** With a configured secret, every delivery carries
  `X-Libre-Signature: sha256=<hmac>` computed over the exact body.
- **Redacted.** The envelope contains the event kind, notification type,
  title, identifiers, and timestamps. Notification bodies, message
  content, prompts, and documents never leave the instance.
- **Durable.** Deliveries run as durable jobs with bounded retries;
  a 5xx from the receiver retries, a 4xx is treated as the receiver's
  verdict and settles.
- **Scoped.** Each target subscribes to specific notification types (or
  `*`).

## Browser push

Settings → Notifications registers this browser for Web Push, so mentions,
shares, reminders, and finished work reach the device even when the tab is
closed. The implementation is standard and self-contained:

- **VAPID (RFC 8292).** The server signs each delivery with an ES256 key
  pair, generated once and stored encrypted, or pinned with
  `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` (`VAPID_SUBJECT` sets the contact
  claim). No third-party push library or service account is involved beyond
  the browser vendor's push endpoint.
- **Encrypted payloads (RFC 8291).** Every message is encrypted to the
  device's own keys with aes128gcm before it leaves the instance; the push
  service relays ciphertext it cannot read.
- **Per device, session-bound.** A subscription belongs to the browser that
  created it and to that browser's auth session: signing the session out
  (or "sign out other sessions") also removes its push registration.
  Endpoints are stored encrypted with a keyed lookup token, and must be
  public HTTPS destinations — the same egress hygiene as webhooks.
- **Durable.** Push deliveries run as durable jobs with bounded retries; a
  push service reporting the subscription gone (404/410) removes it.
- The payload carries the notification title, optional body, type, and
  target link — the same redaction posture as the inbox.

Push requires the production app (the service worker registers only there)
and a secure origin. The offline shell and installability come from the same
service worker: the app manifest makes Libre WebUI installable, navigations
fall back to the cached shell when offline, and hashed build assets are
cached immutably. API traffic is never cached.

## Email

Email is the third delivery channel, and the only one that needs setup by an
administrator. **Settings → User Management → Access & policies → Email
notifications** holds one outgoing SMTP server: host, port, connection
security (STARTTLS, implicit TLS, or none for a trusted network), optional
credentials, the sender address, and the public URL used for links. The
`SMTP_*` environment variables in
[Environment Variables](./26-ENVIRONMENT_VARIABLES.md) seed the same fields
for container deployments; a value saved in the UI takes precedence. The
password is stored encrypted and never returned to the browser. **Send
test** delivers a message to the administrator's own address (or any address
typed in) so the round trip is proven before users rely on it.

Once the switch is on, each user chooses what reaches their inbox under
**Settings → Notifications → Email notifications**:

- **Channel mentions:** a message that mentions you in a channel, with the
  preview and a link to the channel.
- **Automation results:** the outcome of each of your automation runs,
  success or failure. A chat run carries the assistant's reply itself (up
  to a few thousand characters); a Work run carries the task's status line;
  a failure carries the error. The link opens the resulting chat or task.

Both switches stay off until the user turns them on, and they only work for
accounts that have an email address, which the account holder sets at
sign-up or an administrator adds under Users. Messages leave through the
same durable job runtime as Web Push, with bounded retries for transient
relay failures, and the SMTP client is a small built-in implementation
(EHLO, STARTTLS, AUTH PLAIN or LOGIN) that never sends credentials over an
unencrypted connection unless the mode is explicitly `none`. Every message
has a plain-text part and an HTML alternative in the website's look: the
Libre WebUI wordmark, one card with the content, a coral button to the
target, and a footer pointing back to Settings → Notifications. An
automation result is rendered from Markdown (headings, lists, emphasis,
code, links to http(s) targets only); everything else is escaped, and the
only external image is the logo served from librewebui.org. No tracking.

## Boundaries

- Per-type user preferences are not implemented yet; automations honor
  their own notify setting, and leaving a channel stops its
  notifications.
