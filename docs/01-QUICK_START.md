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
| Node.js     | 22.12+   | Latest LTS                          |
| RAM         | 8 GB     | 16 GB+                              |
| Disk        | 5 GB     | 20 GB+ for models                   |
| GPU         | Optional | 8 GB+ VRAM for fast local inference |

Libre WebUI works with CPU-only Ollama, but smaller models are a better fit on CPU. For cloud provider plugins, you only need the relevant API key.

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

## Keyboard Shortcuts

| Shortcut        | Action             |
| --------------- | ------------------ |
| `Cmd/Ctrl + K`  | New chat           |
| `Cmd/Ctrl + B`  | Toggle sidebar     |
| `Cmd/Ctrl + ,`  | Settings           |
| `Cmd/Ctrl + D`  | Toggle theme       |
| `?`             | Keyboard shortcuts |
| `Enter`         | Send message       |
| `Shift + Enter` | New line           |

## Next Steps

- [Working with Models](./WORKING_WITH_MODELS)
- [Hardware Requirements](./HARDWARE_REQUIREMENTS)
- [Document Chat](./RAG_FEATURE)
- [Artifacts](./ARTIFACTS_FEATURE)
- [Docker](./DOCKER)
