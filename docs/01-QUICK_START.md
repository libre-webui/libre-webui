---
sidebar_position: 2
title: "Quick Start"
description: "Get Libre WebUI running in 60 seconds with Ollama"
slug: /QUICK_START
keywords: [libre webui, quick start, installation, setup, ollama, hardware requirements]
---

# Quick Start

## Requirements

Before you begin, make sure you have:

| Requirement | Minimum | Recommended |
|-------------|---------|-------------|
| **RAM** | 8GB | 16GB+ |
| **GPU VRAM** | None (CPU works) | 8GB+ for speed |
| **Disk Space** | 5GB | 20GB+ for models |
| **Node.js** | v18+ | v20+ |

:::tip No GPU? No Problem
Libre WebUI works with CPU-only inference. Expect 5-15 tokens/second with smaller models (3-7B). For faster performance, see [Hardware Requirements](./HARDWARE_REQUIREMENTS).
:::

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
ollama pull llama3.1:8b
```

**Windows:**
Download from [ollama.ai](https://ollama.ai), then:
```bash
ollama pull llama3.1:8b
```

:::info Model Size
`llama3.1:8b` downloads ~5GB and needs ~5GB VRAM (GPU) or ~8GB RAM (CPU). For smaller systems, try `llama3.2:3b` (~2GB).
:::

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

- [Hardware Requirements](./HARDWARE_REQUIREMENTS) - GPU and memory guide
- [Working with Models](./WORKING_WITH_MODELS) - Model selection and optimization
- [Plugins](./PLUGIN_ARCHITECTURE) - Cloud providers (OpenAI, Anthropic, etc.)
- [Docker](./DOCKER) - Docker Compose options
- [Kubernetes](./KUBERNETES) - Helm chart configuration
