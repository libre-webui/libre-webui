---
sidebar_position: 65
title: 'Cordis Configuration'
description: 'Configuration reference for the embedded Cordis/DSH engine: settings document, composition document, and environment variables.'
slug: /CORDIS_CONFIGURATION
keywords:
  [
    cordis configuration,
    cordis.patch.yml,
    cordis.config.yml,
    dsh engine config,
    model provider routes,
    libre cordis env,
  ]
---

# Cordis Configuration

The embedded Cordis/DSH engine is configured by two documents and a set of
environment variables. Both documents live next to the backend by default;
`LIBRE_CORDIS_CONFIG` and `LIBRE_CORDIS_SETTINGS` relocate them.

| Document            | Owner            | Shape                    | Purpose                                     |
| ------------------- | ---------------- | ------------------------ | ------------------------------------------- |
| `cordis.patch.yml`  | Cordis Loader    | Top-level YAML **array** | The plugin rows that mount the engine       |
| `cordis.config.yml` | Libre WebUI host | YAML **mapping**         | Provider, credentials source, feature flags |

Two documents rather than one because the Cordis `Include` tree carrier reads
the composition itself and rejects any file that is not a top-level array. Host
settings therefore cannot share that file.

### Enabling it

![The Cordis Engine opt-in in Settings, beside the Agents opt-in.](./assets/cordis-admin-card.png)

An administrator enables the engine in **Settings → User Management → Access &
policies → Cordis Engine**. The change applies immediately: enabling starts the
engine on its next request, and disabling disposes it. No restart is involved.

Two deployment-level sources can pin the value, and both grey out the toggle
rather than being silently overridden:

| Source                                      | Effect                                                                                      |
| ------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `LIBRE_CORDIS_ENABLED` environment variable | `true`/`false` pins the feature for the deployment                                          |
| `features.enabled` in `cordis.config.yml`   | An explicitly stated value pins it; omitting the key leaves the choice to the administrator |

The engine also needs a composition. Start from the shipped examples:

```bash
cd backend
cp cordis.patch.example.yml cordis.patch.yml
cp cordis.config.example.yml cordis.config.yml
```

The host reads `cordis.patch.yml`, merges its own defaults into the bridge row,
and writes the result to `<DATA_DIR>/cordis-runtime/cordis.composed.yml`. That
generated file is disposable and must not be edited: the authoritative document
is the operator's `cordis.patch.yml`.

## `cordis.config.yml`

```yaml
trace: false

model:
  provider: libre-webui
  # Empty selects the authenticated caller's configured default/fallback route.
  model: ''

features:
  # Omit enabled to let the administrator use the Settings toggle.
  streaming: true
  tools: true
  persistence: true

# Optional absolute paths; defaults live under Libre WebUI's data directory.
# workspacePath: /absolute/path/to/workspace
# sessionStorePath: /absolute/path/to/sessions
```

### Top-level keys

| Key        | Type    | Default | Meaning                                |
| ---------- | ------- | ------- | -------------------------------------- |
| `trace`    | boolean | `false` | Log every Cordis activation transition |
| `model`    | mapping | –       | Model adapter selection; see below     |
| `features` | mapping | –       | Capability switches; see below         |

### `features`

| Key           | Type    | Default | Meaning                                                                    |
| ------------- | ------- | ------- | -------------------------------------------------------------------------- |
| `enabled`     | boolean | `false` | Mount the engine. While false every route returns `503`.                   |
| `streaming`   | boolean | `true`  | Accept turns that stream model output                                      |
| `tools`       | boolean | `true`  | Allow engine tools and expose their registry                               |
| `persistence` | boolean | `true`  | Enable JSONL persistence and require its service; sessions survive restart |

`features.enabled` is the only switch that must be set to turn the bridge on. A
top-level `enabled` key is not read; keeping every capability switch inside
`features` means there is one place to look for what is turned on.

### `model`

| Key         | Type    | Default          | Meaning                                                              |
| ----------- | ------- | ---------------- | -------------------------------------------------------------------- |
| `provider`  | string  | `libre-webui`    | `libre-webui`, `deepseek`, `pi-ai`, or `none`                        |
| `apiKeyEnv` | string  | `OPENAI_API_KEY` | **Name** of the environment variable holding the key                 |
| `route`     | string  | `libre-webui`    | Provider route the engine names in requests                          |
| `model`     | string  | `''`             | Model id the engine requests. **Set this** for a hand-declared route |
| `baseUrl`   | string  | `''`             | Endpoint override; empty uses the adapter's own default              |
| `providers` | mapping | `{}`             | Hand-declared provider routes, keyed by route name                   |

### Where the engine's models come from

The engine does not have its own provider configuration. It calls the providers
Libre WebUI already has, through the `libre-webui` route that the composition's
`libre-webui-llm-adapter` row registers. Whatever you can chat with in the UI is
what the engine can use: pull a model in the UI and the engine sees it, with the
credentials and endpoint already configured.

Set `model.provider: libre-webui` to use it. That is the shipped default;
credentials and provider endpoints remain in Libre WebUI's existing settings.

`model` names the model the engine requests. Empty means "use the app's default
model", and if the deployment has no default the engine takes the first chat
model the provider layer reports, preferring available local models. Embedding
models are excluded. Internally selected routes retain both provider and model:
`lwui:ollama:<encoded-model>` or `lwui:plugin:<encoded-provider>:<encoded-model>`.
This prevents matching model names or an Ollama outage from redirecting a local
request to a remote provider. An explicit provider selection fails if that
provider is unavailable; it never silently falls back to another provider.

An empty `model` is only safe on the `libre-webui` route. A route served by a
provider package needs one named explicitly: `dsh-llm-pi-ai` resolves a route's
catalog to answer catalog queries but does not fall back to the route's first
entry, so a hand-declared route with no `model` accepts no turn and fails with:

```
provider "<route>" resolves no models; the installed catalog does not describe
this route, so its models must be listed in configuration
```

Set `model` to an id from that route's `models` list. The shipped example pairs
`route: ollama` with `model: llama3.2`, matching the `llama3.2` entry it
declares.

`provider` selects which adapter package is mounted:

- `libre-webui` serves the engine through this deployment's own provider layer.
  This is the supported mode and the default.
- `none` starts the engine without model access. Tools list, sessions work, and
  a turn cannot be answered — useful for exercising a composition.
- `deepseek` and `pi-ai` mount a provider package directly. **Those packages are
  not dependencies of this backend**: carrying every provider SDK pulled in 59
  transitive packages, including deprecated ones for capabilities the engine
  never reaches. Install the package you want and mount its row in the
  composition; the host names the missing package if it is not there.

A provider route is described by:

| Field         | Meaning                                                                 |
| ------------- | ----------------------------------------------------------------------- |
| `displayName` | Human-readable name                                                     |
| `api`         | Wire protocol, e.g. `openai-completions`                                |
| `baseURL`     | Endpoint base                                                           |
| `apiKeyEnv`   | Environment variable holding the key                                    |
| `models`      | Model list; each entry takes `id`, `name`, `contextWindow`, `maxTokens` |

**Credentials are never written into either document.** `apiKeyEnv` names an
environment variable, and the adapter resolves it per request, so rotating a key
needs no restart.

## `cordis.patch.yml`

A top-level array of Cordis loader entries. The shipped example mounts nine
rows and is the recommended starting point.

```yaml
- id: llm
  name: '@deepseek-ai/dsh-llm'

- id: session
  name: '@deepseek-ai/dsh-session'

- id: session-projection
  name: '@deepseek-ai/dsh-session-projection'

- id: session-persistence
  name: '@deepseek-ai/dsh-session-persistence-jsonl'
  config:
    # The host supplies the resolved sessionStorePath.

- id: system-prompt
  name: '@deepseek-ai/dsh-system-prompt'
  config:
    personaPrefix: ''

- id: tools
  name: '@deepseek-ai/dsh-tools'

- id: agent
  name: '@deepseek-ai/dsh-agent'

- id: agent-loop
  name: '@deepseek-ai/dsh-agent-loop'
  config:
    agents: []

- id: libre-webui-bridge
  name: './dist/cordis/dsh/engine-plugin.js'
```

### Entry fields

| Field      | Required | Meaning                                                          |
| ---------- | -------- | ---------------------------------------------------------------- |
| `id`       | no       | Stable id used to target the row. Derived from `name` if omitted |
| `name`     | **yes**  | Module specifier the loader imports. Must be a literal string    |
| `config`   | no       | Config for the plugin; `!!js` expressions allowed                |
| `disabled` | no       | Skip the row without deleting it; `!!js` allowed                 |
| `inject`   | no       | Extra required services or intercept config for the row          |

`name` is imported directly by the loader and is never evaluated, so it cannot
be a `!!js` expression. `config` values can use `!!js`; those expressions are
evaluated later, in the owning row's fiber, with the loader context in scope —
`process.env` and `ctx.get(...)` work, `import.meta` does not.

Relative specifiers resolve against the **composition file's own directory**.
Bare specifiers resolve through the backend package, so
`@deepseek-ai/dsh-tools` finds the copy in `backend/node_modules`.

Row order carries no load semantics. Cordis activates a row once the services it
declares are available, so the grouping above is for readers only.

### Required rows

An engine that answers chat needs all of:

| Row                      | Provides             | Needed by          |
| ------------------------ | -------------------- | ------------------ |
| `dsh-llm`                | `llm`                | agent loop         |
| `dsh-session`            | `sessions`           | agent loop, bridge |
| `dsh-session-projection` | `sessionProjections` | agent loop         |
| `dsh-system-prompt`      | `systemPrompt`       | tools, agent loop  |
| `dsh-tools`              | `tools`              | agent loop, bridge |
| `dsh-agent`              | `agents`             | bridge             |
| `dsh-agent-loop`         | agent driver         | answers turns      |
| the bridge row           | `libreDshEngine`     | every route        |

Mounting a tool plugin row as well (for example `@deepseek-ai/dsh-fs-sandbox`
plus `@deepseek-ai/dsh-tool-fs`) is what makes `GET /api/cordis/tools` return
anything; a tool registry with no tool plugins is legitimately empty.

## Environment variables

Every settings value has an environment override. The variable wins over the
document, which wins over the built-in default.

| Variable                      | Overrides                   | Default                         |
| ----------------------------- | --------------------------- | ------------------------------- |
| `LIBRE_CORDIS_ENABLED`        | `features.enabled`          | `false`                         |
| `LIBRE_CORDIS_STREAMING`      | `features.streaming`        | `true`                          |
| `LIBRE_CORDIS_TOOLS`          | `features.tools`            | `true`                          |
| `LIBRE_CORDIS_PERSISTENCE`    | `features.persistence`      | `true`                          |
| `LIBRE_CORDIS_TRACE`          | `trace`                     | `false`                         |
| `LIBRE_CORDIS_MODEL_PROVIDER` | `model.provider`            | `pi-ai`                         |
| `LIBRE_CORDIS_MODEL_ROUTE`    | `model.route`               | `openai-compatible`             |
| `LIBRE_CORDIS_MODEL`          | `model.model`               | `''`                            |
| `LIBRE_CORDIS_API_KEY_ENV`    | `model.apiKeyEnv`           | `OPENAI_API_KEY`                |
| `LIBRE_CORDIS_BASE_URL`       | `model.baseUrl`             | `''`                            |
| `LIBRE_CORDIS_CONFIG`         | Composition document path   | `<cwd>/cordis.patch.yml`        |
| `LIBRE_CORDIS_SETTINGS`       | Settings document path      | beside the composition document |
| `LIBRE_CORDIS_WORKSPACE`      | Engine default workspace    | `<DATA_DIR>/cordis-workspace`   |
| `LIBRE_CORDIS_SESSION_STORE`  | Persisted session directory | `<DATA_DIR>/cordis-sessions`    |

Boolean variables accept `1/true/yes/on` and `0/false/no/off`. An unreadable
value falls back to the document rather than guessing.

`LIBRE_CORDIS_SESSION_STORE` and `LIBRE_CORDIS_WORKSPACE` are also read by the
shipped composition's `!!js` expressions, which is why the host exports them
before the tree is mounted.

## Worked examples

### Local Ollama, fully offline

```yaml
features:
  enabled: true
model:
  provider: pi-ai
  route: ollama
  model: llama3.2
  apiKeyEnv: OLLAMA_API_KEY
  providers:
    ollama:
      api: openai-completions
      baseURL: http://127.0.0.1:11434/v1
      apiKeyEnv: OLLAMA_API_KEY
      models:
        - id: llama3.2
          contextWindow: 131072
          maxTokens: 4096
```

Ollama ignores the key, but the OpenAI client requires one to be set. Export
`OLLAMA_API_KEY=ollama` to satisfy it without inventing a secret. Nothing leaves
the machine.

### An OpenAI-compatible gateway

```yaml
features:
  enabled: true
model:
  provider: pi-ai
  route: gateway
  model: acme-large
  apiKeyEnv: ACME_GATEWAY_API_KEY
  providers:
    gateway:
      displayName: Acme Gateway
      api: openai-completions
      baseURL: https://gateway.acme.example/v1
      apiKeyEnv: ACME_GATEWAY_API_KEY
      models:
        - id: acme-large
          contextWindow: 65536
          maxTokens: 4096
```

### First-party DeepSeek

```yaml
features:
  enabled: true
model:
  provider: deepseek
  route: deepseek
  apiKeyEnv: DEEPSEEK_API_KEY
```

Set `DEEPSEEK_API_KEY` in the backend's environment.

### No provider, tools only

```yaml
features:
  enabled: true
model:
  provider: none
```

The engine starts, sessions can be created, and
`GET /api/cordis/tools` lists the configured tool plugins. Sending a message
fails, because no adapter can serve the request.

## Migration notes

The Cordis bridge is additive. No existing behavior changes when it is off, and
it is off by default.

**Upgrading an existing deployment.** Nothing is required. The two example
documents ship as `cordis.patch.example.yml` and `cordis.config.example.yml`, so
neither is picked up until you copy it and enable the feature. No migration
runs, no table is created, and no existing data directory is touched.

**Enabling it for the first time.** Copy both example documents, set
`features.enabled: true`, and install nothing further: the engine packages are
already dependencies of the backend. On first request the engine creates
`<DATA_DIR>/cordis-workspace`, `<DATA_DIR>/cordis-sessions`, and
`<DATA_DIR>/cordis-runtime`. All three are new directories under the existing
data directory, so an existing backup or restore that covers that directory
covers them too.

**Upgrading the engine.** The resolved engine versions are recorded in `package-lock.json`.
`backend/package.json` declares alpha-compatible ranges. Upgrade deliberately
and validate the provider and session contracts after running
`npm install`. If a DSH package gains a peer dependency, npm reports it at
install time rather than at mount time. Model and session formats are owned by
DSH; a format change is a DSH release note, not a Libre WebUI migration.

**Rolling back.** Set `features.enabled: false` and restart, or remove the
bridge row from `cordis.patch.yml`. The `libreDshEngine` service is withdrawn,
its listener released, and the agents it created are disposed. Session files
stay on disk as data; delete the `sessionStorePath` directory to reclaim the
space. Uninstalling the packages is optional and does not affect any other
Libre WebUI feature.

**Existing Chat and Work deployments.** Chat gains an administrator-only
DeepSeek Harness selection, using transient engine sessions and the existing
Chat transcript. Work gains a separate DeepSeek Harness engine choice backed by an
isolated DSH driver and the existing Work sandbox/approval pipeline. Existing
model selections keep their normal behavior.

With the standard `libre-webui` adapter, Chat's Agents selector includes explicit
DSH provider-model choices as well as the base profile. Explicit choices retain
their qualified provider identity. The base profile uses the running composition's
model default. Titles and thinking summaries for these DSH choices call the
underlying provider directly, with no agent tools. A custom model-adapter route
keeps only its base Chat entry and requires a separate Ollama or plugin task model
for title generation and thinking summaries.

DSH honors the administrator's Ollama switch. When Ollama is disabled, its models
are neither listed nor probed, and an explicit Ollama choice fails without
switching providers. Operator-pinned, unqualified model names also require
Ollama's catalog to resolve safely; use a qualified `lwui:plugin:<plugin>:<model>`
choice for a plugin-only deployment.

## Operational boundaries

- **Host Engine and Chat are administrator-only and solo-only.** The Engine page
  is a shared administrator console, with a local JSONL store. It cannot mount in
  team mode. Sandboxed Work uses its existing SQL repositories instead.
- **Model calls use the authenticated caller.** Interactive host turns use that
  administrator's provider credentials and default-model preference. A trusted
  noninteractive composition may explicitly set `LIBRE_CORDIS_USER` to an active
  administrator's ID. There is no implicit oldest-administrator fallback.
- **Host filesystem tools are workspace-confined.** Reads and writes check the
  canonical target; a session cannot select a working directory outside the
  configured root. Native DSH mutation restrictions still apply. Additional
  operator-installed plugins are trusted server code.
- **Host tools use DSH's policies.** The Engine page provides per-session
  read-only/workspace-write controls and native one-shot approval cards. Those
  controls never bypass the configured workspace boundary. Headless Chat turns
  reject approval requests they cannot present. Work's DSH driver instead uses
  Work approvals and container isolation with no host filesystem tools.
- **Streams contain live text and exposed reasoning.** Durable messages preserve
  the completed transcript; clients do not receive a second copy of live text.
- **Restart and deletion use stored sessions.** Empty and completed Engine
  sessions survive restarts. Deleting a bridge-created JSONL session stops its
  writer and removes the artifact. Other persistence implementations must supply
  an appropriate deletion adapter.
- **Legacy malformed logs require explicit repair.** Earlier bridge revisions
  wrote user messages without required IDs. The strict reader refuses those logs
  rather than discarding them. See the recovery procedure in
  [Troubleshooting](./06-TROUBLESHOOTING.md#saved-session-fails-with-an-identified-message-error).
- **Titles are derived locally.** Session summaries use the first human message
  as a short title; empty sessions have no derived title.

## Connect models from a running DSH instance

The optional native provider bundle exposes the models and provider connections
already configured in another DSH instance, such as the local web app on port 3080. Install it into that instance's existing profile. It calls only `ctx.llm`:
provider keys stay in DSH, and the connection cannot create sessions, run agents,
read native attachment files, or execute native tools.

Both processes must run on the same Unix host under the same OS account. The
transport uses an explicitly configured Unix socket, with a physical directory
owned by that account and mode `0700`, and socket mode `0600`. It adds no HTTP
listener and does not reuse or weaken DSH's browser authentication. Windows and
remote DSH hosts are not supported by this local connection.

From the Libre WebUI installation directory, build the backend for a source
checkout, then prepare a new local bundle directory. Replace the absolute paths
below with paths on your host; keep the socket path under 100 bytes:

```bash
npm run build:backend
node scripts/prepare-dsh-provider.mjs /absolute/dsh-provider-bundle /absolute/private-directory/provider.sock
dsh plugin --profile web add /absolute/dsh-provider-bundle
```

Use the profile actually running your DSH instance instead of `web` if different.
The bundle declares its own plugin row; the supported plugin manager installs
and mounts it. The preparation command refuses an existing output directory.
Installed npm distributions already contain the compiled backend and preparation
script and do not need the build command.

Point Libre WebUI's `cordis.config.yml` at the same socket:

```yaml
nativeProvider:
  socketPath: /absolute/private-directory/provider.sock
```

Alternatively, set `LIBRE_DSH_PROVIDER_SOCKET` to that absolute path. An empty
environment value disables the connection even when the file declares a path.
Enable **Cordis Engine** in LWUI. Active administrators can then choose native
models in Work's **DeepSeek Harness** engine, the Engine page, and Chat's Agents
group (Chat also requires **Agent CLI models**). Work keeps the raw native model
and provider ID with `providerType: dsh`; existing LWUI-backed DSH tasks retain
their original provider identity and engine marker.

The native model list is read live. Provider or credential configuration changes
invalidate the connection's generation and cancel in-flight native calls. An
unavailable socket, model, or native provider stops the request; LWUI does not
fall back to Ollama or another provider. Titles and thinking summaries call the
selected native LLM directly with no tools. This first connection accepts text,
reasoning, and tool messages; native image/file references are rejected.

The native credentials belong to the DSH operator, so this connection is
administrator-only even when ordinary Work is available to more users. Model
requests can leave the host according to the provider configured in DSH; Work
shows its remote-provider disclosure. In a team deployment every worker handling
such tasks needs access to the configured local connection; a missing connection
fails closed. Disabling Cordis or removing the socket setting withdraws native
access while preserving saved tasks. If DSH crashes and leaves a socket behind,
stop the owning instance and remove only that stale socket before restarting;
the plugin refuses to replace an existing filesystem entry.

### Native provider usage

Native requests appear in **Provider Usage** under **DeepSeek Harness · provider**,
with the raw selected model. Each actual model request is counted once, including
tool rounds, titles, and thinking summaries. The dashboard includes successful,
failed, and cancelled calls, latency, and tokens reported by DSH. Cached input is
included once in the input total; missing usage stays unmetered rather than being
estimated. Provider IDs use `dsh-native:<percent-encoded-native-provider-id>` for
existing tariff and cost-reporting rules. Unknown tariffs remain unpriced.

DSH requests through LWUI-configured providers retain those providers' existing
usage records. Catalog reads and rejected requests that never reach native
inference do not create extra model-call records. Metering starts when this
connection version is installed; it does not invent historical usage. Stored
usage contains identity, status, time, and counters, without prompts, responses,
credentials, endpoints, or provider error text.

## Verifying a configuration

```bash
curl -s http://127.0.0.1:3001/api/cordis/health | jq
```

```json
{
  "success": true,
  "enabled": true,
  "ready": true,
  "services": [
    { "name": "llm", "state": "ready" },
    { "name": "systemPrompt", "state": "ready" },
    { "name": "sessions", "state": "ready" },
    { "name": "tools", "state": "ready" },
    { "name": "agents", "state": "ready" }
  ]
}
```

A `503` with `code: CORDIS_UNAVAILABLE` means the composition did not mount.
The `error` field carries the reason, and `LIBRE_CORDIS_TRACE=true` adds the
Cordis activation log. See [Troubleshooting](./06-TROUBLESHOOTING.md) for the
common causes.
