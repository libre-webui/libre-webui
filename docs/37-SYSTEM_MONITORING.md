---
sidebar_position: 37
title: 'System Diagnostics & Usage Analytics'
description: 'Administrator-only System and Usage pages for live host diagnostics and model/provider usage metering.'
slug: /SYSTEM_MONITORING
keywords:
  [
    libre webui system diagnostics,
    usage analytics,
    model usage,
    provider metering,
    admin monitoring,
    docker status,
  ]
---

# System Diagnostics & Usage Analytics

Libre WebUI gives administrators two live views of the instance: a **System**
page with host and runtime diagnostics, and a **Usage** page with model and
provider usage analytics. Both are administrator-only in the backend and the
interface. Reading either page stays inside the deployment; optional external
telemetry is a separate, operator-configured
[Observability](./60-OBSERVABILITY.md) path.

Reach them from the sidebar admin entries, the tab menu's admin shortcuts, or
directly at `/system` and `/usage`. Non-administrators cannot open either page,
and the admin tabs are closed if a signed-in account loses the `admin` role.

## System Diagnostics

The System page (`/system`) reports:

- **Host**: hostname, platform, kernel release, architecture, uptime, logical
  CPU count, CPU model, load average, and whether the process looks
  containerized. There is no CPU utilization percentage; CPU load is the load
  average only.
- **Runtime**: application version, Node.js version, process id, process
  uptime, and working directory.
- **Memory**: total, free, and used host memory, plus the process RSS and heap
  figures.
- **Filesystems**: capacity and usage for the runtime filesystem (`/`) and the
  data directory (`DATA_DIR`).
- **Network**: interface names and addresses, with received/transmitted byte
  counters on Linux.
- **Docker**: engine version, host OS, kernel, CPU and memory as the engine
  reports them, and container counts plus a reduced container list, when the
  Docker socket is available.

The page refreshes every 30 seconds while its tab is focused and has a manual
refresh button. The backend endpoint is `GET /api/system`, guarded by
authentication, an active administrator role, and a per-user rate limit of 120
requests per 15 minutes. Responses are never cached (`Cache-Control:
no-store`), and every request collects fresh values.

### Docker socket dependency

The Docker section resolves its endpoint the same way the Work runtime and
interactive terminal do: `WORK_DOCKER_SOCKET` when set (always a local Unix
socket path), otherwise `DOCKER_HOST` — a `unix://` URL or a plain-HTTP
`tcp://` endpoint such as a filtered Docker API proxy — otherwise
`/var/run/docker.sock`. `ssh://` and `npipe://` endpoints, and `tcp://`
with TLS verification enabled, are deliberately not queried. The requests are strictly read-only engine `GET`s
(version, info, container list) with a 4-second timeout and a bounded response
size, and the container list is capped at 100 entries.

Without a usable socket the rest of the page still works: the Docker panel
reports why it is unavailable — socket not mounted, mounted but unreadable,
daemon unreachable, or remote endpoint — instead of failing the whole request.

### What the page reveals, and to whom

The container list is reduced on purpose: short id, name, image, state, and
created time. Environment variables, labels, mounts, container commands, and
inspect payloads are never included, and no credentials appear anywhere in the
response.

The page still shows real infrastructure detail — hostname, working directory,
internal IP addresses, and the names and images of every container on the
Docker host, not only Libre WebUI's own. That is consistent with the trust
model: in a Docker deployment every Libre WebUI administrator is already
effectively a host administrator (see [Docker](./DOCKER)). Grant the `admin`
role accordingly.

## Usage Analytics

The Usage page (`/usage`) charts user-attributed model and provider work.
Metering happens at each supported execution boundary and currently covers:

- local Ollama chat calls, including native Chat and Ollama-backed Work calls;
- installed agent CLI chat calls;
- plugin-backed chat, streaming and non-streaming;
- plugin embeddings, image generation, speech to text, text to speech, sound,
  and video; and
- plugin-backed Work calls.

Background operations without an owning user are deliberately not assigned to a
synthetic account and therefore are not metered. A call is still recorded when
it fails or is cancelled.

Each event records:

- provider/plugin id and a snapshot of its display name (`ollama` and
  `agent-cli:*` use the same ledger as plugin providers)
- capability (`chat`, `embedding`, `image`, `stt`, `tts`, `audio`, `video`)
- model
- status: `success`, `error`, or `cancelled` (an aborted stream counts as
  cancelled)
- token counts, only when the provider returned usage metadata
- unit counters appropriate to the capability (characters for TTS, images,
  embedding inputs, jobs for video, bytes for audio)
- end-to-end duration and a timestamp
- the requesting user id

Nothing else is stored. **Prompts, responses, provider endpoints, credentials,
and provider error bodies are never written to the usage table** — a failed
call is recorded only as `status = 'error'`. The events live in the selected
application database (SQLite in solo mode, PostgreSQL in team mode) and are kept
for **400 days**; older rows are pruned opportunistically on write, at most once
per day. Metering is best-effort by design and can never make a model or
provider request fail.

The page offers 7, 30, and 90-day ranges over a single admin-only endpoint,
`GET /api/plugins/usage?days=<1..365>` (default 30). It shows total calls,
reported tokens, success rate, average latency, and the share of calls that
reported token usage. Reading the page is read-only and uses the deployment's
existing usage ledger.

### Explore models and providers

Model colors connect the daily chart, yearly activity calendar, model table,
and provider bars. Model names, values, and selection indicators accompany the
colors. The activity calendar always covers the last 365 days, independently
of the selected range; each day's color identifies its most-used model.

The daily chart switches between **Calls** and **Tokens**. Hover over a model
in its legend or move keyboard focus to it to trace that model's line. Select
the model to keep it highlighted, select it again to release it, or choose
**Show all models** to reset. The model table also provides a highlight action.
Highlighting changes emphasis while preserving the daily totals, table values,
and provider totals.

Move the pointer across the chart or use **Explore daily usage** to inspect a
day's total and model breakdown. The daily slider supports keyboard navigation:
arrow keys move between days, and Home/End reach the first/last day. Daily
buckets and their labels use UTC.

By default, the chart shows the top 12 model names by call count in the selected
period, including when viewing tokens. Every model remains individually
inspectable: focus or select a model in the table or provider details to load
its exact daily line, even when it is outside those 12. A loading message names
the requested model while its history is fetched.

An additional model's line is separated from **Other models**, and the
remaining group excludes its calls, reported tokens, and failures. The chart
contains at most 13 named model lines plus the remaining group, and their daily
values still reconcile to the same totals. Choose **Show all models** to return
to the default view.

Daily lines combine calls with the same recorded model name across providers.
The model table retains separate provider/model entries, so the same model can
appear under more than one provider. Named models retain individual colors in
the table and provider bars, including models outside the default chart.

Provider details show each provider's share of requests, a bar divided by
model, reported tokens, failed or cancelled calls, and average response time.
The capability mix remains available below the model and provider breakdowns.

Token totals include only calls where the provider reported usage metadata.
The coverage percentage makes partial reporting visible; missing token counts
are never estimated from requests or from another model. A period with no
reported tokens shows an explanation in the Tokens view, and its request
history remains available in Calls.

The endpoint includes daily model points in `modelSeries`. An optional `model`
query parameter requests one exact recorded model name alongside the default
top 12, for example `GET /api/plugins/usage?days=30&model=<encoded-model-name>`.
This is the same administrator-only, read-only endpoint: it queries the local
usage ledger and never calls a model provider to retrieve history.

An optional `to` parameter fixes the request's end boundary to a Unix timestamp
in milliseconds. It requires `model` and accepts only a non-negative safe
integer no later than the server's current time. The browser sends the
overview's `range.to` when loading an individual model, preserving its UTC day
and year boundaries and excluding calls after that timestamp. Without `to`,
the endpoint uses the current time.

Loading a model keeps the overview's cards, table, provider totals, and colors
in place. Its daily line is added only when the response's time bounds and
daily totals match that overview. The time boundary does not freeze the
database: if historical backfills or deletions change those totals, the browser
refreshes the overview before showing the model line.

If an older server omits `modelSeries`, the chart shows the aggregate **All
models** series with an explanation that the model breakdown is unavailable.
The model table remains available; the browser does not infer daily model
history from period totals or the yearly calendar.

There is no switch to disable metering. Because the data is aggregated across
accounts, inspecting it is restricted to administrators.

The Usage page reports calls, units, tokens, latency, and outcomes. Add
[Cost Governance](./58-COST_GOVERNANCE.md) when those events need
effective-dated tariffs, spend breakdowns, budgets, alerts, or accounting
export. Events without a matching tariff or provider-reported usage remain
visibly unpriced rather than being treated as free.

### OpenRouter attribution

Since 0.18.0, requests to OpenRouter identify the application through
OpenRouter's app-attribution headers (`HTTP-Referer: https://librewebui.org`,
an application title, and category hints). These headers are sent only when the
request goes to `https://openrouter.ai` itself — never to a custom or
self-hosted route — and they add nothing to what is stored locally.

## Related Docs

- [Authentication](./AUTHENTICATION)
- [Docker](./DOCKER)
- [Plugin Architecture](./PLUGIN_ARCHITECTURE)
- [Environment Variables](./ENVIRONMENT_VARIABLES)
- [Cost Governance](./58-COST_GOVERNANCE.md)
- [Observability](./60-OBSERVABILITY.md)
