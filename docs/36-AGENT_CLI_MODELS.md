---
sidebar_position: 14
title: 'Use an Installed Coding Agent as a Chat Model'
description: 'Expose the Claude Code or Codex CLI already installed on your server as a selectable Libre WebUI chat model, without adding an API key.'
slug: /AGENT_CLI_MODELS
keywords:
  [
    agent cli,
    claude code,
    codex,
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

| Model           | Command  | Provided by |
| --------------- | -------- | ----------- |
| **Claude Code** | `claude` | Anthropic   |
| **Codex**       | `codex`  | OpenAI      |

Anything found appears under an **Agents** group in the model selector. Nothing
is installed for you, and no configuration file is required — if the command
runs in your server's shell, it shows up.

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
machine. If that is not what you want on a shared or public deployment, turn it
off:

```bash
AGENT_CLI_MODELS_ENABLED=false
```

For a model that can act on files but stays inside a sandbox, use
[Work](./WORKSPACES) instead: it runs tool-capable models in a locked-down
container with an isolated workspace.

## Configuration

| Variable                   | Default  | Purpose                                                  |
| -------------------------- | -------- | -------------------------------------------------------- |
| `AGENT_CLI_MODELS_ENABLED` | `true`   | Set to `false` to hide agent CLIs from the model list    |
| `AGENT_CLI_TIMEOUT_MS`     | `600000` | How long a single agent turn may run before it is killed |

## Troubleshooting

**No Agents group appears.** Confirm you are signed in as an administrator, then
check that the command is on the `PATH` of the process running the backend — not
just your interactive shell. A service manager, Docker container, or desktop
launcher often starts with a much smaller `PATH` than a login terminal.

**The reply fails immediately.** Run the same command by hand as the server user
(`claude -p "hello"` or `codex exec "hello"`). Most failures are the agent asking
for a login that has expired, or a rate limit on the underlying subscription.

**Replies stop partway.** A long turn may have hit `AGENT_CLI_TIMEOUT_MS`. Raise
it, or break the request into smaller steps.

## Related

- [Work: Isolated Workspaces](./WORKSPACES)
- [Environment Variables](./ENVIRONMENT_VARIABLES)
- [Connect Third-Party and Self-Hosted Providers](./PROVIDER_CONNECTIONS)
