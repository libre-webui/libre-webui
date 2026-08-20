# Notifications

Libre WebUI keeps a durable, per-user notification inbox so team activity
— mentions, direct messages, shares, automation failures, and calendar
reminders — reaches people even when the relevant page is closed.

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

| Type                | Produced when                                                    |
| ------------------- | ---------------------------------------------------------------- |
| `channel-dm`        | Someone sends you a direct message                               |
| `channel-mention`   | Someone `@mentions` you in a channel, or replies to your message |
| `channel-invite`    | You are added to a channel                                       |
| `share`             | Someone shares a resource with you                               |
| `automation-failed` | One of your automations fails (unless it opted out)              |
| `calendar-reminder` | An event with a reminder offset reaches its reminder time        |
| `system`            | Instance-level announcements                                     |

Notifications are always published to the affected user only; a mention
of a username that is not a member of the channel produces nothing.

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

## Boundaries

- Browser push and service-worker notifications wait for the PWA phase;
  delivery today is in-app (live SSE plus the bell) and webhooks.
- Per-type user preferences are not implemented yet; automations honor
  their own notify setting, and leaving a channel stops its
  notifications.
