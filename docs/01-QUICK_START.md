---
sidebar_position: 2
title: "Quick Start"
description: "Get Libre WebUI running in 60 seconds"
slug: /QUICK_START
keywords: [libre webui, quick start, installation, setup, ollama]
---

# Quick Start

## Install

```bash
npx libre-webui
```

Opens at [http://localhost:8080](http://localhost:8080).

**Prerequisite:** [Ollama](https://ollama.ai) must be installed and running.

## Install Ollama

**macOS / Linux:**
```bash
curl -fsSL https://ollama.ai/install.sh | sh
ollama pull llama3.2
```

**Windows:**
Download from [ollama.ai](https://ollama.ai), then:
```bash
ollama pull llama3.2
```

## Alternative: Docker

Everything included (Libre WebUI + Ollama):

```bash
git clone https://github.com/libre-webui/libre-webui
cd libre-webui
docker-compose up -d
```

With NVIDIA GPU:
```bash
docker-compose -f docker-compose.gpu.yml up -d
```

If you already have Ollama running:
```bash
docker-compose -f docker-compose.external-ollama.yml up -d
```

## Alternative: Kubernetes

```bash
helm install libre-webui oci://ghcr.io/libre-webui/charts/libre-webui
```

See [Kubernetes docs](./KUBERNETES) for configuration options.

## Add Cloud Providers

Optional: connect OpenAI, Anthropic, and other providers.

Add to `backend/.env`:
```env
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
```

Enable in Settings → Plugins.

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Cmd/Ctrl + K` | New chat |
| `Cmd/Ctrl + B` | Toggle sidebar |
| `Cmd/Ctrl + ,` | Settings |
| `Cmd/Ctrl + D` | Toggle dark mode |
| `?` | Show all shortcuts |

## Next Steps

- [Plugins](./PLUGIN_ARCHITECTURE) - Cloud providers, image generation, TTS
- [Docker](./DOCKER) - Docker Compose options
- [Kubernetes](./KUBERNETES) - Helm chart configuration
- [Personas](./PERSONA_DEVELOPMENT_FRAMEWORK) - Custom AI personalities
