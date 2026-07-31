---
sidebar_position: 30
title: 'Local GPU Stack'
description: 'Run Libre WebUI locally with Docker, an external Ollama instance, and GPU-aware model choices.'
slug: /LOCAL_GPU_STACK
keywords: [local setup, gpu, docker compose, ollama, nvidia]
---

# Local GPU Stack

This guide describes the repository-supported local GPU setup: Ollama runs natively on the host for direct GPU access, and Libre WebUI runs in Docker with `docker-compose.dev.external-ollama.yml`.

## Work Availability

This stack gives you both: Ollama runs natively on the host GPU, and the Libre
WebUI container mounts the host Docker socket, so Work creates task-scoped
containers on the same daemon. No native Libre WebUI install is needed.

That socket grants root-equivalent control of the Docker host. Remove the
`/var/run/docker.sock` mount from the Compose file if you do not want Work, and
on Linux set `DOCKER_GID` in `.env` to the group that owns the socket.

On memory-constrained machines, Work can instead use an Ollama Cloud model or a
configured remote completion/chat plugin. That reduces local model memory
pressure, but Docker is still required for the task workspace and commands.

## What You Get

- Libre WebUI using the `librewebui/libre-webui:dev` image.
- Native host Ollama for local model inference.
- Persistent Libre WebUI data volumes.
- A clean path for testing the dev image without containerizing Ollama.

## Prerequisites

| Component | Requirement                                                                   |
| --------- | ----------------------------------------------------------------------------- |
| Docker    | Docker Desktop or Docker Engine with Compose v2                               |
| Ollama    | Installed and running on the host                                             |
| GPU       | Optional but recommended for local models                                     |
| NVIDIA    | Current driver and NVIDIA Container Toolkit if you containerize GPU workloads |
| Disk      | Enough space for Ollama model files                                           |

## Install and Verify Ollama

Linux:

```bash
curl -fsSL https://ollama.com/install.sh | sh
```

macOS:

```bash
brew install ollama
ollama serve
```

Pull a starter model:

```bash
ollama pull gemma3:4b
```

Verify the API:

```bash
curl http://localhost:11434/api/version
```

## Start Libre WebUI

From the repository root:

```bash
docker compose -f docker-compose.dev.external-ollama.yml up -d
```

Open [http://localhost:8080](http://localhost:8080).

## Custom Ollama Endpoint

If Ollama is on another machine:

```bash
OLLAMA_BASE_URL=http://192.168.1.100:11434 docker compose -f docker-compose.dev.external-ollama.yml up -d
```

For Tailscale:

```bash
OLLAMA_BASE_URL=http://100.x.y.z:11434 docker compose -f docker-compose.dev.external-ollama.yml up -d
```

## Recommended Models

For a first GPU workstation:

```bash
ollama pull gemma3:4b
ollama pull qwen3:8b
ollama pull deepseek-r1:8b
ollama pull nomic-embed-text
```

Use the Model Manager to discover larger models once the basic stack is working.

## LAN Access

Add your LAN or Tailscale origin to `CORS_ORIGIN` in the compose environment before exposing the app to another device:

```env
CORS_ORIGIN=http://localhost:8080,http://192.168.1.50:8080
```

Then restart:

```bash
docker compose -f docker-compose.dev.external-ollama.yml up -d
```

## Useful Commands

```bash
docker compose -f docker-compose.dev.external-ollama.yml ps
docker compose -f docker-compose.dev.external-ollama.yml logs -f libre-webui
docker compose -f docker-compose.dev.external-ollama.yml pull
docker compose -f docker-compose.dev.external-ollama.yml up -d
```

## Troubleshooting

**Container cannot reach Ollama**

```bash
docker compose -f docker-compose.dev.external-ollama.yml exec libre-webui \
  wget -O- http://host.docker.internal:11434/api/version
```

On Linux, add:

```yaml
extra_hosts:
  - 'host.docker.internal:host-gateway'
```

**Model runs on CPU**

Native Ollama uses the host installation. Check your Ollama install, GPU driver, and `ollama ps`.

**Need TTS**

Use the [Qwen3-TTS](./QWEN3_TTS) or [Kyutai TTS](./KYUTAI_TTS) server guides, then enable the matching plugin in Settings.

## Related Docs

- [Work: Isolated Workspaces](./WORKSPACES)
- [Docker with External Ollama](./DOCKER_EXTERNAL_OLLAMA)
- [Hardware Requirements](./HARDWARE_REQUIREMENTS)
- [Working with Models](./WORKING_WITH_MODELS)
