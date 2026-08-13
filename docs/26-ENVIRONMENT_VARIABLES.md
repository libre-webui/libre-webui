---
sidebar_position: 26
title: 'Environment Variables'
description: 'Supported backend and frontend environment variables in Libre WebUI.'
slug: /ENVIRONMENT_VARIABLES
keywords:
  [
    libre webui environment variables,
    configuration,
    env,
    docker env,
    kubernetes config,
    api keys,
  ]
---

# Environment Variables

This page lists the supported operator-facing environment variables read by
the current Libre WebUI backend, frontend, and maintenance scripts. Internal
test-only canaries are intentionally omitted.

## Backend Server

| Variable                     | Default                             | Purpose                                                                                       |
| ---------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------- |
| `NODE_ENV`                   | `development`                       | Runtime mode                                                                                  |
| `PORT`                       | `3001` in dev, `8080` in production | Backend HTTP port                                                                             |
| `TRUST_PROXY`                | unset                               | Express trust proxy setting                                                                   |
| `CORS_ORIGIN`                | local dev origins                   | Comma-separated allowed browser origins                                                       |
| `SERVE_FRONTEND`             | unset                               | Serve built frontend from backend when `true`                                                 |
| `DOCKER_ENV`                 | unset                               | Enables Docker-oriented behavior when `true`                                                  |
| `DATA_DIR`                   | `backend/data`                      | Persistent data directory                                                                     |
| `PLATFORM_PREFLIGHT_TMP_DIR` | `backend/temp/preflight`            | Scratch space for a private DB/WAL startup inspection copy; size it for the database plus WAL |
| `PLUGINS_DIR`                | `$DATA_DIR/plugins`                 | Writable directory for installed/customized plugins                                           |
| `BASE_URL`                   | `http://localhost:3001`             | Base URL used for OAuth callback defaults                                                     |
| `LOG_LEVEL`                  | `info` (`warn` in tests)            | Backend log level                                                                             |
| `WEBUI_HOST`                 | loopback; `0.0.0.0` in Docker       | HTTP listen address                                                                           |
| `OPEN_BROWSER`               | `true` when serving the frontend    | Set `false` to suppress automatic browser launch                                              |

The default data path is module-relative, not working-directory-relative, so
root and backend workspace commands use the same `backend/data`. If a database
exists at the historical accidental `backend/backend/data` path while
`DATA_DIR` is unset, startup fails with migration guidance instead of hiding or
copying that data.

## Platform Foundation

The supported profile remains `solo`: SQLite, local encrypted blobs,
embedded vectors, local coordination, an inactive durable-job substrate, and
one application replica. No domain job handler worker is bootstrapped yet. The
selectors for the future shared profile are parsed and validated now, but
PostgreSQL, S3, PGVector, and the external worker fail closed as unavailable in
this release.

| Variable                           | Default                                | Purpose                                                                        |
| ---------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------ |
| `LIBRE_PLATFORM_MODE`              | `solo`                                 | Select `solo` or the fail-closed future `team` profile                         |
| `DATABASE_BACKEND`                 | `sqlite`                               | Select `sqlite` or unavailable `postgres`                                      |
| `DATABASE_URL`                     | unset                                  | PostgreSQL URL; parsed but not usable until its adapter ships                  |
| `BLOB_STORE_BACKEND`               | `local`                                | Select `local` or unavailable `s3`                                             |
| `VECTOR_STORE_BACKEND`             | `embedded` with SQLite                 | Select `embedded` or unavailable `pgvector`                                    |
| `COORDINATION_BACKEND`             | `local` in solo; `redis` in team       | Select process-local or Redis coordination                                     |
| `REDIS_URL`                        | unset                                  | `redis:` or `rediss:` URL, required with Redis coordination                    |
| `REDIS_KEY_PREFIX`                 | `libre`                                | 1-64 character namespace for Libre coordination keys                           |
| `REDIS_CONNECT_TIMEOUT_MS`         | `5000`                                 | Initial Redis connection timeout, capped at 60 seconds                         |
| `JOB_WORKER_MODE`                  | `embedded` in solo; `external` in team | Selector only; no worker is bootstrapped, and external workers are unavailable |
| `STORAGE_ENCRYPTION_KEYS`          | unset                                  | Secret JSON key map; currently must include `legacy` matching `ENCRYPTION_KEY` |
| `STORAGE_ENCRYPTION_ACTIVE_KEY_ID` | unset                                  | Key ID used for new local blob and embedded-vector writes                      |

When the versioned storage key map is absent, storage adapters use the existing
`ENCRYPTION_KEY` as key ID `legacy`; when it is also absent, they read the
existing `${DATA_DIR}/.encryption_key` without generating or modifying it.
Explicit configuration and the persistent file must agree. If a versioned map
is introduced while a legacy key exists, retain that key under the exact ID
`legacy` until all objects and vectors have been rewritten or rewrapped and
verified. Conflicts, unsafe file permissions, symlinks, and missing configured
keys fail closed.

Redis is coordination, not canonical persistence. Selecting it does not make
SQLite, local files, process-local tickets, or current Work events safe across
replicas. See [Platform Foundation](./45-PLATFORM_FOUNDATION.md).

The supplied Compose variants forward every selector above. In the Helm
chart, non-secret selectors live under `env`; set `secrets.redisUrl`,
`secrets.databaseUrl`, and `secrets.storageEncryptionKeys` for connection or
key material. PostgreSQL remains unavailable even when its URL is rendered.

## Private Backup Helper

These variables configure `deploy/private/libre-webui-backup` and are read by
the maintenance script, not the application process:

| Variable                            | Default                         | Purpose                                           |
| ----------------------------------- | ------------------------------- | ------------------------------------------------- |
| `LIBRE_WEBUI_STACK_DIR`             | `/opt/libre-webui`              | Directory containing the private Compose file     |
| `LIBRE_WEBUI_BACKUP_DIR`            | `/var/backups/libre-webui`      | Protected directory for backup sets and lock file |
| `LIBRE_WEBUI_BACKUP_RETENTION_DAYS` | `14`                            | Age after which completed backup sets are removed |
| `LIBRE_WEBUI_CONTAINER_NAME`        | `libre-webui`                   | Deployed application container to inspect         |
| `LIBRE_WEBUI_DATA_VOLUME`           | resolved from the app container | Explicit data-volume name override                |

The systemd unit loads these overrides from the optional root-owned file
`/etc/libre-webui/backup.env`. Set it to mode `0600`. Stack directory,
retention, container name, and data-volume overrides can be set there directly.
The unit's filesystem sandbox permits writes only below the default backup
directory. A custom `LIBRE_WEBUI_BACKUP_DIR` additionally requires that exact,
pre-created directory in a `ReadWritePaths=` service drop-in; see
[Private Remote Deployment](./36-PRIVATE_REMOTE_DEPLOYMENT.md#backups-and-recovery).

## Authentication and Security

| Variable                      | Default                           | Purpose                                                  |
| ----------------------------- | --------------------------------- | -------------------------------------------------------- |
| `ENABLE_SIGNUP`               | `false`                           | Allow registration after the first local administrator   |
| `JWT_SECRET`                  | generated/fallback in development | JWT signing secret; set explicitly in production         |
| `JWT_EXPIRES_IN`              | `7d`                              | Session-token lifetime                                   |
| `ENCRYPTION_KEY`              | auto-generated                    | 64-character hex key for encrypted values                |
| `DEBUG_ENCRYPTION`            | unset                             | Logs encryption debug output when set                    |
| `TURNSTILE_SITE_KEY`          | unset                             | Cloudflare Turnstile site key for login and signup       |
| `TURNSTILE_SECRET_KEY`        | unset                             | Cloudflare Turnstile secret key for backend verification |
| `TURNSTILE_EXPECTED_HOSTNAME` | hostname from `BASE_URL`          | Required hostname in Cloudflare's verification response  |

Turnstile is enabled only when both Turnstile keys are present.

`ENABLE_SIGNUP=false` still permits the first local administrator on an empty
database, then blocks additional local and OAuth accounts. Protect a remotely
reachable bootstrap route with an outer identity boundary before first start.

Chat WebSocket admission can be tuned without weakening authentication:

| Variable                                  | Default | Purpose                                                 |
| ----------------------------------------- | ------- | ------------------------------------------------------- |
| `CHAT_WS_MAX_PAYLOAD_BYTES`               | 10 MiB  | Maximum accepted WebSocket message size                 |
| `CHAT_WS_MAX_MESSAGES_PER_MINUTE`         | `120`   | Per-connection WebSocket message ceiling                |
| `CHAT_WS_MAX_ACTIVE_GENERATIONS_PER_USER` | `4`     | Provider generations allowed per account                |
| `CHAT_WS_MAX_CONNECTIONS_PER_USER`        | `5`     | Concurrent authenticated sockets per account            |
| `WEBSOCKET_TICKET_TTL_MS`                 | `30000` | One-use Chat/Work ticket lifetime; capped at 60 seconds |

The browser exchanges its normal Authorization header for an opaque ticket and
puts only that short-lived value in the WebSocket upgrade URL. Tickets are
single use, protocol-bound, session-bounded, and stored only as hashes. This
keeps durable session tokens out of reverse-proxy request-target logs.
When `CORS_ORIGIN` or `BASE_URL` is configured, browser upgrades with an
`Origin` header must match one of those configured origins. Set at least one on
a remotely reachable deployment; with neither configured, the Origin filter
is permissive for local-development compatibility.
Originless upgrades remain supported intentionally for Electron and
non-browser clients, where browsers' Origin control is unavailable; they still
need a valid one-use ticket and receive the same current account, Work-access,
and task checks. Treat the ticket as the authentication boundary and restrict
non-browser access with the deployment's normal TLS, firewall, and reverse
proxy controls.

## OAuth

| Variable                    | Purpose                            |
| --------------------------- | ---------------------------------- |
| `GITHUB_CLIENT_ID`          | GitHub OAuth client ID             |
| `GITHUB_CLIENT_SECRET`      | GitHub OAuth client secret         |
| `GITHUB_CALLBACK_URL`       | GitHub callback URL override       |
| `HUGGINGFACE_CLIENT_ID`     | Hugging Face OAuth client ID       |
| `HUGGINGFACE_CLIENT_SECRET` | Hugging Face OAuth client secret   |
| `HUGGINGFACE_CALLBACK_URL`  | Hugging Face callback URL override |

If callback URLs are not set, Libre WebUI builds defaults from `BASE_URL`.

## Ollama

| Variable                        | Default                  | Purpose                                             |
| ------------------------------- | ------------------------ | --------------------------------------------------- |
| `OLLAMA_BASE_URL`               | `http://localhost:11434` | Ollama API base URL                                 |
| `OLLAMA_TIMEOUT`                | `300000`                 | Standard Ollama request timeout in milliseconds     |
| `OLLAMA_LONG_OPERATION_TIMEOUT` | `900000`                 | Long operation timeout for pulls and large requests |
| `OLLAMA_MAX_CONTEXT`            | `32768`                  | Maximum model context adopted automatically         |

## Web Search

| Variable      | Default | Purpose                                                                                             |
| ------------- | ------- | --------------------------------------------------------------------------------------------------- |
| `SEARXNG_URL` | unset   | Default SearXNG endpoint for the web-search setting; an admin still enables it in Settings > Search |

## Libre Claw

| Variable                | Default                 | Purpose                         |
| ----------------------- | ----------------------- | ------------------------------- |
| `LIBRE_CLAW_BASE_URL`   | `http://127.0.0.1:8766` | Optional Libre Claw daemon URL  |
| `LIBRE_CLAW_TIMEOUT_MS` | `30000`                 | Libre Claw HTTP request timeout |

## Work Runtime

These variables configure Work execution on the machine or Kubernetes cluster
running the Libre WebUI backend. Docker is the default runtime; the Helm chart
selects Kubernetes when `work.enabled=true`.

| Variable                              | Default                                                                                       | Purpose                                                                                                     |
| ------------------------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `WORK_RUNTIME_IMAGE`                  | `node:22.22-bookworm@sha256:2d178f2785b96dfbf62a416ca2e40f50e30150b4ff3320d706f0d96e90600eb3` | Pinned image used for Work sandboxes                                                                        |
| `WORK_DOCKER_COMMAND`                 | `docker`                                                                                      | Docker-backend CLI executable available to the process                                                      |
| `WORK_COMMAND_TIMEOUT_MS`             | `120000`                                                                                      | Default timeout; a tool can request up to `600000` ms                                                       |
| `WORK_MAX_OUTPUT_CHARS`               | `50000`                                                                                       | Captured stdout/stderr limit, applied to each stream                                                        |
| `WORK_MAX_AGENT_ROUNDS`               | `48`                                                                                          | Provider-agnostic model/tool round budget for one run                                                       |
| `WORK_MEMORY_LIMIT`                   | `2g`                                                                                          | Memory limit passed to each Work container                                                                  |
| `WORK_CPU_LIMIT`                      | `2`                                                                                           | CPU limit passed to each Work container                                                                     |
| `WORK_PIDS_LIMIT`                     | `256`                                                                                         | Process limit passed to each Work container                                                                 |
| `WORK_PREVIEW_PORT`                   | `4173`                                                                                        | Port a preview server must use inside the task container                                                    |
| `WORK_PREVIEW_BIND`                   | `127.0.0.1`                                                                                   | Host interface a task preview port is published on                                                          |
| `WORK_MAX_ACTIVE_RUNTIMES_GLOBAL`     | `3`                                                                                           | Concurrent runtime-backed tasks for the whole instance                                                      |
| `WORK_MAX_ACTIVE_RUNTIMES_PER_USER`   | `2`                                                                                           | Concurrent runtime-backed tasks for one user                                                                |
| `WORK_MAX_TASKS_GLOBAL`               | `500`                                                                                         | Maximum persisted Work tasks for the whole instance                                                         |
| `WORK_MAX_TASKS_PER_USER`             | `100`                                                                                         | Maximum persisted Work tasks for one administrator                                                          |
| `WORK_NETWORK_NAME`                   | `libre-webui-work`                                                                            | Managed sandbox bridge network for networked tasks                                                          |
| `WORK_RUNTIME_DNS`                    | unset                                                                                         | Comma-separated resolver IPs forced onto networked tasks                                                    |
| `WORK_DOCKER_SOCKET`                  | `DOCKER_HOST` if `unix://` or `tcp://`, else `/var/run/docker.sock`                           | Docker Engine endpoint for terminals and diagnostics                                                        |
| `WORK_TERMINAL_MAX_SESSIONS_PER_TASK` | `2`                                                                                           | Simultaneous browser terminals attached to one task                                                         |
| `WORK_TERMINAL_IDLE_TIMEOUT_MS`       | `900000`                                                                                      | Idle timeout before a terminal session is closed                                                            |
| `WORK_RUNTIME_IDLE_TIMEOUT_MS`        | `0` (disabled)                                                                                | Stop a sandbox after this much inactivity (previews too)                                                    |
| `WORK_HOST_WORKSPACES_ENABLED`        | `false`                                                                                       | Allow a task to use a host folder instead of a volume                                                       |
| `WORK_HOST_WORKSPACE_ROOTS`           | the server user's home directory                                                              | `:`-separated roots a host workspace must live inside                                                       |
| `WORK_RUNTIME_BACKEND`                | `docker`                                                                                      | Sandbox backend: `docker` or `kubernetes`                                                                   |
| `WORK_K8S_NAMESPACE`                  | `libre-webui-work`                                                                            | Namespace holding Kubernetes sandbox Pods and PVCs                                                          |
| `WORK_K8S_STORAGE_CLASS`              | cluster default                                                                               | StorageClass for workspace PVCs                                                                             |
| `WORK_K8S_WORKSPACE_SIZE`             | `5Gi`                                                                                         | Per-task workspace PVC size (a real disk quota)                                                             |
| `WORK_K8S_POD_READY_TIMEOUT_MS`       | `900000`                                                                                      | Wait for a sandbox Pod to reach Running (covers pulls)                                                      |
| `WORK_K8S_POD_GONE_TIMEOUT_MS`        | `60000`                                                                                       | Wait for a deleted sandbox Pod to disappear                                                                 |
| `AGENT_CLI_MODELS_ENABLED`            | unset (admin toggle, off)                                                                     | Pin the Agents feature on/off; unset leaves it to the admin toggle in User Management (disabled by default) |
| `AGENT_CLI_TIMEOUT_MS`                | `600000`                                                                                      | Time an agent CLI may run before it is killed                                                               |
| `CODEX_OAUTH_MODELS_ENABLED`          | `true`                                                                                        | Offer the Codex (ChatGPT) provider to admins                                                                |
| `CODEX_HOME`                          | `~/.codex`                                                                                    | Where the Codex CLI sign-in (`auth.json`) is read from                                                      |

On the Docker backend, a host workspace bind-mounts a real directory at
`/workspace`, so the task can read and write those files directly instead of
working in its own Docker volume. Kubernetes rejects host-folder workspaces.
This is a deliberate reduction of the Docker sandbox: keep
`WORK_HOST_WORKSPACES_ENABLED` off unless you want it, and keep
`WORK_HOST_WORKSPACE_ROOTS` as narrow as possible. Requested paths are resolved
through symlinks before they are checked against the roots, and folders such as
`.ssh`, `.gnupg`, `.aws`, and `.config` are rejected outright.

Agent CLI models expose coding agents already installed on the server (`claude`,
`codex`) as selectable chat models, so a subscription agent can answer without an
API key. Only administrators see them, the CLI runs as the Libre WebUI server
user, and it inherits that user's agent credentials — treat it as equivalent to
granting shell access to those agents.

On Docker, networked Work tasks attach to the managed `WORK_NETWORK_NAME`
bridge, created with inter-container communication disabled so one sandbox
cannot reach another sandbox or the deployment's own containers.
`WORK_RUNTIME_DNS` is the supported Docker egress-policy hook: point it at a
filtering resolver to apply name-based allow/deny lists. Entries that are not
IPv4/IPv6 addresses are rejected and logged. DNS filtering does not constrain
direct-IP egress; add host firewall rules when a deployment requires that. The
Kubernetes backend instead uses the chart's default-deny NetworkPolicies and
`work.networkPolicy.blockedEgressCidrs` values.

On Docker, the interactive terminal and system diagnostics talk to the Docker
Engine API directly. They follow `WORK_DOCKER_SOCKET` when set, otherwise `DOCKER_HOST` —
either a `unix://` socket or a plain-HTTP `tcp://` endpoint such as a socket
proxy (see `docker-compose.socket-proxy.yml`) — otherwise
`/var/run/docker.sock`. A `DOCKER_HOST` this client cannot speak to (`ssh://`,
or `tcp://` with `DOCKER_TLS_VERIFY` set) reports the terminal and Docker
diagnostics as unavailable; the rest of Work continues to run through the
Docker CLI, which understands those endpoints on its own. On Kubernetes, the
terminal uses the Pod exec subresource and does not use a Docker endpoint.

Work reads these values when the backend starts. The preview port is internal to
the task container; Libre WebUI publishes it to a dynamically assigned loopback
port rather than exposing this value directly on every host interface.

Keep the runtime image pinned to a reviewed version or digest. Increasing
concurrency or resource limits raises the amount of runtime capacity one or
more autonomous runs can consume. `WORK_MAX_AGENT_ROUNDS` applies equally to
Ollama and plugin-backed runs; there is no lower plugin-only clamp. The
tool-call safety budget is `max(128, WORK_MAX_AGENT_ROUNDS × 8)`. When a run
uses its round budget, Work requests a final no-tools handoff from the model
and ends in the terminal `needs_input` state instead of returning a raw
round-limit error or claiming successful completion. A follow-up run continues
in the same durable workspace. Persisted tool output has a separate bound of
approximately 20,000 source characters plus a truncation marker.

These variables tune a Work runtime that is already reachable. Repository
Compose deployments enable it by default: the image ships the Docker CLI and
the Compose files mount the host Docker socket. Two Compose-level variables
control that wiring:

| Variable        | Default                | Purpose                                                         |
| --------------- | ---------------------- | --------------------------------------------------------------- |
| `DOCKER_GID`    | `0`                    | Group id of the host Docker socket, added to the container user |
| `DOCKER_SOCKET` | `/var/run/docker.sock` | Host path of the Docker socket to mount                         |

`DOCKER_GID` must be the socket's group **as seen inside a container**; a macOS
host reports a different value. The Helm chart never mounts a node runtime
socket. Enable its native Pod/PVC Work backend with `work.enabled=true`.

Libre WebUI itself must remain at zero or one application replica while it
uses SQLite and process-local coordination. The Helm chart accepts zero for a
deliberate suspension where Libre serves no traffic, rejects larger
`replicaCount` values and autoscaling, and still lets Work sandbox Pods scale
independently within the configured runtime limits.

Repository Compose files also accept `WEBUI_BIND_ADDRESS` (default
`127.0.0.1`) and `WEBUI_PORT` (default `8080`). Keep the loopback default unless
a trusted LAN or host reverse proxy must reach the port.

## Provider Model Discovery

A provider's model catalog is rediscovered on its own when it is missing or
stale, so a reload reflects the models the provider currently serves. These
variables tune that cycle:

| Variable                                     | Default           | Purpose                                                                 |
| -------------------------------------------- | ----------------- | ----------------------------------------------------------------------- |
| `PLUGIN_MODEL_DISCOVERY_TTL_MS`              | `21600000` (6 h)  | Age at which a stored catalog is refreshed on the next plugin-list read |
| `PLUGIN_MODEL_DISCOVERY_RETRY_MS`            | `600000` (10 min) | Minimum gap between attempts, so a failing provider is not probed often |
| `PLUGIN_MODEL_DISCOVERY_REFRESH_DEADLINE_MS` | `3000`            | How long a plugin-list response waits for refreshes before answering    |

A refresh that outruns the deadline still completes and is served on the next
request. An explicit **Refresh models** always contacts the provider and
ignores the interval.

## Provider Plugin Keys

Provider plugins can use environment keys as deployment-wide defaults:

| Variable              | Provider                                    |
| --------------------- | ------------------------------------------- |
| `OPENAI_API_KEY`      | OpenAI and OpenAI TTS                       |
| `ANTHROPIC_API_KEY`   | Anthropic                                   |
| `GROQ_API_KEY`        | Groq                                        |
| `GEMINI_API_KEY`      | Google Gemini                               |
| `MISTRAL_API_KEY`     | Mistral                                     |
| `OPENROUTER_API_KEY`  | OpenRouter                                  |
| `KIMI_API_KEY`        | Kimi Code by Moonshot AI                    |
| `GITHUB_API_KEY`      | GitHub Models                               |
| `HUGGINGFACE_API_KEY` | Hugging Face APIs where configured          |
| `ELEVENLABS_API_KEY`  | ElevenLabs TTS                              |
| `COMFYUI_API_KEY`     | ComfyUI deployments that require an API key |

Users can also store provider credentials in the UI when per-user keys are
preferred. Environment keys are used only with the routing and authentication
projection of an unshadowed bundled definition. Imported definitions, writable
definitions that reuse a bundled ID, and administrator-saved custom routes
require a credential stored by that account. Libre WebUI will not attach an
environment key to those routes or expose it through discovery and availability
checks. Trust comes from a compiled hash of each shipped manifest, so container
layouts where the legacy and bundled plugin directories share a path remain
supported without treating a modified manifest as bundled.

User-saved keys are bound to the effective provider definition, source,
authentication contract, and routing values. Users must save a key again after
an administrator changes that destination. Pre-upgrade unbound keys are
accepted and bound on first use only for an exact shipped definition using its
bundled route.

Relative `PLUGINS_DIR` values resolve from the project root. For compatibility,
Libre also reads the deterministic `backend/plugins` directory and the
historical backend-relative location of a configured relative path. Move those
definitions into `$DATA_DIR/plugins`; recovery reports the legacy paths as
external state and blocks a volume-only snapshot while custom definitions
remain there. Plugin directories and JSON definitions must be physical regular
entries—Libre does not follow plugin symlinks.

## Frontend

| Variable             | Default                                 | Purpose                                              |
| -------------------- | --------------------------------------- | ---------------------------------------------------- |
| `VITE_API_BASE_URL`  | inferred from host/dev config           | Frontend API base URL                                |
| `VITE_WS_BASE_URL`   | inferred from API URL                   | Absolute `ws:`/`wss:` base for Chat and Work sockets |
| `VITE_APP_VERSION`   | package version injected by Vite config | Displayed app version                                |
| `VITE_DEMO_MODE`     | `false`                                 | Enables demo-mode mocks when `true`                  |
| `VITE_API_TIMEOUT`   | `300000`                                | Frontend API timeout in milliseconds                 |
| `VITE_BACKEND_URL`   | `http://localhost:3001`                 | Used by some auth helper components                  |
| `VITE_DEBUG_VERBOSE` | unset                                   | Enables verbose frontend debug logs in development   |
| `VITE_LOG_LEVEL`     | unset                                   | Overrides the frontend log level                     |
| `ELECTRON_BUILD`     | unset                                   | Enables Electron-specific Vite behavior when `true`  |

`VITE_WS_BASE_URL` overrides every WebSocket fallback for both Chat and the
Work terminal. It may include a reverse-proxy path prefix, but it must be an
absolute `ws:` or `wss:` URL without credentials, a query, or a fragment. When
it is unset, Electron `file:` clients use `ws://localhost:3001`; browser
clients derive their base from `VITE_API_BASE_URL`, then the production browser
origin or the development backend on port 3001.

## Maintenance Scripts

| Variable                  | Purpose                                             |
| ------------------------- | --------------------------------------------------- |
| `CHANGELOG_AI`            | Set to `0` to disable AI-assisted changelog drafts  |
| `CHANGELOG_AI_MODEL`      | Ollama model for release/changelog generation       |
| `CHANGELOG_AI_TIMEOUT_MS` | Timeout for AI changelog generation in milliseconds |

Example:

```bash
CHANGELOG_AI_MODEL=glm-5.2:cloud npm run changelog
CHANGELOG_AI=0 npm run release:minor
```

## Production Example

```env
NODE_ENV=production
PORT=3001
SERVE_FRONTEND=true
DATA_DIR=/data/libre-webui
CORS_ORIGIN=https://librewebui.example
BASE_URL=https://librewebui.example

JWT_SECRET=replace-with-a-long-random-secret
ENCRYPTION_KEY=replace-with-64-hex-characters
ENABLE_SIGNUP=false

OLLAMA_BASE_URL=http://ollama:11434
OLLAMA_TIMEOUT=300000
OLLAMA_LONG_OPERATION_TIMEOUT=900000

TURNSTILE_SITE_KEY=...
TURNSTILE_SECRET_KEY=...
TURNSTILE_EXPECTED_HOSTNAME=librewebui.example
```

## Related Docs

- [Authentication](./AUTHENTICATION)
- [Single Sign-On](./SINGLE_SIGN_ON)
- [Database Encryption](./DATABASE_ENCRYPTION)
- [Work: Isolated Workspaces](./WORKSPACES)
- [Docker](./DOCKER)
