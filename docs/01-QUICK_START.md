---
sidebar_position: 2
title: 'Quick Start'
description: 'Get Libre WebUI running with Ollama or provider plugins'
slug: /QUICK_START
keywords:
  [libre webui, quick start, installation, setup, ollama, hardware requirements]
---

# Quick Start

## Requirements

| Requirement | Minimum  | Recommended                         |
| ----------- | -------- | ----------------------------------- |
| Node.js     | 22.22+   | Latest LTS                          |
| RAM         | 8 GB     | 16 GB+                              |
| Disk        | 5 GB     | 20 GB+ for models                   |
| GPU         | Optional | 8 GB+ VRAM for fast local inference |
| Docker      | Optional | Required for Work tasks             |

Libre WebUI works with CPU-only Ollama, but smaller models are a better fit on CPU. For cloud provider plugins, you only need the relevant API key.

Chat, documents, artifacts, and provider-backed features do not require Docker.
Work does: Docker must be installed on the machine running the Libre WebUI
backend, and the backend process must be allowed to invoke it. The
`npx libre-webui` command does not install Docker. If Docker is unavailable, the
rest of Libre WebUI continues to run while Work reports **Runtime unavailable**;
model commands are never run directly on the host as a fallback.

## Start Libre WebUI

```bash
npx libre-webui
```

Open [http://localhost:8080](http://localhost:8080). On a fresh install, create the first account; that account becomes the administrator.

## Install Ollama

Install [Ollama](https://ollama.com), then pull a small general model:

```bash
ollama pull gemma3:4b
```

Other good first models are `qwen3:8b`, `deepseek-r1:8b`, and `mistral`. Use the Model Manager in Libre WebUI to browse installed models, search the live Ollama Library, and pull models without leaving the app.

:::tip Embeddings for documents
For semantic document search, also install an embedding model:

```bash
ollama pull nomic-embed-text
```

:::

## Add Cloud Providers

Cloud providers are optional. Add keys to `backend/.env`, restart the backend, then enable the provider in Settings:

```env
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
GROQ_API_KEY=gsk_...
GEMINI_API_KEY=...
OPENROUTER_API_KEY=sk-or-...
KIMI_API_KEY=...
```

Provider model lists are refreshed by the app when supported. You do not need to keep the docs open to find the latest model names.

## Start Your First Work Task

Work gives each task a persistent conversation and a separate container-backed
filesystem. It is available to authenticated administrators.

1. Install and start Docker on the machine running the Libre WebUI backend.
2. Select **Work** in the sidebar.
3. Choose a model that supports tool calling.
4. Describe what you want to build or change, then select **Run**.
5. Inspect the generated files, tool activity, and application preview in the
   workspace pane.

The task remains in the sidebar so you can return to the same conversation and
files later. Stopping a run or preview preserves the workspace. Deleting the
task permanently deletes its workspace.

Work can use an installed Ollama model, an Ollama Cloud model, or a configured
chat or completion-provider plugin. When you select a remote provider, Libre
WebUI shows a disclosure before the run: the provider receives the
conversation, tool definitions, and any tool results requested by the model.
An autonomous run can make multiple paid provider calls.

See [Work: Isolated Workspaces](./WORKSPACES) for the runtime, persistence,
network, preview, and security details.

## Docker

```bash
git clone https://github.com/libre-webui/libre-webui
cd libre-webui
docker compose up -d
```

If Ollama is already running on the host or another machine:

```bash
docker compose -f docker-compose.external-ollama.yml up -d
```

For NVIDIA GPU acceleration, use the GPU compose file provided by the repository.

Every repository Compose file mounts the host Docker socket, so Work is enabled
out of the box: task containers run on the same daemon that runs Libre WebUI.
That access is root-equivalent on the Docker host, so read
[Work: Isolated Workspaces](./WORKSPACES) before exposing the stack beyond a
machine whose administrators you already trust. On Linux, set `DOCKER_GID` in
`.env` to the group that owns the socket.

## Keyboard Shortcuts

| Shortcut        | Action             |
| --------------- | ------------------ |
| `Cmd/Ctrl + B`  | Toggle sidebar     |
| `Cmd/Ctrl + ,`  | Settings           |
| `Cmd/Ctrl + D`  | Toggle theme       |
| `?`             | Keyboard shortcuts |
| `Enter`         | Send message       |
| `Shift + Enter` | New line           |

## Next Steps

- [Working with Models](./WORKING_WITH_MODELS)
- [Work: Isolated Workspaces](./WORKSPACES)
- [Hardware Requirements](./HARDWARE_REQUIREMENTS)
- [Document Chat](./RAG_FEATURE)
- [Artifacts](./ARTIFACTS_FEATURE)
- [Docker](./DOCKER)
