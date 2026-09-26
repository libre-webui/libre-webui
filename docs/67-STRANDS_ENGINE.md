---
sidebar_position: 67
title: 'Strands Engine'
description: 'Run the embedded Strands agent engine on the models Libre WebUI already serves: persistent sessions on the Strands page, a Strands entry in Chat, and a Strands engine for Work.'
slug: /STRANDS_ENGINE
keywords:
  [
    strands,
    strands agents,
    strands engine,
    agent harness,
    embedded agent,
    agent engine,
    work engine,
    ollama,
    provider plugins,
  ]
---

# Strands Engine

Libre WebUI embeds an agent engine built on the open-source
[Strands Agents harness](https://github.com/strands-agents/harness-sdk)
(`@strands-agents/harness` 0.1.1 on `@strands-agents/sdk` 1.19.0). It runs
inside the Libre WebUI backend process, so there is no separate daemon to
install. The SDK is loaded the first time the engine is used; a server with
Strands switched off never loads it.

The engine drives the models Libre WebUI already serves:

- Ollama models, when Ollama is enabled
- models from active chat or completion provider plugins

Every model call goes through the same Ollama and plugin services Chat uses.
There is no separate provider configuration and no separate API key. Provider
credentials and the Ollama switch apply unchanged.

You can use the engine in three places:

- the **Strands** page, for persistent agent sessions
- **Chat**, through the **Strands** entries in the model selector
- **Work**, as the **Strands** option of the composer's **Engine** control

## Access

An administrator chooses who can use the engine under **Settings → User
Management → Access & policies → Strands engine**:

| Mode        | Label in the setting | Who can use Strands                       |
| ----------- | -------------------- | ----------------------------------------- |
| `disabled`  | Off                  | Nobody, administrators included (default) |
| `admins`    | Administrators       | Active administrators                     |
| `all-users` | All users            | Every active account                      |

A change takes effect on the next request, without a restart.

To pin the mode at the deployment level, set `LIBRE_STRANDS_ACCESS`:

```bash
LIBRE_STRANDS_ACCESS=admins   # or disabled, all-users
```

A pinned mode locks the control in User Management. Any value other than
`disabled`, `admins`, or `all-users` locks the engine off instead of falling
back to the saved setting.

The server enforces the mode on every REST request, on WebSocket chat, and on
every model call of a Work run. If the mode cannot be read, access is denied.
Accounts without access do not see the Strands page, the Strands chat entries,
or the Strands Work engine, and the API answers `403`.

## Strands page

Open **Strands** from the sidebar (`/strands`).

- Sessions persist across restarts, up to 200 per account. The first message
  names a new session.
- Pick a model for each session. **Default model** uses your default chat
  model.
- Replies stream as they are generated, with the model's reasoning and a card
  for each tool call.
- **Stop** cancels the running turn. A session runs one turn at a time.
- Deleting a session removes its history and its workspace.

## Chat

Pick **Strands** in the model selector. It appears in the **Agents** group next
to the Agent CLI models:

- **Strands** (`strands`) uses the engine default, which is your default chat
  model.
- **Strands · model (provider)** (`strands:<route>`) pins one model and its
  provider for the conversation.

Strands in Chat depends only on Strands access. It does not need the Agent CLI
models toggle, and it appears while that toggle is off. In Chat the agent has
the same file tools as on the Strands page, in one private workspace per
account, and its replies arrive as text and reasoning. See
[Installed coding agents](./AGENT_CLI_MODELS) for the Agents group and for using
a Strands entry as the task model for titles and thinking summaries.

## Work

In the Work composer, choose **Libre WebUI** or **Strands** in the **Engine**
control and pick the model separately. With **Strands**, a Strands agent plans
each step, and Work executes the tools it asks for in the Work sandbox under
Work's normal approval policy. Work stays authoritative for the transcript,
approvals, tool execution, and run history; the Strands agent runs no tools of
its own in Work.

The underlying provider model must support tool calling. Work checks this
before a run starts and rejects a model that does not advertise tool support.

Work runs saved by earlier releases with a `dsh:` model prefix open as Strands
runs. See [Work: Strands engine](./WORKSPACES#strands-engine) for how the engine
choice interacts with models carried over from Chat.

## Security model

On the Strands page and in Chat, the agent has a deliberately small tool set:

- `read`, `write`, and `edit`, for files in its workspace
- the harness `todos` plugin, for planning multi-step work

It has no shell, no web fetch, no memory, and no skills, and no `AGENTS.md`
file is injected into its instructions.

Each session has a private workspace directory, which the agent sees as
`/workspace`. Every path is resolved after following symlinks and must stay
inside that directory, so a link in the workspace cannot reach the rest of the
disk. The sandbox refuses to execute commands.

| Item                    | Limit             |
| ----------------------- | ----------------- |
| Sessions per account    | 200               |
| Prompt length           | 32,000 characters |
| Agent turns per message | 24                |
| File read or write      | 2 MB per call     |
| Session title           | 120 characters    |

A turn that reaches the turn limit stops and says so. Each turn can make
several model calls to your providers, so grant access with the same care as
any other model access that spends provider budget.

## Storage

Strands data lives under `<DATA_DIR>/strands/`, not in the application
database. Each account has its own directory,
`<DATA_DIR>/strands/users/<account-hash>/`, containing:

- `registry.json`: the account's session list
- `sessions/`: the Strands session snapshots the agent uses as context
- `transcripts/`: the transcript shown on the Strands page for each session
- `workspaces/`: the private workspace of each session
- `chat-workspace/`: the workspace used by Chat turns

Include `<DATA_DIR>/strands/` in backups if the sessions matter to you.

## Usage

Provider Usage (`/usage`) attributes Strands calls to the **Strands** agent in
its **Agents** section. See [Agent usage](./SYSTEM_MONITORING#agent-usage).

## API

Every route requires an authenticated account with Strands access, except
`/api/strands/access`, which requires an administrator.

| Method   | Path                                        | Purpose                                                                     |
| -------- | ------------------------------------------- | --------------------------------------------------------------------------- |
| `GET`    | `/api/strands/access`                       | Read the access mode and whether `LIBRE_STRANDS_ACCESS` pins it (admin)     |
| `PUT`    | `/api/strands/access`                       | Set `mode` to `disabled`, `admins`, or `all-users` (admin; `409` if pinned) |
| `GET`    | `/api/strands/health`                       | Engine availability and the harness and SDK versions                        |
| `GET`    | `/api/strands/models`                       | Models the engine can drive for this account                                |
| `GET`    | `/api/strands/sessions`                     | List sessions                                                               |
| `POST`   | `/api/strands/sessions`                     | Create a session (optional `title` and `model`)                             |
| `GET`    | `/api/strands/sessions/:sessionId`          | Read a session, its transcript, and whether a turn is running               |
| `PATCH`  | `/api/strands/sessions/:sessionId`          | Change a session's title or model                                           |
| `DELETE` | `/api/strands/sessions/:sessionId`          | Delete a session with its transcript and workspace                          |
| `POST`   | `/api/strands/sessions/:sessionId/messages` | Send `{ "text": "..." }` and stream the turn as NDJSON                      |
| `POST`   | `/api/strands/sessions/:sessionId/cancel`   | Stop the running turn                                                       |

The message stream writes one JSON event per line: `turn-start`, `text`,
`reasoning`, `tool-start`, `tool-result`, `done` (with the stop reason and
token usage when the provider reports it), and `error`. Closing the connection
cancels the turn. Sending a message while a turn is running returns `409`.

## Configuration

| Variable               | Default                       | Purpose                                                                        |
| ---------------------- | ----------------------------- | ------------------------------------------------------------------------------ |
| `LIBRE_STRANDS_ACCESS` | unset (admin setting, admins) | Pin `disabled`, `admins`, or `all-users`; any other value locks the engine off |

## Troubleshooting

See [Strands Engine Problems](./TROUBLESHOOTING#strands-engine-problems).
