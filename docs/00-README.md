---
sidebar_position: 1
title: 'Documentation'
description: 'Libre WebUI documentation - self-hosted, privacy-first AI chat interface'
slug: /
keywords:
  [
    libre webui,
    ollama,
    local ai,
    privacy ai,
    self-hosted ai,
    chatgpt alternative,
  ]
---

# Libre WebUI Documentation

Libre WebUI is a self-hosted AI workspace for chat, local Ollama models, cloud provider plugins, personas, document search, and interactive artifacts. It is designed for people who want a polished WebUI without giving up control of their data or model stack.

## Quick Start

```bash
npx libre-webui
```

Libre WebUI opens at `http://localhost:8080`. Install [Ollama](https://ollama.com) first if you want local models, or add provider API keys for cloud models.

## Installation Options

| Method                      | Command                                                                 | Best for                |
| --------------------------- | ----------------------------------------------------------------------- | ----------------------- |
| npx                         | `npx libre-webui`                                                       | Fast local setup        |
| Docker                      | `docker compose up -d`                                                  | Persistent self-hosting |
| Docker with external Ollama | `docker compose -f docker-compose.external-ollama.yml up -d`            | Existing Ollama servers |
| Kubernetes                  | `helm install libre-webui oci://ghcr.io/libre-webui/charts/libre-webui` | Cluster deployment      |
| Source                      | `npm install && npm run dev`                                            | Development             |

## Core Features

- Streaming chat with local and plugin-backed models
- Model Manager for installed Ollama models, live Ollama Library search, and Ollama Cloud models
- Document Chat for PDF and plain-text files, with keyword search or embeddings
- Personas with model settings, prompts, import/export, memory, and mutation state
- Interactive artifacts for HTML, SVG, JSON, code, and bundled multi-file outputs
- Authentication with local accounts, optional GitHub/Hugging Face OAuth, and optional Cloudflare Turnstile on signup
- Light/dark themes with custom accent colors

## AI Providers

Local inference is handled through Ollama. Cloud providers are added through plugins and include OpenAI-compatible APIs plus first-party entries for OpenAI, Anthropic, Google, Groq, Mistral, OpenRouter, Hugging Face, and other compatible services. Provider plugin files in the repository are the fallback source of truth, while live provider discovery can populate newer models when a provider exposes a compatible model-list endpoint.

## Documentation

### Getting Started

- [Quick Start](./QUICK_START)
- [Hardware Requirements](./HARDWARE_REQUIREMENTS)
- [Working with Models](./WORKING_WITH_MODELS)
- [Keyboard Shortcuts](./KEYBOARD_SHORTCUTS)
- [Troubleshooting](./TROUBLESHOOTING)

### Deployment

- [Docker](./DOCKER)
- [Docker with External Ollama](./DOCKER_EXTERNAL_OLLAMA)
- [Kubernetes](./KUBERNETES)
- [Desktop App](./ELECTRON_DESKTOP_APP)

### Features

- [Plugin Architecture](./PLUGIN_ARCHITECTURE)
- [Hugging Face Hub](./HUGGINGFACE_HUB)
- [Document Chat](./RAG_FEATURE)
- [Artifacts](./ARTIFACTS_FEATURE)
- [Personas](./PERSONA_DEVELOPMENT_FRAMEWORK)
- [Qwen3-TTS](./QWEN3_TTS)
- [Kyutai TTS](./KYUTAI_TTS)

### Administration

- [Authentication](./AUTHENTICATION)
- [Single Sign-On](./SINGLE_SIGN_ON)
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

# Optional signup protection
TURNSTILE_SITE_KEY=...
TURNSTILE_SECRET_KEY=...
```

The first local account created in a fresh install becomes the administrator.

## Links

- [Website](https://librewebui.org)
- [GitHub](https://github.com/libre-webui/libre-webui)
- [Issues](https://github.com/libre-webui/libre-webui/issues)
