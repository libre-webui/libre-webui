---
sidebar_position: 37
title: 'System Diagnostics & Usage Analytics'
description: 'Administrator-only System and Usage pages: live host diagnostics and provider usage metering in Libre WebUI.'
slug: /SYSTEM_MONITORING
keywords:
  [
    libre webui system diagnostics,
    usage analytics,
    provider metering,
    admin monitoring,
    docker status,
  ]
---

# System Diagnostics & Usage Analytics

Libre WebUI 0.18.0 gives administrators two live views of the instance: a
**System** page with host and runtime diagnostics, and a **Usage** page with
provider usage analytics. Both are administrator-only, in the backend and in
the interface, and both read only the instance's own state — nothing is
transmitted off the box.

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

The Docker section works only through a local Unix socket. Libre WebUI uses
`WORK_DOCKER_SOCKET` when set, otherwise `DOCKER_HOST` when it is a `unix://`
URL, otherwise `/var/run/docker.sock`. A remote TCP Docker endpoint is
deliberately not queried. The requests are strictly read-only engine `GET`s
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

The Usage page (`/usage`) charts outbound provider traffic. Metering happens on
the server at the plugin provider boundary, so it covers every plugin-backed
call regardless of which surface made it: chat (streaming and non-streaming),
embeddings, image generation, TTS, audio and video generation, and plugin-backed
Work runs. Requests to local Ollama are not metered.

Each event records:

- plugin id and a snapshot of the plugin name
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
call is recorded only as `status = 'error'`. The events live in the instance's
own SQLite database and are kept for **400 days**; older rows are pruned
opportunistically on write, at most once per day. Metering is best-effort by
design and can never make a provider request fail.

The page offers 7, 30, and 90-day ranges over a single admin-only endpoint,
`GET /api/plugins/usage?days=<1..365>` (default 30). It shows total calls,
reported tokens, success rate, and average latency, a daily chart switchable
between calls and tokens, a per-model table, per-plugin traffic shares, and the
capability mix. Token totals include only calls where the provider reported
usage metadata.

There is no switch to disable metering. Because the data is aggregated across
accounts, inspecting it is restricted to administrators.

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
