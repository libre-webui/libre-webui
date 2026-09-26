---
sidebar_position: 14
title: 'Use an Installed Coding Agent as a Chat Model'
description: 'Expose the Claude Code, Codex, OpenCode, or Pi CLI already installed on your server as a selectable Libre WebUI chat model, without adding an API key.'
slug: /AGENT_CLI_MODELS
keywords:
  [
    agent cli,
    claude code,
    codex,
    opencode,
    pi,
    coding agent,
    chat model,
    no api key,
    subscription agent,
  ]
---

# Use an Installed Coding Agent as a Chat Model

If you already pay for a coding agent and it is signed in on the machine running
Libre WebUI, you can talk to it from a normal chat instead of adding a separate
API key. Libre WebUI detects the agent's command-line interface and offers it in
the model selector like any other model.

## What gets detected

On each request for the model list, Libre WebUI looks on the server's `PATH` for
these commands:

| Model           | Command    | Provided by   |
| --------------- | ---------- | ------------- |
| **Claude Code** | `claude`   | Anthropic     |
| **Codex**       | `codex`    | OpenAI        |
| **OpenCode**    | `opencode` | SST           |
| **Pi**          | `pi`       | Mario Zechner |

Anything found appears under an **Agents** group in the model selector. Nothing
is installed for you, and no configuration file is required — if the command
runs in your server's shell, it shows up.

Settings → Chat → Defaults also identifies these entries as **Agent**, including
Strands when your account may use it. Plugin models keep their provider name, and only
Ollama models carry the Ollama label. Disabling Ollama does not hide configured
agents or plugins. The model information card shows the selected entry's display
name and provider, with size, family, and format only when supplied by its catalog.

## Choosing a model, not just a CLI

Each CLI can expose several entries in the Agents group:

- **Claude Code** offers its signed-in default plus Sonnet, Opus, Haiku, and an
  explicit **Opus 5.5** choice (`claude-opus-5-5`). Opus 5.5 requires
  [Claude Code 2.1.280 or later](https://code.claude.com/docs/en/model-config)
  and access through the signed-in account; run `claude update` to update the CLI.
  The existing **Opus** alias continues to follow the CLI's current model mapping.
- **Codex** offers its configured default plus the documented ChatGPT sign-in
  family: GPT-6 Astra, GPT-6 Sol, GPT-6 Luna, GPT-5.6 Sol, Terra, Luna, GPT-5.5,
  and GPT-5.3 Codex Spark.
  Availability depends on the CLI's sign-in and account access.
- **Pi** runs with the model configured in the CLI itself.
- **OpenCode** lists the models of every provider it is authenticated with
  (from `opencode models`), and always requires an explicit choice — its
  CLI-level default can point at a local server that is not reachable from the
  Libre WebUI host.

The embedded [Strands engine](./STRANDS_ENGINE) also appears in the Agents group
when your account may use it. It is not a CLI: it runs inside the backend and
drives your Ollama and provider plugin models. The plain **Strands** entry
(`strands`) uses your default chat model. The other entries (`strands:<route>`)
list one per available model, such as **Strands · gpt-5.6-sol (Codex
(ChatGPT))**, and pin both the model and its provider for that conversation;
another available provider cannot replace it during an outage. Listing choices
does not start the engine.

The same Strands entries work as the task model under **Settings → Chat →
Defaults** for automatic titles and thinking summaries. **Use current running
model** uses the conversation's saved Strands selection. These short text
requests call its underlying provider model directly; they do not run the
agent's tools or create an agent session. Other CLI profiles require an Ollama,
plugin, or Strands task model for these auxiliary requests.

Pi runs each turn stateless (`--no-session`), with local tools disabled and a
neutral system prompt, so replies are not colored by — and chats never touch —
the personal Pi configuration of the server's operating-system user.

## Using it

1. Sign in as an administrator.
2. Start a chat and open the model selector.
3. Pick an entry under **Agents**.
4. Send messages as usual. Replies stream back token by token.

The conversation is stored like any other chat, so you can leave and come back
to it, rename it, and search it from the command palette. Each turn sends a
transcript of the recent conversation to the agent and streams its answer back.

## Who can use it, and what it can reach

This feature is **administrator-only**, and the reason matters. The agent runs
as the same operating-system user as the Libre WebUI backend, on the host — not
inside a Work container. It therefore inherits that user's agent credentials and
whatever access those agents normally have, including the ability to read files
and run commands on the server if it decides to.

Treat enabling this as equivalent to granting the agent shell access to the
machine. Because of that, the feature ships **disabled**: an administrator must
turn it on under **Settings → User Management → Access & policies → Agent CLI models**. The setting is persisted and
takes effect immediately, without a restart.

Changing this control refreshes the model catalogue immediately; the **Agents**
category contains direct CLI entries, while **Plugin Models** contains provider
API integrations such as Codex (ChatGPT). **Strands** is listed in the same
category but follows its own **Strands engine** access setting, not this
toggle, so it can appear while Agent CLI models are off. Its model discovery
cannot block discovery of installed CLI agents.

Existing installations inherit their previous saved Agents decision until an
independent CLI setting is saved.

To pin the decision at the deployment level regardless of the runtime toggle,
set the environment variable either way (this also locks the toggle in the
interface):

```bash
AGENT_CLI_MODELS_ENABLED=false   # or true
```

For a model that can act on files but stays inside a sandbox, use
[Work](./WORKSPACES) instead: it runs tool-capable models in a locked-down
container with an isolated workspace.

## Usage tracking

Open **Provider Usage** (`/usage`) and find **Agents** near the top. Claude Code,
Codex, OpenCode, Pi, and Strands activity have explicit entries, including a
clear message when the selected period has no recorded calls.

CLI calls made through LWUI record their outcome, duration, and reported token
usage. Each invocation creates one usage event; repeated usage snapshots and
per-step reports do not create duplicate events or token counts. Missing token
counters remain unreported. Stopping a response records cancellation, and an
unsuccessful CLI exit does not become a success merely because it produced
partial text. Usage from CLI calls outside LWUI is not imported.

Strands calls are attributed to the **Strands** agent. See
[Agent usage](./SYSTEM_MONITORING#agent-usage) for the breakdown and limits.

## Configuration

| Variable                   | Default  | Purpose                                                                           |
| -------------------------- | -------- | --------------------------------------------------------------------------------- |
| `AGENT_CLI_MODELS_ENABLED` | unset    | Pin the feature `true`/`false`; unset defers to the admin toggle (off by default) |
| `AGENT_CLI_TIMEOUT_MS`     | `600000` | How long a single agent turn may run before it is killed                          |

## Troubleshooting

**No Agents group appears.** Confirm the feature is enabled under
**Settings → User Management → Access & policies → Agent CLI models** (it is off by default) and that you are signed in
as an administrator, then
check that the command is on the `PATH` of the process running the backend — not
just your interactive shell. A service manager, Docker container, or desktop
launcher often starts with a much smaller `PATH` than a login terminal.

**The reply fails immediately.** Run the same command by hand as the server user
(`claude -p "hello"` or `codex exec "hello"`). Most failures are the agent asking
for a login that has expired, or a rate limit on the underlying subscription.
OpenCode in particular reports an expired provider login only in its own logs;
re-run `opencode auth login` as the server user.

**Replies stop partway.** A long turn may have hit `AGENT_CLI_TIMEOUT_MS`. Raise
it, or break the request into smaller steps.

## Related

- [Work: Isolated Workspaces](./WORKSPACES)
- [Environment Variables](./ENVIRONMENT_VARIABLES)
- [Connect Third-Party and Self-Hosted Providers](./PROVIDER_CONNECTIONS)
