---
sidebar_position: 1
title: 'Documentation'
description: 'Libre WebUI documentation - local-first chat, private knowledge, artifacts, and isolated Work tasks'
slug: /
keywords:
  [
    libre webui,
    ollama,
    local ai,
    privacy ai,
    self-hosted ai,
    coding agent,
    isolated workspace,
    chatgpt alternative,
  ]
---

# Libre WebUI Documentation

Libre WebUI is a self-hosted AI workspace for chat, local Ollama models, cloud
provider plugins, isolated model-driven Work tasks, personas, document search,
and interactive artifacts. It is designed for people who want a polished WebUI
without giving up control of their data or model stack.

## Quick Start

```bash
npx libre-webui
```

Libre WebUI opens at `http://localhost:8080`. A fresh install always permits
the first local administrator; later public registration is closed by default.
Install [Ollama](https://ollama.com) first if you want local models, or add
provider API keys for cloud models.

The main app and Chat do not require Docker. **Work** does: Docker must be
installed and usable on the machine running the Libre WebUI backend. Without it,
the app continues to work and the Work page reports **Runtime unavailable**.

## Installation Options

| Method                      | Command                                                                   | Work availability                                                  |
| --------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| npx                         | `npx libre-webui`                                                         | Available when Docker is installed on the same machine             |
| Docker                      | `docker compose up -d`                                                    | Available through the mounted host Docker socket                   |
| Docker with external Ollama | `docker compose -f docker-compose.external-ollama.yml up -d`              | Available through the mounted host Docker socket                   |
| Kubernetes                  | `helm install libre-webui oci://ghcr.io/libre-webui/charts/libre-webui`   | Unavailable in the current chart; no per-task runtime driver       |
| Source                      | `npm install && npm run dev`                                              | Available when the native backend process can use Docker           |
| Electron                    | [Download a release](https://github.com/libre-webui/libre-webui/releases) | Uses Docker on its separately managed backend host, when available |

## Getting Around

The interface is organized as tabs, like a browser. **Home** is always the first
tab: it greets you, offers what to start, and lists recent chats and Work
sessions so you can pick one back up. Opening a chat, a Work session, or a page
adds a tab beside it; the `+` button starts a new one and lists the shortcut for
each.

Press `Cmd/Ctrl + K` anywhere to search your chats, Work sessions, and actions.
It works even while you are typing a message, so you can jump elsewhere without
losing a draft. `Cmd/Ctrl + Shift + O` starts a chat and `Cmd/Ctrl + Shift + U`
starts a Work session.

The sidebar keeps your conversation list, a search entry, and a compact row of
icons for Models, Personas, Imagine, and Agents. Every one of those is also in
the command palette and on Home, so you never have to remember which surface
something lives on.

## Core Features

- Streaming chat with local and plugin-backed models
- Native Work tasks with a dedicated persistent Docker volume, isolated command
  container, durable conversation, file editor, tool activity, and app preview
- Model Manager for installed Ollama models, live Ollama Library search, and Ollama Cloud models
- Document Chat for PDF and plain-text files, with keyword search or embeddings
- Personas with model settings, prompts, import/export, memory, and mutation state
- Interactive artifacts for HTML, SVG, JSON, code, and bundled multi-file outputs
- Authentication with local accounts, optional GitHub/Hugging Face OAuth, and optional Cloudflare Turnstile on login and signup
- Light/dark themes with custom accent colors and 25 translated locales,
  including fully mirrored Arabic RTL Work layouts

## Work at a Glance

Select **Work** beside **Chat**, choose a tool-capable Ollama, Ollama Cloud, or
plugin-backed model, then describe what you want to build or change. A Work task
owns:

- its conversation and run history;
- an exact persisted provider route;
- a dedicated Docker named volume mounted at `/workspace`;
- a disposable, policy-checked container for file and shell tools;
- Files, Activity, and Preview views in a draggable responsive workspace.

Work is built into Libre WebUI and does not require Libre Claw. It is restricted
to administrators because it intentionally lets the selected model run arbitrary
commands inside the task container.

[Start with the complete Work guide](./WORKSPACES).

## AI Providers

Local inference is available through Ollama or the MLX LM plugin on Apple
Silicon. Cloud providers are added through plugins and include OpenAI-compatible
APIs plus first-party entries for OpenAI, Anthropic, Google, Groq, Kimi Code by
Moonshot AI, Mistral, OpenRouter, Hugging Face, and other compatible services.
Provider plugin files in the repository are the fallback source of truth, while
live provider discovery can populate newer models when a provider exposes a
compatible model-list endpoint.

[Connect a third-party or self-hosted provider](./PROVIDER_CONNECTIONS) with
the Provider connections workspace introduced in Libre WebUI 0.16.0.

A coding-agent CLI already installed on the server, such as Claude Code or
Codex, can also be used as a chat model without an API key.
[Use an installed coding agent](./AGENT_CLI_MODELS).

## Documentation

### Getting Started

- [Quick Start](./QUICK_START)
- [Hardware Requirements](./HARDWARE_REQUIREMENTS)
- [Working with Models](./WORKING_WITH_MODELS)
- [Work: Isolated Workspaces](./WORKSPACES)
- [Keyboard Shortcuts](./KEYBOARD_SHORTCUTS)
- [Troubleshooting](./TROUBLESHOOTING)

### Deployment

- [Docker](./DOCKER)
- [Private Remote Deployment](./PRIVATE_REMOTE_DEPLOYMENT)
- [Docker with External Ollama](./DOCKER_EXTERNAL_OLLAMA)
- [Kubernetes](./KUBERNETES)
- [Desktop App](./ELECTRON_DESKTOP_APP)

### Features

- [Work: Isolated Workspaces](./WORKSPACES)
- [Connect Third-Party and Self-Hosted Providers](./PROVIDER_CONNECTIONS)
- [Use an Installed Coding Agent as a Chat Model](./AGENT_CLI_MODELS)
- [Plugin Architecture](./PLUGIN_ARCHITECTURE)
- [Kimi Code](./KIMI_CODE)
- [Hugging Face Hub](./HUGGINGFACE_HUB)
- [MLX LM on Apple Silicon](./MLX_APPLE_SILICON)
- [Video & Audio Generation](./MEDIA_GENERATION)
- [Document Chat](./RAG_FEATURE)
- [Artifacts](./ARTIFACTS_FEATURE)
- [Personas](./PERSONA_DEVELOPMENT_FRAMEWORK)
- [Qwen3-TTS](./QWEN3_TTS)
- [Kyutai TTS](./KYUTAI_TTS)

### Administration

- [Authentication](./AUTHENTICATION)
- [Single Sign-On](./SINGLE_SIGN_ON)
- [System Diagnostics & Usage Analytics](./SYSTEM_MONITORING)
- [Environment Variables](./ENVIRONMENT_VARIABLES)
- [Database Encryption](./DATABASE_ENCRYPTION)

## Basic Configuration

Create or edit `backend/.env`:

```env
OLLAMA_BASE_URL=http://localhost:11434
JWT_SECRET=replace-with-a-long-random-secret

# Optional provider keys
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...

# Optional login and signup protection
TURNSTILE_SITE_KEY=...
TURNSTILE_SECRET_KEY=...
TURNSTILE_EXPECTED_HOSTNAME=librewebui.example
```

The first local account created in a fresh install becomes the administrator.

## Links

- [Website](https://librewebui.org)
- [GitHub](https://github.com/libre-webui/libre-webui)
- [Issues](https://github.com/libre-webui/libre-webui/issues)
