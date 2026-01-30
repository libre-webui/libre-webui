---
sidebar_position: 30
title: "Local GPU Stack"
description: "Run the full Libre WebUI stack locally with GPU text-to-speech, auto-updates, and external Ollama"
slug: /LOCAL_GPU_STACK
keywords: [local setup, gpu, docker compose, kyutai tts, watchtower, ollama, nvidia]
---

# Local GPU Stack

This guide covers the recommended local setup for running Libre WebUI with GPU-accelerated text-to-speech, automatic container updates, and an external Ollama instance. This is the same stack the maintainers use for daily development and testing.

## What You Get

- **Libre WebUI** on the `dev` image with auto-updates via Watchtower
- **Kyutai TTS 1.6B** running on GPU for local text-to-speech with voice cloning
- **Ollama** running natively on the host (not containerized) for maximum GPU performance
- **Watchtower** polling Docker Hub every 30 minutes for new images

## Prerequisites

| Component | Requirement |
|-----------|-------------|
| **OS** | Windows 10/11 with WSL2, Linux, or macOS |
| **Docker** | Docker Desktop or Docker Engine with Compose v2 |
| **NVIDIA GPU** | Any GPU with 8GB+ VRAM and CUDA support |
| **NVIDIA Drivers** | 535+ with NVIDIA Container Toolkit installed |
| **Ollama** | Installed natively on the host ([ollama.com](https://ollama.com)) |
| **Disk** | ~10GB for TTS model cache, plus space for Ollama models |

## Step 1 - Install Ollama on the Host

Install Ollama directly on the host rather than in a container. This gives Ollama direct GPU access without Docker overhead and lets you manage models from the terminal.

**Linux:**
```bash
curl -fsSL https://ollama.com/install.sh | sh
```

**Windows:**
Download and install from [ollama.com](https://ollama.com). Ollama runs as a system service automatically.

**macOS:**
```bash
brew install ollama
ollama serve
```

Pull a model to get started:

```bash
ollama pull gemma3:12b
```

Verify Ollama is running:

```bash
curl http://localhost:11434/api/version
```

## Step 2 - Set Up Docker Volumes

The compose file uses external volumes so your data persists even if you `docker compose down -v` by accident. Create them once:

```bash
docker volume create libre_webui_dev_data
docker volume create libre_webui_dev_temp
```

## Step 3 - Start the Stack

From the Libre WebUI repo root:

```bash
docker compose -f docker-compose.dev.external-ollama.watchtower.yml up -d
```

This starts three containers:

| Container | Image | Port | GPU |
|-----------|-------|------|-----|
| `libre-webui` | `librewebui/libre-webui:dev` | 8080 | No |
| `kyutai-tts` | Built from `examples/kyutai-tts-1.6b-server` | 8201 | Yes (1 GPU) |
| `watchtower` | `containrrr/watchtower:latest` | - | No |

On first start, the Kyutai TTS container builds from the Dockerfile and downloads the 1.6B model from Hugging Face (~4GB). This only happens once — the model is cached in the `huggingface_cache` volume.

## Step 4 - Verify Everything

Check all containers are running:

```bash
docker compose -f docker-compose.dev.external-ollama.watchtower.yml ps
```

Test Ollama connectivity from inside the container:

```bash
docker exec libre-webui curl -s http://host.docker.internal:11434/api/version
```

Test TTS:

```bash
curl http://localhost:8201/v1/audio/speech \
  -H "Content-Type: application/json" \
  -d '{"model": "kyutai-tts-1.6b", "input": "Hello from the local stack!", "voice": "alba"}' \
  --output test.wav
```

Open `http://localhost:8080` in your browser. You should see the Libre WebUI interface with your Ollama models in the dropdown.

## Step 5 - Enable TTS in the UI

1. Go to **Settings > Plugins > Kyutai TTS 1.6B**
2. Enable the plugin
3. The endpoint is already configured to `http://kyutai-tts:8201/v1/audio/speech` (container-to-container networking)
4. Select a voice and test it from any chat message

See the [Kyutai TTS docs](./KYUTAI_TTS) for the full list of voices and voice cloning instructions.

## Network Access

The compose file binds to `0.0.0.0` so you can access the UI from other devices on your LAN. Update `CORS_ORIGIN` in the compose file to include your local IP:

```yaml
- CORS_ORIGIN=http://localhost:8080,http://192.168.1.100:8080
```

## How Watchtower Works

Watchtower checks Docker Hub every 30 minutes (`WATCHTOWER_POLL_INTERVAL=1800`) for new `librewebui/libre-webui:dev` images. When it finds one, it pulls the new image, stops the old container, and starts a new one with the same configuration. Your data is safe in the external volumes.

Watchtower monitors all containers (not just labeled ones) because `WATCHTOWER_LABEL_ENABLE=false`. It also cleans up old images after updating (`WATCHTOWER_CLEANUP=true`).

Check Watchtower logs to see when it last checked:

```bash
docker logs watchtower --tail 20
```

## Updating

**Libre WebUI** updates automatically via Watchtower. No action needed.

**Kyutai TTS** is built locally, so Watchtower does not update it. To rebuild with new changes:

```bash
docker compose -f docker-compose.dev.external-ollama.watchtower.yml build kyutai-tts
docker compose -f docker-compose.dev.external-ollama.watchtower.yml up -d kyutai-tts
```

**Ollama** is installed natively — update it through your package manager or by downloading the latest installer.

## Switching to the Stable Image

To use the stable release instead of `dev`, edit the compose file and change:

```yaml
image: librewebui/libre-webui:dev
```

to:

```yaml
image: librewebui/libre-webui:latest
```

Also change the volume names from `libre_webui_dev_data`/`libre_webui_dev_temp` to `libre_webui_data`/`libre_webui_temp` (and create those volumes) to keep stable and dev data separate.

## Troubleshooting

### Ollama not connecting

The container reaches Ollama on the host via `host.docker.internal`. This works out of the box on Docker Desktop (Windows/macOS). On Linux, you may need to add this to the libre-webui service in the compose file:

```yaml
extra_hosts:
  - "host.docker.internal:host-gateway"
```

### Kyutai TTS build fails

Make sure the NVIDIA Container Toolkit is installed and Docker can access the GPU:

```bash
docker run --rm --gpus all nvidia/cuda:12.6.0-base-ubuntu24.04 nvidia-smi
```

### TTS model download hangs

The 1.6B model downloads from Hugging Face on first run. If it stalls, check your internet connection or set a Hugging Face token for faster downloads:

```yaml
environment:
  - HF_TOKEN=hf_...
```

### Container keeps restarting

Check logs:

```bash
docker logs libre-webui --tail 50
docker logs kyutai-tts --tail 50
```
